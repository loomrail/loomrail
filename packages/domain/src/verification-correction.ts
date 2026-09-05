import {
  verificationCorrectionRunSchema,
  verificationFailureSchema,
  verificationRunSchema,
  type PipelineRun,
  type StageAttempt,
  type VerificationCorrectionRun,
  type VerificationCorrectionPassedEvent,
  type VerificationCorrectionStartedEvent,
  type VerificationFailure,
  type VerificationRun,
  type WorkItem,
  type WorkflowDispatch,
} from "@loomrail/contracts";

import { decideCorrectionBudget } from "./correction-budget.js";

export type VerificationCorrectionErrorCode = "LINEAGE_MISMATCH" | "BUDGET_UNAVAILABLE";

export class VerificationCorrectionError extends Error {
  readonly code: VerificationCorrectionErrorCode;

  constructor(code: VerificationCorrectionErrorCode, message: string) {
    super(message);
    this.name = "VerificationCorrectionError";
    this.code = code;
  }
}

export type StartedVerificationCorrectionTransition = {
  action: "START_CORRECTION";
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  completedStageAttempt: StageAttempt;
  completedDispatch: WorkflowDispatch;
  correctionRun: VerificationCorrectionRun;
  nextStageAttempt: StageAttempt;
  nextDispatch: WorkflowDispatch;
  events: readonly (
    | Pick<VerificationCorrectionStartedEvent, "type" | "data">
    | {
        type: "STAGE_ATTEMPT_CHANGED";
        data: { run: PipelineRun; stageAttempt: StageAttempt; previousStatus: StageAttempt["status"] };
      }
  )[];
};

export type PassedVerificationCorrectionTransition = {
  correctionRun: VerificationCorrectionRun;
  event: Pick<VerificationCorrectionPassedEvent, "type" | "data">;
};

/** Starts one automatic fix cycle from daemon-measured Project verification evidence. */
export const decideInitialFailedVerificationCorrectionTransition = (input: {
  verificationRun: VerificationRun;
  failure: VerificationFailure;
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  budgetUsage: { automaticUsed: number; totalUsed: number };
  ids: { correctionRunId: string; nextStageAttemptId: string; nextDispatchId: string };
  now: string;
}): StartedVerificationCorrectionTransition => {
  const verificationRun = verificationRunSchema.parse(input.verificationRun);
  const failure = verificationFailureSchema.parse(input.failure);
  if (verificationRun.status !== "FAILED" && verificationRun.status !== "ERROR") {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "Only a terminal non-passing Project verification Run can start correction",
    );
  }
  if (
    failure.verificationRunId !== verificationRun.id ||
    failure.projectId !== verificationRun.projectId ||
    failure.workItemId !== verificationRun.workItemId ||
    failure.pipelineRunId !== verificationRun.pipelineRunId ||
    failure.planId !== verificationRun.planId ||
    failure.planRevision !== verificationRun.planRevision ||
    failure.planContentHash !== verificationRun.planContentHash ||
    failure.implementationTree !== verificationRun.implementationTree ||
    input.workItem.id !== verificationRun.workItemId ||
    input.workItem.projectId !== verificationRun.projectId ||
    input.workItem.state !== "IN_PROGRESS" ||
    input.workItem.currentStage !== "QA" ||
    input.pipelineRun.id !== verificationRun.pipelineRunId ||
    input.pipelineRun.projectId !== verificationRun.projectId ||
    input.pipelineRun.workItemId !== verificationRun.workItemId ||
    input.pipelineRun.status !== "RUNNING" ||
    input.pipelineRun.currentStageAttemptId !== input.stageAttempt.id ||
    input.stageAttempt.projectId !== verificationRun.projectId ||
    input.stageAttempt.workItemId !== verificationRun.workItemId ||
    input.stageAttempt.pipelineRunId !== verificationRun.pipelineRunId ||
    input.stageAttempt.stage !== "QA" ||
    input.stageAttempt.status !== "QUEUED" ||
    input.stageAttempt.correctionRunId !== null ||
    (input.stageAttempt.verificationCorrectionRunId ?? null) !== null ||
    (verificationRun.verificationCorrectionRunId ?? null) !== null ||
    input.dispatch.projectId !== verificationRun.projectId ||
    input.dispatch.workItemId !== verificationRun.workItemId ||
    input.dispatch.pipelineRunId !== verificationRun.pipelineRunId ||
    input.dispatch.stageAttemptId !== input.stageAttempt.id ||
    input.dispatch.status !== "PENDING"
  ) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The verification failure is not the current measured QA gate of this delivery",
    );
  }
  const budget = decideCorrectionBudget(input.budgetUsage);
  if (budget.action !== "START_AUTOMATIC") {
    throw new VerificationCorrectionError(
      "BUDGET_UNAVAILABLE",
      "The delivery correction budget requires an owner decision",
    );
  }
  const correctionRun = verificationCorrectionRunSchema.parse({
    schemaVersion: 1,
    id: input.ids.correctionRunId,
    projectId: verificationRun.projectId,
    workItemId: verificationRun.workItemId,
    pipelineRunId: verificationRun.pipelineRunId,
    budgetPosition: budget.position,
    automatic: true,
    sourceFailureId: failure.id,
    sourceVerificationRunId: verificationRun.id,
    sourceImplementationTree: verificationRun.implementationTree,
    status: "ACTIVE",
    createdAt: input.now,
    completedAt: null,
    version: 1,
  });
  const completedStageAttempt: StageAttempt = {
    ...input.stageAttempt,
    status: "SUCCEEDED",
    version: input.stageAttempt.version + 1,
    finishedAt: input.now,
    resultTree: verificationRun.implementationTree,
  };
  const completedDispatch: WorkflowDispatch = {
    ...input.dispatch,
    status: "COMPLETED",
    completedAt: input.now,
  };
  const nextStageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: input.ids.nextStageAttemptId,
    pipelineRunId: input.pipelineRun.id,
    projectId: input.workItem.projectId,
    workItemId: input.workItem.id,
    correctionRunId: null,
    verificationCorrectionRunId: correctionRun.id,
    stage: "IMPLEMENT",
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
    ...input.pipelineRun,
    currentStageAttemptId: nextStageAttempt.id,
    version: input.pipelineRun.version + 1,
    updatedAt: input.now,
  };
  const workItem: WorkItem = {
    ...input.workItem,
    state: "IN_PROGRESS",
    currentStage: "IMPLEMENT",
    version: input.workItem.version + 1,
    updatedAt: input.now,
  };
  const nextDispatch: WorkflowDispatch = {
    schemaVersion: 1,
    id: input.ids.nextDispatchId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: pipelineRun.id,
    stageAttemptId: nextStageAttempt.id,
    mode: "START",
    status: "PENDING",
    createdAt: input.now,
    completedAt: null,
  };
  return {
    action: "START_CORRECTION",
    workItem,
    pipelineRun,
    completedStageAttempt,
    completedDispatch,
    correctionRun,
    nextStageAttempt,
    nextDispatch,
    events: [
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: {
          run: pipelineRun,
          stageAttempt: completedStageAttempt,
          previousStatus: input.stageAttempt.status,
        },
      },
      { type: "VERIFICATION_CORRECTION_STARTED", data: { correctionRun } },
    ],
  };
};

