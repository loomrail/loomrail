import type { ProviderId, WorkflowDispatch, WorkflowStage, WorkflowTemplate } from "@loomrail/contracts";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import type { ProviderAdapter } from "@loomrail/provider-core";
import {
  agentRunClaimLimits,
  planDispatchBatch,
  validateSchedulerLimits,
  type SchedulerLimits,
} from "@loomrail/scheduler";
import type { FastifyBaseLogger } from "fastify";

import { readAgentSchedulingSnapshot } from "./agent-scheduling.js";
import type { BrowserQAStageRunner } from "./browser-qa-runner.js";
import { runStageAttempt, type OpenMcpConnections } from "./session-loop.js";

/**
 * The bound on how many pending dispatches one pass through the queue may hand to `runStageAttempt`
 * before stopping. Moved from `server.ts`'s `drainProviderDispatches` unchanged (spec §12 Q1).
 */
export const DISPATCH_CYCLE_LIMIT = 20;

export type SessionWorker = {
  wake: () => void;
  whenIdle: () => Promise<void>;
  stop: () => Promise<void>;
};

export type SessionWorkerDeps = {
  state: LocalState;
  /** Resolve once per dispatch. The returned instance is captured for that live ProviderSession. */
  resolveAdapter?: (
    projectId: string,
    stage?: WorkflowStage,
    avoidProvider?: ProviderId | null,
  ) => ProviderAdapter;
  /** Compatibility injection for focused worker tests that intentionally exercise one adapter. */
  adapter?: ProviderAdapter;
  template: WorkflowTemplate;
  /** Where a WorkItem's worktree is cut; handed straight to `runStageAttempt` (spec D2). */
  workspacesRoot: string;
  createCommandId: () => string;
  logger: FastifyBaseLogger;
  openMcpConnections?: OpenMcpConnections;
  /** Daemon-owned deterministic baseline. When present, QA never opens a provider session. */
  browserQA?: BrowserQAStageRunner;
  /** Validated once at construction; persistence repeats the resolved limits in every claim. */
  schedulingLimits?: SchedulerLimits;
};

/**
 * Runs the workflow-dispatch queue through one scheduler pump and a bounded AgentRun pool.
 *
 * `wake()` schedules a pass over the pending queue; at most one planner pump runs at a time, while
 * the tasks it selects execute concurrently up to the validated global limit. A wake that arrives
 * mid-pass is honoured immediately after it, never dropped. `stop()` asks every captured live
 * ProviderSession to abort and prevents newly freed slots from being filled.
 */
