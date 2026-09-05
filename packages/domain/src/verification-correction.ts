import {
  humanRequestSchema,
  qaCorrectionRunSchema,
  verificationCorrectionRunSchema,
  verificationFailureSchema,
  verificationRunSchema,
  type Decision,
  type HumanRequest,
  type HumanRequestOpenedEvent,
  type HumanRequestResolvedEvent,
  type PipelineRun,
  type PipelineCancelledEvent,
  type QACorrectionCancelledEvent,
  type QACorrectionRun,
  type ResolveVerificationCorrectionGateCommand,
  type StageAttempt,
  type StageAttemptChangedEvent,
  type VerificationCorrectionCancelledEvent,
  type VerificationCorrectionExhaustedEvent,
  type VerificationCorrectionRun,
  type VerificationCorrectionPassedEvent,
  type VerificationCorrectionStartedEvent,
  type VerificationCorrectionSupersededEvent,
  type VerificationFailure,
  type VerificationRun,
  type WorkItem,
  type WorkflowDispatch,
} from "@loomrail/contracts";

import { decideCorrectionBudget } from "./correction-budget.js";

export type VerificationCorrectionErrorCode =
  "ACTOR_FORBIDDEN" | "VERSION_CONFLICT" | "REQUEST_INVALID" | "LINEAGE_MISMATCH" | "BUDGET_UNAVAILABLE";

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

export type VerificationCorrectionCancellation = {
  correctionRun: VerificationCorrectionRun;
  suspendedQACorrection: QACorrectionRun | null;
  events: readonly (
    | Pick<VerificationCorrectionCancelledEvent, "type" | "data">
    | Pick<QACorrectionCancelledEvent, "type" | "data">
  )[];
};

/** Closes verification correction authority when its containing PipelineRun is cancelled. */
export const decideVerificationCorrectionCancellation = (input: {
  correctionRun: VerificationCorrectionRun;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  suspendedQACorrection?: QACorrectionRun | null;
  now: string;
}): VerificationCorrectionCancellation => {
  const correctionRun = verificationCorrectionRunSchema.parse(input.correctionRun);
  const suspendedQACorrection =
    input.suspendedQACorrection === undefined || input.suspendedQACorrection === null
      ? null
      : qaCorrectionRunSchema.parse(input.suspendedQACorrection);
  if (
    (correctionRun.status !== "ACTIVE" && correctionRun.status !== "EXHAUSTED") ||
    input.run.id !== correctionRun.pipelineRunId ||
    input.run.workItemId !== correctionRun.workItemId ||
    input.run.projectId !== correctionRun.projectId ||
    input.run.currentStageAttemptId !== input.stageAttempt.id ||
    input.stageAttempt.pipelineRunId !== input.run.id ||
    input.stageAttempt.workItemId !== correctionRun.workItemId ||
    input.stageAttempt.projectId !== correctionRun.projectId ||
    input.stageAttempt.correctionRunId !== (correctionRun.resumesQACorrectionRunId ?? null) ||
    (input.stageAttempt.verificationCorrectionRunId ?? null) !== correctionRun.id ||
    (correctionRun.resumesQACorrectionRunId ?? null) !== (suspendedQACorrection?.id ?? null) ||
    (suspendedQACorrection !== null &&
      (suspendedQACorrection.status !== "ACTIVE" ||
        suspendedQACorrection.projectId !== correctionRun.projectId ||
        suspendedQACorrection.workItemId !== correctionRun.workItemId ||
        suspendedQACorrection.pipelineRunId !== correctionRun.pipelineRunId))
  ) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The current workflow stage does not belong to the Project verification correction being cancelled",
    );
  }
  const cancelled = verificationCorrectionRunSchema.parse({
    ...correctionRun,
    status: "CANCELLED",
    completedAt: input.now,
    version: correctionRun.version + 1,
  });
  const cancelledQACorrection =
    suspendedQACorrection === null
      ? null
      : qaCorrectionRunSchema.parse({
          ...suspendedQACorrection,
          status: "CANCELLED",
          completedAt: input.now,
          version: suspendedQACorrection.version + 1,
        });
  return {
    correctionRun: cancelled,
    suspendedQACorrection: cancelledQACorrection,
    events: [
      { type: "VERIFICATION_CORRECTION_CANCELLED", data: { correctionRun: cancelled } },
      ...(cancelledQACorrection === null
        ? []
        : [{ type: "QA_CORRECTION_CANCELLED" as const, data: { correctionRun: cancelledQACorrection } }]),
    ],
  };
};

type FailedVerificationCorrectionEvent =
  | Pick<HumanRequestOpenedEvent, "type" | "data">
  | Pick<VerificationCorrectionExhaustedEvent, "type" | "data">
  | Pick<VerificationCorrectionStartedEvent, "type" | "data">
  | Pick<VerificationCorrectionSupersededEvent, "type" | "data">
  | {
      type: "STAGE_ATTEMPT_CHANGED";
      data: { run: PipelineRun; stageAttempt: StageAttempt; previousStatus: StageAttempt["status"] };
    };

export type SubsequentFailedVerificationCorrectionTransition =
  | {
      action: "START_CORRECTION";
      workItem: WorkItem;
      pipelineRun: PipelineRun;
      completedStageAttempt: StageAttempt;
      completedDispatch: WorkflowDispatch;
      previousCorrection: VerificationCorrectionRun;
      correctionRun: VerificationCorrectionRun;
      nextStageAttempt: StageAttempt;
      nextDispatch: WorkflowDispatch;
      request: null;
      events: readonly FailedVerificationCorrectionEvent[];
    }
  | {
      action: "WAIT_FOR_OWNER";
      workItem: WorkItem;
      pipelineRun: PipelineRun;
      completedStageAttempt: StageAttempt;
      completedDispatch: WorkflowDispatch;
      previousCorrection: VerificationCorrectionRun;
      correctionRun: null;
      nextStageAttempt: null;
      nextDispatch: null;
      request: HumanRequest;
      events: readonly FailedVerificationCorrectionEvent[];
    };

