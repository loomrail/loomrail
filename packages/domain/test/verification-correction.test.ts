import type {
  PipelineRun,
  StageAttempt,
  VerificationFailure,
  VerificationRun,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { decideInitialFailedVerificationCorrectionTransition } from "../src/verification-correction.js";

const now = "2026-09-05T13:00:00.000Z";
const tree = "a".repeat(40);
const workItem: WorkItem = {
  schemaVersion: 1,
  id: "work-item-one",
  projectId: "project-one",
  parentId: null,
  type: "TASK",
  title: "Fix measured checks",
  description: "",
  state: "IN_PROGRESS",
  currentStage: "QA",
  priority: "MEDIUM",
  risk: "LOW",
  acceptanceCriteria: [],
  version: 4,
  createdAt: now,
  updatedAt: now,
};
const stageAttempt: StageAttempt = {
  schemaVersion: 1,
  id: "stage-qa-one",
  pipelineRunId: "pipeline-one",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  correctionRunId: null,
  stage: "QA",
  attempt: 1,
  status: "QUEUED",
  version: 1,
  startedAt: null,
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  packShareBackoffs: 0,
  resultTree: null,
};
const pipelineRun: PipelineRun = {
  schemaVersion: 1,
  id: stageAttempt.pipelineRunId,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  workflowTemplateId: "delivery-v1",
  workflowVersion: 1,
  status: "RUNNING",
  currentStageAttemptId: stageAttempt.id,
  version: 7,
  createdAt: now,
  updatedAt: now,
  finishedAt: null,
};
const dispatch: WorkflowDispatch = {
  schemaVersion: 1,
  id: "dispatch-qa-one",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: pipelineRun.id,
  stageAttemptId: stageAttempt.id,
  mode: "START",
  status: "PENDING",
  createdAt: now,
  completedAt: null,
};
const verificationRun: VerificationRun = {
  schemaVersion: 1,
  id: "verification-run-one",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: pipelineRun.id,
  workspaceId: "workspace-one",
  planId: "verification-plan-one",
  planRevision: 1,
  planContentHash: "b".repeat(64),
  implementationTree: tree,
  ordinal: 1,
  retryOfRunId: null,
  platform: "darwin",
  status: "FAILED",
  currentCheckId: null,
  terminalReason: "REQUIRED_CHECK_FAILED",
  startedAt: now,
  completedAt: now,
  createdAt: now,
  version: 3,
};
const failure: VerificationFailure = {
  schemaVersion: 1,
  id: "verification-failure-one",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: pipelineRun.id,
  verificationRunId: verificationRun.id,
  verificationCheckId: "verification-check-one",
  planId: verificationRun.planId,
  planRevision: verificationRun.planRevision,
  planContentHash: verificationRun.planContentHash,
  implementationTree: tree,
  reason: "REQUIRED_CHECK_FAILED",
  staleReasons: [],
  createdAt: now,
};

describe("Project verification correction transition", () => {
  it("starts a distinct automatic correction and returns the pending QA stage to IMPLEMENT", () => {
    const decision = decideInitialFailedVerificationCorrectionTransition({
      verificationRun,
      failure,
      workItem,
      pipelineRun,
      stageAttempt,
      dispatch,
      budgetUsage: { automaticUsed: 0, totalUsed: 0 },
      ids: {
        correctionRunId: "verification-correction-one",
        nextStageAttemptId: "stage-implement-correction-one",
        nextDispatchId: "dispatch-implement-correction-one",
      },
      now,
    });

    expect(decision).toMatchObject({
      action: "START_CORRECTION",
      correctionRun: {
        id: "verification-correction-one",
        budgetPosition: 1,
        automatic: true,
        sourceFailureId: failure.id,
        status: "ACTIVE",
      },
      completedStageAttempt: { id: stageAttempt.id, status: "SUCCEEDED", resultTree: tree },
      completedDispatch: { id: dispatch.id, status: "COMPLETED" },
      nextStageAttempt: {
        id: "stage-implement-correction-one",
        stage: "IMPLEMENT",
        correctionRunId: null,
        verificationCorrectionRunId: "verification-correction-one",
        status: "QUEUED",
      },
      nextDispatch: { id: "dispatch-implement-correction-one", status: "PENDING" },
      workItem: { currentStage: "IMPLEMENT", state: "IN_PROGRESS" },
    });
  });

  it("rejects foreign failure lineage before creating correction authority", () => {
    expect(() =>
      decideInitialFailedVerificationCorrectionTransition({
        verificationRun,
        failure: { ...failure, verificationRunId: "foreign-run" },
        workItem,
        pipelineRun,
        stageAttempt,
        dispatch,
        budgetUsage: { automaticUsed: 0, totalUsed: 0 },
        ids: {
          correctionRunId: "verification-correction-one",
          nextStageAttemptId: "stage-implement-correction-one",
          nextDispatchId: "dispatch-implement-correction-one",
        },
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "LINEAGE_MISMATCH" }));
  });
});
