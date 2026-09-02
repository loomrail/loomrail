import {
  MAX_AUTOMATIC_QA_CORRECTION_RUNS,
  MAX_TOTAL_QA_CORRECTION_RUNS,
  qaCorrectionRunSchema,
  qaDefectSchema,
  qaEvidenceBundleSchema,
  evidenceArtifactSchema,
  reviewReportSchema,
  qaRetestCellReasons,
  qaRetestPlanSchema,
  qaRunSchema,
  type QACorrectionRun,
  type QACorrectionCancelledEvent,
  type QACorrectionExhaustedEvent,
  type QACorrectionPassedEvent,
  type QACorrectionStartedEvent,
  type Decision,
  type QADefect,
  type QADefectWaivedEvent,
  type QAEvidenceBundle,
  type QARetestCellReason,
  type QARetestPlan,
  type QARun,
  type HumanRequest,
  type HumanRequestOpenedEvent,
  type HumanRequestResolvedEvent,
  type PipelineRun,
  type PipelineCancelledEvent,
  type EvidenceArtifact,
  type ReviewReport,
  type StageAttempt,
  type StageAttemptChangedEvent,
  type ResolveQACorrectionGateCommand,
  type WaiveQADefectCommand,
  type WorkflowDispatch,
  type WorkItem,
} from "@loomrail/contracts";

export type QADefectDispositionErrorCode =
  | "QA_DEFECT_NOT_FOUND"
  | "QA_DEFECT_ACTOR_FORBIDDEN"
  | "QA_DEFECT_VERSION_CONFLICT"
  | "QA_DEFECT_ALREADY_CLOSED";

export class QADefectDispositionError extends Error {
  readonly code: QADefectDispositionErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: QADefectDispositionErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "QADefectDispositionError";
    this.code = code;
    this.details = details;
  }
}

export type QADefectDispositionDecision = {
  defect: QADefect;
  events: readonly {
    type: QADefectWaivedEvent["type"];
    data: QADefectWaivedEvent["data"];
  }[];
};

/** Records the owner's risk acceptance without changing the measured QA outcome or evidence. */
export const decideQADefectWaiver = (
  command: WaiveQADefectCommand,
  context: { defect?: QADefect | undefined; now: string },
): QADefectDispositionDecision => {
  if (command.actor.type !== "HUMAN") {
    throw new QADefectDispositionError("QA_DEFECT_ACTOR_FORBIDDEN", "Only the owner can waive a QA defect");
  }
  if (context.defect?.id !== command.payload.defectId) {
    throw new QADefectDispositionError("QA_DEFECT_NOT_FOUND", "The QA defect does not exist");
  }
  if (context.defect.version !== command.payload.expectedVersion) {
    throw new QADefectDispositionError(
      "QA_DEFECT_VERSION_CONFLICT",
      "The QA defect changed before the waiver was recorded",
      { expectedVersion: command.payload.expectedVersion, actualVersion: context.defect.version },
    );
  }
  if (context.defect.status !== "OPEN") {
    throw new QADefectDispositionError("QA_DEFECT_ALREADY_CLOSED", "Only an open QA defect can be waived", {
      status: context.defect.status,
    });
  }
  const defect: QADefect = {
    ...context.defect,
    status: "WAIVED",
    resolutionReason: command.payload.reason,
    resolvedAt: context.now,
    version: context.defect.version + 1,
  };
  return {
    defect,
    events: [{ type: "QA_DEFECT_WAIVED", data: { defect } }],
  };
};

export type QACorrectionErrorCode =
  | "QA_CORRECTION_ACTOR_FORBIDDEN"
  | "QA_CORRECTION_SOURCE_INVALID"
  | "QA_CORRECTION_LINEAGE_MISMATCH"
  | "QA_CORRECTION_REQUEST_INVALID"
  | "QA_CORRECTION_SCOPE_EMPTY"
  | "QA_CORRECTION_SCOPE_INVALID"
  | "QA_CORRECTION_STATE_MISMATCH"
  | "QA_CORRECTION_LIMIT_REACHED"
  | "QA_CORRECTION_VERSION_CONFLICT";

export class QACorrectionError extends Error {
  readonly code: QACorrectionErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: QACorrectionErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "QACorrectionError";
    this.code = code;
    this.details = details;
  }
}

const cellKey = (targetId: string, scenarioId: string): string => `${targetId}\u0000${scenarioId}`;

const requireSameDelivery = (baseline: QARun, source: QARun, evidence: QAEvidenceBundle): void => {
  if (
    source.projectId !== baseline.projectId ||
    source.workItemId !== baseline.workItemId ||
    source.pipelineRunId !== baseline.pipelineRunId ||
    evidence.projectId !== source.projectId ||
    evidence.workItemId !== source.workItemId ||
    evidence.pipelineRunId !== source.pipelineRunId ||
    evidence.qaRunId !== source.id ||
    evidence.stageAttemptId !== source.stageAttemptId ||
    evidence.testedTree !== source.testedTree
  ) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The QA failure, evidence, and baseline do not belong to one delivery lineage",
    );
  }
  if (
    source.plan.revision !== baseline.plan.revision ||
    source.plan.contentHash !== baseline.plan.contentHash ||
    source.targetOrigin !== baseline.targetOrigin ||
    JSON.stringify(source.plan.targets) !== JSON.stringify(baseline.plan.targets) ||
    JSON.stringify(source.plan.scenarios) !== JSON.stringify(baseline.plan.scenarios)
  ) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The QA failure does not use the locked baseline plan",
    );
  }
};

/**
 * Derives the only retest scope persistence may attach to a correction run.
 *
 * The provider supplies none of the scope. The result preserves baseline matrix order and keeps
 * regression selection deterministic so a retry or daemon restart produces the same plan.
 */
