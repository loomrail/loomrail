import { open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { StateCommand, StateCommandResult, VerificationRun } from "@loomrail/contracts";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import {
  executeVerificationRecipe,
  type ExecuteVerificationRecipeInput,
  type VerificationRecipeExecution,
} from "@loomrail/project-readiness";

const MAX_OUTPUT_BYTES = 262_144;

type VerificationLogger = {
  error: (fields: Record<string, unknown>, message: string) => void;
};

type CancelledResult = Extract<StateCommandResult, { type: "VERIFICATION_RUN_INTERRUPTED" }>;
type CancellationCommand = Extract<StateCommand, { type: "CANCEL_VERIFICATION_RUN" }>;

type ActiveVerificationRun = {
  controller: AbortController;
  promise: Promise<void>;
  stopRequested: boolean;
  stopConfirmed: boolean;
  cancelCommand: CancellationCommand | null;
  cancelPromise: Promise<CancelledResult> | null;
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
  }) => Promise<CancelledResult>;
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
}): ProjectVerificationRunner => {
  const active = new Map<string, ActiveVerificationRun>();
  const executeRecipe = input.executeRecipe ?? executeVerificationRecipe;

  const discardUnclaimedArtifact = async (execution: VerificationRecipeExecution): Promise<void> => {
    if (execution.artifactPath !== null)
      await rm(execution.artifactPath, { force: true }).catch(() => undefined);
  };

  const completeUnexpectedFailure = (run: VerificationRun, checkId: string, checkVersion: number): void => {
    input.state.execute({
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
  };

  const run = async (runId: string, authority: ActiveVerificationRun): Promise<void> => {
    for (;;) {
      if (authority.stopRequested) return;
      const context = input.state.query({ type: "GET_VERIFICATION_RUN_CONTEXT", runId });
      if (context.type !== "VERIFICATION_RUN_CONTEXT") return;
      if (context.run.status !== "QUEUED" && context.run.status !== "RUNNING") return;
      const next = context.checks.find((check) => check.status === "QUEUED");
      if (next === undefined) return;
      const started = input.state.execute({
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
      if (started.type !== "VERIFICATION_CHECK_STARTED") return;
      const recipe = context.plan.recipes.find((candidate) => candidate.id === next.recipeId);
      if (recipe === undefined) {
        input.logger.error({ runId, checkId: next.id }, "Verification Run lost its recorded recipe");
        completeUnexpectedFailure(started.run, started.check.id, started.check.version);
        return;
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
        const current = input.state.query({ type: "GET_VERIFICATION_RUN", runId });
        if (current.type === "VERIFICATION_RUN" && current.run?.status === "RUNNING") {
          completeUnexpectedFailure(current.run, started.check.id, started.check.version);
        }
        return;
      }
      authority.stopConfirmed =
        execution.observation.status !== "ERROR" ||
        execution.observation.errorCode !== "PROCESS_TERMINATION_FAILED";
      if (active.get(runId)?.stopRequested === true) {
        await discardUnclaimedArtifact(execution);
        return;
      }
      const current = input.state.query({ type: "GET_VERIFICATION_RUN", runId });
      if (current.type !== "VERIFICATION_RUN" || current.run?.status !== "RUNNING") {
        await discardUnclaimedArtifact(execution);
        return;
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
        if (completed.type !== "VERIFICATION_CHECK_COMPLETED" || completed.next === "TERMINAL") return;
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
      cancelCommand: null,
      cancelPromise: null,
    };
    const promise = Promise.resolve()
      .then(() => run(runId, authority))
      .catch((error: unknown) => {
        input.logger.error(
          { runId, errorName: error instanceof Error ? error.name : "UnknownError" },
          "Verification Run stopped unexpectedly",
        );
      })
      .finally(() => {
        if (!authority.stopRequested) active.delete(runId);
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

  const applyOwnerCancellation = (command: CancellationCommand): CancelledResult => {
    const result = input.state.execute(command);
    return requireCancelledResult(result);
  };

  const inspectOwnerCancellation = (command: CancellationCommand): CancelledResult | null => {
    const replayed = input.state.inspectCommandReceipt(command);
    return replayed === null ? null : requireCancelledResult(replayed);
  };

  return {
    wake,
    cancel: async (request) => {
      const command = cancellationCommand(request);
      const authority = active.get(request.runId);
      if (authority === undefined) return applyOwnerCancellation(command);
      if (authority.cancelPromise !== null) {
        if (authority.cancelCommand?.commandId === request.commandId) {
          if (
            authority.cancelCommand.payload.runId !== command.payload.runId ||
            authority.cancelCommand.payload.expectedRunVersion !== command.payload.expectedRunVersion
          ) {
            throw new StateStoreError(
              "COMMAND_ID_REUSED",
              "The command ID was already used for different input",
            );
          }
          return await authority.cancelPromise;
        }
        await authority.cancelPromise;
        return applyOwnerCancellation(command);
      }
      const replayed = inspectOwnerCancellation(command);
      if (replayed !== null) return replayed;
      const current = input.state.query({ type: "GET_VERIFICATION_RUN", runId: request.runId });
      const run = current.type === "VERIFICATION_RUN" ? current.run : null;
      if (run?.version !== request.expectedVersion || (run.status !== "QUEUED" && run.status !== "RUNNING")) {
        return applyOwnerCancellation(command);
      }

      authority.stopRequested = true;
      authority.cancelCommand = command;
      authority.controller.abort();
      const cancellation = (async (): Promise<CancelledResult> => {
        await authority.promise;
        if (!authority.stopConfirmed) {
          throw new Error("Verification process-tree termination was not confirmed");
        }
        const result = applyOwnerCancellation(command);
        active.delete(request.runId);
        return result;
      })();
      authority.cancelPromise = cancellation;
      return await cancellation;
    },
    whenIdle: async (runId) => {
      if (runId !== undefined) {
        await active.get(runId)?.promise;
        return;
      }
      await Promise.all([...active.values()].map(({ promise }) => promise));
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
        }
        active.delete(runId);
      }
    },
  };
};