/** Starts one automatic fix cycle from daemon-measured Project verification evidence. */
export const decideInitialFailedVerificationCorrectionTransition = (input: {
  verificationRun: VerificationRun;
  failure: VerificationFailure;
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  qaCorrectionRun?: QACorrectionRun;
  budgetUsage: { automaticUsed: number; totalUsed: number };
  ids: { correctionRunId: string; nextStageAttemptId: string; nextDispatchId: string };
  now: string;
}): StartedVerificationCorrectionTransition => {
  const verificationRun = verificationRunSchema.parse(input.verificationRun);
  const failure = verificationFailureSchema.parse(input.failure);
  const qaCorrectionRun =
    input.qaCorrectionRun === undefined ? null : qaCorrectionRunSchema.parse(input.qaCorrectionRun);
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
    input.stageAttempt.correctionRunId !== (qaCorrectionRun?.id ?? null) ||
    (input.stageAttempt.verificationCorrectionRunId ?? null) !== null ||
    (verificationRun.verificationCorrectionRunId ?? null) !== null ||
    input.dispatch.projectId !== verificationRun.projectId ||
    input.dispatch.workItemId !== verificationRun.workItemId ||
    input.dispatch.pipelineRunId !== verificationRun.pipelineRunId ||
    input.dispatch.stageAttemptId !== input.stageAttempt.id ||
    input.dispatch.status !== "PENDING" ||
    (qaCorrectionRun !== null &&
      (qaCorrectionRun.status !== "ACTIVE" ||
        qaCorrectionRun.projectId !== verificationRun.projectId ||
        qaCorrectionRun.workItemId !== verificationRun.workItemId ||
        qaCorrectionRun.pipelineRunId !== verificationRun.pipelineRunId))
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
    resumesQACorrectionRunId: qaCorrectionRun?.id ?? null,
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
    correctionRunId: qaCorrectionRun?.id ?? null,
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

export type InitialVerificationCorrectionGateTransition = {
  action: "WAIT_FOR_OWNER";
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  completedStageAttempt: StageAttempt;
  completedDispatch: WorkflowDispatch;
  qaCorrectionRun: QACorrectionRun;
  correctionRun: null;
  request: HumanRequest;
  events: readonly FailedVerificationCorrectionEvent[];
};

/** Opens the shared owner gate when verification first fails inside a QA correction at the bound. */
export const decideInitialFailedVerificationCorrectionGateTransition = (input: {
  verificationRun: VerificationRun;
  failure: VerificationFailure;
  qaCorrectionRun: QACorrectionRun;
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  budgetUsage: { automaticUsed: number; totalUsed: number };
  ids: { humanRequestId: string; authorizeFinalOptionId: string; cancelOptionId: string };
  now: string;
}): InitialVerificationCorrectionGateTransition => {
  const verificationRun = verificationRunSchema.parse(input.verificationRun);
  const failure = verificationFailureSchema.parse(input.failure);
  const qaCorrectionRun = qaCorrectionRunSchema.parse(input.qaCorrectionRun);
  const lineageMatches =
    (verificationRun.status === "FAILED" || verificationRun.status === "ERROR") &&
    (verificationRun.verificationCorrectionRunId ?? null) === null &&
    failure.verificationRunId === verificationRun.id &&
    failure.projectId === verificationRun.projectId &&
    failure.workItemId === verificationRun.workItemId &&
    failure.pipelineRunId === verificationRun.pipelineRunId &&
    failure.planId === verificationRun.planId &&
    failure.planRevision === verificationRun.planRevision &&
    failure.planContentHash === verificationRun.planContentHash &&
    failure.implementationTree === verificationRun.implementationTree &&
    (failure.reason === "REQUIRED_CHECK_FAILED" || failure.reason === "REQUIRED_CHECK_ERROR") &&
    qaCorrectionRun.status === "ACTIVE" &&
    qaCorrectionRun.projectId === verificationRun.projectId &&
    qaCorrectionRun.workItemId === verificationRun.workItemId &&
    qaCorrectionRun.pipelineRunId === verificationRun.pipelineRunId &&
    input.workItem.id === verificationRun.workItemId &&
    input.workItem.projectId === verificationRun.projectId &&
    input.workItem.state === "IN_PROGRESS" &&
    input.workItem.currentStage === "QA" &&
    input.pipelineRun.id === verificationRun.pipelineRunId &&
    input.pipelineRun.projectId === verificationRun.projectId &&
    input.pipelineRun.workItemId === verificationRun.workItemId &&
    input.pipelineRun.status === "RUNNING" &&
    input.pipelineRun.currentStageAttemptId === input.stageAttempt.id &&
    input.stageAttempt.projectId === verificationRun.projectId &&
    input.stageAttempt.workItemId === verificationRun.workItemId &&
    input.stageAttempt.pipelineRunId === verificationRun.pipelineRunId &&
    input.stageAttempt.stage === "QA" &&
    input.stageAttempt.status === "QUEUED" &&
    input.stageAttempt.correctionRunId === qaCorrectionRun.id &&
    (input.stageAttempt.verificationCorrectionRunId ?? null) === null &&
    input.dispatch.projectId === verificationRun.projectId &&
    input.dispatch.workItemId === verificationRun.workItemId &&
    input.dispatch.pipelineRunId === verificationRun.pipelineRunId &&
    input.dispatch.stageAttemptId === input.stageAttempt.id &&
    input.dispatch.status === "PENDING";
  if (!lineageMatches) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The verification failure is not the current suspended Browser QA correction gate",
    );
  }
  const budget = decideCorrectionBudget(input.budgetUsage);
  if (budget.action === "START_AUTOMATIC") {
    throw new VerificationCorrectionError(
      "BUDGET_UNAVAILABLE",
      "The verification failure still has an automatic shared correction available",
    );
  }
  const canAuthorizeFinal = budget.action === "WAIT_FOR_OWNER";
  const completedStageAttempt: StageAttempt = {
    ...input.stageAttempt,
    status: "WAITING_HUMAN",
    failureCode: "VERIFICATION_CORRECTION_EXHAUSTED",
    version: input.stageAttempt.version + 1,
  };
  const pipelineRun: PipelineRun = {
    ...input.pipelineRun,
    status: "WAITING_HUMAN",
    version: input.pipelineRun.version + 1,
    updatedAt: input.now,
  };
  const workItem: WorkItem = {
    ...input.workItem,
    state: "BLOCKED",
    version: input.workItem.version + 1,
    updatedAt: input.now,
  };
  const completedDispatch: WorkflowDispatch = {
    ...input.dispatch,
    status: "COMPLETED",
    completedAt: input.now,
  };
  const request = humanRequestSchema.parse({
    schemaVersion: 1,
    id: input.ids.humanRequestId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    stageAttemptId: completedStageAttempt.id,
    kind: "SINGLE_CHOICE",
    blocking: true,
    title: "Project verification correction needs a decision",
    context: canAuthorizeFinal
      ? "Two automatic delivery corrections were consumed before this measured Project verification failure."
      : "The owner-authorized final delivery correction was consumed before this measured Project verification failure.",
    recommendation: canAuthorizeFinal
      ? "Inspect the exact check output and QA correction history before authorizing the final shared position."
      : "Inspect the remaining failure and cancel this delivery because no bounded correction remains.",
    options: [
      ...(canAuthorizeFinal
        ? [
            {
              id: input.ids.authorizeFinalOptionId,
              label: "Authorize one final Project verification correction",
              consequence: "Creates shared correction position 3, then returns to the locked QA retest.",
              recommended: true,
            },
          ]
        : []),
      {
        id: input.ids.cancelOptionId,
        label: "Cancel the delivery",
        consequence: "Stops this PipelineRun without acceptance.",
        recommended: false,
      },
    ],
    allowOther: false,
    status: "OPEN",
    version: 1,
    createdAt: input.now,
    resolvedAt: null,
  });
  return {
    action: "WAIT_FOR_OWNER",
    workItem,
    pipelineRun,
    completedStageAttempt,
    completedDispatch,
    qaCorrectionRun,
    correctionRun: null,
    request,
    events: [
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: {
          run: pipelineRun,
          stageAttempt: completedStageAttempt,
          previousStatus: input.stageAttempt.status,
        },
      },
      { type: "HUMAN_REQUEST_OPENED", data: { request } },
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

export type PassedVerificationCorrectionQAHandoff = {
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  completedStageAttempt: StageAttempt;
  completedDispatch: WorkflowDispatch;
  nextStageAttempt: StageAttempt;
  nextDispatch: WorkflowDispatch;
  events: readonly Pick<StageAttemptChangedEvent, "type" | "data">[];
};

/** Returns a passing nested Project verification correction to its exact suspended QA retest. */
export const decidePassedVerificationCorrectionQAHandoff = (input: {
  verificationRun: VerificationRun;
  verificationCorrectionRun: VerificationCorrectionRun;
  qaCorrectionRun: QACorrectionRun;
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  nextQAAttempt: number;
  ids: { nextStageAttemptId: string; nextDispatchId: string };
  now: string;
}): PassedVerificationCorrectionQAHandoff => {
  const verificationRun = verificationRunSchema.parse(input.verificationRun);
  const verificationCorrectionRun = verificationCorrectionRunSchema.parse(input.verificationCorrectionRun);
  const qaCorrectionRun = qaCorrectionRunSchema.parse(input.qaCorrectionRun);
  const lineageMatches =
    verificationRun.status === "PASSED" &&
    (verificationRun.verificationCorrectionRunId ?? null) === verificationCorrectionRun.id &&
    verificationCorrectionRun.status === "PASSED" &&
    (verificationCorrectionRun.resumesQACorrectionRunId ?? null) === qaCorrectionRun.id &&
    qaCorrectionRun.status === "ACTIVE" &&
    qaCorrectionRun.projectId === verificationRun.projectId &&
    qaCorrectionRun.workItemId === verificationRun.workItemId &&
    qaCorrectionRun.pipelineRunId === verificationRun.pipelineRunId &&
    input.workItem.id === verificationRun.workItemId &&
    input.workItem.projectId === verificationRun.projectId &&
    input.workItem.state === "IN_PROGRESS" &&
    input.workItem.currentStage === "QA" &&
    input.pipelineRun.id === verificationRun.pipelineRunId &&
    input.pipelineRun.projectId === verificationRun.projectId &&
    input.pipelineRun.workItemId === verificationRun.workItemId &&
    input.pipelineRun.status === "RUNNING" &&
    input.pipelineRun.currentStageAttemptId === input.stageAttempt.id &&
    input.stageAttempt.projectId === verificationRun.projectId &&
    input.stageAttempt.workItemId === verificationRun.workItemId &&
    input.stageAttempt.pipelineRunId === verificationRun.pipelineRunId &&
    input.stageAttempt.stage === "QA" &&
    input.stageAttempt.status === "QUEUED" &&
    input.stageAttempt.correctionRunId === qaCorrectionRun.id &&
    (input.stageAttempt.verificationCorrectionRunId ?? null) === verificationCorrectionRun.id &&
    input.dispatch.projectId === verificationRun.projectId &&
    input.dispatch.workItemId === verificationRun.workItemId &&
    input.dispatch.pipelineRunId === verificationRun.pipelineRunId &&
    input.dispatch.stageAttemptId === input.stageAttempt.id &&
    input.dispatch.status === "PENDING" &&
    Number.isInteger(input.nextQAAttempt) &&
    input.nextQAAttempt > 0;
  if (!lineageMatches) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The passing Project verification correction cannot resume this QA correction",
    );
  }

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
    correctionRunId: qaCorrectionRun.id,
    verificationCorrectionRunId: verificationCorrectionRun.id,
    stage: "QA",
    attempt: input.nextQAAttempt,
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
    workItem,
    pipelineRun,
    completedStageAttempt,
    completedDispatch,
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
    ],
  };
};

