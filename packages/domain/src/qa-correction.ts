import {
  MAX_AUTOMATIC_QA_CORRECTION_RUNS,
  MAX_TOTAL_QA_CORRECTION_RUNS,
  qaCorrectionRunSchema,
  qaDefectSchema,
  qaEvidenceBundleSchema,
  qaRetestCellReasons,
  qaRetestPlanSchema,
  qaRunSchema,
  type QACorrectionRun,
  type QADefect,
  type QADefectWaivedEvent,
  type QAEvidenceBundle,
  type QARetestCellReason,
  type QARetestPlan,
  type QARun,
  type WaiveQADefectCommand,
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
  | "QA_CORRECTION_SOURCE_INVALID"
  | "QA_CORRECTION_LINEAGE_MISMATCH"
  | "QA_CORRECTION_SCOPE_EMPTY"
  | "QA_CORRECTION_SCOPE_INVALID"
  | "QA_CORRECTION_STATE_MISMATCH"
  | "QA_CORRECTION_LIMIT_REACHED";

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
