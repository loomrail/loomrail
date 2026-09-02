import {
  qaDriverResultSchema,
  qaRunSchema,
  type AgentRun,
  type QAAttachmentRef,
  type QADefectDraft,
  type QADriverResult,
  type QAFinalizedAttachment,
  type QAEnvironment,
  type QAObservation,
  type QARun,
  type ProviderOutcome,
  type ReserveQARunCommand,
  type QAScenarioExecution,
  type StageAttempt,
} from "@loomrail/contracts";

export type QAReservationErrorCode =
  | "QA_RUN_ACTOR_FORBIDDEN"
  | "QA_STAGE_NOT_RUNNING"
  | "QA_AGENT_RUN_MISMATCH"
  | "QA_SCOPE_MISMATCH"
  | "STALE_QA_TREE";

export class QAReservationError extends Error {
  readonly code: QAReservationErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: QAReservationErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "QAReservationError";
    this.code = code;
    this.details = details;
  }
}

/** Reserves the exact browser run the daemon may execute; no provider can manufacture one. */
export const decideQAReservation = (
  command: ReserveQARunCommand,
  context: {
    newQARunId: string;
    now: string;
    currentTree: string;
    stageAttempt: StageAttempt;
    agentRun: AgentRun;
  },
): QARun => {
  if (command.actor.type !== "SYSTEM" || command.actor.id !== "local-daemon") {
    throw new QAReservationError(
      "QA_RUN_ACTOR_FORBIDDEN",
      "Only the local daemon can reserve a deterministic browser QA run",
    );
  }
  if (
    context.stageAttempt.id !== command.payload.stageAttemptId ||
    context.stageAttempt.stage !== "QA" ||
    context.stageAttempt.status !== "RUNNING"
  ) {
    throw new QAReservationError(
      "QA_STAGE_NOT_RUNNING",
      "A browser QA run requires the matching running QA StageAttempt",
    );
  }
  if (
    context.agentRun.id !== command.payload.agentRunId ||
    context.agentRun.stageAttemptId !== context.stageAttempt.id ||
    context.agentRun.profile.role !== "BROWSER_QA" ||
    context.agentRun.status !== "RUNNING"
  ) {
    throw new QAReservationError(
      "QA_AGENT_RUN_MISMATCH",
      "A browser QA run requires the active Browser QA AgentRun",
    );
  }
  if (command.payload.testedTree !== context.currentTree) {
    throw new QAReservationError("STALE_QA_TREE", "The reserved QA tree is not the current stable tree", {
      testedTree: command.payload.testedTree,
      currentTree: context.currentTree,
    });
  }
  const correctionRunId = context.stageAttempt.correctionRunId;
  if (
    (correctionRunId === null && command.payload.scope.type !== "FULL") ||
    (correctionRunId !== null &&
      (command.payload.scope.type !== "RETEST" || command.payload.scope.correctionRunId !== correctionRunId))
  ) {
    throw new QAReservationError(
      "QA_SCOPE_MISMATCH",
      "The Browser QA scope does not match the StageAttempt correction lineage",
    );
  }
  return qaRunSchema.parse({
    schemaVersion: 1,
    id: context.newQARunId,
    projectId: context.stageAttempt.projectId,
    workItemId: context.stageAttempt.workItemId,
    pipelineRunId: context.stageAttempt.pipelineRunId,
    stageAttemptId: context.stageAttempt.id,
    agentRunId: context.agentRun.id,
    driverId: "PLAYWRIGHT",
    testedTree: command.payload.testedTree,
    targetOrigin: command.payload.targetOrigin,
    plan: command.payload.plan,
    scope: command.payload.scope,
    status: "RUNNING",
    error: null,
    startedAt: context.now,
    completedAt: null,
    version: 1,
  });
};

export type QACompletionErrorCode =
  | "QA_RUN_VERSION_CONFLICT"
  | "QA_RUN_NOT_RUNNING"
  | "QA_AGENT_RUN_MISMATCH"
  | "STALE_QA_TREE"
  | "QA_MATRIX_INCOMPLETE"
  | "QA_EVIDENCE_INCONSISTENT";

export class QACompletionError extends Error {
  readonly code: QACompletionErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: QACompletionErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "QACompletionError";
    this.code = code;
    this.details = details;
  }
}

export type QAMeasuredEvidence = {
  verdict: "PASSED" | "FAILED";
  environment: QAEnvironment;
  executions: readonly QAScenarioExecution[];
  observations: readonly QAObservation[];
  attachments: readonly QAAttachmentRef[];
  defects: readonly QADefectDraft[];
};