/** Advances a failed correction rerun to one more bounded cycle or an explicit owner gate. */
export const decideSubsequentFailedVerificationCorrectionTransition = (input: {
  verificationRun: VerificationRun;
  failure: VerificationFailure;
  correctionRun: VerificationCorrectionRun;
  correctionSourceVerificationRun: VerificationRun;
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  budgetUsage: { automaticUsed: number; totalUsed: number };
  ids: {
    correctionRunId: string;
    nextStageAttemptId: string;
    nextDispatchId: string;
    humanRequestId: string;
    authorizeFinalOptionId: string;
    cancelOptionId: string;
  };
  now: string;
}): SubsequentFailedVerificationCorrectionTransition => {
  const verificationRun = verificationRunSchema.parse(input.verificationRun);
  const failure = verificationFailureSchema.parse(input.failure);
  const correctionRun = verificationCorrectionRunSchema.parse(input.correctionRun);
  const correctionSourceVerificationRun = verificationRunSchema.parse(input.correctionSourceVerificationRun);
  const lineageMatches =
    (verificationRun.status === "FAILED" || verificationRun.status === "ERROR") &&
    (verificationRun.verificationCorrectionRunId ?? null) === correctionRun.id &&
    verificationRun.projectId === correctionRun.projectId &&
    verificationRun.workItemId === correctionRun.workItemId &&
    verificationRun.pipelineRunId === correctionRun.pipelineRunId &&
    verificationRun.ordinal > correctionSourceVerificationRun.ordinal &&
    verificationRun.planId === correctionSourceVerificationRun.planId &&
    verificationRun.planRevision === correctionSourceVerificationRun.planRevision &&
    verificationRun.planContentHash === correctionSourceVerificationRun.planContentHash &&
    verificationRun.implementationTree !== correctionRun.sourceImplementationTree &&
    failure.verificationRunId === verificationRun.id &&
    failure.projectId === verificationRun.projectId &&
    failure.workItemId === verificationRun.workItemId &&
    failure.pipelineRunId === verificationRun.pipelineRunId &&
    failure.planId === verificationRun.planId &&
    failure.planRevision === verificationRun.planRevision &&
    failure.planContentHash === verificationRun.planContentHash &&
    failure.implementationTree === verificationRun.implementationTree &&
    (failure.reason === "REQUIRED_CHECK_FAILED" || failure.reason === "REQUIRED_CHECK_ERROR") &&
    correctionRun.status === "ACTIVE" &&
    correctionRun.sourceVerificationRunId === correctionSourceVerificationRun.id &&
    correctionRun.sourceImplementationTree === correctionSourceVerificationRun.implementationTree &&
    input.workItem.id === verificationRun.workItemId &&
    input.workItem.projectId === verificationRun.projectId &&
    input.workItem.state === "IN_PROGRESS" &&
    input.workItem.currentStage === "QA" &&
    input.pipelineRun.id === verificationRun.pipelineRunId &&
    input.pipelineRun.projectId === verificationRun.projectId &&
    input.pipelineRun.workItemId === verificationRun.workItemId &&
    input.pipelineRun.status === "RUNNING" &&
    input.pipelineRun.currentStageAttemptId === input.stageAttempt.id &&
    input.stageAttempt.projectId === verificationRun.projectId &&
    input.stageAttempt.workItemId === verificationRun.workItemId &&
    input.stageAttempt.pipelineRunId === verificationRun.pipelineRunId &&
    input.stageAttempt.stage === "QA" &&
    input.stageAttempt.status === "QUEUED" &&
    input.stageAttempt.correctionRunId === (correctionRun.resumesQACorrectionRunId ?? null) &&
    (input.stageAttempt.verificationCorrectionRunId ?? null) === correctionRun.id &&
    input.dispatch.projectId === verificationRun.projectId &&
    input.dispatch.workItemId === verificationRun.workItemId &&
    input.dispatch.pipelineRunId === verificationRun.pipelineRunId &&
    input.dispatch.stageAttemptId === input.stageAttempt.id &&
    input.dispatch.status === "PENDING";
  if (!lineageMatches) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The failed Project verification rerun is not the current active correction gate",
    );
  }
  const budget = decideCorrectionBudget(input.budgetUsage);
  if (budget.action === "START_AUTOMATIC") {
    if (budget.position !== correctionRun.budgetPosition + 1) {
      throw new VerificationCorrectionError(
        "BUDGET_UNAVAILABLE",
        "The shared correction budget does not continue the active verification correction",
      );
    }
    const previousCorrection = verificationCorrectionRunSchema.parse({
      ...correctionRun,
      status: "SUPERSEDED",
      completedAt: input.now,
      version: correctionRun.version + 1,
    });
    const nextCorrection = verificationCorrectionRunSchema.parse({
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
      resumesQACorrectionRunId: correctionRun.resumesQACorrectionRunId ?? null,
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
      correctionRunId: correctionRun.resumesQACorrectionRunId ?? null,
      verificationCorrectionRunId: nextCorrection.id,
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
      previousCorrection,
      correctionRun: nextCorrection,
      nextStageAttempt,
      nextDispatch,
      request: null,
      events: [
        {
          type: "STAGE_ATTEMPT_CHANGED",
          data: {
            run: pipelineRun,
            stageAttempt: completedStageAttempt,
            previousStatus: input.stageAttempt.status,
          },
        },
        { type: "VERIFICATION_CORRECTION_SUPERSEDED", data: { correctionRun: previousCorrection } },
        { type: "VERIFICATION_CORRECTION_STARTED", data: { correctionRun: nextCorrection } },
      ],
    };
  }

  const canAuthorizeFinal = budget.action === "WAIT_FOR_OWNER";
  const exhaustedCorrection = verificationCorrectionRunSchema.parse({
    ...correctionRun,
    status: "EXHAUSTED",
    completedAt: null,
    version: correctionRun.version + 1,
  });
  const completedStageAttempt: StageAttempt = {
    ...input.stageAttempt,
    status: "WAITING_HUMAN",
    failureCode: "VERIFICATION_CORRECTION_EXHAUSTED",
    version: input.stageAttempt.version + 1,
  };
  const pipelineRun: PipelineRun = {
    ...input.pipelineRun,
    status: "WAITING_HUMAN",
    version: input.pipelineRun.version + 1,
    updatedAt: input.now,
  };
  const workItem: WorkItem = {
    ...input.workItem,
    state: "BLOCKED",
    currentStage: "QA",
    version: input.workItem.version + 1,
    updatedAt: input.now,
  };
  const completedDispatch: WorkflowDispatch = {
    ...input.dispatch,
    status: "COMPLETED",
    completedAt: input.now,
  };
  const request = humanRequestSchema.parse({
    schemaVersion: 1,
    id: input.ids.humanRequestId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    stageAttemptId: completedStageAttempt.id,
    kind: "SINGLE_CHOICE",
    blocking: true,
    title: "Project verification correction needs a decision",
    context: canAuthorizeFinal
      ? "Two automatic Project verification corrections still ended in measured failures."
      : "The owner-authorized final Project verification correction still ended in a measured failure.",
    recommendation: canAuthorizeFinal
      ? "Inspect the exact check output and correction history before authorizing the one final correction."
      : "Inspect the remaining failure and cancel this delivery because no bounded correction remains.",
    options: [
      ...(canAuthorizeFinal
        ? [
            {
              id: input.ids.authorizeFinalOptionId,
              label: "Authorize one final Project verification correction",
              consequence: "Creates correction 3 and requires another independent review and fresh rerun.",
              recommended: true,
            },
          ]
        : []),
      {
        id: input.ids.cancelOptionId,
        label: "Cancel the delivery",
        consequence: "Stops this PipelineRun without acceptance.",
        recommended: false,
      },
    ],
    allowOther: false,
    status: "OPEN",
    version: 1,
    createdAt: input.now,
    resolvedAt: null,
  });
  return {
    action: "WAIT_FOR_OWNER",
    workItem,
    pipelineRun,
    completedStageAttempt,
    completedDispatch,
    previousCorrection: exhaustedCorrection,
    correctionRun: null,
    nextStageAttempt: null,
    nextDispatch: null,
    request,
    events: [
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: {
          run: pipelineRun,
          stageAttempt: completedStageAttempt,
          previousStatus: input.stageAttempt.status,
        },
      },
      { type: "HUMAN_REQUEST_OPENED", data: { request } },
      {
        type: "VERIFICATION_CORRECTION_EXHAUSTED",
        data: { correctionRun: exhaustedCorrection, canAuthorizeFinal },
      },
    ],
  };
};

