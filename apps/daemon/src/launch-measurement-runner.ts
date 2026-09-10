import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

import {
  LaunchMeasurementDriverError,
  createPlaywrightLaunchMeasurementDriver,
  type LaunchMeasurementDriver,
} from "@loomrail/browser-qa";
import type {
  LaunchMeasurementRun,
  LaunchMeasurementRunErrorCode,
  VerificationRecipe,
} from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import {
  prepareVerificationProcessIntent,
  recoverVerificationRunProcesses,
  removeVerificationProcessRecord,
  startVerificationService,
  type StartVerificationServiceInput,
  type VerificationServiceStart,
} from "@loomrail/project-readiness";

type LaunchMeasurementLogger = {
  error: (fields: Record<string, unknown>, message: string) => void;
};

export type LaunchServiceStarter = (
  input: StartVerificationServiceInput,
) => Promise<VerificationServiceStart>;

type ActiveLaunchMeasurement = {
  controller: AbortController;
  promise: Promise<void>;
  stopService: (() => void) | null;
};

export type LaunchMeasurementRunner = {
  wake: (runId: string) => void;
  cancel: (input: {
    runId: string;
    expectedVersion: number;
    commandId: string;
    correlationId: string;
  }) => Promise<void>;
  recover: () => Promise<void>;
  whenIdle: (runId?: string) => Promise<void>;
  stop: () => Promise<void>;
};

const isLoopbackAddress = (address: string): boolean => {
  if (address === "::1") return true;
  const mapped = /^::ffff:(127(?:\.\d{1,3}){3})$/iu.exec(address)?.[1];
  const octets = (mapped ?? address).split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
};

class LaunchTargetError extends Error {
  readonly code: "ORIGIN_FORBIDDEN" | "TARGET_UNHEALTHY";

  constructor(code: "ORIGIN_FORBIDDEN" | "TARGET_UNHEALTHY", message: string) {
    super(message);
    this.name = "LaunchTargetError";
    this.code = code;
  }
}

const resolvePinnedAddress = async (hostname: string): Promise<string> => {
  if (hostname !== "localhost") return hostname.replace(/^\[|\]$/gu, "");
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isLoopbackAddress(address))) {
    throw new Error("LOOPBACK_RESOLUTION_REJECTED");
  }
  return (addresses.find(({ family }) => family === 4) ?? addresses[0])?.address ?? "";
};

const probeHealth = async (input: {
  origin: string;
  healthPath: string;
  address: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<boolean> => {
  const target = new URL(input.healthPath, input.origin);
  const origin = new URL(input.origin);
  if (target.origin !== origin.origin) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", cancel);
      resolve(value);
    };
    const request = (origin.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: origin.protocol,
        hostname: input.address,
        port: origin.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { host: origin.host },
        servername: origin.hostname,
        timeout: input.timeoutMs,
      },
      (response) => {
        const healthy =
          response.statusCode !== undefined &&
          response.statusCode >= 200 &&
          response.statusCode < 300 &&
          response.headers.location === undefined;
        response.destroy();
        finish(healthy);
      },
    );
    function cancel(): void {
      request.destroy();
      finish(false);
    }
    request.once("timeout", () => {
      request.destroy();
    });
    request.once("error", () => {
      finish(false);
    });
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) cancel();
    else request.end();
  });
};

const waitForHealthyTarget = async (input: {
  origin: string;
  healthPath: string;
  deadlineMs: number;
  signal: AbortSignal;
}): Promise<boolean> => {
  const origin = new URL(input.origin);
  const address = await resolvePinnedAddress(origin.hostname).catch(() => {
    throw new LaunchTargetError("TARGET_UNHEALTHY", "The local target hostname could not be resolved");
  });
  if (!isLoopbackAddress(address)) {
    throw new LaunchTargetError("ORIGIN_FORBIDDEN", "The local target resolved outside loopback");
  }
  const deadline = Date.now() + input.deadlineMs;
  while (!input.signal.aborted && Date.now() < deadline) {
    if (
      await probeHealth({
        origin: input.origin,
        healthPath: input.healthPath,
        address,
        timeoutMs: Math.min(2_000, Math.max(250, deadline - Date.now())),
        signal: input.signal,
      })
    ) {
      return true;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      timer.unref();
    });
  }
  return false;
};

const serviceRecipe = (recipes: readonly VerificationRecipe[], recipeId: string): VerificationRecipe | null =>
  recipes.find(({ id }) => id === recipeId) ?? null;