export const deriveQARetestPlan = (input: {
  retestPlanId: string;
  correctionRunId: string;
  baselineQARun: QARun;
  sourceQARun: QARun;
  sourceEvidence: QAEvidenceBundle;
  openDefects: readonly QADefect[];
  now: string;
}): QARetestPlan => {
  const baseline = qaRunSchema.parse(input.baselineQARun);
  const source = qaRunSchema.parse(input.sourceQARun);
  const evidence = qaEvidenceBundleSchema.parse(input.sourceEvidence);
  const defects = input.openDefects.map((defect) => qaDefectSchema.parse(defect));
  if (baseline.status !== "FAILED" || source.status !== "FAILED" || evidence.verdict !== "FAILED") {
    throw new QACorrectionError(
      "QA_CORRECTION_SOURCE_INVALID",
      "A correction retest plan requires a measured failed baseline and source QA run",
    );
  }
  requireSameDelivery(baseline, source, evidence);
  if (defects.length === 0) {
    throw new QACorrectionError(
      "QA_CORRECTION_SCOPE_EMPTY",
      "A failed QA correction source requires at least one open defect",
    );
  }

  const matrix = baseline.plan.targets.flatMap((target) =>
    baseline.plan.scenarios.map((scenario) => ({
      targetId: target.id,
      scenarioId: scenario.id,
      key: cellKey(target.id, scenario.id),
    })),
  );
  const matrixKeys = new Set(matrix.map(({ key }) => key));
  const reasons = new Map<string, Set<QARetestCellReason>>();
  const addReason = (key: string, reason: QARetestCellReason): void => {
    if (!matrixKeys.has(key)) {
      const [targetId = "", scenarioId = ""] = key.split("\u0000");
      throw new QACorrectionError(
        "QA_CORRECTION_SCOPE_INVALID",
        "QA correction evidence refers to a cell outside the locked baseline plan",
        { targetId, scenarioId },
      );
    }
    const current = reasons.get(key) ?? new Set<QARetestCellReason>();
    current.add(reason);
    reasons.set(key, current);
  };

  const executionKeys = new Set<string>();
  for (const execution of evidence.executions) {
    const key = cellKey(execution.targetId, execution.scenarioId);
    if (executionKeys.has(key)) {
      throw new QACorrectionError(
        "QA_CORRECTION_SCOPE_INVALID",
        "QA correction evidence repeats a target/scenario execution",
        { targetId: execution.targetId, scenarioId: execution.scenarioId },
      );
    }
    executionKeys.add(key);
    if (!matrixKeys.has(key)) {
      addReason(key, "FAILED_CHECK");
    }
    const failed =
      execution.steps.some(({ status }) => status === "FAILED") ||
      execution.assertions.some(({ status }) => status === "FAILED");
    if (failed) addReason(key, "FAILED_CHECK");
  }
  for (const observation of evidence.observations) {
    if (observation.blocking) {
      addReason(cellKey(observation.targetId, observation.scenarioId), "BLOCKING_OBSERVATION");
    }
  }

  const defectIds = new Set<string>();
  for (const defect of defects) {
    if (defectIds.has(defect.id)) {
      throw new QACorrectionError(
        "QA_CORRECTION_SCOPE_INVALID",
        "QA correction input repeats an open defect",
        { defectId: defect.id },
      );
    }
    defectIds.add(defect.id);
    if (
      defect.status !== "OPEN" ||
      defect.projectId !== source.projectId ||
      defect.workItemId !== source.workItemId
    ) {
      throw new QACorrectionError(
        "QA_CORRECTION_LINEAGE_MISMATCH",
        "QA correction input contains a closed or unrelated defect",
        { defectId: defect.id },
      );
    }
    addReason(cellKey(defect.targetId, defect.scenarioId), "OPEN_DEFECT");
  }
  for (const sourceDefectId of evidence.defectIds) {
    if (!defectIds.has(sourceDefectId)) {
      throw new QACorrectionError(
        "QA_CORRECTION_LINEAGE_MISMATCH",
        "The open defect set omits a defect from the immediate QA failure",
        { defectId: sourceDefectId },
      );
    }
  }

  const affectedKeys = new Set(reasons.keys());
  if (affectedKeys.size === 0) {
    throw new QACorrectionError(
      "QA_CORRECTION_SCOPE_EMPTY",
      "The QA failure has no affected target/scenario cell",
    );
  }
  const affectedTargets = new Set(
    matrix.filter(({ key }) => affectedKeys.has(key)).map(({ targetId }) => targetId),
  );
  const affectedScenarios = new Set(
    matrix.filter(({ key }) => affectedKeys.has(key)).map(({ scenarioId }) => scenarioId),
  );

  for (const target of baseline.plan.targets) {
    if (!affectedTargets.has(target.id)) continue;
    const regression = matrix.find(({ targetId, key }) => targetId === target.id && !affectedKeys.has(key));
    if (regression) addReason(regression.key, "REGRESSION");
  }
  for (const scenario of baseline.plan.scenarios) {
    if (!affectedScenarios.has(scenario.id)) continue;
    const regression = matrix.find(
      ({ scenarioId, key }) => scenarioId === scenario.id && !affectedKeys.has(key),
    );
    if (regression) addReason(regression.key, "REGRESSION");
  }
  const hasRegression = [...reasons.values()].some((cellReasons) => cellReasons.has("REGRESSION"));
  if (!hasRegression) {
    const regression = matrix.find(({ key }) => !affectedKeys.has(key));
    if (regression) addReason(regression.key, "REGRESSION");
  }

  return qaRetestPlanSchema.parse({
    schemaVersion: 1,
    id: input.retestPlanId,
    projectId: source.projectId,
    workItemId: source.workItemId,
    pipelineRunId: source.pipelineRunId,
    correctionRunId: input.correctionRunId,
    baselineQARunId: baseline.id,
    sourceQARunId: source.id,
    sourceEvidenceBundleId: evidence.id,
    baselinePlanRevision: baseline.plan.revision,
    baselinePlanContentHash: baseline.plan.contentHash,
    cells: matrix
      .filter(({ key }) => reasons.has(key))
      .map(({ targetId, scenarioId, key }) => ({
        targetId,
        scenarioId,
        reasons: qaRetestCellReasons.filter((reason) => reasons.get(key)?.has(reason)),
      })),
    createdAt: input.now,
  });
};

export type QACorrectionLoopDecision =
  | { action: "ADVANCE_BASELINE_TO_ACCEPTANCE" }
  | { action: "RETRY_ENVIRONMENT"; correctionRun: QACorrectionRun | null }
  | {
      action: "START_CORRECTION";
      automatic: true;
      nextOrdinal: number;
      previousCorrection: QACorrectionRun | null;
    }
  | { action: "PASS_CORRECTION"; correctionRun: QACorrectionRun }
  | {
      action: "WAIT_FOR_OWNER";
      correctionRun: QACorrectionRun;
      canAuthorizeFinal: boolean;
    };

