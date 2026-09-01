import { join } from "node:path";

import type { WorkflowDispatch, WorkflowSnapshot } from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";

// Shared by `session.integration.test.ts` and `session-worker.integration.test.ts` -- both need the
// same fixture project, a queued attempt seeded from it, and the two read helpers, and pasting a
// second copy in the newer file would let the two drift.

export type SeededAttempt = {
  workItemId: string;
  stageAttemptId: string;
  dispatch: WorkflowDispatch;
};

export const FIXTURE_PROJECT_ID = "project-web";

/**
 * Registers the shared fixture project, once per `LocalState`. Idempotent: a worker test seeds more
 * than one queued attempt against the same open database in a single test, and the persistence layer
 * treats a second `REGISTER_PROJECT` for the same id as `PROJECT_ALREADY_REGISTERED`, not as
 * a no-op.
 */
const registerProject = (
  localState: LocalState,
  createCommandId: () => string,
  temporaryDirectory: string,
  projectId: string,
): void => {
  const existing = localState.query({ type: "LIST_PROJECTS" });
  if (existing.type === "PROJECTS" && existing.projects.some(({ id }) => id === projectId)) {
    return;
  }
  localState.execute({
    schemaVersion: 1,
    commandId: createCommandId(),
    correlationId: "correlation-seed-project",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "REGISTER_PROJECT",
    payload: {
      id: projectId,
      fixtureId: projectId === FIXTURE_PROJECT_ID ? "web-app-a" : null,
      name: projectId === FIXTURE_PROJECT_ID ? "Web fixture" : `Fixture ${projectId}`,
      repositoryPath: join(temporaryDirectory, projectId),
    },
  });
};

// A WorkItem in READY with no pipeline, and so no dispatch: a daemon can boot on this with its
// startup drain finding nothing, which is what lets a test choose when the first drain runs.
const seedReadyWorkItem = (
  localState: LocalState,
  createCommandId: () => string,
  projectId: string,
  title = "Carry a stage attempt across provider sessions",
): string => {
  const created = localState.execute({
    schemaVersion: 1,
    commandId: createCommandId(),
    correlationId: "correlation-seed-item",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "CREATE_WORK_ITEM",
    payload: {
      projectId,
      parentId: null,
      type: "TASK",
      title,
      description: "Synthetic fixture work for the session loop.",
      priority: "MEDIUM",
      risk: "LOW",
      acceptanceCriteria: ["The attempt survives a context handoff"],
    },
  });
  if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected a WorkItem");
  localState.execute({
    schemaVersion: 1,
    commandId: createCommandId(),
    correlationId: "correlation-seed-ready",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "MOVE_WORK_ITEM",
    payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
  });
  return created.workItem.id;
};

export const seedQueuedAttempt = (
  localState: LocalState,
  createCommandId: () => string,
  temporaryDirectory: string,
  projectId = FIXTURE_PROJECT_ID,
): SeededAttempt => {
  registerProject(localState, createCommandId, temporaryDirectory, projectId);
  const workItemId = seedReadyWorkItem(localState, createCommandId, projectId);
  const started = localState.execute({
    schemaVersion: 1,
    commandId: createCommandId(),
    correlationId: "correlation-seed-pipeline",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "START_MOCK_PIPELINE",
    payload: {
      workItemId,
      expectedVersion: 2,
      template: mockDeliveryTemplate,
      budget: { maxEstimatedTokens: 100_000, warningThresholds: [0.5, 0.8, 0.95] },
    },
  });
  if (started.type !== "PIPELINE_STARTED") throw new Error("Expected a started pipeline");
  return {
    workItemId,
    stageAttemptId: started.stageAttempt.id,
    dispatch: started.dispatch,
  };
};

export const pendingDispatchModes = (localState: LocalState): string[] => {
  const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
  if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatches");
  return pending.dispatches.map(({ mode }) => mode);
};

export const snapshotOf = (localState: LocalState, workItemId: string): WorkflowSnapshot => {
  const result = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
  if (result.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected a workflow snapshot");
  return result.snapshot;
};