type VerificationCorrectionGateEvent =
  | Pick<HumanRequestResolvedEvent, "type" | "data">
  | Pick<StageAttemptChangedEvent, "type" | "data">
  | Pick<VerificationCorrectionSupersededEvent, "type" | "data">
  | Pick<VerificationCorrectionStartedEvent, "type" | "data">
  | Pick<VerificationCorrectionCancelledEvent, "type" | "data">
  | Pick<QACorrectionCancelledEvent, "type" | "data">
  | Pick<PipelineCancelledEvent, "type" | "data">;

export type VerificationCorrectionGateResolution =
  | {
      action: "AUTHORIZE_FINAL";
      workItem: WorkItem;
      run: PipelineRun;
      stageAttempt: StageAttempt;
      request: HumanRequest;
      decision: Decision;
      previousCorrection: VerificationCorrectionRun;
      cancelledQACorrection: null;
      correctionRun: VerificationCorrectionRun;
      nextStageAttempt: StageAttempt;
      dispatch: WorkflowDispatch;
      events: readonly VerificationCorrectionGateEvent[];
    }
  | {
      action: "CANCEL";
      workItem: WorkItem;
      run: PipelineRun;
      stageAttempt: StageAttempt;
      request: HumanRequest;
      decision: Decision;
      previousCorrection: VerificationCorrectionRun;
      cancelledQACorrection: QACorrectionRun | null;
      correctionRun: null;
      nextStageAttempt: null;
      dispatch: null;
      events: readonly VerificationCorrectionGateEvent[];
    };