/** Selects the bounded workflow branch after one completed browser QA run. */
export const decideQACorrectionLoop = (input: {
  qaRun: QARun;
  currentCorrection?: QACorrectionRun | undefined;
  now: string;
}): QACorrectionLoopDecision => {
  const qaRun = qaRunSchema.parse(input.qaRun);
  const correction =
    input.currentCorrection === undefined ? undefined : qaCorrectionRunSchema.parse(input.currentCorrection);
  if (qaRun.status === "RUNNING") {
    throw new QACorrectionError(
      "QA_CORRECTION_SOURCE_INVALID",
      "A running QA run has no correction-loop outcome",
    );
  }
  if (
    correction !== undefined &&
    (correction.projectId !== qaRun.projectId ||
      correction.workItemId !== qaRun.workItemId ||
      correction.pipelineRunId !== qaRun.pipelineRunId)
  ) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The QA run and current correction do not belong to one delivery",
    );
  }
  if (correction !== undefined && correction.status !== "ACTIVE") {
    throw new QACorrectionError(
      "QA_CORRECTION_STATE_MISMATCH",
      "Only the active correction can receive a QA outcome",
      { status: correction.status },
    );
  }

  if (qaRun.status === "ERROR") {
    return { action: "RETRY_ENVIRONMENT", correctionRun: correction ?? null };
  }
  if (qaRun.status === "PASSED") {
    if (correction === undefined) return { action: "ADVANCE_BASELINE_TO_ACCEPTANCE" };
    return {
      action: "PASS_CORRECTION",
      correctionRun: qaCorrectionRunSchema.parse({
        ...correction,
        status: "PASSED",
        completedAt: input.now,
        version: correction.version + 1,
      }),
    };
  }
  if (correction === undefined) {
    return { action: "START_CORRECTION", automatic: true, nextOrdinal: 1, previousCorrection: null };
  }
  if (correction.ordinal < MAX_AUTOMATIC_QA_CORRECTION_RUNS) {
    return {
      action: "START_CORRECTION",
      automatic: true,
      nextOrdinal: correction.ordinal + 1,
      previousCorrection: qaCorrectionRunSchema.parse({
        ...correction,
        status: "SUPERSEDED",
        completedAt: input.now,
        version: correction.version + 1,
      }),
    };
  }
  return {
    action: "WAIT_FOR_OWNER",
    correctionRun: qaCorrectionRunSchema.parse({
      ...correction,
      status: "EXHAUSTED",
      completedAt: null,
      version: correction.version + 1,
    }),
    canAuthorizeFinal: correction.ordinal < MAX_TOTAL_QA_CORRECTION_RUNS,
  };
};

type QACorrectionTransitionEvent =
  | Pick<QACorrectionStartedEvent, "type" | "data">
  | Pick<QACorrectionExhaustedEvent, "type" | "data">
  | Pick<StageAttemptChangedEvent, "type" | "data">
  | Pick<HumanRequestOpenedEvent, "type" | "data">;

export type FailedQACorrectionTransition =
  | {
      action: "START_CORRECTION";
      workItem: WorkItem;
      run: PipelineRun;
      completedStageAttempt: StageAttempt;
      completedDispatch: WorkflowDispatch;
      previousCorrection: QACorrectionRun | null;
      correctionRun: QACorrectionRun;
      retestPlan: QARetestPlan;
      nextStageAttempt: StageAttempt;
      nextDispatch: WorkflowDispatch;
      request: null;
      events: readonly QACorrectionTransitionEvent[];
    }
  | {
      action: "WAIT_FOR_OWNER";
      workItem: WorkItem;
      run: PipelineRun;
      completedStageAttempt: StageAttempt;
      completedDispatch: WorkflowDispatch;
      previousCorrection: QACorrectionRun;
      correctionRun: null;
      retestPlan: null;
      nextStageAttempt: null;
      nextDispatch: null;
      request: HumanRequest;
      events: readonly QACorrectionTransitionEvent[];
    };

const assertQAFailureWorkflowLineage = (input: {
  qaRun: QARun;
  sourceEvidence: QAEvidenceBundle;
  baselineQARun: QARun;
  currentCorrection?: QACorrectionRun | undefined;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
}): void => {
  const { qaRun, sourceEvidence, baselineQARun, currentCorrection, workItem, run, stageAttempt, dispatch } =
    input;
  const sameDelivery =
    qaRun.status === "FAILED" &&
    sourceEvidence.verdict === "FAILED" &&
    sourceEvidence.qaRunId === qaRun.id &&
    sourceEvidence.stageAttemptId === stageAttempt.id &&
    baselineQARun.status === "FAILED" &&
    baselineQARun.id === (currentCorrection?.baselineQARunId ?? qaRun.id) &&
    workItem.id === qaRun.workItemId &&
    workItem.projectId === qaRun.projectId &&
    workItem.state === "IN_PROGRESS" &&
    workItem.currentStage === "QA" &&
    run.id === qaRun.pipelineRunId &&
    run.workItemId === workItem.id &&
    run.projectId === workItem.projectId &&
    run.status === "RUNNING" &&
    run.currentStageAttemptId === stageAttempt.id &&
    stageAttempt.id === qaRun.stageAttemptId &&
    stageAttempt.projectId === workItem.projectId &&
    stageAttempt.workItemId === workItem.id &&
    stageAttempt.pipelineRunId === run.id &&
    stageAttempt.stage === "QA" &&
    stageAttempt.status === "RUNNING" &&
    dispatch.projectId === workItem.projectId &&
    dispatch.workItemId === workItem.id &&
    dispatch.pipelineRunId === run.id &&
    dispatch.stageAttemptId === stageAttempt.id &&
    dispatch.status === "PENDING";
  const scopeMatches =
    qaRun.scope.type === "FULL"
      ? currentCorrection === undefined && stageAttempt.correctionRunId === null
      : currentCorrection?.id === qaRun.scope.correctionRunId &&
        currentCorrection.id === stageAttempt.correctionRunId &&
        currentCorrection.status === "ACTIVE";
  if (!sameDelivery || !scopeMatches) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The failed QA run is not the current measured stage of this correction lineage",
    );
  }
};

/**
 * Owns the complete workflow mutation after measured QA failure.
 *
 * Persistence supplies identities and commits this decision atomically; neither the driver nor the daemon
 * selects defect scope, correction ordinal, workflow state, or the owner gate.
 */