export const createLaunchMeasurementRunner = (input: {
  state: LocalState;
  artifactsDirectory: string;
  createCommandId: () => string;
  now: () => Date;
  logger: LaunchMeasurementLogger;
  driver?: LaunchMeasurementDriver;
  startService?: LaunchServiceStarter;
}): LaunchMeasurementRunner => {
  const active = new Map<string, ActiveLaunchMeasurement>();
  const driver = input.driver ?? createPlaywrightLaunchMeasurementDriver();
  const startService = input.startService ?? startVerificationService;
  const registryDirectory = join(input.artifactsDirectory, ".launch-processes");

  const currentRun = (runId: string): LaunchMeasurementRun | null => {
    const context = input.state.query({ type: "GET_LAUNCH_MEASUREMENT_RUN_CONTEXT", runId });
    return context.type === "LAUNCH_MEASUREMENT_RUN_CONTEXT" ? context.run : null;
  };

  const interrupt = (
    runId: string,
    errorCode: LaunchMeasurementRunErrorCode,
    processStopped: boolean,
  ): void => {
    const run = currentRun(runId);
    if (
      run === null ||
      (run.status !== "RUNNING" && run.status !== "CANCELLING" && run.status !== "BLOCKED")
    ) {
      return;
    }
    if (!processStopped && run.status === "BLOCKED") return;
    input.state.execute({
      schemaVersion: 1,
      commandId: input.createCommandId(),
      correlationId: `launch-measurement-${runId}`,
      actor: { type: "SYSTEM", id: "launch-measurement-runner" },
      type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
      payload: { runId, expectedVersion: run.version, errorCode, processStopped },
    });
    if (!processStopped) {
      input.logger.error(
        { runId, errorCode: "SERVICE_TERMINATION_FAILED" },
        "Launch measurement is blocked because process-tree stop was not proved",
      );
    }
  };

  const executeRun = async (runId: string, authority: ActiveLaunchMeasurement): Promise<void> => {
    const context = input.state.query({ type: "GET_LAUNCH_MEASUREMENT_RUN_CONTEXT", runId });
    if (context.type !== "LAUNCH_MEASUREMENT_RUN_CONTEXT") return;
    if (context.run.status !== "RUNNING" && context.run.status !== "CANCELLING") return;
    if (context.run.status === "CANCELLING") {
      interrupt(runId, "OWNER_CANCELLED", true);
      return;
    }
    const recipe = serviceRecipe(
      context.verificationPlan.recipes,
      context.plan.configuration.startupRecipeId,
    );
    if (recipe === null) {
      interrupt(runId, "RECIPE_NOT_APPROVED", true);
      return;
    }
    let started: VerificationServiceStart;
    try {
      await prepareVerificationProcessIntent(registryDirectory, runId);
      started = await startService({
        recipe,
        worktreePath: context.project.repositoryPath,
        expectedTree: context.run.testedTree,
        processGuard: { runId, registryDirectory },
      });
    } catch {
      await removeVerificationProcessRecord(registryDirectory, runId).catch(() => undefined);
      interrupt(runId, "SERVICE_SPAWN_FAILED", true);
      return;
    }
    if (started.state === "ERROR") {
      await removeVerificationProcessRecord(registryDirectory, runId).catch(() => undefined);
      interrupt(runId, started.errorCode, true);
      return;
    }
    authority.stopService = started.stop;
    let terminal: Awaited<typeof started.completion> | null = null;
    try {
      const health = await Promise.race([
        started.completion.then((value) => ({ type: "TERMINAL" as const, value })),
        waitForHealthyTarget({
          origin: context.plan.configuration.targetOrigin,
          healthPath: context.plan.configuration.healthPath,
          deadlineMs: Math.min(30_000, recipe.timeoutSeconds * 1_000),
          signal: authority.controller.signal,
        }).then((available) => ({ type: "HEALTH" as const, available })),
      ]);
      if (health.type === "TERMINAL") {
        terminal = health.value;
        interrupt(runId, health.value.errorCode ?? "SERVICE_EXITED", health.value.processStopped);
        return;
      }
      if (!health.available) {
        started.stop();
        terminal = await started.completion;
        interrupt(
          runId,
          authority.controller.signal.aborted ? "OWNER_CANCELLED" : "TARGET_UNHEALTHY",
          terminal.processStopped,
        );
        return;
      }

      const measured = await Promise.race([
        driver
          .measure(context.plan.configuration, authority.controller.signal)
          .then((value) => ({ type: "MEASURED" as const, value })),
        started.completion.then((value) => ({ type: "TERMINAL" as const, value })),
      ]);
      if (measured.type === "TERMINAL") {
        terminal = measured.value;
        interrupt(runId, measured.value.errorCode ?? "SERVICE_EXITED", measured.value.processStopped);
        return;
      }
      started.stop();
      const stopped = await started.completion;
      terminal = stopped;
      if (stopped.state !== "STOPPED" || !stopped.processStopped || stopped.afterTree === null) {
        interrupt(runId, stopped.errorCode ?? "SERVICE_TERMINATION_FAILED", stopped.processStopped);
        return;
      }
      const auditRecipeId = context.plan.configuration.dependencyAuditRecipeId;
      const audit =
        auditRecipeId === null
          ? null
          : input.state.query({
              type: "GET_LATEST_PROJECT_AUDIT_EVIDENCE",
              projectId: context.project.id,
              recipeId: auditRecipeId,
              testedTree: context.run.testedTree,
            });
      const latest = currentRun(runId);
      if (latest?.status !== "RUNNING") {
        if (latest?.status === "CANCELLING") interrupt(runId, "OWNER_CANCELLED", true);
        return;
      }
      input.state.execute({
        schemaVersion: 1,
        commandId: input.createCommandId(),
        correlationId: `launch-measurement-${runId}`,
        actor: { type: "SYSTEM", id: "launch-measurement-runner" },
        type: "COMPLETE_LAUNCH_MEASUREMENT_RUN",
        payload: {
          runId,
          expectedVersion: latest.version,
          currentTree: stopped.afterTree,
          browserMeasurement: measured.value,
          dependencyAudit: audit?.type === "LAUNCH_DEPENDENCY_AUDIT_EVIDENCE" ? audit.evidence : null,
          processStopped: true,
        },
      });
    } catch (error: unknown) {
      started.stop();
      const stopped = await started.completion;
      terminal = stopped;
      const ownerCancelled = authority.controller.signal.aborted;
      const errorCode: LaunchMeasurementRunErrorCode = ownerCancelled
        ? "OWNER_CANCELLED"
        : error instanceof LaunchTargetError
          ? error.code
          : error instanceof LaunchMeasurementDriverError
            ? error.code === "ORIGIN_FORBIDDEN"
              ? "ORIGIN_FORBIDDEN"
              : error.code === "MEASUREMENT_TIMEOUT"
                ? "MEASUREMENT_TIMEOUT"
                : error.code === "CANCELLED"
                  ? "OWNER_CANCELLED"
                  : "EVIDENCE_INVALID"
            : "EVIDENCE_INVALID";
      interrupt(runId, errorCode, stopped.processStopped);
    } finally {
      authority.stopService = null;
      if (terminal?.processStopped) {
        await removeVerificationProcessRecord(registryDirectory, runId).catch(() => undefined);
      }
    }
  };

  const wake = (runId: string): void => {
    if (active.has(runId)) return;
    const authority: ActiveLaunchMeasurement = {
      controller: new AbortController(),
      promise: Promise.resolve(),
      stopService: null,
    };
    authority.promise = Promise.resolve()
      .then(() => executeRun(runId, authority))
      .catch((error: unknown) => {
        input.logger.error(
          { runId, errorName: error instanceof Error ? error.name : "UnknownError" },
          "Launch measurement runner failed outside its typed boundary",
        );
      })
      .finally(() => active.delete(runId));
    active.set(runId, authority);
  };

  return {
    wake,
    cancel: async (request) => {
      const beforeCancellation = currentRun(request.runId);
      const result = input.state.execute({
        schemaVersion: 1,
        commandId: request.commandId,
        correlationId: request.correlationId,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CANCEL_LAUNCH_MEASUREMENT_RUN",
        payload: { runId: request.runId, expectedVersion: request.expectedVersion },
      });
      if (result.type !== "LAUNCH_MEASUREMENT_RUN_CHANGED") return;
      const authority = active.get(request.runId);
      if (authority === undefined) {
        const recovery = await recoverVerificationRunProcesses({
          registryDirectory,
          runIds: [request.runId],
          now: input.now,
        });
        const action = recovery[0]?.action;
        const stopped =
          action === "CONFIRMED" ||
          action === "KILLED" ||
          (action === "NO_RECORD" && beforeCancellation?.status !== "BLOCKED");
        interrupt(request.runId, "OWNER_CANCELLED", stopped);
        return;
      }
      authority.controller.abort();
      authority.stopService?.();
      await authority.promise;
    },
    recover: async () => {
      const result = input.state.query({ type: "LIST_ACTIVE_LAUNCH_MEASUREMENT_RUNS" });
      if (result.type !== "LAUNCH_MEASUREMENT_RUNS") return;
      for (const run of result.runs) {
        const recovery = await recoverVerificationRunProcesses({
          registryDirectory,
          runIds: [run.id],
          now: input.now,
        });
        if (
          recovery[0]?.action === "BLOCKED" ||
          (run.status === "BLOCKED" && recovery[0]?.action === "NO_RECORD")
        ) {
          interrupt(run.id, "SERVICE_TERMINATION_FAILED", false);
          input.logger.error(
            { runId: run.id, errorCode: "SERVICE_TERMINATION_FAILED" },
            "Launch measurement recovery could not prove process-tree stop",
          );
          continue;
        }
        interrupt(run.id, run.status === "CANCELLING" ? "OWNER_CANCELLED" : "DAEMON_RESTART", true);
        await removeVerificationProcessRecord(registryDirectory, run.id).catch(() => undefined);
      }
    },
    whenIdle: async (runId) => {
      if (runId !== undefined) {
        await active.get(runId)?.promise;
        return;
      }
      await Promise.all([...active.values()].map(({ promise }) => promise));
    },
    stop: async () => {
      const running = [...active.entries()];
      for (const [, authority] of running) {
        authority.controller.abort();
        authority.stopService?.();
      }
      await Promise.all(running.map(([, { promise }]) => promise));
      for (const [runId] of running) {
        const run = currentRun(runId);
        if (run !== null && (run.status === "RUNNING" || run.status === "CANCELLING")) {
          interrupt(runId, "DAEMON_RESTART", true);
        }
      }
    },
  };
};
