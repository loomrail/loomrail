import type {
  Project,
  StageAttempt,
  WorkItem,
  WorkflowDispatch,
  WorkflowSnapshot,
} from "@loomrail/contracts";
import { stageWritesInWorkspace } from "@loomrail/domain";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import type { ProviderAdapter } from "@loomrail/provider-core";
import type { ActiveAgentRun, SchedulerCandidate, SchedulerWorkspaceClaim } from "@loomrail/scheduler";

export type SchedulingCandidateContext = {
  dispatch: WorkflowDispatch;
  adapter: ProviderAdapter;
  project: Project;
  workItem: WorkItem;
  attempt: StageAttempt;
};

export type AgentSchedulingSnapshot = {
  candidates: SchedulerCandidate[];
  activeRuns: ActiveAgentRun[];
  contexts: Map<string, SchedulingCandidateContext>;
};

const latestCheckpoint = (snapshot: WorkflowSnapshot): string | null =>
  [...snapshot.stageAttempts].reverse().find(({ resultTree }) => resultTree !== null)?.resultTree ?? null;

const workspaceClaim = (
  state: LocalState,
  workItemId: string,
  stage: StageAttempt["stage"],
  checkpoint: string | null,
): SchedulerWorkspaceClaim => {
  const result = state.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
  const workspace = result.type === "WORKSPACE" ? result.workspace : null;
  if (workspace === null) return { type: "NONE" };
  return {
    type: "WORKSPACE",
    workspaceId: workspace.id,
    access: stageWritesInWorkspace(stage) ? "READ_WRITE" : "READ_ONLY",
    checkpoint,
  };
};

/**
 * Reads one bounded, durable scheduler view. The planner remains advisory; this function only
 * assembles validated state and captures the exact adapter instance a selected dispatch will use.
 */
export const readAgentSchedulingSnapshot = (input: {
  state: LocalState;
  resolveAdapter: (projectId: string) => ProviderAdapter;
  excludedDispatchIds?: ReadonlySet<string>;
}): AgentSchedulingSnapshot => {
  const queued = input.state.query({ type: "LIST_PENDING_DISPATCHES" });
  const dispatches = queued.type === "WORKFLOW_DISPATCHES" ? queued.dispatches : [];
  const contexts = new Map<string, SchedulingCandidateContext>();
  const candidates: SchedulerCandidate[] = [];

  for (const dispatch of dispatches) {
    if (input.excludedDispatchIds?.has(dispatch.id) === true) continue;
    const snapshotResult = input.state.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: dispatch.workItemId,
    });
    const workItemResult = input.state.query({ type: "GET_WORK_ITEM", workItemId: dispatch.workItemId });
    const projectResult = input.state.query({ type: "GET_PROJECT", projectId: dispatch.projectId });
    const snapshot = snapshotResult.type === "WORKFLOW_SNAPSHOT" ? snapshotResult.snapshot : null;
    const attempt = snapshot?.stageAttempts.find(({ id }) => id === dispatch.stageAttemptId);
    const workItem = workItemResult.type === "WORK_ITEM" ? workItemResult.workItem : null;
    const project = projectResult.type === "PROJECT" ? projectResult.project : null;
    if (snapshot === null || attempt === undefined || workItem === null || project === null) {
      throw new StateStoreError("PERSISTENCE_FAILURE", "A scheduler candidate is incomplete");
    }
    const adapter = input.resolveAdapter(dispatch.projectId);
    contexts.set(dispatch.id, { dispatch, adapter, project, workItem, attempt });
    candidates.push({
      dispatchId: dispatch.id,
      stageAttemptId: dispatch.stageAttemptId,
      projectId: dispatch.projectId,
      provider: adapter.capabilities().provider,
      priority: workItem.priority,
      createdAt: dispatch.createdAt,
      ready: attempt.status === "QUEUED" || attempt.status === "RUNNING",
      budgetAllowed: snapshot.run?.status === "RUNNING",
      requiresStableCheckpoint: attempt.stage === "REVIEW" || attempt.stage === "QA",
      workspace: workspaceClaim(input.state, dispatch.workItemId, attempt.stage, latestCheckpoint(snapshot)),
    });
  }

  const activeResult = input.state.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" });
  const activeRuns: ActiveAgentRun[] =
    activeResult.type === "AGENT_RUNS"
      ? activeResult.runs.map((run) => {
          const snapshotResult = input.state.query({
            type: "GET_WORKFLOW_SNAPSHOT",
            workItemId: run.workItemId,
          });
          const snapshot = snapshotResult.type === "WORKFLOW_SNAPSHOT" ? snapshotResult.snapshot : null;
          const attempt = snapshot?.stageAttempts.find(({ id }) => id === run.stageAttemptId);
          if (snapshot === null || attempt === undefined) {
            throw new StateStoreError("PERSISTENCE_FAILURE", "An active AgentRun is incomplete");
          }
          return {
            agentRunId: run.id,
            stageAttemptId: run.stageAttemptId,
            projectId: run.projectId,
            provider: run.provider,
            workspace: workspaceClaim(input.state, run.workItemId, attempt.stage, latestCheckpoint(snapshot)),
          };
        })
      : [];

  return { candidates, activeRuns, contexts };
};