export const decideFailedQACorrectionTransition = (input: {
  qaRun: QARun;
  sourceEvidence: QAEvidenceBundle;
  baselineQARun: QARun;
  openDefects: readonly QADefect[];
  currentCorrection?: QACorrectionRun | undefined;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  ids: {
    correctionRunId: string;
    retestPlanId: string;
    nextStageAttemptId: string;
    nextDispatchId: string;
    humanRequestId: string;
    authorizeFinalOptionId: string;
    cancelOptionId: string;
  };
  now: string;
}): FailedQACorrectionTransition => {
  const qaRun = qaRunSchema.parse(input.qaRun);
  const evidence = qaEvidenceBundleSchema.parse(input.sourceEvidence);
  const baseline = qaRunSchema.parse(input.baselineQARun);
  const currentCorrection =
    input.currentCorrection === undefined ? undefined : qaCorrectionRunSchema.parse(input.currentCorrection);
  const openDefects = input.openDefects.map((defect) => qaDefectSchema.parse(defect));
  assertQAFailureWorkflowLineage({
    qaRun,
    sourceEvidence: evidence,
    baselineQARun: baseline,
    ...(currentCorrection === undefined ? {} : { currentCorrection }),
    workItem: input.workItem,
    run: input.run,
    stageAttempt: input.stageAttempt,
    dispatch: input.dispatch,
  });
  const loop = decideQACorrectionLoop({
    qaRun,
    ...(currentCorrection === undefined ? {} : { currentCorrection }),
    now: input.now,
  });
  if (loop.action !== "START_CORRECTION" && loop.action !== "WAIT_FOR_OWNER") {
    throw new QACorrectionError(
      "QA_CORRECTION_STATE_MISMATCH",
      "A measured QA failure did not produce a correction transition",
    );
  }

  const completedDispatch: WorkflowDispatch = {
    ...input.dispatch,
    status: "COMPLETED",
    completedAt: input.now,
  };
  if (loop.action === "WAIT_FOR_OWNER") {
    const completedStageAttempt: StageAttempt = {
      ...input.stageAttempt,
      status: "WAITING_HUMAN",
      failureCode: "QA_CORRECTION_EXHAUSTED",
      version: input.stageAttempt.version + 1,
    };
    const run: PipelineRun = {
      ...input.run,
      status: "WAITING_HUMAN",
      version: input.run.version + 1,
      updatedAt: input.now,
    };
    const workItem: WorkItem = {
      ...input.workItem,
      state: "BLOCKED",
      currentStage: "QA",
      version: input.workItem.version + 1,
      updatedAt: input.now,
    };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: input.ids.humanRequestId,
      projectId: workItem.projectId,
      workItemId: workItem.id,
      stageAttemptId: completedStageAttempt.id,
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "QA correction loop needs a decision",
      context: loop.canAuthorizeFinal
        ? "Two automatic QA correction runs still ended in measured defects."
        : "The owner-authorized final QA correction still ended in measured defects.",
      recommendation: loop.canAuthorizeFinal
        ? "Inspect the complete defect and evidence history before authorizing the one final correction."
        : "Inspect the remaining defects and cancel this delivery when no further bounded correction is available.",
      options: [
        ...(loop.canAuthorizeFinal
          ? [
              {
                id: input.ids.authorizeFinalOptionId,
                label: "Authorize one final QA correction",
                consequence: "Creates CorrectionRun 3 with a locked retest plan.",
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
    };
    return {
      action: "WAIT_FOR_OWNER",
      workItem,
      run,
      completedStageAttempt,
      completedDispatch,
      previousCorrection: loop.correctionRun,
      correctionRun: null,
      retestPlan: null,
      nextStageAttempt: null,
      nextDispatch: null,
      request,
      events: [
        {
          type: "STAGE_ATTEMPT_CHANGED",
          data: { run, stageAttempt: completedStageAttempt, previousStatus: input.stageAttempt.status },
        },
        { type: "HUMAN_REQUEST_OPENED", data: { request } },
        {
          type: "QA_CORRECTION_EXHAUSTED",
          data: { correctionRun: loop.correctionRun, canAuthorizeFinal: loop.canAuthorizeFinal },
        },
      ],
    };
  }

  const correctionRun = qaCorrectionRunSchema.parse({
    schemaVersion: 1,
    id: input.ids.correctionRunId,
    projectId: qaRun.projectId,
    workItemId: qaRun.workItemId,
    pipelineRunId: qaRun.pipelineRunId,
    ordinal: loop.nextOrdinal,
    sourceQARunId: qaRun.id,
    baselineQARunId: baseline.id,
    sourceEvidenceBundleId: evidence.id,
    sourceTestedTree: qaRun.testedTree,
    defectIds: openDefects.map(({ id }) => id),
    status: "ACTIVE",
    createdAt: input.now,
    completedAt: null,
    version: 1,
  });
  const retestPlan = deriveQARetestPlan({
    retestPlanId: input.ids.retestPlanId,
    correctionRunId: correctionRun.id,
    baselineQARun: baseline,
    sourceQARun: qaRun,
    sourceEvidence: evidence,
    openDefects,
    now: input.now,
  });
  const completedStageAttempt: StageAttempt = {
    ...input.stageAttempt,
    status: "SUCCEEDED",
    version: input.stageAttempt.version + 1,
    finishedAt: input.now,
    resultTree: qaRun.testedTree,
  };
  const nextStageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: input.ids.nextStageAttemptId,
    pipelineRunId: input.run.id,
    projectId: input.workItem.projectId,
    workItemId: input.workItem.id,
    correctionRunId: correctionRun.id,
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
  const run: PipelineRun = {
    ...input.run,
    status: "RUNNING",
    currentStageAttemptId: nextStageAttempt.id,
    version: input.run.version + 1,
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
    pipelineRunId: run.id,
    stageAttemptId: nextStageAttempt.id,
    mode: "START",
    status: "PENDING",
    createdAt: input.now,
    completedAt: null,
  };
  return {
    action: "START_CORRECTION",
    workItem,
    run,
    completedStageAttempt,
    completedDispatch,
    previousCorrection: loop.previousCorrection,
    correctionRun,
    retestPlan,
    nextStageAttempt,
    nextDispatch,
    request: null,
    events: [
      { type: "QA_CORRECTION_STARTED", data: { correctionRun, retestPlan } },
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: { run, stageAttempt: completedStageAttempt, previousStatus: input.stageAttempt.status },
      },
    ],
  };
};

export type PassedQACorrectionTransition = {
  correctionRun: QACorrectionRun;
  resolvedDefects: readonly QADefect[];
  events: readonly Pick<QACorrectionPassedEvent, "type" | "data">[];
};

/** Proves the complete FULL baseline -> sequential corrections -> current passing RETEST chain. */
export const assertQACorrectionAcceptanceLineage = (input: {
  passingQARun: QARun;
  passingEvidence: QAEvidenceBundle;
  currentTree: string;
  correctionRuns: readonly QACorrectionRun[];
  retestPlans: readonly QARetestPlan[];
  qaRuns: readonly QARun[];
  evidenceBundles: readonly QAEvidenceBundle[];
  defects: readonly QADefect[];
}): void => {
  const passingQARun = qaRunSchema.parse(input.passingQARun);
  const passingEvidence = qaEvidenceBundleSchema.parse(input.passingEvidence);
  const correctionRuns = input.correctionRuns.map((run) => qaCorrectionRunSchema.parse(run));
  const retestPlans = input.retestPlans.map((plan) => qaRetestPlanSchema.parse(plan));
  const qaRuns = input.qaRuns.map((run) => qaRunSchema.parse(run));
  const evidenceBundles = input.evidenceBundles.map((bundle) => qaEvidenceBundleSchema.parse(bundle));
  const defects = input.defects.map((item) => qaDefectSchema.parse(item));
  const correctionIds = new Set(correctionRuns.map(({ id }) => id));
  const retestPlanIds = new Set(retestPlans.map(({ id }) => id));
  if (
    correctionRuns.length === 0 ||
    correctionRuns.length > MAX_TOTAL_QA_CORRECTION_RUNS ||
    retestPlans.length !== correctionRuns.length ||
    correctionIds.size !== correctionRuns.length ||
    retestPlanIds.size !== retestPlans.length ||
    defects.some(({ status }) => status === "OPEN")
  ) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "Acceptance requires a complete bounded correction history with no open QA defects",
    );
  }
  const firstCorrection = correctionRuns[0];
  const latestCorrection = correctionRuns.at(-1);
  if (firstCorrection === undefined || latestCorrection === undefined) {
    throw new QACorrectionError("QA_CORRECTION_LINEAGE_MISMATCH", "Acceptance requires a passing correction");
  }
  const baseline = qaRuns.find(({ id }) => id === firstCorrection.baselineQARunId);
  if (
    baseline?.status !== "FAILED" ||
    baseline.scope.type !== "FULL" ||
    passingQARun.status !== "PASSED" ||
    passingQARun.scope.type !== "RETEST" ||
    passingQARun.scope.correctionRunId !== latestCorrection.id ||
    passingEvidence.verdict !== "PASSED" ||
    passingEvidence.qaRunId !== passingQARun.id ||
    passingEvidence.projectId !== passingQARun.projectId ||
    passingEvidence.workItemId !== passingQARun.workItemId ||
    passingEvidence.pipelineRunId !== passingQARun.pipelineRunId ||
    passingEvidence.testedTree !== passingQARun.testedTree ||
    passingEvidence.stageAttemptId !== passingQARun.stageAttemptId ||
    passingEvidence.defectIds.length !== 0 ||
    passingQARun.testedTree !== input.currentTree ||
    latestCorrection.status !== "PASSED" ||
    latestCorrection.projectId !== passingQARun.projectId ||
    latestCorrection.workItemId !== passingQARun.workItemId ||
    latestCorrection.pipelineRunId !== passingQARun.pipelineRunId
  ) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "Acceptance QA is not the current passing correction retest",
    );
  }

  const defectById = new Map(defects.map((item) => [item.id, item]));
  for (const [index, correctionRun] of correctionRuns.entries()) {
    const ordinal = index + 1;
    const previousCorrection = correctionRuns.at(index - 1);
    const expectedStatus = index === correctionRuns.length - 1 ? "PASSED" : "SUPERSEDED";
    const retestPlan = retestPlans.find(({ correctionRunId }) => correctionRunId === correctionRun.id);
    const sourceQARun = qaRuns.find(({ id }) => id === correctionRun.sourceQARunId);
    const sourceEvidence = evidenceBundles.find(({ id }) => id === correctionRun.sourceEvidenceBundleId);
    if (retestPlan === undefined || sourceQARun === undefined || sourceEvidence === undefined) {
      throw new QACorrectionError(
        "QA_CORRECTION_LINEAGE_MISMATCH",
        "The correction history is missing its source run, evidence, or retest plan",
        { ordinal },
      );
    }
    const previousRetestPlan =
      previousCorrection === undefined
        ? undefined
        : retestPlans.find(({ correctionRunId }) => correctionRunId === previousCorrection.id);
    const sourceMatches =
      correctionRun.ordinal === ordinal &&
      correctionRun.status === expectedStatus &&
      correctionRun.projectId === passingQARun.projectId &&
      correctionRun.workItemId === passingQARun.workItemId &&
      correctionRun.pipelineRunId === passingQARun.pipelineRunId &&
      correctionRun.baselineQARunId === baseline.id &&
      correctionRun.defectIds.every((id) => {
        const item = defectById.get(id);
        return (
          item?.projectId === passingQARun.projectId &&
          item.workItemId === passingQARun.workItemId &&
          (item.status !== "RESOLVED" || item.resolvedByQARunId === passingQARun.id)
        );
      }) &&
      sourceQARun.status === "FAILED" &&
      sourceQARun.projectId === correctionRun.projectId &&
      sourceQARun.workItemId === correctionRun.workItemId &&
      sourceQARun.pipelineRunId === correctionRun.pipelineRunId &&
      sourceQARun.testedTree === correctionRun.sourceTestedTree &&
      sourceEvidence.verdict === "FAILED" &&
      sourceEvidence.qaRunId === sourceQARun.id &&
      sourceEvidence.projectId === sourceQARun.projectId &&
      sourceEvidence.workItemId === sourceQARun.workItemId &&
      sourceEvidence.pipelineRunId === sourceQARun.pipelineRunId &&
      sourceEvidence.stageAttemptId === sourceQARun.stageAttemptId &&
      sourceEvidence.testedTree === sourceQARun.testedTree &&
      sourceEvidence.defectIds.every((id) => correctionRun.defectIds.includes(id)) &&
      retestPlan.pipelineRunId === correctionRun.pipelineRunId &&
      retestPlan.workItemId === correctionRun.workItemId &&
      retestPlan.projectId === correctionRun.projectId &&
      retestPlan.baselineQARunId === baseline.id &&
      retestPlan.sourceQARunId === sourceQARun.id &&
      retestPlan.sourceEvidenceBundleId === sourceEvidence.id &&
      retestPlan.baselinePlanRevision === baseline.plan.revision &&
      retestPlan.baselinePlanContentHash === baseline.plan.contentHash &&
      (index === 0
        ? sourceQARun.id === baseline.id && sourceQARun.scope.type === "FULL"
        : sourceQARun.scope.type === "RETEST" &&
          sourceQARun.scope.correctionRunId === previousCorrection?.id &&
          sourceQARun.scope.retestPlanId === previousRetestPlan?.id);
    if (!sourceMatches) {
      throw new QACorrectionError(
        "QA_CORRECTION_LINEAGE_MISMATCH",
        "The correction history contains a gap, branch, stale source, or unlocked retest plan",
        { ordinal },
      );
    }
  }
  const latestRetestPlan = retestPlans.find(({ correctionRunId }) => correctionRunId === latestCorrection.id);
  if (latestRetestPlan?.id !== passingQARun.scope.retestPlanId) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The passing QA run did not execute the last correction's immutable retest plan",
    );
  }
};

