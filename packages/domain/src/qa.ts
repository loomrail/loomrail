import {
  qaDriverResultSchema,
  qaRunSchema,
  type QAAttachmentDraft,
  type QADefectDraft,
  type QADriverResult,
  type QAEnvironment,
  type QAObservation,
  type QARun,
  type QAScenarioExecution,
} from "@loomrail/contracts";

export type QACompletionErrorCode =
  | "QA_RUN_VERSION_CONFLICT"
  | "QA_RUN_NOT_RUNNING"
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
  attachments: readonly QAAttachmentDraft[];
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

/**
 * Completes one durable QA reservation without trusting a provider or driver aggregate verdict.
 * The caller still owns IDs, persistence, attachment finalization and workflow transitions.
 */
export const decideQACompletion = (input: {
  qaRun: QARun;
  expectedVersion: number;
  currentTree: string;
  result: QADriverResult;
  now: string;
}): QACompletionDecision => {
  const run = qaRunSchema.parse(input.qaRun);
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
    attachments: result.attachments,
    defects: result.defects,
  };
  if (status === "FAILED") {
    return { status, qaRun, evidence: { ...evidence, verdict: status }, requiresHumanRequest: true };
  }
  return { status, qaRun, evidence: { ...evidence, verdict: status }, requiresHumanRequest: false };
};
