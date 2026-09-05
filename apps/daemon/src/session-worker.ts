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
import type { ProjectVerificationWorkflowGate } from "./project-verification-gate.js";
import { runStageAttempt, type OpenMcpConnections } from "./session-loop.js";

/**
 * The bound on how many pending dispatches one pass through the queue may hand to `runStageAttempt`
 * before stopping. Moved from `server.ts`'s `drainProviderDispatches` unchanged (spec §12 Q1).
 */
export const DISPATCH_CYCLE_LIMIT = 20;

export type SessionWorker = {
  wake: () => void;
  /** Revoke only work that has not opened a ProviderSession; a live Soft Pause turn keeps running. */
  pausePipeline: (pipelineRunId: string) => void;
  /** Revoke provider start authority and resolve only after every registered child has stopped. */
  revokePipeline: (pipelineRunId: string) => Promise<readonly string[]>;
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
  /** Runs an adopted Project verification Plan before Browser QA receives execution authority. */
  projectVerification?: ProjectVerificationWorkflowGate;
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
  const activeExecutions = new Map<
    string,
    {
      adapter: ProviderAdapter;
      providerSessionId: string | null;
      pipelineRunId: string;
      authority: AbortController;
    }
  >();
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
    const authority = new AbortController();
    const execution = {
      adapter,
      providerSessionId: null as string | null,
      pipelineRunId: dispatch.pipelineRunId,
      authority,
    };
    activeExecutions.set(dispatch.id, execution);
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

      const testedTree =
        stageAttempt.stage === "QA" && deps.browserQA !== undefined
          ? [...workflowSnapshot.stageAttempts]
              .reverse()
              .find(
                ({ stage, status, resultTree }) =>
                  stage === "IMPLEMENT" && status === "SUCCEEDED" && resultTree !== null,
              )?.resultTree
          : undefined;
      if (stageAttempt.stage === "QA" && deps.browserQA !== undefined) {
        if (testedTree === undefined || testedTree === null) {
          throw new StateStoreError(
            "QA_STABLE_TREE_MISSING",
            "Browser QA requires a successful implementation tree",
          );
        }
        if (deps.projectVerification !== undefined) {
          const gate = await deps.projectVerification.beforeBrowserQA({ dispatch, testedTree });
          if (gate.status === "BLOCKED") {
            deps.logger.info(
              { dispatchId: dispatch.id, blocker: gate.blocker },
              "Browser QA is waiting for Project verification",
            );
            return { dispatchId: dispatch.id, moved: false };
          }
        }
      }

      let agentRunId: string;

      // Every provider invocation is owned by one immutable AgentRun. ACCEPTANCE is preparation
      // by the bounded Acceptance Manager; the separate owner-only package decision remains a
      // domain gate after that run finishes.
      if (stageAttempt.status !== "RUNNING") {
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
            modelMapping: adapter.modelMapping?.() ?? null,
            limits: agentRunClaimLimits(schedulingLimits, dispatch.projectId, provider),
          },
        });
        if (started.type !== "AGENT_RUN_STARTED") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The AgentRun reservation did not start");
        }
        agentRunId = started.run.id;
      } else {
        const active = deps.state.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" });
        const activeAgentRunId =
          active.type === "AGENT_RUNS"
            ? active.runs.find(({ stageAttemptId }) => stageAttemptId === stageAttempt.id)?.id
            : undefined;
        if (activeAgentRunId === undefined) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "A running executable StageAttempt has no active AgentRun authority",
          );
        }
        agentRunId = activeAgentRunId;
      }

      if (stageAttempt.stage === "QA" && deps.browserQA !== undefined) {
        if (testedTree === undefined || testedTree === null) {
          throw new StateStoreError(
            "QA_STABLE_TREE_MISSING",
            "Browser QA requires an active AgentRun and a successful implementation tree",
          );
        }
        const agentRunResult = deps.state.query({ type: "GET_AGENT_RUN", agentRunId });
        const policy = agentRunResult.type === "AGENT_RUNS" ? agentRunResult.runs[0]?.policySnapshot : null;
        if (!policy?.effectiveCapabilities.includes("BROWSER_READ")) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "Browser QA is not permitted by the active AgentRun policy snapshot",
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
        authoritySignal: authority.signal,
        ...(deps.openMcpConnections === undefined ? {} : { openMcpConnections: deps.openMcpConnections }),
        onSessionLive: (providerSessionId) => {
          execution.providerSessionId = providerSessionId;
        },
      });
    } catch (error: unknown) {
      deps.logger.error(
        { dispatchId: dispatch.id, error: error instanceof Error ? error.name : "unknown" },
        "A background AgentRun could not finish",
      );
    } finally {
      activeExecutions.delete(dispatch.id);
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
    pausePipeline: (pipelineRunId) => {
      for (const execution of activeExecutions.values()) {
        if (execution.pipelineRunId !== pipelineRunId || execution.providerSessionId !== null) continue;
        // The state transaction found no live ProviderSession and already closed any pre-claim
        // AgentRun. Prevent its stale async preparation from claiming the run created by Resume.
        execution.authority.abort();
      }
    },
    revokePipeline: async (pipelineRunId) => {
      // Snapshot every mutable field before the first await. `onSessionLive(null)` can clear the
      // execution record as the revoked start settles, but the session id whose adapter stop we
      // just requested remains the proof the cancellation boundary needs to finalize durable state.
      const matching = [...activeExecutions.values()]
        .filter(({ pipelineRunId: livePipelineRunId }) => livePipelineRunId === pipelineRunId)
        .map(({ adapter, providerSessionId, authority }) => ({ adapter, providerSessionId, authority }));
      for (const { authority } of matching) {
        // Synchronous first: adapters check this signal immediately before spawn. If a child was
        // already registered, abortSession owns the other side of the same race.
        authority.abort();
      }
      // A cancellation must not make the durable writer lease available until every adapter has
      // confirmed its registered child exited. Rejections propagate so the control command keeps
      // the lease and active state fail-closed rather than claiming a stop that was not proven.
      await Promise.all(
        matching.flatMap(({ adapter, providerSessionId }) =>
          providerSessionId === null ? [] : [adapter.abortSession(providerSessionId)],
        ),
      );
      return matching.flatMap(({ providerSessionId }) =>
        providerSessionId === null ? [] : [providerSessionId],
      );
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
      // Shutdown uses the same adapter boundary as cancellation. Built-in process adapters resolve
      // only after the registered child exits; errors are suppressed here because shutdown is
      // already terminal and startup reconciliation owns any remaining durable RUNNING rows.
      for (const { authority } of activeExecutions.values()) authority.abort();
      await Promise.all(
        [...activeExecutions.values()].flatMap(({ adapter, providerSessionId }) =>
          providerSessionId === null ? [] : [adapter.abortSession(providerSessionId).catch(() => undefined)],
        ),
      );
      settleIdle();
    },
  };
};