/** Closes one correction only after its immutable browser retest produced measured green evidence. */
export const decidePassedQACorrectionTransition = (input: {
  qaRun: QARun;
  evidence: QAEvidenceBundle;
  currentCorrection: QACorrectionRun;
  defects: readonly QADefect[];
  openDefects: readonly QADefect[];
  reviewReport: ReviewReport;
  reviewArtifact: EvidenceArtifact;
  now: string;
}): PassedQACorrectionTransition => {
  const qaRun = qaRunSchema.parse(input.qaRun);
  const evidence = qaEvidenceBundleSchema.parse(input.evidence);
  const currentCorrection = qaCorrectionRunSchema.parse(input.currentCorrection);
  const defects = input.defects.map((defect) => qaDefectSchema.parse(defect));
  const openDefects = input.openDefects.map((defect) => qaDefectSchema.parse(defect));
  const reviewReport = reviewReportSchema.parse(input.reviewReport);
  const reviewArtifact = evidenceArtifactSchema.parse(input.reviewArtifact);
  const defectIds = defects.map(({ id }) => id);
  const correctionDefectIds = new Set(currentCorrection.defectIds);
  const lineageMatches =
    qaRun.status === "PASSED" &&
    qaRun.scope.type === "RETEST" &&
    qaRun.scope.correctionRunId === currentCorrection.id &&
    currentCorrection.status === "ACTIVE" &&
    qaRun.projectId === currentCorrection.projectId &&
    qaRun.workItemId === currentCorrection.workItemId &&
    qaRun.pipelineRunId === currentCorrection.pipelineRunId &&
    evidence.verdict === "PASSED" &&
    evidence.qaRunId === qaRun.id &&
    evidence.projectId === qaRun.projectId &&
    evidence.workItemId === qaRun.workItemId &&
    evidence.pipelineRunId === qaRun.pipelineRunId &&
    evidence.stageAttemptId === qaRun.stageAttemptId &&
    evidence.testedTree === qaRun.testedTree &&
    evidence.defectIds.length === 0 &&
    defectIds.length === currentCorrection.defectIds.length &&
    currentCorrection.defectIds.every((id, index) => defectIds[index] === id) &&
    openDefects.every(({ id }) => correctionDefectIds.has(id)) &&
    defects.every(
      (defect) =>
        defect.projectId === qaRun.projectId &&
        defect.workItemId === qaRun.workItemId &&
        defect.status !== "RESOLVED",
    ) &&
    reviewReport.correctionRunId === currentCorrection.id &&
    reviewReport.projectId === qaRun.projectId &&
    reviewReport.workItemId === qaRun.workItemId &&
    reviewReport.pipelineRunId === qaRun.pipelineRunId &&
    reviewReport.reviewedTree === qaRun.testedTree &&
    reviewReport.verdict === "PASSED" &&
    reviewArtifact.correctionRunId === currentCorrection.id &&
    reviewArtifact.stage === "REVIEW" &&
    reviewArtifact.kind === "REVIEW_REPORT" &&
    reviewArtifact.reviewReportId === reviewReport.id &&
    reviewArtifact.testedTree === qaRun.testedTree;
  if (!lineageMatches) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The passing QA evidence is not the active correction's immutable retest outcome",
    );
  }
  const loop = decideQACorrectionLoop({ qaRun, currentCorrection, now: input.now });
  if (loop.action !== "PASS_CORRECTION") {
    throw new QACorrectionError(
      "QA_CORRECTION_STATE_MISMATCH",
      "The passing retest did not close its active correction",
    );
  }
  const resolvedDefects = defects
    .filter(({ status }) => status === "OPEN")
    .map((defect) =>
      qaDefectSchema.parse({
        ...defect,
        status: "RESOLVED",
        resolutionReason: `Correction ${currentCorrection.ordinal.toString()} passed its locked browser retest.`,
        resolvedByQARunId: qaRun.id,
        resolvedAt: input.now,
        version: defect.version + 1,
      }),
    );
  return {
    correctionRun: loop.correctionRun,
    resolvedDefects,
    events: [
      {
        type: "QA_CORRECTION_PASSED",
        data: { correctionRun: loop.correctionRun, resolvedDefects },
      },
    ],
  };
};

