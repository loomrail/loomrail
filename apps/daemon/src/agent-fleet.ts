import {
  agentFleetResponseSchema,
  maxAgentFleetEntries,
  type AgentFleetEntry,
  type AgentFleetResponse,
  type ProviderId,
  type WorkflowStage,
} from "@loomrail/contracts";
import { standardAgentProfileForStage } from "@loomrail/domain";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import type { ProviderAdapter } from "@loomrail/provider-core";
import { planDispatchBatch, type ValidatedSchedulerLimits } from "@loomrail/scheduler";

import { readAgentSchedulingSnapshot } from "./agent-scheduling.js";

const profileRefFor = (
  state: LocalState,
  pipelineRunId: string,
  stage: AgentFleetEntry["stage"],
): AgentFleetEntry["profile"] | null => {
  const result = state.query({ type: "GET_SQUAD_ASSIGNMENT", pipelineRunId });
  const assigned =
    result.type === "SQUAD_ASSIGNMENT"
      ? result.assignment?.stages.find((candidate) => candidate.stage === stage)?.profile
      : undefined;
  if (assigned !== undefined) return assigned;
  const fallback = standardAgentProfileForStage(stage);
  return fallback === null ? null : { id: fallback.id, revision: fallback.revision, role: fallback.role };
};

/** Builds the bounded browser projection from durable state and the same scheduler plan as worker claims. */
export const buildAgentFleet = (input: {
  state: LocalState;
  resolveAdapter: (
    projectId: string,
    stage?: WorkflowStage,
    avoidProvider?: ProviderId | null,
  ) => ProviderAdapter;
  schedulingLimits: ValidatedSchedulerLimits;
}): AgentFleetResponse => {
  const scheduling = readAgentSchedulingSnapshot({
    state: input.state,
    resolveAdapter: input.resolveAdapter,
  });
  const plan = planDispatchBatch({
    candidates: scheduling.candidates,
    activeRuns: scheduling.activeRuns,
    limits: input.schedulingLimits,
  });
  const selected = new Set(plan.selectedDispatchIds);
  const deferrals = new Map(plan.deferred.map(({ dispatchId, reason }) => [dispatchId, reason]));

  const activeResult = input.state.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" });
  const activeRuns = activeResult.type === "AGENT_RUNS" ? activeResult.runs : [];
  const activeStageAttemptIds = new Set(activeRuns.map(({ stageAttemptId }) => stageAttemptId));
  const entries: AgentFleetEntry[] = [];

  for (const run of activeRuns) {
    const projectResult = input.state.query({ type: "GET_PROJECT", projectId: run.projectId });
    const workItemResult = input.state.query({ type: "GET_WORK_ITEM", workItemId: run.workItemId });
    const workflowResult = input.state.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: run.workItemId });
    const project = projectResult.type === "PROJECT" ? projectResult.project : null;
    const workItem = workItemResult.type === "WORK_ITEM" ? workItemResult.workItem : null;
    const stage =
      workflowResult.type === "WORKFLOW_SNAPSHOT"
        ? workflowResult.snapshot.stageAttempts.find(({ id }) => id === run.stageAttemptId)?.stage
        : undefined;
    if (project === null || workItem === null || stage === undefined) {
      throw new StateStoreError("PERSISTENCE_FAILURE", "An active Fleet entry is incomplete");
    }
    entries.push({
      schemaVersion: 1,
      project: { id: project.id, name: project.name },
      workItem: { id: workItem.id, title: workItem.title },
      pipelineRunId: run.pipelineRunId,
      stageAttemptId: run.stageAttemptId,
      dispatchId: null,
      agentRunId: run.id,
      profile: run.profile,
      stage,
      provider: run.provider,
      status: "RUNNING",
      waitReason: null,
      startedAt: run.startedAt,
    });
  }

  for (const candidate of scheduling.candidates) {
    if (activeStageAttemptIds.has(candidate.stageAttemptId)) continue;
    const context = scheduling.contexts.get(candidate.dispatchId);
    if (context === undefined) continue;
    const profile = profileRefFor(input.state, context.dispatch.pipelineRunId, context.attempt.stage);
    if (profile === null) continue;
    const waitReason = deferrals.get(candidate.dispatchId) ?? null;
    entries.push({
      schemaVersion: 1,
      project: { id: context.project.id, name: context.project.name },
      workItem: { id: context.workItem.id, title: context.workItem.title },
      pipelineRunId: context.dispatch.pipelineRunId,
      stageAttemptId: context.dispatch.stageAttemptId,
      dispatchId: context.dispatch.id,
      agentRunId: null,
      profile,
      stage: context.attempt.stage,
      provider: candidate.provider,
      status: selected.has(candidate.dispatchId) ? "READY" : "WAITING",
      waitReason,
      startedAt: null,
    });
  }

  return agentFleetResponseSchema.parse({
    schemaVersion: 1,
    entries: entries.slice(0, maxAgentFleetEntries),
    capacity: { active: activeRuns.length, globalLimit: input.schedulingLimits.global },
  });
};