/** Resolves the bounded Project verification correction gate as one owner-only transition. */
export const decideVerificationCorrectionGateResolution = (input: {
  command: ResolveVerificationCorrectionGateCommand;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
  correctionRun: VerificationCorrectionRun;
  suspendedQACorrection?: QACorrectionRun | null;
  correctionSourceVerificationRun: VerificationRun;
  failedVerificationRun: VerificationRun;
  failure: VerificationFailure;
  ids: {
    decisionId: string;
    correctionRunId: string;
    nextStageAttemptId: string;
    dispatchId: string;
  };
  now: string;
}): VerificationCorrectionGateResolution => {
  const correctionRun = verificationCorrectionRunSchema.parse(input.correctionRun);
  const suspendedQACorrection =
    input.suspendedQACorrection === undefined || input.suspendedQACorrection === null
      ? null
      : qaCorrectionRunSchema.parse(input.suspendedQACorrection);
  const correctionSourceVerificationRun = verificationRunSchema.parse(input.correctionSourceVerificationRun);
  const failedVerificationRun = verificationRunSchema.parse(input.failedVerificationRun);
  const failure = verificationFailureSchema.parse(input.failure);
  const { command, workItem, run, stageAttempt, request } = input;
  const commandQACorrectionRunId = command.payload.qaCorrectionRunId ?? null;
  const expectedQACorrectionVersion = command.payload.expectedQACorrectionVersion ?? null;

  if (command.actor.type !== "HUMAN") {
    throw new VerificationCorrectionError(
      "ACTOR_FORBIDDEN",
      "Only the owner can resolve an exhausted Project verification correction gate",
    );
  }
  if (
    request.id !== command.payload.humanRequestId ||
    correctionRun.id !== command.payload.correctionRunId ||
    commandQACorrectionRunId !== (suspendedQACorrection?.id ?? null)
  ) {
    throw new VerificationCorrectionError(
      "REQUEST_INVALID",
      "The owner action does not identify this Project verification correction gate",
    );
  }
  if (
    request.version !== command.payload.expectedRequestVersion ||
    correctionRun.version !== command.payload.expectedCorrectionVersion ||
    expectedQACorrectionVersion !== (suspendedQACorrection?.version ?? null) ||
    run.version !== command.payload.expectedPipelineRunVersion
  ) {
    throw new VerificationCorrectionError(
      "VERSION_CONFLICT",
      "The Project verification correction gate changed after it was loaded",
    );
  }

  const expectedOptionCount = correctionRun.budgetPosition === 2 ? 2 : 1;
  const sameDelivery =
    correctionRun.status === "EXHAUSTED" &&
    (correctionRun.resumesQACorrectionRunId ?? null) === (suspendedQACorrection?.id ?? null) &&
    (suspendedQACorrection === null ||
      (suspendedQACorrection.status === "ACTIVE" &&
        suspendedQACorrection.projectId === correctionRun.projectId &&
        suspendedQACorrection.workItemId === correctionRun.workItemId &&
        suspendedQACorrection.pipelineRunId === correctionRun.pipelineRunId)) &&
    request.status === "OPEN" &&
    request.kind === "SINGLE_CHOICE" &&
    request.blocking &&
    !request.allowOther &&
    request.options.length === expectedOptionCount &&
    workItem.id === correctionRun.workItemId &&
    workItem.projectId === correctionRun.projectId &&
    workItem.state === "BLOCKED" &&
    workItem.currentStage === "QA" &&
    run.id === correctionRun.pipelineRunId &&
    run.projectId === workItem.projectId &&
    run.workItemId === workItem.id &&
    run.status === "WAITING_HUMAN" &&
    run.currentStageAttemptId === stageAttempt.id &&
    stageAttempt.projectId === workItem.projectId &&
    stageAttempt.workItemId === workItem.id &&
    stageAttempt.pipelineRunId === run.id &&
    stageAttempt.correctionRunId === (correctionRun.resumesQACorrectionRunId ?? null) &&
    (stageAttempt.verificationCorrectionRunId ?? null) === correctionRun.id &&
    stageAttempt.stage === "QA" &&
    stageAttempt.status === "WAITING_HUMAN" &&
    stageAttempt.failureCode === "VERIFICATION_CORRECTION_EXHAUSTED" &&
    request.projectId === workItem.projectId &&
    request.workItemId === workItem.id &&
    request.stageAttemptId === stageAttempt.id &&
    correctionRun.sourceVerificationRunId === correctionSourceVerificationRun.id &&
    correctionRun.sourceFailureId !== failure.id &&
    correctionRun.sourceImplementationTree === correctionSourceVerificationRun.implementationTree &&
    correctionSourceVerificationRun.projectId === workItem.projectId &&
    correctionSourceVerificationRun.workItemId === workItem.id &&
    correctionSourceVerificationRun.pipelineRunId === run.id &&
    (failedVerificationRun.status === "FAILED" || failedVerificationRun.status === "ERROR") &&
    (failedVerificationRun.verificationCorrectionRunId ?? null) === correctionRun.id &&
    failedVerificationRun.projectId === workItem.projectId &&
    failedVerificationRun.workItemId === workItem.id &&
    failedVerificationRun.pipelineRunId === run.id &&
    failedVerificationRun.ordinal > correctionSourceVerificationRun.ordinal &&
    failedVerificationRun.planId === correctionSourceVerificationRun.planId &&
    failedVerificationRun.planRevision === correctionSourceVerificationRun.planRevision &&
    failedVerificationRun.planContentHash === correctionSourceVerificationRun.planContentHash &&
    failedVerificationRun.implementationTree !== correctionSourceVerificationRun.implementationTree &&
    failure.verificationRunId === failedVerificationRun.id &&
    failure.projectId === workItem.projectId &&
    failure.workItemId === workItem.id &&
    failure.pipelineRunId === run.id &&
    failure.planId === failedVerificationRun.planId &&
    failure.planRevision === failedVerificationRun.planRevision &&
    failure.planContentHash === failedVerificationRun.planContentHash &&
    failure.implementationTree === failedVerificationRun.implementationTree &&
    (failure.reason === "REQUIRED_CHECK_FAILED" || failure.reason === "REQUIRED_CHECK_ERROR");
  if (!sameDelivery) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The request is not the current exhausted Project verification correction gate for this delivery",
    );
  }
  if (command.payload.action === "AUTHORIZE_FINAL" && correctionRun.budgetPosition !== 2) {
    throw new VerificationCorrectionError(
      "BUDGET_UNAVAILABLE",
      "The final owner-authorized Project verification correction is no longer available",
    );
  }

  const optionId =
    command.payload.action === "AUTHORIZE_FINAL" ? request.options[0]?.id : request.options.at(-1)?.id;
  if (optionId === undefined) {
    throw new VerificationCorrectionError(
      "REQUEST_INVALID",
      "The Project verification correction gate does not contain the requested action",
    );
  }
  const resolvedRequest: HumanRequest = {
    ...request,
    status: "RESOLVED",
    version: request.version + 1,
    resolvedAt: input.now,
  };
  const decision: Decision = {
    schemaVersion: 1,
    id: input.ids.decisionId,
    projectId: request.projectId,
    workItemId: request.workItemId,
    humanRequestId: request.id,
    answer: { type: "OPTION", optionIds: [optionId] },
    actor: command.actor,
    reason:
      command.payload.action === "AUTHORIZE_FINAL"
        ? "Owner authorized the one final bounded Project verification correction."
        : "Owner cancelled the delivery after the Project verification correction gate.",
    createdAt: input.now,
  };

  if (command.payload.action === "CANCEL") {
    const cancelledCorrection = verificationCorrectionRunSchema.parse({
      ...correctionRun,
      status: "CANCELLED",
      completedAt: input.now,
      version: correctionRun.version + 1,
    });
    const cancelledStageAttempt: StageAttempt = {
      ...stageAttempt,
      status: "CANCELLED",
      version: stageAttempt.version + 1,
      finishedAt: input.now,
    };
    const cancelledRun: PipelineRun = {
      ...run,
      status: "CANCELLED",
      version: run.version + 1,
      updatedAt: input.now,
      finishedAt: input.now,
    };
    const cancelledWorkItem: WorkItem = {
      ...workItem,
      state: "CANCELLED",
      currentStage: null,
      version: workItem.version + 1,
      updatedAt: input.now,
    };
    const cancelledQACorrection =
      suspendedQACorrection === null
        ? null
        : qaCorrectionRunSchema.parse({
            ...suspendedQACorrection,
            status: "CANCELLED",
            completedAt: input.now,
            version: suspendedQACorrection.version + 1,
          });
    return {
      action: "CANCEL",
      workItem: cancelledWorkItem,
      run: cancelledRun,
      stageAttempt: cancelledStageAttempt,
      request: resolvedRequest,
      decision,
      previousCorrection: cancelledCorrection,
      cancelledQACorrection,
      correctionRun: null,
      nextStageAttempt: null,
      dispatch: null,
      events: [
        { type: "HUMAN_REQUEST_RESOLVED", data: { request: resolvedRequest, decision } },
        {
          type: "STAGE_ATTEMPT_CHANGED",
          data: {
            run: cancelledRun,
            stageAttempt: cancelledStageAttempt,
            previousStatus: stageAttempt.status,
          },
        },
        { type: "VERIFICATION_CORRECTION_CANCELLED", data: { correctionRun: cancelledCorrection } },
        ...(cancelledQACorrection === null
          ? []
          : [{ type: "QA_CORRECTION_CANCELLED" as const, data: { correctionRun: cancelledQACorrection } }]),
        { type: "PIPELINE_CANCELLED", data: { run: cancelledRun, stageAttempt: cancelledStageAttempt } },
      ],
    };
  }

  const previousCorrection = verificationCorrectionRunSchema.parse({
    ...correctionRun,
    status: "SUPERSEDED",
    completedAt: input.now,
    version: correctionRun.version + 1,
  });
  const nextCorrection = verificationCorrectionRunSchema.parse({
    schemaVersion: 1,
    id: input.ids.correctionRunId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    budgetPosition: 3,
    automatic: false,
    sourceFailureId: failure.id,
    sourceVerificationRunId: failedVerificationRun.id,
    sourceImplementationTree: failedVerificationRun.implementationTree,
    resumesQACorrectionRunId: correctionRun.resumesQACorrectionRunId ?? null,
    status: "ACTIVE",
    createdAt: input.now,
    completedAt: null,
    version: 1,
  });
  const completedStageAttempt: StageAttempt = {
    ...stageAttempt,
    status: "SUCCEEDED",
    failureCode: null,
    version: stageAttempt.version + 1,
    finishedAt: input.now,
    resultTree: failedVerificationRun.implementationTree,
  };
  const nextStageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: input.ids.nextStageAttemptId,
    pipelineRunId: run.id,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    correctionRunId: correctionRun.resumesQACorrectionRunId ?? null,
    verificationCorrectionRunId: nextCorrection.id,
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
  const resumedRun: PipelineRun = {
    ...run,
    status: "RUNNING",
    currentStageAttemptId: nextStageAttempt.id,
    version: run.version + 1,
    updatedAt: input.now,
  };
  const resumedWorkItem: WorkItem = {
    ...workItem,
    state: "IN_PROGRESS",
    currentStage: "IMPLEMENT",
    version: workItem.version + 1,
    updatedAt: input.now,
  };
  const dispatch: WorkflowDispatch = {
    schemaVersion: 1,
    id: input.ids.dispatchId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    stageAttemptId: nextStageAttempt.id,
    mode: "START",
    status: "PENDING",
    createdAt: input.now,
    completedAt: null,
  };
  return {
    action: "AUTHORIZE_FINAL",
    workItem: resumedWorkItem,
    run: resumedRun,
    stageAttempt: completedStageAttempt,
    request: resolvedRequest,
    decision,
    previousCorrection,
    cancelledQACorrection: null,
    correctionRun: nextCorrection,
    nextStageAttempt,
    dispatch,
    events: [
      { type: "HUMAN_REQUEST_RESOLVED", data: { request: resolvedRequest, decision } },
      { type: "VERIFICATION_CORRECTION_SUPERSEDED", data: { correctionRun: previousCorrection } },
      { type: "VERIFICATION_CORRECTION_STARTED", data: { correctionRun: nextCorrection } },
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: { run: resumedRun, stageAttempt: completedStageAttempt, previousStatus: stageAttempt.status },
      },
    ],
  };
};