export type QACorrectionOwnerDecision =
  | {
      action: "START_FINAL_CORRECTION";
      nextOrdinal: typeof MAX_TOTAL_QA_CORRECTION_RUNS;
      previousCorrection: QACorrectionRun;
    }
  | { action: "CANCEL_CORRECTION"; correctionRun: QACorrectionRun };

/** Applies the only owner choices exposed after the automatic correction bound is exhausted. */
export const decideQACorrectionOwnerAction = (input: {
  correctionRun: QACorrectionRun;
  action: "AUTHORIZE_FINAL" | "CANCEL";
  now: string;
}): QACorrectionOwnerDecision => {
  const correction = qaCorrectionRunSchema.parse(input.correctionRun);
  if (correction.status !== "EXHAUSTED") {
    throw new QACorrectionError(
      "QA_CORRECTION_STATE_MISMATCH",
      "Only an exhausted correction can receive an owner action",
      { status: correction.status },
    );
  }
  if (input.action === "AUTHORIZE_FINAL") {
    if (correction.ordinal !== MAX_AUTOMATIC_QA_CORRECTION_RUNS) {
      throw new QACorrectionError(
        "QA_CORRECTION_LIMIT_REACHED",
        "The final owner-authorized QA correction is no longer available",
        { ordinal: correction.ordinal },
      );
    }
    return {
      action: "START_FINAL_CORRECTION",
      nextOrdinal: MAX_TOTAL_QA_CORRECTION_RUNS,
      previousCorrection: qaCorrectionRunSchema.parse({
        ...correction,
        status: "SUPERSEDED",
        completedAt: input.now,
        version: correction.version + 1,
      }),
    };
  }
  return {
    action: "CANCEL_CORRECTION",
    correctionRun: qaCorrectionRunSchema.parse({
      ...correction,
      status: "CANCELLED",
      completedAt: input.now,
      version: correction.version + 1,
    }),
  };
};