export type QACompletionDecision =
  | {
      status: "PASSED";
      qaRun: QARun;
      evidence: QAMeasuredEvidence & { verdict: "PASSED" };
      requiresHumanRequest: false;
    }
  | {
      status: "FAILED";
      qaRun: QARun;
      evidence: QAMeasuredEvidence & { verdict: "FAILED" };
      requiresHumanRequest: true;
    }
  | {
      status: "ERROR";
      qaRun: QARun;
      evidence: null;
      requiresHumanRequest: true;
    };

/** Converts daemon-derived QA state into the existing workflow outcome vocabulary. */
export const qaWorkflowOutcome = (decision: QACompletionDecision): ProviderOutcome => {
  if (decision.status === "PASSED") {
    const assertionCount = decision.evidence.executions.reduce(
      (total, execution) => total + execution.assertions.length,
      0,
    );
    return {
      type: "COMPLETED",
      summary: "The deterministic browser baseline passed.",
      artifacts: [
        {
          kind: "QA_REPORT",
          title: "Deterministic browser QA",
          summary: `Playwright measured ${decision.evidence.executions.length.toString()} required target/scenario executions on the exact implementation tree.`,
          checks: [
            `${assertionCount.toString()} required assertions passed.`,
            "No blocking console or network observations were recorded.",
            `${decision.evidence.attachments.length.toString()} screenshot/trace attachments were finalized and verified.`,
          ],
        },
      ],
    };
  }

  if (decision.status === "FAILED") {
    return {
      type: "NEEDS_HUMAN",
      request: {
        kind: "FREE_TEXT",
        blocking: true,
        title: "Browser QA found blocking defects",
        context: `${decision.evidence.defects.length.toString()} blocking defect(s) were measured on tree ${decision.qaRun.testedTree}. Acceptance did not start.`,
        recommendation:
          "Inspect and fix the recorded defects, then answer when this exact stage is ready to rerun.",
        options: [],
        allowOther: true,
      },
    };
  }

  return {
    type: "NEEDS_HUMAN",
    request: {
      kind: "FREE_TEXT",
      blocking: true,
      title: "Browser QA could not prove the implementation",
      context:
        decision.qaRun.error?.summary ?? "The deterministic browser baseline ended without valid evidence.",
      recommendation:
        "Restore the loopback target or browser environment, then answer when the baseline can rerun.",
      options: [],
      allowOther: true,
    },
  };
};

const sameIds = (actual: readonly { id: string }[], expected: readonly { id: string }[]): boolean =>
  actual.length === expected.length && actual.every(({ id }, index) => id === expected[index]?.id);

const executionKey = (targetId: string, scenarioId: string): string => `${targetId}\u0000${scenarioId}`;

const validateMeasuredMatrix = (
  run: QARun,
  result: Extract<QADriverResult, { outcome: "MEASURED" }>,
): void => {
  const expected = new Set<string>();
  for (const target of run.plan.targets) {
    for (const scenario of run.plan.scenarios) expected.add(executionKey(target.id, scenario.id));
  }
  const actual = new Set<string>();
  for (const execution of result.executions) {
    const key = executionKey(execution.targetId, execution.scenarioId);
    if (actual.has(key) || !expected.has(key)) {
      throw new QACompletionError(
        "QA_MATRIX_INCOMPLETE",
        "The browser result contains an unexpected or duplicate target/scenario execution",
        { targetId: execution.targetId, scenarioId: execution.scenarioId },
      );
    }
    actual.add(key);
    const scenario = run.plan.scenarios.find(({ id }) => id === execution.scenarioId);
    if (
      !scenario ||
      !sameIds(execution.steps, scenario.steps) ||
      !sameIds(execution.assertions, scenario.assertions)
    ) {
      throw new QACompletionError(
        "QA_MATRIX_INCOMPLETE",
        "The browser result omitted or reordered required scenario checks",
        { targetId: execution.targetId, scenarioId: execution.scenarioId },
      );
    }
  }
  if (actual.size !== expected.size) {
    throw new QACompletionError(
      "QA_MATRIX_INCOMPLETE",
      "The browser result did not cover the complete QA matrix",
      {
        expected: expected.size,
        actual: actual.size,
      },
    );
  }
  for (const item of [...result.observations, ...result.attachments, ...result.defects]) {
    if (!actual.has(executionKey(item.targetId, item.scenarioId))) {
      throw new QACompletionError(
        "QA_EVIDENCE_INCONSISTENT",
        "QA evidence refers to a target/scenario pair outside the measured matrix",
        { targetId: item.targetId, scenarioId: item.scenarioId },
      );
    }
  }
};