export type MixedVerificationCorrectionGateResolution =
  | {
      action: "AUTHORIZE_FINAL";
      workItem: WorkItem;
      run: PipelineRun;
      stageAttempt: StageAttempt;
      request: HumanRequest;
      decision: Decision;
      previousCorrection: null;
      qaCorrection: QACorrectionRun;
      correctionRun: VerificationCorrectionRun;
      nextStageAttempt: StageAttempt;
      dispatch: WorkflowDispatch;
      events: readonly VerificationCorrectionGateEvent[];
    }
  | {
      action: "CANCEL";
      workItem: WorkItem;
      run: PipelineRun;
      stageAttempt: StageAttempt;
      request: HumanRequest;
      decision: Decision;
      previousCorrection: null;
      qaCorrection: QACorrectionRun;
      correctionRun: null;
      nextStageAttempt: null;
      dispatch: null;
      events: readonly VerificationCorrectionGateEvent[];
    };

/** Resolves a verification owner gate whose current authority is a suspended QA correction. */
export const decideMixedVerificationCorrectionGateResolution = (input: {
  command: ResolveVerificationCorrectionGateCommand;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
  qaCorrectionRun: QACorrectionRun;
  failedVerificationRun: VerificationRun;
  failure: VerificationFailure;
  budgetUsage: { automaticUsed: number; totalUsed: number };
  ids: {
    decisionId: string;
    correctionRunId: string;
    nextStageAttemptId: string;
    dispatchId: string;
  };
  now: string;
}): MixedVerificationCorrectionGateResolution => {
  const qaCorrectionRun = qaCorrectionRunSchema.parse(input.qaCorrectionRun);
  const failedVerificationRun = verificationRunSchema.parse(input.failedVerificationRun);
  const failure = verificationFailureSchema.parse(input.failure);
  const { command, workItem, run, stageAttempt, request } = input;
  const commandQACorrectionRunId = command.payload.qaCorrectionRunId ?? null;
  const expectedQACorrectionVersion = command.payload.expectedQACorrectionVersion ?? null;
  if (command.actor.type !== "HUMAN") {
    throw new VerificationCorrectionError(
      "ACTOR_FORBIDDEN",
      "Only the owner can resolve an exhausted Project verification correction gate",
    );
  }
  if (
    request.id !== command.payload.humanRequestId ||
    command.payload.correctionRunId !== null ||
    commandQACorrectionRunId !== qaCorrectionRun.id
  ) {
    throw new VerificationCorrectionError(
      "REQUEST_INVALID",
      "The owner action does not identify this mixed Project verification correction gate",
    );
  }
  if (
    request.version !== command.payload.expectedRequestVersion ||
    expectedQACorrectionVersion !== qaCorrectionRun.version ||
    run.version !== command.payload.expectedPipelineRunVersion
  ) {
    throw new VerificationCorrectionError(
      "VERSION_CONFLICT",
      "The mixed Project verification correction gate changed after it was loaded",
    );
  }
  const budget = decideCorrectionBudget(input.budgetUsage);
  const canAuthorizeFinal = budget.action === "WAIT_FOR_OWNER";
  const sameDelivery =
    qaCorrectionRun.status === "ACTIVE" &&
    request.status === "OPEN" &&
    request.kind === "SINGLE_CHOICE" &&
    request.blocking &&
    !request.allowOther &&
    request.options.length === (canAuthorizeFinal ? 2 : 1) &&
    workItem.id === qaCorrectionRun.workItemId &&
    workItem.projectId === qaCorrectionRun.projectId &&
    workItem.state === "BLOCKED" &&
    workItem.currentStage === "QA" &&
    run.id === qaCorrectionRun.pipelineRunId &&
    run.projectId === workItem.projectId &&
    run.workItemId === workItem.id &&
    run.status === "WAITING_HUMAN" &&
    run.currentStageAttemptId === stageAttempt.id &&
    stageAttempt.projectId === workItem.projectId &&
    stageAttempt.workItemId === workItem.id &&
    stageAttempt.pipelineRunId === run.id &&
    stageAttempt.correctionRunId === qaCorrectionRun.id &&
    (stageAttempt.verificationCorrectionRunId ?? null) === null &&
    stageAttempt.stage === "QA" &&
    stageAttempt.status === "WAITING_HUMAN" &&
    stageAttempt.failureCode === "VERIFICATION_CORRECTION_EXHAUSTED" &&
    request.projectId === workItem.projectId &&
    request.workItemId === workItem.id &&
    request.stageAttemptId === stageAttempt.id &&
    (failedVerificationRun.status === "FAILED" || failedVerificationRun.status === "ERROR") &&
    (failedVerificationRun.verificationCorrectionRunId ?? null) === null &&
    failedVerificationRun.projectId === workItem.projectId &&
    failedVerificationRun.workItemId === workItem.id &&
    failedVerificationRun.pipelineRunId === run.id &&
    failure.verificationRunId === failedVerificationRun.id &&
    failure.projectId === workItem.projectId &&
    failure.workItemId === workItem.id &&
    failure.pipelineRunId === run.id &&
    failure.planId === failedVerificationRun.planId &&
    failure.planRevision === failedVerificationRun.planRevision &&
    failure.planContentHash === failedVerificationRun.planContentHash &&
    failure.implementationTree === failedVerificationRun.implementationTree &&
    (failure.reason === "REQUIRED_CHECK_FAILED" || failure.reason === "REQUIRED_CHECK_ERROR");
  if (!sameDelivery) {
    throw new VerificationCorrectionError(
      "LINEAGE_MISMATCH",
      "The request is not the current mixed Project verification correction gate",
    );
  }
  if (command.payload.action === "AUTHORIZE_FINAL" && !canAuthorizeFinal) {
    throw new VerificationCorrectionError(
      "BUDGET_UNAVAILABLE",
      "The final owner-authorized Project verification correction is no longer available",
    );
  }
  const optionId =
    command.payload.action === "AUTHORIZE_FINAL" ? request.options[0]?.id : request.options.at(-1)?.id;
  if (optionId === undefined) {
    throw new VerificationCorrectionError(
      "REQUEST_INVALID",
      "The mixed Project verification gate does not contain the requested action",
    );
  }
  const resolvedRequest: HumanRequest = {
    ...request,
    status: "RESOLVED",
    version: request.version + 1,
    resolvedAt: input.now,
  };
  const decision: Decision = {
    schemaVersion: 1,
    id: input.ids.decisionId,
    projectId: request.projectId,
    workItemId: request.workItemId,
    humanRequestId: request.id,
    answer: { type: "OPTION", optionIds: [optionId] },
    actor: command.actor,
    reason:
      command.payload.action === "AUTHORIZE_FINAL"
        ? "Owner authorized the final shared Project verification correction inside Browser QA."
        : "Owner cancelled the delivery at the mixed Project verification correction gate.",
    createdAt: input.now,
  };

  if (command.payload.action === "CANCEL") {
    const cancelledQACorrection = qaCorrectionRunSchema.parse({
      ...qaCorrectionRun,
      status: "CANCELLED",
      completedAt: input.now,
      version: qaCorrectionRun.version + 1,
    });
    const cancelledStageAttempt: StageAttempt = {
      ...stageAttempt,
      status: "CANCELLED",
      version: stageAttempt.version + 1,
      finishedAt: input.now,
    };
    const cancelledRun: PipelineRun = {
      ...run,
      status: "CANCELLED",
      version: run.version + 1,
      updatedAt: input.now,
      finishedAt: input.now,
    };
    const cancelledWorkItem: WorkItem = {
      ...workItem,
      state: "CANCELLED",
      currentStage: null,
      version: workItem.version + 1,
      updatedAt: input.now,
    };
    return {
      action: "CANCEL",
      workItem: cancelledWorkItem,
      run: cancelledRun,
      stageAttempt: cancelledStageAttempt,
      request: resolvedRequest,
      decision,
      previousCorrection: null,
      qaCorrection: cancelledQACorrection,
      correctionRun: null,
      nextStageAttempt: null,
      dispatch: null,
      events: [
        { type: "HUMAN_REQUEST_RESOLVED", data: { request: resolvedRequest, decision } },
        {
          type: "STAGE_ATTEMPT_CHANGED",
          data: {
            run: cancelledRun,
            stageAttempt: cancelledStageAttempt,
            previousStatus: stageAttempt.status,
          },
        },
        { type: "QA_CORRECTION_CANCELLED", data: { correctionRun: cancelledQACorrection } },
        { type: "PIPELINE_CANCELLED", data: { run: cancelledRun, stageAttempt: cancelledStageAttempt } },
      ],
    };
  }

  if (budget.action !== "WAIT_FOR_OWNER") {
    throw new VerificationCorrectionError(
      "BUDGET_UNAVAILABLE",
      "The final shared Project verification correction position is unavailable",
    );
  }
  const nextCorrection = verificationCorrectionRunSchema.parse({
    schemaVersion: 1,
    id: input.ids.correctionRunId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    budgetPosition: budget.position,
    automatic: false,
    sourceFailureId: failure.id,
    sourceVerificationRunId: failedVerificationRun.id,
    sourceImplementationTree: failedVerificationRun.implementationTree,
    resumesQACorrectionRunId: qaCorrectionRun.id,
    status: "ACTIVE",
    createdAt: input.now,
    completedAt: null,
    version: 1,
  });
  const completedStageAttempt: StageAttempt = {
    ...stageAttempt,
    status: "SUCCEEDED",
    failureCode: null,
    version: stageAttempt.version + 1,
    finishedAt: input.now,
    resultTree: failedVerificationRun.implementationTree,
  };
  const nextStageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: input.ids.nextStageAttemptId,
    pipelineRunId: run.id,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    correctionRunId: qaCorrectionRun.id,
    verificationCorrectionRunId: nextCorrection.id,
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
  const resumedRun: PipelineRun = {
    ...run,
    status: "RUNNING",
    currentStageAttemptId: nextStageAttempt.id,
    version: run.version + 1,
    updatedAt: input.now,
  };
  const resumedWorkItem: WorkItem = {
    ...workItem,
    state: "IN_PROGRESS",
    currentStage: "IMPLEMENT",
    version: workItem.version + 1,
    updatedAt: input.now,
  };
  const dispatch: WorkflowDispatch = {
    schemaVersion: 1,
    id: input.ids.dispatchId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    stageAttemptId: nextStageAttempt.id,
    mode: "START",
    status: "PENDING",
    createdAt: input.now,
    completedAt: null,
  };
  return {
    action: "AUTHORIZE_FINAL",
    workItem: resumedWorkItem,
    run: resumedRun,
    stageAttempt: completedStageAttempt,
    request: resolvedRequest,
    decision,
    previousCorrection: null,
    qaCorrection: qaCorrectionRun,
    correctionRun: nextCorrection,
    nextStageAttempt,
    dispatch,
    events: [
      { type: "HUMAN_REQUEST_RESOLVED", data: { request: resolvedRequest, decision } },
      { type: "VERIFICATION_CORRECTION_STARTED", data: { correctionRun: nextCorrection } },
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: { run: resumedRun, stageAttempt: completedStageAttempt, previousStatus: stageAttempt.status },
      },
    ],
  };
};