export type QACorrectionCancellation = {
  correctionRun: QACorrectionRun;
  events: readonly Pick<QACorrectionCancelledEvent, "type" | "data">[];
};

/** Closes correction authority when its containing PipelineRun is cancelled through normal control. */
export const decideQACorrectionCancellation = (input: {
  correctionRun: QACorrectionRun;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  now: string;
}): QACorrectionCancellation => {
  const correctionRun = qaCorrectionRunSchema.parse(input.correctionRun);
  if (
    (correctionRun.status !== "ACTIVE" && correctionRun.status !== "EXHAUSTED") ||
    input.run.id !== correctionRun.pipelineRunId ||
    input.run.workItemId !== correctionRun.workItemId ||
    input.run.projectId !== correctionRun.projectId ||
    input.run.currentStageAttemptId !== input.stageAttempt.id ||
    input.stageAttempt.pipelineRunId !== input.run.id ||
    input.stageAttempt.workItemId !== correctionRun.workItemId ||
    input.stageAttempt.projectId !== correctionRun.projectId ||
    input.stageAttempt.correctionRunId !== correctionRun.id
  ) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The current workflow stage does not belong to the correction being cancelled",
    );
  }
  const cancelled = qaCorrectionRunSchema.parse({
    ...correctionRun,
    status: "CANCELLED",
    completedAt: input.now,
    version: correctionRun.version + 1,
  });
  return {
    correctionRun: cancelled,
    events: [{ type: "QA_CORRECTION_CANCELLED", data: { correctionRun: cancelled } }],
  };
};

type QACorrectionGateEvent =
  | Pick<HumanRequestResolvedEvent, "type" | "data">
  | Pick<StageAttemptChangedEvent, "type" | "data">
  | Pick<QACorrectionStartedEvent, "type" | "data">
  | Pick<QACorrectionCancelledEvent, "type" | "data">
  | Pick<PipelineCancelledEvent, "type" | "data">;

export type QACorrectionGateResolution =
  | {
      action: "AUTHORIZE_FINAL";
      workItem: WorkItem;
      run: PipelineRun;
      stageAttempt: StageAttempt;
      request: HumanRequest;
      decision: Decision;
      previousCorrection: QACorrectionRun;
      correctionRun: QACorrectionRun;
      retestPlan: QARetestPlan;
      nextStageAttempt: StageAttempt;
      dispatch: WorkflowDispatch;
      events: readonly QACorrectionGateEvent[];
    }
  | {
      action: "CANCEL";
      workItem: WorkItem;
      run: PipelineRun;
      stageAttempt: StageAttempt;
      request: HumanRequest;
      decision: Decision;
      previousCorrection: QACorrectionRun;
      correctionRun: null;
      retestPlan: null;
      nextStageAttempt: null;
      dispatch: null;
      events: readonly QACorrectionGateEvent[];
    };

const assertQACorrectionGateLineage = (input: {
  command: ResolveQACorrectionGateCommand;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
  correctionRun: QACorrectionRun;
  sourceQARun: QARun;
  sourceEvidence: QAEvidenceBundle;
  baselineQARun: QARun;
}): void => {
  const { command, workItem, run, stageAttempt, request, correctionRun, sourceQARun, sourceEvidence } = input;
  if (command.actor.type !== "HUMAN") {
    throw new QACorrectionError(
      "QA_CORRECTION_ACTOR_FORBIDDEN",
      "Only the owner can resolve an exhausted QA correction gate",
    );
  }
  if (request.id !== command.payload.humanRequestId || correctionRun.id !== command.payload.correctionRunId) {
    throw new QACorrectionError(
      "QA_CORRECTION_REQUEST_INVALID",
      "The owner action does not identify this QA correction gate",
    );
  }
  if (
    request.version !== command.payload.expectedRequestVersion ||
    correctionRun.version !== command.payload.expectedCorrectionVersion ||
    run.version !== command.payload.expectedPipelineRunVersion
  ) {
    throw new QACorrectionError(
      "QA_CORRECTION_VERSION_CONFLICT",
      "The QA correction gate changed after it was loaded",
      {
        expectedRequestVersion: command.payload.expectedRequestVersion,
        actualRequestVersion: request.version,
        expectedCorrectionVersion: command.payload.expectedCorrectionVersion,
        actualCorrectionVersion: correctionRun.version,
        expectedPipelineRunVersion: command.payload.expectedPipelineRunVersion,
        actualPipelineRunVersion: run.version,
      },
    );
  }
  const sameDelivery =
    correctionRun.status === "EXHAUSTED" &&
    request.status === "OPEN" &&
    request.kind === "SINGLE_CHOICE" &&
    request.blocking &&
    !request.allowOther &&
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
    stageAttempt.correctionRunId === correctionRun.id &&
    stageAttempt.stage === "QA" &&
    stageAttempt.status === "WAITING_HUMAN" &&
    stageAttempt.failureCode === "QA_CORRECTION_EXHAUSTED" &&
    request.projectId === workItem.projectId &&
    request.workItemId === workItem.id &&
    request.stageAttemptId === stageAttempt.id &&
    sourceQARun.status === "FAILED" &&
    sourceQARun.scope.type === "RETEST" &&
    sourceQARun.scope.correctionRunId === correctionRun.id &&
    sourceQARun.projectId === workItem.projectId &&
    sourceQARun.workItemId === workItem.id &&
    sourceQARun.pipelineRunId === run.id &&
    sourceQARun.stageAttemptId === stageAttempt.id &&
    sourceEvidence.verdict === "FAILED" &&
    sourceEvidence.qaRunId === sourceQARun.id &&
    sourceEvidence.stageAttemptId === stageAttempt.id &&
    sourceEvidence.testedTree === sourceQARun.testedTree;
  if (!sameDelivery) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The request is not the current exhausted QA correction gate for this delivery",
    );
  }
  requireSameDelivery(input.baselineQARun, sourceQARun, sourceEvidence);
  if (input.baselineQARun.id !== correctionRun.baselineQARunId) {
    throw new QACorrectionError(
      "QA_CORRECTION_LINEAGE_MISMATCH",
      "The exhausted correction no longer points to this QA baseline",
    );
  }
  const expectedOptionCount = correctionRun.ordinal === MAX_AUTOMATIC_QA_CORRECTION_RUNS ? 2 : 1;
  if (request.options.length !== expectedOptionCount) {
    throw new QACorrectionError(
      "QA_CORRECTION_REQUEST_INVALID",
      "The exhausted QA correction gate has an invalid action set",
    );
  }
};

