import { createHash } from "node:crypto";
import { open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { StateCommand, StateCommandResult, VerificationRun } from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import {
  executeVerificationRecipe,
  prepareVerificationProcessIntent,
  recoverVerificationRunProcesses,
  removeVerificationProcessRecord,
  type ExecuteVerificationRecipeInput,
  type VerificationRecipeExecution,
} from "@loomrail/project-readiness";

const MAX_OUTPUT_BYTES = 262_144;

type VerificationLogger = {
  error: (fields: Record<string, unknown>, message: string) => void;
};

type CancelledResult = Extract<StateCommandResult, { type: "VERIFICATION_RUN_INTERRUPTED" }>;
type CancellationRequestedResult = Extract<
  StateCommandResult,
  { type: "VERIFICATION_RUN_CANCELLATION_REQUESTED" }
>;
type CancellationCommand = Extract<StateCommand, { type: "CANCEL_VERIFICATION_RUN" }>;

type ActiveVerificationRun = {
  controller: AbortController;
  promise: Promise<void>;
  stopRequested: boolean;
  stopConfirmed: boolean;
  cancelPromise: Promise<void> | null;
};

export type VerificationRecipeExecutor = (
  input: ExecuteVerificationRecipeInput,
) => Promise<VerificationRecipeExecution>;

export type ProjectVerificationRunner = {
  wake: (runId: string) => void;
  cancel: (input: {
    runId: string;
    expectedVersion: number;
    commandId: string;
    correlationId: string;
  }) => Promise<void>;
  whenIdle: (runId?: string) => Promise<void>;
  readOutput: (checkId: string) => Promise<string | null>;
  stop: () => Promise<void>;
};

export const createProjectVerificationRunner = (input: {
  state: LocalState;
  artifactsDirectory: string;
  createCommandId: () => string;
  createArtifactId: () => string;
  now: () => Date;
  logger: VerificationLogger;
  executeRecipe?: VerificationRecipeExecutor;
  /** Re-evaluates any workflow dispatch parked behind this Run after its authority settles. */
  onSettled?: (runId: string) => void;
}): ProjectVerificationRunner => {
  const active = new Map<string, ActiveVerificationRun>();
  const executeRecipe = input.executeRecipe ?? executeVerificationRecipe;

  const discardUnclaimedArtifact = async (execution: VerificationRecipeExecution): Promise<void> => {
    if (execution.artifactPath !== null)
      await rm(execution.artifactPath, { force: true }).catch(() => undefined);
  };

  const completeUnexpectedFailure = (
    run: VerificationRun,
    checkId: string,
    checkVersion: number,
  ): boolean => {
    const completed = input.state.execute({
      schemaVersion: 1,
      commandId: input.createCommandId(),
      correlationId: `verification-run-${run.id}`,
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "COMPLETE_VERIFICATION_CHECK",
      payload: {
        runId: run.id,
        checkId,
        expectedRunVersion: run.version,
        expectedCheckVersion: checkVersion,
        observation: {
          status: "ERROR",
          completedAt: input.now().toISOString(),
          durationMs: 0,
          exitCode: null,
          signal: null,
          errorCode: "RUNNER_INTERNAL_ERROR",
          output: null,
        },
        outputStorageKey: null,
      },
    });
    return completed.type === "VERIFICATION_CHECK_COMPLETED" && completed.next === "TERMINAL";
  };

  const notifySettled = (runId: string): void => {
    try {
      input.onSettled?.(runId);
    } catch (error: unknown) {
      input.logger.error(
        { runId, errorName: error instanceof Error ? error.name : "UnknownError" },
        "Verification Run settlement callback failed",
      );
    }
  };

  const run = async (runId: string, authority: ActiveVerificationRun): Promise<boolean> => {
    const registryDirectory = join(input.artifactsDirectory, ".processes");
    for (;;) {
      if (authority.stopRequested) return false;
      const context = input.state.query({ type: "GET_VERIFICATION_RUN_CONTEXT", runId });
      if (context.type !== "VERIFICATION_RUN_CONTEXT") return false;
      if (context.run.status !== "QUEUED" && context.run.status !== "RUNNING") return false;
      const next = context.checks.find((check) => check.status === "QUEUED");
      if (next === undefined) return false;
      await prepareVerificationProcessIntent(registryDirectory, runId);
      let started: Extract<StateCommandResult, { type: "VERIFICATION_CHECK_STARTED" }>;
      try {
        const result = input.state.execute({
          schemaVersion: 1,
          commandId: input.createCommandId(),
          correlationId: `verification-run-${runId}`,
          actor: { type: "SYSTEM", id: "verification-runner" },
          type: "START_VERIFICATION_CHECK",
          payload: {
            runId,
            checkId: next.id,
            expectedRunVersion: context.run.version,
            expectedCheckVersion: next.version,
          },
        });
        if (result.type !== "VERIFICATION_CHECK_STARTED") {
          await removeVerificationProcessRecord(registryDirectory, runId);
          return false;
        }
        started = result;
      } catch (error: unknown) {
        await removeVerificationProcessRecord(registryDirectory, runId);
        throw error;
      }
      const recipe = context.plan.recipes.find((candidate) => candidate.id === next.recipeId);
      if (recipe === undefined) {
        input.logger.error({ runId, checkId: next.id }, "Verification Run lost its recorded recipe");
        const terminal = completeUnexpectedFailure(started.run, started.check.id, started.check.version);
        await removeVerificationProcessRecord(registryDirectory, runId);
        return terminal;
      }
      let execution: VerificationRecipeExecution;
      try {
        const artifactId = input.createArtifactId();
        authority.stopConfirmed = false;
        execution = await executeRecipe({
          recipe,
          worktreePath: context.workspace.worktreePath,
          artifactDirectory: input.artifactsDirectory,
          artifactId,
          expectedTree: context.run.implementationTree,
          processGuard: {
            runId,
            registryDirectory,
          },
          signal: authority.controller.signal,
        });
      } catch (error: unknown) {
        input.logger.error(
          {
            runId,
            checkId: next.id,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Verification recipe runner failed outside its typed boundary",
        );
        authority.stopConfirmed = false;
        return false;
      }
      authority.stopConfirmed =
        execution.observation.status !== "ERROR" ||
        execution.observation.errorCode !== "PROCESS_TERMINATION_FAILED";
      if (!authority.stopConfirmed) {
        await discardUnclaimedArtifact(execution);
        return false;
      }
      if (active.get(runId)?.stopRequested === true) {
        await discardUnclaimedArtifact(execution);
        return false;
      }
      const current = input.state.query({ type: "GET_VERIFICATION_RUN", runId });
      if (current.type !== "VERIFICATION_RUN" || current.run?.status !== "RUNNING") {
        await discardUnclaimedArtifact(execution);
        await removeVerificationProcessRecord(registryDirectory, runId);
        return false;
      }
      try {
        const completed = input.state.execute({
          schemaVersion: 1,
          commandId: input.createCommandId(),
          correlationId: `verification-run-${runId}`,
          actor: { type: "SYSTEM", id: "verification-runner" },
          type: "COMPLETE_VERIFICATION_CHECK",
          payload: {
            runId,
            checkId: started.check.id,
            expectedRunVersion: current.run.version,
            expectedCheckVersion: started.check.version,
            observation: execution.observation,
            outputStorageKey:
              execution.observation.output === null ? null : `${execution.observation.output.artifactId}.txt`,
          },
        });
        await removeVerificationProcessRecord(registryDirectory, runId);
        if (completed.type !== "VERIFICATION_CHECK_COMPLETED") return false;
        if (completed.next === "TERMINAL") return true;
      } catch (error: unknown) {
        await discardUnclaimedArtifact(execution);
        throw error;
      }
    }
  };

  const wake = (runId: string): void => {
    if (active.has(runId)) return;
    const controller = new AbortController();
    const authority: ActiveVerificationRun = {
      controller,
      promise: Promise.resolve(),
      stopRequested: false,
      stopConfirmed: true,
      cancelPromise: null,
    };
    let durableTerminal = false;
    const promise = Promise.resolve()
      .then(() => run(runId, authority))
      .then((terminal) => {
        durableTerminal = terminal;
      })
      .catch((error: unknown) => {
        input.logger.error(
          { runId, errorName: error instanceof Error ? error.name : "UnknownError" },
          "Verification Run stopped unexpectedly",
        );
      })
      .finally(() => {
        if (!authority.stopRequested) active.delete(runId);
        if (durableTerminal) notifySettled(runId);
      });
    authority.promise = promise;
    active.set(runId, authority);
  };

  const cancellationCommand = (request: {
    runId: string;
    expectedVersion: number;
    commandId: string;
    correlationId: string;
  }): CancellationCommand => ({
    schemaVersion: 1,
    commandId: request.commandId,
    correlationId: request.correlationId,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "CANCEL_VERIFICATION_RUN",
    payload: { runId: request.runId, expectedRunVersion: request.expectedVersion },
  });

  const requireCancelledResult = (result: StateCommandResult): CancelledResult => {
    if (result.type !== "VERIFICATION_RUN_INTERRUPTED") {
      throw new Error("Verification cancellation returned an unexpected command result");
    }
    return result;
  };

  const requestOwnerCancellation = (command: CancellationCommand): CancellationRequestedResult => {
    const result = input.state.execute(command);
    if (result.type !== "VERIFICATION_RUN_CANCELLATION_REQUESTED") {
      throw new Error("Verification cancellation request returned an unexpected command result");
    }
    return result;
  };

  const finalizeOwnerCancellation = (
    requested: CancellationRequestedResult,
    ownerCommandId: string,
  ): void => {
    const current = input.state.query({ type: "GET_VERIFICATION_RUN", runId: requested.run.id });
    if (
      current.type === "VERIFICATION_RUN" &&
      current.run?.status === "INTERRUPTED" &&
      current.run.terminalReason === "OWNER_CANCELLED"
    ) {
      return;
    }
    const result = input.state.execute({
      schemaVersion: 1,
      commandId: `finalize-verification-cancel-${createHash("sha256").update(ownerCommandId).digest("hex")}`,
      correlationId: requested.event.correlationId,
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "FINALIZE_VERIFICATION_RUN_CANCELLATION",
      payload: { runId: requested.run.id, expectedRunVersion: requested.run.version },
    });
    requireCancelledResult(result);
  };

  const recoverProcessAuthority = async (run: VerificationRun): Promise<void> => {
    const current = input.state.query({ type: "GET_VERIFICATION_RUN", runId: run.id });
    if (
      current.type === "VERIFICATION_RUN" &&
      current.run?.status === "INTERRUPTED" &&
      current.run.terminalReason === "OWNER_CANCELLED"
    ) {
      return;
    }
    const reports = await recoverVerificationRunProcesses({
      registryDirectory: join(input.artifactsDirectory, ".processes"),
      runIds: [run.id],
      now: input.now,
    });
    const report = reports[0];
    if (
      report === undefined ||
      report.action === "BLOCKED" ||
      (report.action === "NO_RECORD" && run.currentCheckId !== null)
    ) {
      throw new Error("Verification process-tree recovery could not confirm that authority ended");
    }
  };

  const waitForAuthority = async (authority: ActiveVerificationRun): Promise<void> => {
    await authority.promise;
    if (authority.cancelPromise !== null) await authority.cancelPromise;
  };

  return {
    wake,
    cancel: async (request) => {
      const command = cancellationCommand(request);
      const requested = requestOwnerCancellation(command);
      const authority = active.get(request.runId);
      if (authority === undefined) {
        await recoverProcessAuthority(requested.run);
        finalizeOwnerCancellation(requested, command.commandId);
        await removeVerificationProcessRecord(join(input.artifactsDirectory, ".processes"), request.runId);
        notifySettled(request.runId);
        return;
      }
      if (authority.cancelPromise !== null) {
        await authority.cancelPromise;
        return;
      }

      authority.stopRequested = true;
      authority.controller.abort();
      const cancellation = (async (): Promise<void> => {
        await authority.promise;
        if (!authority.stopConfirmed) {
          throw new Error("Verification process-tree termination was not confirmed");
        }
        finalizeOwnerCancellation(requested, command.commandId);
        await removeVerificationProcessRecord(join(input.artifactsDirectory, ".processes"), request.runId);
        active.delete(request.runId);
        notifySettled(request.runId);
      })();
      authority.cancelPromise = cancellation;
      await cancellation;
    },
    whenIdle: async (runId) => {
      if (runId !== undefined) {
        const authority = active.get(runId);
        if (authority !== undefined) await waitForAuthority(authority);
        return;
      }
      await Promise.all([...active.values()].map(waitForAuthority));
    },
    readOutput: async (checkId) => {
      const result = input.state.query({ type: "GET_VERIFICATION_OUTPUT_ARTIFACT", checkId });
      if (result.type !== "VERIFICATION_OUTPUT_ARTIFACT" || result.artifact === null) return null;
      const { storageKey } = result.artifact;
      if (basename(storageKey) !== storageKey) return null;
      const root = await realpath(input.artifactsDirectory).catch(() => null);
      if (root === null) return null;
      const candidate = join(root, storageKey);
      const canonical = await realpath(candidate).catch(() => null);
      if (canonical === null || dirname(canonical) !== root) return null;
      const handle = await open(canonical, "r");
      try {
        const details = await handle.stat();
        if (!details.isFile() || details.size > MAX_OUTPUT_BYTES) return null;
        const buffer = Buffer.alloc(details.size);
        const read = await handle.read(buffer, 0, details.size, 0);
        return buffer.subarray(0, read.bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    },
    stop: async () => {
      const running = [...active.entries()];
      for (const [, authority] of running) {
        authority.stopRequested = true;
        authority.controller.abort();
      }
      await Promise.all(running.map(([, { promise }]) => promise));
      for (const [runId, authority] of running) {
        if (!authority.stopConfirmed) {
          throw new Error(`Verification process-tree termination was not confirmed for ${runId}`);
        }
        const current = input.state.query({ type: "GET_VERIFICATION_RUN", runId });
        if (
          current.type === "VERIFICATION_RUN" &&
          current.run !== null &&
          (current.run.status === "QUEUED" || current.run.status === "RUNNING")
        ) {
          input.state.execute({
            schemaVersion: 1,
            commandId: input.createCommandId(),
            correlationId: `verification-run-${runId}`,
            actor: { type: "SYSTEM", id: "verification-runner" },
            type: "INTERRUPT_VERIFICATION_RUN",
            payload: {
              runId,
              expectedRunVersion: current.run.version,
              reason: "DAEMON_RESTART",
            },
          });
        } else if (current.type === "VERIFICATION_RUN" && current.run?.status === "CANCELLING") {
          input.state.execute({
            schemaVersion: 1,
            commandId: input.createCommandId(),
            correlationId: `verification-run-${runId}`,
            actor: { type: "SYSTEM", id: "verification-runner" },
            type: "FINALIZE_VERIFICATION_RUN_CANCELLATION",
            payload: {
              runId,
              expectedRunVersion: current.run.version,
            },
          });
        }
        await removeVerificationProcessRecord(join(input.artifactsDirectory, ".processes"), runId);
        active.delete(runId);
      }
    },
  };
};