const validateFinalizedAttachments = (
  run: QARun,
  result: Extract<QADriverResult, { outcome: "MEASURED" }>,
  finalized: readonly QAFinalizedAttachment[],
): readonly QAAttachmentRef[] => {
  if (finalized.length !== result.attachments.length) {
    throw new QACompletionError(
      "QA_EVIDENCE_INCONSISTENT",
      "Every browser attachment must be finalized before QA completion",
      { expected: result.attachments.length, actual: finalized.length },
    );
  }
  if (
    new Set(finalized.map(({ ref }) => ref.id)).size !== finalized.length ||
    new Set(finalized.map(({ ref }) => ref.storageKey)).size !== finalized.length
  ) {
    throw new QACompletionError(
      "QA_EVIDENCE_INCONSISTENT",
      "Finalized browser attachments must have unique IDs and storage keys",
    );
  }
  return result.attachments.map((draft, index) => {
    const completed = finalized[index];
    if (completed?.handle !== draft.handle) {
      throw new QACompletionError(
        "QA_EVIDENCE_INCONSISTENT",
        "Finalized browser attachment metadata does not match the measured draft",
        { attachmentIndex: index },
      );
    }
    if (
      completed.ref.qaRunId !== run.id ||
      completed.ref.kind !== draft.kind ||
      completed.ref.contentHash !== draft.contentHash ||
      completed.ref.byteSize !== draft.byteSize ||
      completed.ref.targetId !== draft.targetId ||
      completed.ref.scenarioId !== draft.scenarioId ||
      completed.ref.capturedAt !== draft.capturedAt
    ) {
      throw new QACompletionError(
        "QA_EVIDENCE_INCONSISTENT",
        "Finalized browser attachment metadata does not match the measured draft",
        { attachmentIndex: index },
      );
    }
    return completed.ref;
  });
};

/**
 * Completes one durable QA reservation without trusting a provider or driver aggregate verdict.
 * The caller still owns IDs, persistence, attachment finalization and workflow transitions.
 */
export const decideQACompletion = (input: {
  qaRun: QARun;
  agentRun: AgentRun;
  expectedVersion: number;
  currentTree: string;
  result: QADriverResult;
  finalizedAttachments: readonly QAFinalizedAttachment[];
  now: string;
}): QACompletionDecision => {
  const run = qaRunSchema.parse(input.qaRun);
  if (
    input.agentRun.id !== run.agentRunId ||
    input.agentRun.stageAttemptId !== run.stageAttemptId ||
    input.agentRun.profile.role !== "BROWSER_QA" ||
    input.agentRun.status !== "RUNNING"
  ) {
    throw new QACompletionError(
      "QA_AGENT_RUN_MISMATCH",
      "QA completion requires the active Browser QA AgentRun that owns the reservation",
    );
  }
  if (run.version !== input.expectedVersion) {
    throw new QACompletionError("QA_RUN_VERSION_CONFLICT", "The QA run changed before completion", {
      expectedVersion: input.expectedVersion,
      actualVersion: run.version,
    });
  }
  if (run.status !== "RUNNING") {
    throw new QACompletionError("QA_RUN_NOT_RUNNING", "Only a running QA run can be completed", {
      status: run.status,
    });
  }
  if (run.testedTree !== input.currentTree) {
    throw new QACompletionError("STALE_QA_TREE", "The browser result does not describe the current tree", {
      testedTree: run.testedTree,
      currentTree: input.currentTree,
    });
  }
  const result = qaDriverResultSchema.parse(input.result);
  if (result.outcome === "ERROR") {
    if (input.finalizedAttachments.length !== 0) {
      throw new QACompletionError(
        "QA_EVIDENCE_INCONSISTENT",
        "An errored browser run cannot publish finalized attachments",
      );
    }
    const qaRun = qaRunSchema.parse({
      ...run,
      status: "ERROR",
      error: { code: result.code, summary: result.summary },
      completedAt: input.now,
      version: run.version + 1,
    });
    return { status: "ERROR", qaRun, evidence: null, requiresHumanRequest: true };
  }

  validateMeasuredMatrix(run, result);
  const attachments = validateFinalizedAttachments(run, result, input.finalizedAttachments);
  const failedCheck = result.executions.some(
    ({ steps, assertions }) =>
      steps.some(({ status }) => status === "FAILED") || assertions.some(({ status }) => status === "FAILED"),
  );
  const failed =
    failedCheck || result.observations.some(({ blocking }) => blocking) || result.defects.length > 0;
  if (failed && result.defects.length === 0) {
    throw new QACompletionError(
      "QA_EVIDENCE_INCONSISTENT",
      "A measured QA failure requires at least one reproducible defect",
    );
  }
  const status = failed ? "FAILED" : "PASSED";
  const qaRun = qaRunSchema.parse({
    ...run,
    status,
    error: null,
    completedAt: input.now,
    version: run.version + 1,
  });
  const evidence = {
    environment: result.environment,
    executions: result.executions,
    observations: result.observations,
    attachments,
    defects: result.defects,
  };
  if (status === "FAILED") {
    return { status, qaRun, evidence: { ...evidence, verdict: status }, requiresHumanRequest: true };
  }
  return { status, qaRun, evidence: { ...evidence, verdict: status }, requiresHumanRequest: false };
};