/**
 * Resolves the exhausted correction gate as one semantic command.
 *
 * Option labels remain presentation; the domain maps the semantic action to the immutable option
 * position created by `decideFailedQACorrectionTransition` and owns every resulting state change.
 */
export const decideQACorrectionGateResolution = (input: {
  command: ResolveQACorrectionGateCommand;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
  correctionRun: QACorrectionRun;
  sourceQARun: QARun;
  sourceEvidence: QAEvidenceBundle;
  baselineQARun: QARun;
  openDefects: readonly QADefect[];
  ids: {
    decisionId: string;
    correctionRunId: string;
    retestPlanId: string;
    nextStageAttemptId: string;
    dispatchId: string;
  };
  now: string;
}): QACorrectionGateResolution => {
  const correctionRun = qaCorrectionRunSchema.parse(input.correctionRun);
  const sourceQARun = qaRunSchema.parse(input.sourceQARun);
  const sourceEvidence = qaEvidenceBundleSchema.parse(input.sourceEvidence);
  const baselineQARun = qaRunSchema.parse(input.baselineQARun);
  const openDefects = input.openDefects.map((defect) => qaDefectSchema.parse(defect));
  assertQACorrectionGateLineage({
    command: input.command,
    workItem: input.workItem,
    run: input.run,
    stageAttempt: input.stageAttempt,
    request: input.request,
    correctionRun,
    sourceQARun,
    sourceEvidence,
    baselineQARun,
  });
  const ownerDecision = decideQACorrectionOwnerAction({
    correctionRun,
    action: input.command.payload.action,
    now: input.now,
  });
  const optionId =
    input.command.payload.action === "AUTHORIZE_FINAL"
      ? input.request.options[0]?.id
      : input.request.options.at(-1)?.id;
  if (optionId === undefined) {
    throw new QACorrectionError(
      "QA_CORRECTION_REQUEST_INVALID",
      "The exhausted QA correction gate does not contain the requested action",
    );
  }
  const request: HumanRequest = {
    ...input.request,
    status: "RESOLVED",
    version: input.request.version + 1,
    resolvedAt: input.now,
  };
  const decision: Decision = {
    schemaVersion: 1,
    id: input.ids.decisionId,
    projectId: request.projectId,
    workItemId: request.workItemId,
    humanRequestId: request.id,
    answer: { type: "OPTION", optionIds: [optionId] },
    actor: input.command.actor,
    reason:
      input.command.payload.action === "AUTHORIZE_FINAL"
        ? "Owner authorized the one final bounded QA correction."
        : "Owner cancelled the delivery after the QA correction gate.",
    createdAt: input.now,
  };

  if (ownerDecision.action === "CANCEL_CORRECTION") {
    const stageAttempt: StageAttempt = {
      ...input.stageAttempt,
      status: "CANCELLED",
      version: input.stageAttempt.version + 1,
      finishedAt: input.now,
    };
    const run: PipelineRun = {
      ...input.run,
      status: "CANCELLED",
      version: input.run.version + 1,
      updatedAt: input.now,
      finishedAt: input.now,
    };
    const workItem: WorkItem = {
      ...input.workItem,
      state: "CANCELLED",
      currentStage: null,
      version: input.workItem.version + 1,
      updatedAt: input.now,
    };
    return {
      action: "CANCEL",
      workItem,
      run,
      stageAttempt,
      request,
      decision,
      previousCorrection: ownerDecision.correctionRun,
      correctionRun: null,
      retestPlan: null,
      nextStageAttempt: null,
      dispatch: null,
      events: [
        { type: "HUMAN_REQUEST_RESOLVED", data: { request, decision } },
        {
          type: "STAGE_ATTEMPT_CHANGED",
          data: { run, stageAttempt, previousStatus: input.stageAttempt.status },
        },
        { type: "QA_CORRECTION_CANCELLED", data: { correctionRun: ownerDecision.correctionRun } },
        { type: "PIPELINE_CANCELLED", data: { run, stageAttempt } },
      ],
    };
  }

  const nextCorrection = qaCorrectionRunSchema.parse({
    schemaVersion: 1,
    id: input.ids.correctionRunId,
    projectId: sourceQARun.projectId,
    workItemId: sourceQARun.workItemId,
    pipelineRunId: sourceQARun.pipelineRunId,
    ordinal: ownerDecision.nextOrdinal,
    sourceQARunId: sourceQARun.id,
    baselineQARunId: baselineQARun.id,
    sourceEvidenceBundleId: sourceEvidence.id,
    sourceTestedTree: sourceQARun.testedTree,
    defectIds: openDefects.map(({ id }) => id),
    status: "ACTIVE",
    createdAt: input.now,
    completedAt: null,
    version: 1,
  });
  const retestPlan = deriveQARetestPlan({
    retestPlanId: input.ids.retestPlanId,
    correctionRunId: nextCorrection.id,
    baselineQARun,
    sourceQARun,
    sourceEvidence,
    openDefects,
    now: input.now,
  });
  const stageAttempt: StageAttempt = {
    ...input.stageAttempt,
    status: "SUCCEEDED",
    failureCode: null,
    version: input.stageAttempt.version + 1,
    finishedAt: input.now,
    resultTree: sourceQARun.testedTree,
  };
  const nextStageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: input.ids.nextStageAttemptId,
    pipelineRunId: input.run.id,
    projectId: input.workItem.projectId,
    workItemId: input.workItem.id,
    correctionRunId: nextCorrection.id,
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
  const run: PipelineRun = {
    ...input.run,
    status: "RUNNING",
    currentStageAttemptId: nextStageAttempt.id,
    version: input.run.version + 1,
    updatedAt: input.now,
  };
  const workItem: WorkItem = {
    ...input.workItem,
    state: "IN_PROGRESS",
    currentStage: "IMPLEMENT",
    version: input.workItem.version + 1,
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
    workItem,
    run,
    stageAttempt,
    request,
    decision,
    previousCorrection: ownerDecision.previousCorrection,
    correctionRun: nextCorrection,
    retestPlan,
    nextStageAttempt,
    dispatch,
    events: [
      { type: "HUMAN_REQUEST_RESOLVED", data: { request, decision } },
      { type: "QA_CORRECTION_STARTED", data: { correctionRun: nextCorrection, retestPlan } },
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: { run, stageAttempt, previousStatus: input.stageAttempt.status },
      },
    ],
  };
};