/** Closes correction authority only for a fresh green rerun of its exact owner-approved plan. */
export const decidePassedVerificationCorrectionTransition = (input: {
  verificationRun: VerificationRun;
  sourceVerificationRun: VerificationRun;
  sourceFailure: VerificationFailure;
  correctionRun: VerificationCorrectionRun;
  now: string;
}): PassedVerificationCorrectionTransition => {
  const verificationRun = verificationRunSchema.parse(input.verificationRun);
  const sourceVerificationRun = verificationRunSchema.parse(input.sourceVerificationRun);
  const sourceFailure = verificationFailureSchema.parse(input.sourceFailure);
  const correctionRun = verificationCorrectionRunSchema.parse(input.correctionRun);
  const lineageMatches =
    verificationRun.status === "PASSED" &&
    (verificationRun.verificationCorrectionRunId ?? null) === correctionRun.id &&
    verificationRun.projectId === correctionRun.projectId &&
    verificationRun.workItemId === correctionRun.workItemId &&
    verificationRun.pipelineRunId === correctionRun.pipelineRunId &&
    verificationRun.ordinal > sourceVerificationRun.ordinal &&
    verificationRun.planId === sourceVerificationRun.planId &&
    verificationRun.planRevision === sourceVerificationRun.planRevision &&
    verificationRun.planContentHash === sourceVerificationRun.planContentHash &&
    verificationRun.implementationTree !== sourceVerificationRun.implementationTree &&
    correctionRun.status === "ACTIVE" &&
    correctionRun.sourceFailureId === sourceFailure.id &&
    correctionRun.sourceVerificationRunId === sourceVerificationRun.id &&
    correctionRun.sourceImplementationTree === sourceVerificationRun.implementationTree &&
    sourceFailure.verificationRunId === sourceVerificationRun.id &&
    sourceFailure.projectId === sourceVerificationRun.projectId &&
    sourceFailure.workItemId === sourceVerificationRun.workItemId &&
    sourceFailure.pipelineRunId === sourceVerificationRun.pipelineRunId &&
    sourceFailure.planId === sourceVerificationRun.planId &&
    sourceFailure.planRevision === sourceVerificationRun.planRevision &&
    sourceFailure.planContentHash === sourceVerificationRun.planContentHash &&
    sourceFailure.implementationTree === sourceVerificationRun.implementationTree &&
    (sourceFailure.reason === "REQUIRED_CHECK_FAILED" || sourceFailure.reason === "REQUIRED_CHECK_ERROR") &&
    (sourceVerificationRun.status === "FAILED" || sourceVerificationRun.status === "ERROR") &&
    sourceVerificationRun.projectId === correctionRun.projectId &&
    sourceVerificationRun.workItemId === correctionRun.workItemId &&
    sourceVerificationRun.pipelineRunId === correctionRun.pipelineRunId;
  if (!lineageMatches) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The passing Project verification Run is not a fresh rerun of the active correction's exact plan",
    );
  }
  const passedCorrection = verificationCorrectionRunSchema.parse({
    ...correctionRun,
    status: "PASSED",
    completedAt: input.now,
    version: correctionRun.version + 1,
  });
  return {
    correctionRun: passedCorrection,
    event: { type: "VERIFICATION_CORRECTION_PASSED", data: { correctionRun: passedCorrection } },
  };
};