export const createSessionWorker = (deps: SessionWorkerDeps): SessionWorker => {
  const schedulingLimits = validateSchedulerLimits(deps.schedulingLimits);
  const fixedAdapter = deps.adapter;
  const resolveAdapter =
    deps.resolveAdapter ??
    (fixedAdapter === undefined
      ? (): ProviderAdapter => {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The provider adapter resolver is missing");
        }
      : (): ProviderAdapter => fixedAdapter);
  let running = false;
  let pending = false;
  let stopping = false;
  const liveSessions = new Map<string, { adapter: ProviderAdapter; providerSessionId: string }>();
  type DispatchTaskResult = { dispatchId: string; moved: boolean };
  const activeTasks = new Map<string, Promise<DispatchTaskResult>>();
  const idleWaiters: (() => void)[] = [];

  const settleIdle = (): void => {
    for (const waiter of idleWaiters.splice(0)) waiter();
  };

  const executeDispatch = async (
    dispatch: WorkflowDispatch,
    adapter: ProviderAdapter,
  ): Promise<DispatchTaskResult> => {
    try {
      const snapshotResult = deps.state.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: dispatch.workItemId,
      });
      if (snapshotResult.type !== "WORKFLOW_SNAPSHOT") {
        throw new StateStoreError("PERSISTENCE_FAILURE", "A pending workflow dispatch is incomplete");
      }
      const workflowSnapshot = snapshotResult.snapshot;
      const stageAttempt = workflowSnapshot.stageAttempts.find(({ id }) => id === dispatch.stageAttemptId);
      if (!stageAttempt) {
        throw new StateStoreError("PERSISTENCE_FAILURE", "A pending workflow dispatch is incomplete");
      }

      let agentRunId: string | undefined;

      // A3 reservations replace the old mark-only transition for executable agent stages.
      // ACCEPTANCE remains the owner gate and therefore has no synthetic AgentRun.
      if (stageAttempt.status !== "RUNNING") {
        if (stageAttempt.stage === "ACCEPTANCE") {
          const started = deps.state.execute({
            schemaVersion: 1,
            commandId: `mark-started-${dispatch.id}`,
            correlationId: `dispatch-${dispatch.id}`,
            actor: { type: "SYSTEM", id: "local-daemon" },
            type: "MARK_WORKFLOW_DISPATCH_STARTED",
            payload: { dispatchId: dispatch.id },
          });
          if (started.type !== "WORKFLOW_DISPATCH_STARTED") {
            throw new StateStoreError("PERSISTENCE_FAILURE", "The owner-acceptance dispatch did not start");
          }
        } else {
          const provider = adapter.capabilities().provider;
          const started = deps.state.execute({
            schemaVersion: 1,
            commandId: `start-agent-run-${dispatch.id}`,
            correlationId: `dispatch-${dispatch.id}`,
            actor: { type: "SYSTEM", id: "local-daemon" },
            type: "START_AGENT_RUN",
            payload: {
              dispatchId: dispatch.id,
              provider,
              limits: agentRunClaimLimits(schedulingLimits, dispatch.projectId, provider),
            },
          });
          if (started.type !== "AGENT_RUN_STARTED") {
            throw new StateStoreError("PERSISTENCE_FAILURE", "The AgentRun reservation did not start");
          }
          agentRunId = started.run.id;
        }
      }

      if (stageAttempt.stage === "QA" && deps.browserQA !== undefined) {
        if (agentRunId === undefined) {
          const active = deps.state.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" });
          agentRunId =
            active.type === "AGENT_RUNS"
              ? active.runs.find(({ stageAttemptId }) => stageAttemptId === stageAttempt.id)?.id
              : undefined;
        }
        const testedTree = [...workflowSnapshot.stageAttempts]
          .reverse()
          .find(
            ({ stage, status, resultTree }) =>
              stage === "IMPLEMENT" && status === "SUCCEEDED" && resultTree !== null,
          )?.resultTree;
        if (agentRunId === undefined || testedTree === undefined || testedTree === null) {
          throw new StateStoreError(
            "QA_STABLE_TREE_MISSING",
            "Browser QA requires an active AgentRun and a successful implementation tree",
          );
        }
        await deps.browserQA.run({ dispatch, agentRunId, testedTree });
        return { dispatchId: dispatch.id, moved: true };
      }

      await runStageAttempt({
        state: deps.state,
        adapter,
        dispatch,
        template: deps.template,
        workspacesRoot: deps.workspacesRoot,
        createCommandId: deps.createCommandId,
        correlationId: `dispatch-${dispatch.id}`,
        logger: deps.logger,
        ...(deps.openMcpConnections === undefined ? {} : { openMcpConnections: deps.openMcpConnections }),
        onSessionLive: (providerSessionId) => {
          if (providerSessionId === null) liveSessions.delete(dispatch.id);
          else liveSessions.set(dispatch.id, { adapter, providerSessionId });
        },
      });
    } catch (error: unknown) {
      deps.logger.error(
        { dispatchId: dispatch.id, error: error instanceof Error ? error.name : "unknown" },
        "A background AgentRun could not finish",
      );
    } finally {
      liveSessions.delete(dispatch.id);
    }

    const queued = deps.state.query({ type: "LIST_PENDING_DISPATCHES" });
    const moved =
      queued.type === "WORKFLOW_DISPATCHES" && !queued.dispatches.some(({ id }) => id === dispatch.id);
    return { dispatchId: dispatch.id, moved };
  };

  const runOnce = async (): Promise<void> => {
    const blocked = new Set<string>();
    let progressedSinceRetry = false;

    const consumeOne = async (): Promise<boolean> => {
      const settled = await Promise.race(activeTasks.values());
      activeTasks.delete(settled.dispatchId);
      if (settled.moved) {
        return true;
      }
      blocked.add(settled.dispatchId);
      deps.logger.info(
        { dispatchId: settled.dispatchId },
        "This pending workflow dispatch could not be started yet; the drain moves past it",
      );
      return false;
    };

    let cycle = 0;
    while (cycle < DISPATCH_CYCLE_LIMIT) {
      if (stopping) return;
      const available = Math.max(0, schedulingLimits.global - activeTasks.size);
      if (available > 0) {
        const excludedDispatchIds = new Set([...blocked, ...activeTasks.keys()]);
        const snapshot = readAgentSchedulingSnapshot({
          state: deps.state,
          resolveAdapter,
          excludedDispatchIds,
        });
        const plan = planDispatchBatch({
          candidates: snapshot.candidates,
          activeRuns: snapshot.activeRuns,
          limits: schedulingLimits,
        });
        const selected = plan.selectedDispatchIds.slice(0, available);
        for (const dispatchId of selected) {
          const context = snapshot.contexts.get(dispatchId);
          if (!context) {
            throw new StateStoreError("PERSISTENCE_FAILURE", "A selected dispatch lost its context");
          }
          activeTasks.set(dispatchId, executeDispatch(context.dispatch, context.adapter));
        }
        if (selected.length > 0) {
          cycle += selected.length;
          continue;
        }
      }

      if (activeTasks.size > 0) {
        if (await consumeOne()) progressedSinceRetry = true;
        continue;
      }
      if (progressedSinceRetry && blocked.size > 0) {
        cycle += 1;
        blocked.clear();
        progressedSinceRetry = false;
        continue;
      }
      return;
    }

    while (activeTasks.size > 0) await consumeOne();
    deps.logger.error(
      { limit: DISPATCH_CYCLE_LIMIT },
      "The workflow dispatch queue exceeded its safety limit",
    );
  };

  const pump = async (): Promise<void> => {
    // A wake arriving mid-pass leaves `pending` set; the loop below picks it up rather than starting
    // a second, concurrent attempt.
    if (running) return;
    running = true;
    try {
      while (pending && !stopping) {
        pending = false;
        try {
          await runOnce();
        } catch (error: unknown) {
          // There is no caller to hand a 500 to any more. The durable consequences of a failed
          // session already live on the StageAttempt (A1 spec §6.5), and a throw leaves a bounded
          // state that RECONCILE_WORKFLOWS repairs on the next start.
          deps.logger.error(
            { error: error instanceof Error ? error.name : "unknown" },
            "The background session worker could not finish a pass",
          );
        }
      }
    } finally {
      running = false;
      // The `while` loop above can only exit once `!pending || stopping` already holds -- nothing
      // between that exit and here can change either flag -- so settling here is unconditional
      // rather than re-testing a condition that is always true by construction.
      settleIdle();
    }
  };

  return {
    wake: () => {
      if (stopping) return;
      pending = true;
      // `pump()` cannot reject today -- every path inside it that can throw is already wrapped by
      // the try/catch around `runOnce()`. The catch is here because nothing enforces that: a future
      // edit that moves work outside that try would turn a rejection here into an unhandled promise
      // rejection, which on Node's default settings terminates the daemon rather than logging.
      void pump().catch((error: unknown) => {
        deps.logger.error(
          { error: error instanceof Error ? error.name : "unknown" },
          "The background session worker's pump rejected",
        );
      });
    },
    whenIdle: () =>
      stopping || (!running && !pending && activeTasks.size === 0)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
    stop: async () => {
      stopping = true;
      pending = false;
      // Spec D5: the provider is told to stop, and we do not wait to be told it did. `abortSession`
      // resolving is not proof the run ended -- that gap is the next milestone's, where there will
      // finally be an adapter capable of failing to stop.
      await Promise.all(
        [...liveSessions.values()].map(({ adapter, providerSessionId }) =>
          adapter.abortSession(providerSessionId).catch(() => undefined),
        ),
      );
      settleIdle();
    },
  };
};
