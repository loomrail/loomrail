import type {
  HumanRequest,
  PipelineRun,
  StageAttempt,
  VerificationCorrectionRun,
  VerificationFailure,
  VerificationRun,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideInitialFailedVerificationCorrectionTransition,
  decidePassedVerificationCorrectionTransition,
  decideSubsequentFailedVerificationCorrectionTransition,
  decideVerificationCorrectionCancellation,
  decideVerificationCorrectionGateResolution,
} from "../src/verification-correction.js";

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
const correctionRun: VerificationCorrectionRun = {
  schemaVersion: 1,
  id: "verification-correction-one",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: pipelineRun.id,
  budgetPosition: 1,
  automatic: true,
  sourceFailureId: failure.id,
  sourceVerificationRunId: verificationRun.id,
  sourceImplementationTree: verificationRun.implementationTree,
  status: "ACTIVE",
  createdAt: now,
  completedAt: null,
  version: 1,
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
      events: [
        { type: "STAGE_ATTEMPT_CHANGED", data: { previousStatus: "QUEUED" } },
        {
          type: "VERIFICATION_CORRECTION_STARTED",
          data: { correctionRun: { id: "verification-correction-one" } },
        },
      ],
    });
  });

  it("closes only a fresh passing rerun of the active correction and exact approved plan", () => {
    const passingRun: VerificationRun = {
      ...verificationRun,
      id: "verification-run-two",
      implementationTree: "c".repeat(40),
      ordinal: 2,
      retryOfRunId: verificationRun.id,
      verificationCorrectionRunId: correctionRun.id,
      status: "PASSED",
      terminalReason: "ALL_REQUIRED_PASSED",
      version: 4,
    };

    expect(
      decidePassedVerificationCorrectionTransition({
        verificationRun: passingRun,
        sourceVerificationRun: verificationRun,
        sourceFailure: failure,
        correctionRun,
        now,
      }),
    ).toMatchObject({
      correctionRun: { id: correctionRun.id, status: "PASSED", completedAt: now, version: 2 },
      event: {
        type: "VERIFICATION_CORRECTION_PASSED",
        data: { correctionRun: { id: correctionRun.id, status: "PASSED" } },
      },
    });
  });

  it("rejects a passing rerun with a changed plan or unchanged implementation tree", () => {
    const passingRun: VerificationRun = {
      ...verificationRun,
      id: "verification-run-two",
      ordinal: 2,
      retryOfRunId: verificationRun.id,
      verificationCorrectionRunId: correctionRun.id,
      status: "PASSED",
      terminalReason: "ALL_REQUIRED_PASSED",
      version: 4,
    };

    expect(() =>
      decidePassedVerificationCorrectionTransition({
        verificationRun: passingRun,
        sourceVerificationRun: verificationRun,
        sourceFailure: failure,
        correctionRun,
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "LINEAGE_MISMATCH" }));
    expect(() =>
      decidePassedVerificationCorrectionTransition({
        verificationRun: { ...passingRun, implementationTree: "c".repeat(40), planRevision: 2 },
        sourceVerificationRun: verificationRun,
        sourceFailure: failure,
        correctionRun,
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "LINEAGE_MISMATCH" }));
  });

  it("supersedes the active verification correction and starts the second automatic cycle", () => {
    const failedRerun: VerificationRun = {
      ...verificationRun,
      id: "verification-run-two",
      implementationTree: "c".repeat(40),
      ordinal: 2,
      retryOfRunId: verificationRun.id,
      verificationCorrectionRunId: correctionRun.id,
      version: 4,
    };
    const rerunFailure: VerificationFailure = {
      ...failure,
      id: "verification-failure-two",
      verificationRunId: failedRerun.id,
      implementationTree: failedRerun.implementationTree,
    };

    expect(
      decideSubsequentFailedVerificationCorrectionTransition({
        verificationRun: failedRerun,
        failure: rerunFailure,
        correctionRun,
        correctionSourceVerificationRun: verificationRun,
        workItem,
        pipelineRun,
        stageAttempt: { ...stageAttempt, verificationCorrectionRunId: correctionRun.id },
        dispatch,
        budgetUsage: { automaticUsed: 1, totalUsed: 1 },
        ids: {
          correctionRunId: "verification-correction-two",
          nextStageAttemptId: "stage-implement-correction-two",
          nextDispatchId: "dispatch-implement-correction-two",
          humanRequestId: "verification-correction-request",
          authorizeFinalOptionId: "authorize-final-verification-correction",
          cancelOptionId: "cancel-verification-delivery",
        },
        now,
      }),
    ).toMatchObject({
      action: "START_CORRECTION",
      previousCorrection: { id: correctionRun.id, status: "SUPERSEDED", version: 2 },
      correctionRun: { id: "verification-correction-two", budgetPosition: 2, status: "ACTIVE" },
      nextStageAttempt: {
        verificationCorrectionRunId: "verification-correction-two",
        stage: "IMPLEMENT",
      },
      events: [
        { type: "STAGE_ATTEMPT_CHANGED" },
        { type: "VERIFICATION_CORRECTION_SUPERSEDED" },
        { type: "VERIFICATION_CORRECTION_STARTED" },
      ],
    });
  });

  it("opens the owner gate after the two automatic verification corrections are spent", () => {
    const secondCorrection: VerificationCorrectionRun = {
      ...correctionRun,
      id: "verification-correction-two",
      budgetPosition: 2,
    };
    const failedRerun: VerificationRun = {
      ...verificationRun,
      id: "verification-run-three",
      implementationTree: "d".repeat(40),
      ordinal: 3,
      retryOfRunId: "verification-run-two",
      verificationCorrectionRunId: secondCorrection.id,
      version: 4,
    };
    const rerunFailure: VerificationFailure = {
      ...failure,
      id: "verification-failure-three",
      verificationRunId: failedRerun.id,
      implementationTree: failedRerun.implementationTree,
    };

    expect(
      decideSubsequentFailedVerificationCorrectionTransition({
        verificationRun: failedRerun,
        failure: rerunFailure,
        correctionRun: secondCorrection,
        correctionSourceVerificationRun: verificationRun,
        workItem,
        pipelineRun,
        stageAttempt: { ...stageAttempt, verificationCorrectionRunId: secondCorrection.id },
        dispatch,
        budgetUsage: { automaticUsed: 2, totalUsed: 2 },
        ids: {
          correctionRunId: "verification-correction-three",
          nextStageAttemptId: "stage-implement-correction-three",
          nextDispatchId: "dispatch-implement-correction-three",
          humanRequestId: "verification-correction-request",
          authorizeFinalOptionId: "authorize-final-verification-correction",
          cancelOptionId: "cancel-verification-delivery",
        },
        now,
      }),
    ).toMatchObject({
      action: "WAIT_FOR_OWNER",
      previousCorrection: { id: secondCorrection.id, status: "EXHAUSTED", version: 2 },
      correctionRun: null,
      nextStageAttempt: null,
      nextDispatch: null,
      workItem: { state: "BLOCKED", currentStage: "QA" },
      pipelineRun: { status: "WAITING_HUMAN" },
      completedStageAttempt: {
        verificationCorrectionRunId: secondCorrection.id,
        status: "WAITING_HUMAN",
        failureCode: "VERIFICATION_CORRECTION_EXHAUSTED",
      },
      request: { status: "OPEN", options: [{ recommended: true }, { recommended: false }] },
      events: [
        { type: "STAGE_ATTEMPT_CHANGED" },
        { type: "HUMAN_REQUEST_OPENED" },
        { type: "VERIFICATION_CORRECTION_EXHAUSTED", data: { canAuthorizeFinal: true } },
      ],
    });
  });

  it("lets only the owner authorize the third and final Project verification correction", () => {
    const secondCorrection: VerificationCorrectionRun = {
      ...correctionRun,
      id: "verification-correction-two",
      budgetPosition: 2,
      status: "EXHAUSTED",
      version: 2,
    };
    const failedRerun: VerificationRun = {
      ...verificationRun,
      id: "verification-run-three",
      implementationTree: "d".repeat(40),
      ordinal: 3,
      retryOfRunId: "verification-run-two",
      verificationCorrectionRunId: secondCorrection.id,
      version: 4,
    };
    const rerunFailure: VerificationFailure = {
      ...failure,
      id: "verification-failure-three",
      verificationRunId: failedRerun.id,
      implementationTree: failedRerun.implementationTree,
    };
    const waitingStage: StageAttempt = {
      ...stageAttempt,
      verificationCorrectionRunId: secondCorrection.id,
      status: "WAITING_HUMAN",
      failureCode: "VERIFICATION_CORRECTION_EXHAUSTED",
      version: 2,
    };
    const waitingRun: PipelineRun = {
      ...pipelineRun,
      status: "WAITING_HUMAN",
      version: 8,
    };
    const waitingWorkItem: WorkItem = { ...workItem, state: "BLOCKED", version: 5 };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: "verification-correction-request",
      projectId: workItem.projectId,
      workItemId: workItem.id,
      stageAttemptId: waitingStage.id,
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Project verification correction needs a decision",
      context: "Two automatic corrections failed.",
      recommendation: "Inspect evidence before continuing.",
      options: [
        {
          id: "authorize-final-verification-correction",
          label: "Authorize final correction",
          consequence: "Starts correction 3.",
          recommended: true,
        },
        {
          id: "cancel-verification-delivery",
          label: "Cancel delivery",
          consequence: "Stops the run.",
          recommended: false,
        },
      ],
      allowOther: false,
      status: "OPEN",
      version: 1,
      createdAt: now,
      resolvedAt: null,
    };
    const command = {
      schemaVersion: 1 as const,
      commandId: "resolve-verification-correction",
      correlationId: "correlation-one",
      actor: { type: "HUMAN" as const, id: "owner-one" },
      type: "RESOLVE_VERIFICATION_CORRECTION_GATE" as const,
      payload: {
        humanRequestId: request.id,
        expectedRequestVersion: request.version,
        correctionRunId: secondCorrection.id,
        expectedCorrectionVersion: secondCorrection.version,
        expectedPipelineRunVersion: waitingRun.version,
        action: "AUTHORIZE_FINAL" as const,
      },
    };

    const decision = decideVerificationCorrectionGateResolution({
      command,
      workItem: waitingWorkItem,
      run: waitingRun,
      stageAttempt: waitingStage,
      request,
      correctionRun: secondCorrection,
      correctionSourceVerificationRun: verificationRun,
      failedVerificationRun: failedRerun,
      failure: rerunFailure,
      ids: {
        decisionId: "verification-owner-decision",
        correctionRunId: "verification-correction-three",
        nextStageAttemptId: "stage-implement-correction-three",
        dispatchId: "dispatch-implement-correction-three",
      },
      now,
    });

    expect(decision).toMatchObject({
      action: "AUTHORIZE_FINAL",
      request: { status: "RESOLVED", version: 2 },
      previousCorrection: { id: secondCorrection.id, status: "SUPERSEDED", version: 3 },
      correctionRun: {
        id: "verification-correction-three",
        budgetPosition: 3,
        automatic: false,
        sourceFailureId: rerunFailure.id,
        sourceVerificationRunId: failedRerun.id,
        status: "ACTIVE",
      },
      stageAttempt: { status: "SUCCEEDED", failureCode: null },
      nextStageAttempt: {
        id: "stage-implement-correction-three",
        verificationCorrectionRunId: "verification-correction-three",
        stage: "IMPLEMENT",
      },
      run: { status: "RUNNING", currentStageAttemptId: "stage-implement-correction-three" },
      workItem: { state: "IN_PROGRESS", currentStage: "IMPLEMENT" },
      events: [
        { type: "HUMAN_REQUEST_RESOLVED" },
        { type: "VERIFICATION_CORRECTION_SUPERSEDED" },
        { type: "VERIFICATION_CORRECTION_STARTED" },
        { type: "STAGE_ATTEMPT_CHANGED" },
      ],
    });
    expect(() =>
      decideVerificationCorrectionGateResolution({
        command: { ...command, actor: { type: "SYSTEM", id: "daemon" } },
        workItem: waitingWorkItem,
        run: waitingRun,
        stageAttempt: waitingStage,
        request,
        correctionRun: secondCorrection,
        correctionSourceVerificationRun: verificationRun,
        failedVerificationRun: failedRerun,
        failure: rerunFailure,
        ids: {
          decisionId: "verification-owner-decision",
          correctionRunId: "verification-correction-three",
          nextStageAttemptId: "stage-implement-correction-three",
          dispatchId: "dispatch-implement-correction-three",
        },
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "ACTOR_FORBIDDEN" }));
    expect(() =>
      decideVerificationCorrectionGateResolution({
        command: {
          ...command,
          payload: { ...command.payload, expectedCorrectionVersion: secondCorrection.version + 1 },
        },
        workItem: waitingWorkItem,
        run: waitingRun,
        stageAttempt: waitingStage,
        request,
        correctionRun: secondCorrection,
        correctionSourceVerificationRun: verificationRun,
        failedVerificationRun: failedRerun,
        failure: rerunFailure,
        ids: {
          decisionId: "verification-owner-decision",
          correctionRunId: "verification-correction-three",
          nextStageAttemptId: "stage-implement-correction-three",
          dispatchId: "dispatch-implement-correction-three",
        },
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(() =>
      decideVerificationCorrectionGateResolution({
        command,
        workItem: waitingWorkItem,
        run: waitingRun,
        stageAttempt: waitingStage,
        request,
        correctionRun: secondCorrection,
        correctionSourceVerificationRun: verificationRun,
        failedVerificationRun: failedRerun,
        failure: { ...rerunFailure, pipelineRunId: "foreign-pipeline" },
        ids: {
          decisionId: "verification-owner-decision",
          correctionRunId: "verification-correction-three",
          nextStageAttemptId: "stage-implement-correction-three",
          dispatchId: "dispatch-implement-correction-three",
        },
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "LINEAGE_MISMATCH" }));
  });

  it("cancels the delivery from an exhausted Project verification correction gate", () => {
    const finalCorrection: VerificationCorrectionRun = {
      ...correctionRun,
      id: "verification-correction-three",
      budgetPosition: 3,
      automatic: false,
      status: "EXHAUSTED",
      version: 2,
    };
    const failedRerun: VerificationRun = {
      ...verificationRun,
      id: "verification-run-four",
      implementationTree: "e".repeat(40),
      ordinal: 4,
      verificationCorrectionRunId: finalCorrection.id,
      version: 4,
    };
    const rerunFailure: VerificationFailure = {
      ...failure,
      id: "verification-failure-four",
      verificationRunId: failedRerun.id,
      implementationTree: failedRerun.implementationTree,
    };
    const waitingStage: StageAttempt = {
      ...stageAttempt,
      verificationCorrectionRunId: finalCorrection.id,
      status: "WAITING_HUMAN",
      failureCode: "VERIFICATION_CORRECTION_EXHAUSTED",
      version: 2,
    };
    const waitingRun: PipelineRun = { ...pipelineRun, status: "WAITING_HUMAN", version: 8 };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: "verification-correction-request",
      projectId: workItem.projectId,
      workItemId: workItem.id,
      stageAttemptId: waitingStage.id,
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Project verification correction needs a decision",
      context: "Final correction failed.",
      recommendation: "Cancel this delivery.",
      options: [
        {
          id: "cancel-verification-delivery",
          label: "Cancel delivery",
          consequence: "Stops the run.",
          recommended: false,
        },
      ],
      allowOther: false,
      status: "OPEN",
      version: 1,
      createdAt: now,
      resolvedAt: null,
    };

    expect(
      decideVerificationCorrectionGateResolution({
        command: {
          schemaVersion: 1,
          commandId: "cancel-verification-correction",
          correlationId: "correlation-one",
          actor: { type: "HUMAN", id: "owner-one" },
          type: "RESOLVE_VERIFICATION_CORRECTION_GATE",
          payload: {
            humanRequestId: request.id,
            expectedRequestVersion: request.version,
            correctionRunId: finalCorrection.id,
            expectedCorrectionVersion: finalCorrection.version,
            expectedPipelineRunVersion: waitingRun.version,
            action: "CANCEL",
          },
        },
        workItem: { ...workItem, state: "BLOCKED", version: 5 },
        run: waitingRun,
        stageAttempt: waitingStage,
        request,
        correctionRun: finalCorrection,
        correctionSourceVerificationRun: verificationRun,
        failedVerificationRun: failedRerun,
        failure: rerunFailure,
        ids: {
          decisionId: "verification-owner-decision",
          correctionRunId: "unused-correction",
          nextStageAttemptId: "unused-stage",
          dispatchId: "unused-dispatch",
        },
        now,
      }),
    ).toMatchObject({
      action: "CANCEL",
      previousCorrection: { status: "CANCELLED", completedAt: now },
      correctionRun: null,
      run: { status: "CANCELLED", finishedAt: now },
      stageAttempt: { status: "CANCELLED", finishedAt: now },
      workItem: { state: "CANCELLED", currentStage: null },
      events: [
        { type: "HUMAN_REQUEST_RESOLVED" },
        { type: "STAGE_ATTEMPT_CHANGED" },
        { type: "VERIFICATION_CORRECTION_CANCELLED" },
        { type: "PIPELINE_CANCELLED" },
      ],
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

  it("does not turn an interrupted verifier process into an implementation correction", () => {
    expect(() =>
      decideInitialFailedVerificationCorrectionTransition({
        verificationRun: {
          ...verificationRun,
          status: "INTERRUPTED",
          terminalReason: "DAEMON_RESTART",
        },
        failure: {
          ...failure,
          reason: "RUN_INTERRUPTED",
          verificationCheckId: null,
        },
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

  it("closes active correction authority when its PipelineRun is cancelled normally", () => {
    const correctionStage = { ...stageAttempt, verificationCorrectionRunId: correctionRun.id };
    expect(
      decideVerificationCorrectionCancellation({
        correctionRun,
        run: pipelineRun,
        stageAttempt: correctionStage,
        now,
      }),
    ).toMatchObject({
      correctionRun: { id: correctionRun.id, status: "CANCELLED", completedAt: now, version: 2 },
      events: [{ type: "VERIFICATION_CORRECTION_CANCELLED" }],
    });
    expect(() =>
      decideVerificationCorrectionCancellation({
        correctionRun,
        run: pipelineRun,
        stageAttempt: { ...correctionStage, verificationCorrectionRunId: "foreign-correction" },
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "LINEAGE_MISMATCH" }));
  });
});
