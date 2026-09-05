import type {
  EvidenceArtifact,
  HumanRequest,
  PipelineRun,
  QACorrectionRun,
  QADefect,
  QAEvidenceBundle,
  QAPlanSnapshot,
  QARun,
  ReviewReport,
  ResolveQACorrectionGateCommand,
  StageAttempt,
  WaiveQADefectCommand,
  WorkflowDispatch,
  WorkItem,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  assertQACorrectionAcceptanceLineage,
  decideFailedQACorrectionTransition,
  decidePassedQACorrectionTransition,
  decideQACorrectionGateResolution,
  decideQACorrectionCancellation,
  decideQACorrectionLoop,
  decideQACorrectionOwnerAction,
  decideQADefectWaiver,
  deriveQARetestPlan,
  QACorrectionError,
  QADefectDispositionError,
} from "../src/qa-correction.js";

const now = "2026-09-02T12:00:00.000Z";
const completedAt = "2026-09-02T11:59:00.000Z";
const testedTree = "a".repeat(40);

const plan: QAPlanSnapshot = {
  schemaVersion: 1,
  revision: 4,
  contentHash: `sha256:${"b".repeat(64)}`,
  targets: ["desktop", "tablet", "mobile"].map((id, index) => ({
    id,
    viewport: { width: 1_280 - index * 320, height: 800 },
    locale: "en-US",
    theme: "LIGHT",
  })),
  scenarios: ["overview", "settings", "acceptance"].map((id) => ({
    id,
    title: `${id} scenario`,
    steps: [{ id: `${id}-open`, title: `Open ${id}`, action: { type: "NAVIGATE", path: "/" } }],
    assertions: [
      {
        id: `${id}-visible`,
        title: `${id} is visible`,
        rule: { type: "VISIBLE", locator: { by: "TEXT", value: id } },
      },
    ],
  })),
};

const failedRun: QARun = {
  schemaVersion: 1,
  id: "qa-run-failed",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "pipeline-1",
  stageAttemptId: "qa-attempt-1",
  agentRunId: "qa-agent-1",
  driverId: "PLAYWRIGHT",
  testedTree,
  targetOrigin: "http://127.0.0.1:4173",
  plan,
  scope: { type: "FULL" },
  status: "FAILED",
  error: null,
  startedAt: "2026-09-02T11:50:00.000Z",
  completedAt,
  version: 2,
};

const execution = (targetId: string, scenarioId: string, failed = false) => ({
  targetId,
  scenarioId,
  durationMs: 100,
  steps: [{ id: `${scenarioId}-open`, status: "PASSED" as const, durationMs: 50 }],
  assertions: [
    {
      id: `${scenarioId}-visible`,
      status: failed ? ("FAILED" as const) : ("PASSED" as const),
      details: failed ? "The expected surface is missing." : null,
    },
  ],
});

const failedEvidence: QAEvidenceBundle = {
  schemaVersion: 1,
  id: "qa-evidence-failed",
  qaRunId: failedRun.id,
  projectId: failedRun.projectId,
  workItemId: failedRun.workItemId,
  pipelineRunId: failedRun.pipelineRunId,
  stageAttemptId: failedRun.stageAttemptId,
  testedTree,
  verdict: "FAILED",
  environment: {
    osFamily: "MACOS",
    runtimeName: "NODE",
    runtimeVersion: "24.7.0",
    browserName: "CHROMIUM",
    browserVersion: "140.0",
  },
  executions: plan.targets.flatMap((target) =>
    plan.scenarios.map((scenario) =>
      execution(target.id, scenario.id, target.id === "desktop" && scenario.id === "overview"),
    ),
  ),
  observations: [
    {
      kind: "CONSOLE",
      severity: "ERROR",
      blocking: true,
      targetId: "tablet",
      scenarioId: "settings",
      summary: "The settings surface threw an uncaught error.",
    },
  ],
  attachmentIds: [],
  defectIds: ["defect-1"],
  createdAt: completedAt,
};

const defect = (id: string, targetId: string, scenarioId: string, ordinal: number): QADefect => ({
  schemaVersion: 1,
  id,
  qaRunId: failedRun.id,
  projectId: failedRun.projectId,
  workItemId: failedRun.workItemId,
  testedTree,
  ordinal,
  severity: "HIGH",
  status: "OPEN",
  title: `${id} title`,
  description: `${id} description`,
  reproduction: ["Open the target and run the scenario."],
  targetId,
  scenarioId,
  resolutionReason: null,
  resolvedByQARunId: null,
  createdAt: completedAt,
  resolvedAt: null,
  version: 1,
});

const defects = [
  defect("defect-1", "desktop", "overview", 1),
  defect("defect-2", "tablet", "settings", 2),
  defect("defect-3", "mobile", "overview", 3),
];
const firstDefect = defects.at(0);
const secondDefect = defects.at(1);
const thirdDefect = defects.at(2);
if (firstDefect === undefined || secondDefect === undefined || thirdDefect === undefined) {
  throw new Error("Expected all QA defect fixtures");
}

const waiveDefectCommand = (overrides: Partial<WaiveQADefectCommand> = {}): WaiveQADefectCommand => ({
  schemaVersion: 1,
  commandId: "waive-defect-1",
  correlationId: "correlation-waive-defect-1",
  actor: { type: "HUMAN", id: "owner-1" },
  type: "WAIVE_QA_DEFECT",
  payload: {
    defectId: firstDefect.id,
    expectedVersion: 1,
    reason: "The owner accepts this documented risk for the bounded release.",
  },
  ...overrides,
});

describe("QA defect owner disposition", () => {
  it("records an attributed audit intent without changing measured QA state", () => {
    const decision = decideQADefectWaiver(waiveDefectCommand(), {
      defect: firstDefect,
      now,
    });

    expect(decision).toEqual({
      defect: {
        ...firstDefect,
        status: "WAIVED",
        resolutionReason: "The owner accepts this documented risk for the bounded release.",
        resolvedAt: now,
        version: 2,
      },
      events: [{ type: "QA_DEFECT_WAIVED", data: { defect: decision.defect } }],
    });
  });

  it("rejects system actors, stale versions, missing and already-closed defects", () => {
    expect(() =>
      decideQADefectWaiver(waiveDefectCommand({ actor: { type: "SYSTEM", id: "provider" } }), {
        defect: firstDefect,
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QADefectDispositionError>>({ code: "QA_DEFECT_ACTOR_FORBIDDEN" }),
    );
    expect(() =>
      decideQADefectWaiver(
        waiveDefectCommand({ payload: { ...waiveDefectCommand().payload, expectedVersion: 2 } }),
        { defect: firstDefect, now },
      ),
    ).toThrow(
      expect.objectContaining<Partial<QADefectDispositionError>>({ code: "QA_DEFECT_VERSION_CONFLICT" }),
    );
    expect(() => decideQADefectWaiver(waiveDefectCommand(), { now })).toThrow(
      expect.objectContaining<Partial<QADefectDispositionError>>({ code: "QA_DEFECT_NOT_FOUND" }),
    );
    expect(() =>
      decideQADefectWaiver(
        waiveDefectCommand({ payload: { ...waiveDefectCommand().payload, expectedVersion: 2 } }),
        {
          defect: {
            ...firstDefect,
            status: "RESOLVED",
            resolutionReason: "A passing scoped retest resolved this defect.",
            resolvedByQARunId: "qa-run-resolved",
            resolvedAt: completedAt,
            version: 2,
          },
          now,
        },
      ),
    ).toThrow(
      expect.objectContaining<Partial<QADefectDispositionError>>({ code: "QA_DEFECT_ALREADY_CLOSED" }),
    );
  });
});

const correction = (ordinal: 1 | 2 | 3): QACorrectionRun => ({
  schemaVersion: 1,
  id: `correction-${ordinal.toString()}`,
  projectId: failedRun.projectId,
  workItemId: failedRun.workItemId,
  pipelineRunId: failedRun.pipelineRunId,
  ordinal,
  sourceQARunId: failedRun.id,
  baselineQARunId: failedRun.id,
  sourceEvidenceBundleId: failedEvidence.id,
  sourceTestedTree: testedTree,
  defectIds: defects.map(({ id }) => id),
  status: "ACTIVE",
  createdAt: completedAt,
  completedAt: null,
  version: 1,
});

const qaWorkItem: WorkItem = {
  schemaVersion: 1,
  id: failedRun.workItemId,
  projectId: failedRun.projectId,
  parentId: null,
  type: "TASK",
  title: "Correct measured QA defects",
  description: "Synthetic bounded QA correction fixture",
  state: "IN_PROGRESS",
  currentStage: "QA",
  priority: "HIGH",
  risk: "HIGH",
  acceptanceCriteria: ["Measured defects are corrected before acceptance."],
  version: 7,
  createdAt: failedRun.startedAt,
  updatedAt: failedRun.startedAt,
};

const qaPipelineRun: PipelineRun = {
  schemaVersion: 1,
  id: failedRun.pipelineRunId,
  projectId: failedRun.projectId,
  workItemId: failedRun.workItemId,
  workflowTemplateId: "delivery-v1",
  workflowVersion: 1,
  status: "RUNNING",
  currentStageAttemptId: failedRun.stageAttemptId,
  version: 9,
  createdAt: failedRun.startedAt,
  updatedAt: failedRun.startedAt,
  finishedAt: null,
};

const qaStageAttempt = (correctionRunId: string | null = null): StageAttempt => ({
  schemaVersion: 1,
  id: failedRun.stageAttemptId,
  pipelineRunId: failedRun.pipelineRunId,
  projectId: failedRun.projectId,
  workItemId: failedRun.workItemId,
  correctionRunId,
  stage: "QA",
  attempt: 1,
  status: "RUNNING",
  version: 2,
  startedAt: failedRun.startedAt,
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  packShareBackoffs: 0,
  resultTree: null,
});

const qaDispatch = (stageAttemptId = failedRun.stageAttemptId): WorkflowDispatch => ({
  schemaVersion: 1,
  id: `dispatch-${stageAttemptId}`,
  projectId: failedRun.projectId,
  workItemId: failedRun.workItemId,
  pipelineRunId: failedRun.pipelineRunId,
  stageAttemptId,
  mode: "START",
  status: "PENDING",
  createdAt: failedRun.startedAt,
  completedAt: null,
});

const transitionIds = {
  correctionRunId: "correction-next",
  retestPlanId: "retest-next",
  nextStageAttemptId: "attempt-implement-next",
  nextDispatchId: "dispatch-implement-next",
  humanRequestId: "request-correction-exhausted",
  authorizeFinalOptionId: "option-authorize-final",
  cancelOptionId: "option-cancel-delivery",
};

describe("QA correction scope", () => {
  it("derives affected cells and a deterministic per-target/per-scenario regression subset", () => {
    const retest = deriveQARetestPlan({
      retestPlanId: "retest-1",
      correctionRunId: "correction-1",
      baselineQARun: failedRun,
      sourceQARun: failedRun,
      sourceEvidence: failedEvidence,
      openDefects: defects,
      now,
    });

    expect(retest).toMatchObject({
      baselineQARunId: failedRun.id,
      sourceQARunId: failedRun.id,
      baselinePlanRevision: plan.revision,
      baselinePlanContentHash: plan.contentHash,
    });
    expect(retest.cells).toEqual([
      {
        targetId: "desktop",
        scenarioId: "overview",
        reasons: ["FAILED_CHECK", "OPEN_DEFECT"],
      },
      { targetId: "desktop", scenarioId: "settings", reasons: ["REGRESSION"] },
      { targetId: "tablet", scenarioId: "overview", reasons: ["REGRESSION"] },
      {
        targetId: "tablet",
        scenarioId: "settings",
        reasons: ["BLOCKING_OBSERVATION", "OPEN_DEFECT"],
      },
      { targetId: "mobile", scenarioId: "overview", reasons: ["OPEN_DEFECT"] },
      { targetId: "mobile", scenarioId: "settings", reasons: ["REGRESSION"] },
    ]);
  });

  it("rejects an unlocked plan, an unrelated defect, and an empty defect set", () => {
    expect(() =>
      deriveQARetestPlan({
        retestPlanId: "retest-1",
        correctionRunId: "correction-1",
        baselineQARun: failedRun,
        sourceQARun: {
          ...failedRun,
          plan: { ...failedRun.plan, contentHash: `sha256:${"c".repeat(64)}` },
        },
        sourceEvidence: failedEvidence,
        openDefects: defects,
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
    expect(() =>
      deriveQARetestPlan({
        retestPlanId: "retest-1",
        correctionRunId: "correction-1",
        baselineQARun: failedRun,
        sourceQARun: {
          ...failedRun,
          plan: { ...failedRun.plan, targets: [...failedRun.plan.targets].reverse() },
        },
        sourceEvidence: failedEvidence,
        openDefects: defects,
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
    expect(() =>
      deriveQARetestPlan({
        retestPlanId: "retest-1",
        correctionRunId: "correction-1",
        baselineQARun: failedRun,
        sourceQARun: failedRun,
        sourceEvidence: failedEvidence,
        openDefects: [{ ...firstDefect, projectId: "other-project" }],
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
    expect(() =>
      deriveQARetestPlan({
        retestPlanId: "retest-1",
        correctionRunId: "correction-1",
        baselineQARun: failedRun,
        sourceQARun: failedRun,
        sourceEvidence: failedEvidence,
        openDefects: [],
        now,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_SCOPE_EMPTY" }));
    expect(() =>
      deriveQARetestPlan({
        retestPlanId: "retest-1",
        correctionRunId: "correction-1",
        baselineQARun: failedRun,
        sourceQARun: failedRun,
        sourceEvidence: failedEvidence,
        openDefects: defects.slice(1),
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
  });

  it("keeps a fully affected matrix full without inventing regression cells", () => {
    const retest = deriveQARetestPlan({
      retestPlanId: "retest-full",
      correctionRunId: "correction-full",
      baselineQARun: failedRun,
      sourceQARun: failedRun,
      sourceEvidence: {
        ...failedEvidence,
        executions: failedEvidence.executions.map((item) => ({
          ...item,
          assertions: item.assertions.map((assertion) => ({
            ...assertion,
            status: "FAILED" as const,
            details: "The full matrix failed.",
          })),
        })),
        observations: [],
      },
      openDefects: [firstDefect],
      now,
    });

    expect(retest.cells).toHaveLength(9);
    expect(retest.cells.every(({ reasons }) => !reasons.includes("REGRESSION"))).toBe(true);
  });
});

describe("QA correction loop", () => {
  it("starts two automatic corrections without borrowing an R1 attempt", () => {
    expect(
      decideQACorrectionLoop({ qaRun: failedRun, budgetUsage: { automaticUsed: 0, totalUsed: 0 }, now }),
    ).toEqual({
      action: "START_CORRECTION",
      automatic: true,
      nextOrdinal: 1,
      budgetPosition: 1,
      previousCorrection: null,
    });

    const second = decideQACorrectionLoop({
      qaRun: failedRun,
      currentCorrection: correction(1),
      budgetUsage: { automaticUsed: 1, totalUsed: 1 },
      now,
    });
    expect(second).toMatchObject({
      action: "START_CORRECTION",
      automatic: true,
      nextOrdinal: 2,
      budgetPosition: 2,
      previousCorrection: { status: "SUPERSEDED", version: 2, completedAt: now },
    });
  });

  it("keeps the QA ordinal local while consuming the next delivery-wide position", () => {
    expect(
      decideQACorrectionLoop({
        qaRun: failedRun,
        budgetUsage: { automaticUsed: 1, totalUsed: 1 },
        now,
      }),
    ).toEqual({
      action: "START_CORRECTION",
      automatic: true,
      nextOrdinal: 1,
      budgetPosition: 2,
      previousCorrection: null,
    });
  });

  it("requires the owner after correction two and never authorizes correction four", () => {
    const exhausted = decideQACorrectionLoop({
      qaRun: failedRun,
      currentCorrection: correction(2),
      budgetUsage: { automaticUsed: 2, totalUsed: 2 },
      now,
    });
    expect(exhausted).toMatchObject({
      action: "WAIT_FOR_OWNER",
      canAuthorizeFinal: true,
      correctionRun: { status: "EXHAUSTED", version: 2, completedAt: null },
    });
    if (exhausted.action !== "WAIT_FOR_OWNER") throw new Error("Expected exhausted correction");
    if (exhausted.correctionRun === null) throw new Error("Expected current correction");
    expect(
      decideQACorrectionOwnerAction({
        correctionRun: exhausted.correctionRun,
        action: "AUTHORIZE_FINAL",
        now,
      }),
    ).toMatchObject({
      action: "START_FINAL_CORRECTION",
      nextOrdinal: 3,
      previousCorrection: { status: "SUPERSEDED", completedAt: now },
    });

    const finalFailure = decideQACorrectionLoop({
      qaRun: failedRun,
      currentCorrection: correction(3),
      budgetUsage: { automaticUsed: 2, totalUsed: 3 },
      now,
    });
    expect(finalFailure).toMatchObject({ action: "WAIT_FOR_OWNER", canAuthorizeFinal: false });
    if (finalFailure.action !== "WAIT_FOR_OWNER") throw new Error("Expected final exhausted correction");
    if (finalFailure.correctionRun === null) throw new Error("Expected final current correction");
    const exhaustedFinalCorrection = finalFailure.correctionRun;
    expect(() =>
      decideQACorrectionOwnerAction({
        correctionRun: exhaustedFinalCorrection,
        action: "AUTHORIZE_FINAL",
        now,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LIMIT_REACHED" }));
  });

  it("passes a correction, advances a green baseline, and retries ERROR without spending a correction", () => {
    const passedRun: QARun = { ...failedRun, status: "PASSED" };
    expect(
      decideQACorrectionLoop({ qaRun: passedRun, budgetUsage: { automaticUsed: 0, totalUsed: 0 }, now }),
    ).toEqual({
      action: "ADVANCE_BASELINE_TO_ACCEPTANCE",
    });
    expect(
      decideQACorrectionLoop({
        qaRun: passedRun,
        currentCorrection: correction(1),
        budgetUsage: { automaticUsed: 1, totalUsed: 1 },
        now,
      }),
    ).toMatchObject({
      action: "PASS_CORRECTION",
      correctionRun: { status: "PASSED", version: 2, completedAt: now },
    });

    const errorRun: QARun = {
      ...failedRun,
      status: "ERROR",
      error: { code: "TIMEOUT", summary: "The target stopped responding." },
    };
    expect(
      decideQACorrectionLoop({
        qaRun: errorRun,
        currentCorrection: correction(1),
        budgetUsage: { automaticUsed: 1, totalUsed: 1 },
        now,
      }),
    ).toEqual({ action: "RETRY_ENVIRONMENT", correctionRun: correction(1) });
  });

  it("rejects running QA and outcomes applied to a closed correction", () => {
    expect(() =>
      decideQACorrectionLoop({
        qaRun: { ...failedRun, status: "RUNNING", completedAt: null, version: 1 },
        budgetUsage: { automaticUsed: 0, totalUsed: 0 },
        now,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_SOURCE_INVALID" }));
    expect(() =>
      decideQACorrectionLoop({
        qaRun: failedRun,
        currentCorrection: { ...correction(1), status: "PASSED", completedAt: now, version: 2 },
        budgetUsage: { automaticUsed: 1, totalUsed: 1 },
        now,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_STATE_MISMATCH" }));
  });
});

describe("pipeline-level QA correction cancellation", () => {
  it("closes active correction authority with an auditable event", () => {
    const currentCorrection = correction(1);
    const decision = decideQACorrectionCancellation({
      correctionRun: currentCorrection,
      run: { ...qaPipelineRun, currentStageAttemptId: "correction-implement" },
      stageAttempt: {
        ...qaStageAttempt(currentCorrection.id),
        id: "correction-implement",
        stage: "IMPLEMENT",
        status: "QUEUED",
      },
      now,
    });

    expect(decision).toEqual({
      correctionRun: {
        ...currentCorrection,
        status: "CANCELLED",
        completedAt: now,
        version: 2,
      },
      events: [
        {
          type: "QA_CORRECTION_CANCELLED",
          data: {
            correctionRun: {
              ...currentCorrection,
              status: "CANCELLED",
              completedAt: now,
              version: 2,
            },
          },
        },
      ],
    });
  });

  it("rejects cancellation from a stage outside the correction lineage", () => {
    expect(() =>
      decideQACorrectionCancellation({
        correctionRun: correction(1),
        run: qaPipelineRun,
        stageAttempt: qaStageAttempt(null),
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
  });
});

describe("failed QA correction workflow transition", () => {
  it("atomically starts correction one and dispatches a fresh IMPLEMENT cycle", () => {
    const decision = decideFailedQACorrectionTransition({
      qaRun: failedRun,
      sourceEvidence: failedEvidence,
      baselineQARun: failedRun,
      openDefects: defects,
      budgetUsage: { automaticUsed: 0, totalUsed: 0 },
      workItem: qaWorkItem,
      run: qaPipelineRun,
      stageAttempt: qaStageAttempt(),
      dispatch: qaDispatch(),
      ids: transitionIds,
      now,
    });

    expect(decision).toMatchObject({
      action: "START_CORRECTION",
      workItem: { state: "IN_PROGRESS", currentStage: "IMPLEMENT", version: 8 },
      run: {
        status: "RUNNING",
        currentStageAttemptId: transitionIds.nextStageAttemptId,
        version: 10,
      },
      completedStageAttempt: {
        status: "SUCCEEDED",
        finishedAt: now,
        resultTree: testedTree,
        version: 3,
      },
      completedDispatch: { status: "COMPLETED", completedAt: now },
      previousCorrection: null,
      correctionRun: {
        id: transitionIds.correctionRunId,
        ordinal: 1,
        baselineQARunId: failedRun.id,
        sourceQARunId: failedRun.id,
        defectIds: defects.map(({ id }) => id),
        status: "ACTIVE",
      },
      retestPlan: {
        id: transitionIds.retestPlanId,
        correctionRunId: transitionIds.correctionRunId,
        baselineQARunId: failedRun.id,
      },
      nextStageAttempt: {
        correctionRunId: transitionIds.correctionRunId,
        stage: "IMPLEMENT",
        attempt: 1,
        status: "QUEUED",
      },
      nextDispatch: { mode: "START", status: "PENDING" },
      request: null,
    });
    expect(decision.events.map(({ type }) => type)).toEqual([
      "QA_CORRECTION_STARTED",
      "STAGE_ATTEMPT_CHANGED",
    ]);
  });

  it("supersedes correction one and preserves the failed baseline for correction two", () => {
    const currentCorrection = correction(1);
    const retestRun: QARun = {
      ...failedRun,
      id: "qa-run-retest-1",
      stageAttemptId: "qa-attempt-retest-1",
      testedTree: "c".repeat(40),
      scope: {
        type: "RETEST",
        correctionRunId: currentCorrection.id,
        retestPlanId: "retest-1",
      },
    };
    const retestEvidence: QAEvidenceBundle = {
      ...failedEvidence,
      id: "qa-evidence-retest-1",
      qaRunId: retestRun.id,
      stageAttemptId: retestRun.stageAttemptId,
      testedTree: retestRun.testedTree,
    };
    const decision = decideFailedQACorrectionTransition({
      qaRun: retestRun,
      sourceEvidence: retestEvidence,
      baselineQARun: failedRun,
      openDefects: defects,
      currentCorrection,
      budgetUsage: { automaticUsed: 1, totalUsed: 1 },
      workItem: qaWorkItem,
      run: { ...qaPipelineRun, currentStageAttemptId: retestRun.stageAttemptId },
      stageAttempt: {
        ...qaStageAttempt(currentCorrection.id),
        id: retestRun.stageAttemptId,
      },
      dispatch: qaDispatch(retestRun.stageAttemptId),
      ids: { ...transitionIds, correctionRunId: "correction-2", retestPlanId: "retest-2" },
      now,
    });

    expect(decision).toMatchObject({
      action: "START_CORRECTION",
      previousCorrection: { id: currentCorrection.id, status: "SUPERSEDED", version: 2 },
      correctionRun: {
        id: "correction-2",
        ordinal: 2,
        sourceQARunId: retestRun.id,
        baselineQARunId: failedRun.id,
        sourceTestedTree: retestRun.testedTree,
      },
      retestPlan: {
        correctionRunId: "correction-2",
        sourceQARunId: retestRun.id,
        baselineQARunId: failedRun.id,
      },
    });
  });

  it("opens the shared owner gate when other evaluators consumed both automatic positions", () => {
    const decision = decideFailedQACorrectionTransition({
      qaRun: failedRun,
      sourceEvidence: failedEvidence,
      baselineQARun: failedRun,
      openDefects: defects,
      budgetUsage: { automaticUsed: 2, totalUsed: 2 },
      workItem: qaWorkItem,
      run: qaPipelineRun,
      stageAttempt: qaStageAttempt(),
      dispatch: qaDispatch(),
      ids: transitionIds,
      now,
    });

    expect(decision).toMatchObject({
      action: "WAIT_FOR_OWNER",
      previousCorrection: null,
      correctionRun: null,
      request: {
        context: "Two automatic delivery corrections were already consumed before this measured QA failure.",
        options: [
          {
            id: transitionIds.authorizeFinalOptionId,
            consequence: "Creates the final shared correction position with a locked retest plan.",
          },
          { id: transitionIds.cancelOptionId },
        ],
      },
    });
    expect(decision.events.map(({ type }) => type)).toEqual([
      "STAGE_ATTEMPT_CHANGED",
      "HUMAN_REQUEST_OPENED",
    ]);
  });

  it("opens the bounded owner gate after correction two and offers no fourth correction", () => {
    const exhaustedCorrection = correction(2);
    const finalCorrection = correction(3);
    const decideExhaustion = (currentCorrection: QACorrectionRun) => {
      const retestRun: QARun = {
        ...failedRun,
        id: `qa-run-retest-${currentCorrection.ordinal.toString()}`,
        stageAttemptId: `qa-attempt-retest-${currentCorrection.ordinal.toString()}`,
        scope: {
          type: "RETEST",
          correctionRunId: currentCorrection.id,
          retestPlanId: `retest-${currentCorrection.ordinal.toString()}`,
        },
      };
      return decideFailedQACorrectionTransition({
        qaRun: retestRun,
        sourceEvidence: {
          ...failedEvidence,
          id: `qa-evidence-retest-${currentCorrection.ordinal.toString()}`,
          qaRunId: retestRun.id,
          stageAttemptId: retestRun.stageAttemptId,
        },
        baselineQARun: failedRun,
        openDefects: defects,
        currentCorrection,
        budgetUsage:
          currentCorrection.ordinal <= 2
            ? { automaticUsed: currentCorrection.ordinal, totalUsed: currentCorrection.ordinal }
            : { automaticUsed: 2, totalUsed: 3 },
        workItem: qaWorkItem,
        run: { ...qaPipelineRun, currentStageAttemptId: retestRun.stageAttemptId },
        stageAttempt: {
          ...qaStageAttempt(currentCorrection.id),
          id: retestRun.stageAttemptId,
        },
        dispatch: qaDispatch(retestRun.stageAttemptId),
        ids: transitionIds,
        now,
      });
    };

    const automaticLimit = decideExhaustion(exhaustedCorrection);
    expect(automaticLimit).toMatchObject({
      action: "WAIT_FOR_OWNER",
      workItem: { state: "BLOCKED", currentStage: "QA" },
      run: { status: "WAITING_HUMAN" },
      completedStageAttempt: { status: "WAITING_HUMAN", failureCode: "QA_CORRECTION_EXHAUSTED" },
      previousCorrection: { status: "EXHAUSTED", version: 2 },
      correctionRun: null,
      retestPlan: null,
      nextStageAttempt: null,
      nextDispatch: null,
      request: {
        status: "OPEN",
        options: [{ id: transitionIds.authorizeFinalOptionId }, { id: transitionIds.cancelOptionId }],
      },
    });
    expect(automaticLimit.events.map(({ type }) => type)).toEqual([
      "STAGE_ATTEMPT_CHANGED",
      "HUMAN_REQUEST_OPENED",
      "QA_CORRECTION_EXHAUSTED",
    ]);

    const finalLimit = decideExhaustion(finalCorrection);
    expect(finalLimit).toMatchObject({
      action: "WAIT_FOR_OWNER",
      request: { options: [{ id: transitionIds.cancelOptionId }] },
    });
  });

  it("rejects stale workflow and correction scope lineage", () => {
    expect(() =>
      decideFailedQACorrectionTransition({
        qaRun: failedRun,
        sourceEvidence: failedEvidence,
        baselineQARun: failedRun,
        openDefects: defects,
        budgetUsage: { automaticUsed: 0, totalUsed: 0 },
        workItem: qaWorkItem,
        run: { ...qaPipelineRun, version: 10 },
        stageAttempt: { ...qaStageAttempt(), status: "WAITING_HUMAN" },
        dispatch: qaDispatch(),
        ids: transitionIds,
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );

    expect(() =>
      decideFailedQACorrectionTransition({
        qaRun: {
          ...failedRun,
          scope: { type: "RETEST", correctionRunId: "correction-1", retestPlanId: "retest-1" },
        },
        sourceEvidence: failedEvidence,
        baselineQARun: failedRun,
        openDefects: defects,
        currentCorrection: correction(2),
        budgetUsage: { automaticUsed: 2, totalUsed: 2 },
        workItem: qaWorkItem,
        run: qaPipelineRun,
        stageAttempt: qaStageAttempt("correction-1"),
        dispatch: qaDispatch(),
        ids: transitionIds,
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
  });
});

describe("passing QA correction transition", () => {
  const correctionReview = (
    correctionRunId: string,
    reviewedTree: string,
  ): { reviewReport: ReviewReport; reviewArtifact: EvidenceArtifact } => {
    const reviewReport: ReviewReport = {
      schemaVersion: 1,
      id: "review-report-passing-correction",
      projectId: failedRun.projectId,
      workItemId: failedRun.workItemId,
      pipelineRunId: failedRun.pipelineRunId,
      stageAttemptId: "review-attempt-passing-correction",
      correctionRunId,
      authorAgentRunId: "author-agent-passing-correction",
      reviewerAgentRunId: "reviewer-agent-passing-correction",
      providerRelation: "CROSS_PROVIDER",
      reviewedTree,
      round: 1,
      title: "Independent correction review",
      summary: "The correction passed independent review.",
      checks: ["Verified the correction against the reported defect."],
      verdict: "PASSED",
      findingIds: [],
      createdAt: now,
    };
    return {
      reviewReport,
      reviewArtifact: {
        schemaVersion: 1,
        id: "review-artifact-passing-correction",
        projectId: failedRun.projectId,
        workItemId: failedRun.workItemId,
        pipelineRunId: failedRun.pipelineRunId,
        stageAttemptId: reviewReport.stageAttemptId,
        correctionRunId,
        stage: "REVIEW",
        kind: "REVIEW_REPORT",
        status: "PASSED",
        provider: "CLAUDE_CODE",
        title: reviewReport.title,
        summary: reviewReport.summary,
        checks: reviewReport.checks,
        reviewReportId: reviewReport.id,
        testedTree: reviewedTree,
        createdAt: now,
      },
    };
  };

  it("passes the active correction and resolves only its still-open defects", () => {
    const currentCorrection = correction(1);
    const passingRun: QARun = {
      ...failedRun,
      id: "qa-run-passing-retest",
      stageAttemptId: "qa-attempt-passing-retest",
      scope: {
        type: "RETEST",
        correctionRunId: currentCorrection.id,
        retestPlanId: "retest-1",
      },
      status: "PASSED",
    };
    const passingEvidence: QAEvidenceBundle = {
      ...failedEvidence,
      id: "qa-evidence-passing-retest",
      qaRunId: passingRun.id,
      stageAttemptId: passingRun.stageAttemptId,
      verdict: "PASSED",
      executions: failedEvidence.executions.map((item) => ({
        ...item,
        assertions: item.assertions.map((assertion) => ({
          ...assertion,
          status: "PASSED" as const,
          details: null,
        })),
      })),
      observations: [],
      defectIds: [],
    };
    const { reviewReport, reviewArtifact } = correctionReview(currentCorrection.id, passingRun.testedTree);
    const decision = decidePassedQACorrectionTransition({
      qaRun: passingRun,
      evidence: passingEvidence,
      currentCorrection,
      defects: [
        firstDefect,
        {
          ...secondDefect,
          status: "WAIVED",
          resolutionReason: "Accepted risk.",
          resolvedByQARunId: null,
          resolvedAt: now,
          version: 2,
        },
        thirdDefect,
      ],
      openDefects: [firstDefect, thirdDefect],
      reviewReport,
      reviewArtifact,
      now,
    });

    expect(decision).toMatchObject({
      correctionRun: { id: currentCorrection.id, status: "PASSED", completedAt: now, version: 2 },
      resolvedDefects: [
        { id: "defect-1", status: "RESOLVED", version: 2 },
        { id: "defect-3", status: "RESOLVED", version: 2 },
      ],
      events: [{ type: "QA_CORRECTION_PASSED" }],
    });
  });

  it("rejects a green run outside the active correction lineage", () => {
    const currentCorrection = correction(1);
    const { reviewReport, reviewArtifact } = correctionReview(currentCorrection.id, failedRun.testedTree);
    expect(() =>
      decidePassedQACorrectionTransition({
        qaRun: { ...failedRun, status: "PASSED" },
        evidence: {
          ...failedEvidence,
          verdict: "PASSED",
          observations: [],
          defectIds: [],
        },
        currentCorrection,
        defects,
        openDefects: defects,
        reviewReport: { ...reviewReport, correctionRunId: null },
        reviewArtifact,
        now,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
  });
});

describe("QA correction acceptance lineage", () => {
  const correctionRun = correction(1);
  const retestPlan = deriveQARetestPlan({
    retestPlanId: "retest-acceptance-1",
    correctionRunId: correctionRun.id,
    baselineQARun: failedRun,
    sourceQARun: failedRun,
    sourceEvidence: failedEvidence,
    openDefects: defects,
    now,
  });
  const passingTree = "d".repeat(40);
  const passingQARun: QARun = {
    ...failedRun,
    id: "qa-run-acceptance-pass",
    stageAttemptId: "qa-attempt-acceptance-pass",
    agentRunId: "qa-agent-acceptance-pass",
    testedTree: passingTree,
    scope: {
      type: "RETEST",
      correctionRunId: correctionRun.id,
      retestPlanId: retestPlan.id,
    },
    status: "PASSED",
  };
  const passingEvidence: QAEvidenceBundle = {
    ...failedEvidence,
    id: "qa-evidence-acceptance-pass",
    qaRunId: passingQARun.id,
    stageAttemptId: passingQARun.stageAttemptId,
    testedTree: passingTree,
    verdict: "PASSED",
    executions: failedEvidence.executions.map((item) => ({
      ...item,
      assertions: item.assertions.map((assertion) => ({
        ...assertion,
        status: "PASSED" as const,
        details: null,
      })),
    })),
    observations: [],
    defectIds: [],
  };
  const passedCorrection: QACorrectionRun = {
    ...correctionRun,
    status: "PASSED",
    completedAt: now,
    version: 2,
  };
  const resolvedDefects: QADefect[] = defects.map((item) => ({
    ...item,
    status: "RESOLVED",
    resolutionReason: "The locked correction retest passed.",
    resolvedByQARunId: passingQARun.id,
    resolvedAt: now,
    version: 2,
  }));
  const lineage = {
    passingQARun,
    passingEvidence,
    currentTree: passingTree,
    correctionRuns: [passedCorrection],
    retestPlans: [retestPlan],
    qaRuns: [failedRun, passingQARun],
    evidenceBundles: [failedEvidence, passingEvidence],
    defects: resolvedDefects,
  };

  it("accepts one complete baseline-to-passing-retest chain", () => {
    expect(() => {
      assertQACorrectionAcceptanceLineage(lineage);
    }).not.toThrow();
  });

  it("rejects open defects, unrelated source evidence, and false resolution provenance", () => {
    expect(() => {
      assertQACorrectionAcceptanceLineage({
        ...lineage,
        defects: [firstDefect, ...resolvedDefects.slice(1)],
      });
    }).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
    expect(() => {
      assertQACorrectionAcceptanceLineage({
        ...lineage,
        evidenceBundles: [{ ...failedEvidence, projectId: "other-project" }, passingEvidence],
      });
    }).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
    expect(() => {
      assertQACorrectionAcceptanceLineage({
        ...lineage,
        defects: resolvedDefects.map((item, index) =>
          index === 0 ? { ...item, resolvedByQARunId: failedRun.id } : item,
        ),
      });
    }).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LINEAGE_MISMATCH" }),
    );
  });
});

describe("exhausted QA correction owner gate", () => {
  const sourceQARun: QARun = {
    ...failedRun,
    id: "qa-run-exhausting-correction-2",
    stageAttemptId: "qa-attempt-exhausted",
    scope: {
      type: "RETEST",
      correctionRunId: "correction-2",
      retestPlanId: "retest-2",
    },
  };
  const sourceEvidence: QAEvidenceBundle = {
    ...failedEvidence,
    id: "qa-evidence-exhausting-correction-2",
    qaRunId: sourceQARun.id,
    stageAttemptId: sourceQARun.stageAttemptId,
  };
  const exhaustedCorrection: QACorrectionRun = {
    ...correction(2),
    status: "EXHAUSTED",
    version: 2,
  };
  const waitingStage: StageAttempt = {
    ...qaStageAttempt(exhaustedCorrection.id),
    id: sourceQARun.stageAttemptId,
    status: "WAITING_HUMAN",
    failureCode: "QA_CORRECTION_EXHAUSTED",
    version: 3,
  };
  const waitingRun: PipelineRun = {
    ...qaPipelineRun,
    status: "WAITING_HUMAN",
    currentStageAttemptId: waitingStage.id,
    version: 10,
  };
  const blockedWorkItem: WorkItem = {
    ...qaWorkItem,
    state: "BLOCKED",
    version: 8,
  };
  const request: HumanRequest = {
    schemaVersion: 1,
    id: "request-correction-exhausted",
    projectId: failedRun.projectId,
    workItemId: failedRun.workItemId,
    stageAttemptId: waitingStage.id,
    kind: "SINGLE_CHOICE",
    blocking: true,
    title: "QA correction loop needs a decision",
    context: "Two automatic QA correction runs still ended in measured defects.",
    recommendation: "Inspect the complete defect and evidence history.",
    options: [
      {
        id: "option-authorize-final",
        label: "Authorize one final QA correction",
        consequence: "Creates CorrectionRun 3 with a locked retest plan.",
        recommended: true,
      },
      {
        id: "option-cancel",
        label: "Cancel the delivery",
        consequence: "Stops this PipelineRun without acceptance.",
        recommended: false,
      },
    ],
    allowOther: false,
    status: "OPEN",
    version: 1,
    createdAt: completedAt,
    resolvedAt: null,
  };
  const command = (
    action: ResolveQACorrectionGateCommand["payload"]["action"],
    overrides: Partial<ResolveQACorrectionGateCommand> = {},
  ): ResolveQACorrectionGateCommand => ({
    schemaVersion: 1,
    commandId: `resolve-gate-${action.toLowerCase()}`,
    correlationId: `correlation-resolve-gate-${action.toLowerCase()}`,
    actor: { type: "HUMAN", id: "owner-1" },
    type: "RESOLVE_QA_CORRECTION_GATE",
    payload: {
      humanRequestId: request.id,
      expectedRequestVersion: request.version,
      correctionRunId: exhaustedCorrection.id,
      expectedCorrectionVersion: exhaustedCorrection.version,
      expectedPipelineRunVersion: waitingRun.version,
      action,
    },
    ...overrides,
  });
  const gateContext = {
    workItem: blockedWorkItem,
    run: waitingRun,
    stageAttempt: waitingStage,
    request,
    correctionRun: exhaustedCorrection,
    sourceQARun,
    sourceEvidence,
    baselineQARun: failedRun,
    openDefects: defects,
    budgetUsage: { automaticUsed: 2, totalUsed: 2 },
    ids: {
      decisionId: "decision-final-correction",
      correctionRunId: "correction-3",
      retestPlanId: "retest-3",
      nextStageAttemptId: "attempt-implement-correction-3",
      dispatchId: "dispatch-implement-correction-3",
    },
    now,
  };

  it("authorizes exactly correction three and resumes at a fresh IMPLEMENT attempt", () => {
    const decision = decideQACorrectionGateResolution({
      command: command("AUTHORIZE_FINAL"),
      ...gateContext,
    });

    expect(decision).toMatchObject({
      action: "AUTHORIZE_FINAL",
      workItem: { state: "IN_PROGRESS", currentStage: "IMPLEMENT", version: 9 },
      run: {
        status: "RUNNING",
        currentStageAttemptId: "attempt-implement-correction-3",
        version: 11,
      },
      stageAttempt: { status: "SUCCEEDED", failureCode: null, resultTree: testedTree, version: 4 },
      request: { status: "RESOLVED", version: 2, resolvedAt: now },
      decision: { answer: { type: "OPTION", optionIds: ["option-authorize-final"] } },
      previousCorrection: { status: "SUPERSEDED", version: 3, completedAt: now },
      correctionRun: {
        id: "correction-3",
        ordinal: 3,
        sourceQARunId: sourceQARun.id,
        status: "ACTIVE",
      },
      retestPlan: { id: "retest-3", correctionRunId: "correction-3" },
      nextStageAttempt: { stage: "IMPLEMENT", attempt: 1, correctionRunId: "correction-3" },
      dispatch: { stageAttemptId: "attempt-implement-correction-3", status: "PENDING" },
    });
    expect(decision.events.map(({ type }) => type)).toEqual([
      "HUMAN_REQUEST_RESOLVED",
      "QA_CORRECTION_STARTED",
      "STAGE_ATTEMPT_CHANGED",
    ]);
  });

  it("cancels the correction and the complete delivery without a new dispatch", () => {
    const decision = decideQACorrectionGateResolution({
      command: command("CANCEL"),
      ...gateContext,
    });

    expect(decision).toMatchObject({
      action: "CANCEL",
      workItem: { state: "CANCELLED", currentStage: null },
      run: { status: "CANCELLED", finishedAt: now },
      stageAttempt: { status: "CANCELLED", finishedAt: now },
      request: { status: "RESOLVED" },
      decision: { answer: { type: "OPTION", optionIds: ["option-cancel"] } },
      previousCorrection: { status: "CANCELLED", completedAt: now },
      correctionRun: null,
      retestPlan: null,
      nextStageAttempt: null,
      dispatch: null,
    });
    expect(decision.events.map(({ type }) => type)).toEqual([
      "HUMAN_REQUEST_RESOLVED",
      "STAGE_ATTEMPT_CHANGED",
      "QA_CORRECTION_CANCELLED",
      "PIPELINE_CANCELLED",
    ]);
  });

  it("authorizes the final shared position when QA has no earlier local correction", () => {
    const sourceQARun: QARun = {
      ...failedRun,
      id: "qa-run-after-verification-corrections",
      stageAttemptId: waitingStage.id,
      verificationCorrectionRunId: "verification-correction-2",
    };
    const sourceEvidence: QAEvidenceBundle = {
      ...failedEvidence,
      id: "qa-evidence-after-verification-corrections",
      qaRunId: sourceQARun.id,
      stageAttemptId: waitingStage.id,
      verificationCorrectionRunId: "verification-correction-2",
    };
    const decision = decideQACorrectionGateResolution({
      ...gateContext,
      command: {
        ...command("AUTHORIZE_FINAL"),
        payload: {
          ...command("AUTHORIZE_FINAL").payload,
          correctionRunId: null,
          expectedCorrectionVersion: null,
        },
      },
      stageAttempt: {
        ...waitingStage,
        correctionRunId: null,
        verificationCorrectionRunId: "verification-correction-2",
      },
      correctionRun: null,
      sourceQARun,
      sourceEvidence,
      baselineQARun: sourceQARun,
    });

    expect(decision).toMatchObject({
      action: "AUTHORIZE_FINAL",
      previousCorrection: null,
      correctionRun: { ordinal: 1, sourceQARunId: sourceQARun.id },
      budgetAllocation: { position: 3, automatic: false },
      nextStageAttempt: {
        correctionRunId: "correction-3",
        verificationCorrectionRunId: null,
      },
    });
  });

  it("rejects non-owner, stale, and fourth-correction actions", () => {
    expect(() =>
      decideQACorrectionGateResolution({
        command: command("AUTHORIZE_FINAL", { actor: { type: "SYSTEM", id: "daemon" } }),
        ...gateContext,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_ACTOR_FORBIDDEN" }));
    expect(() =>
      decideQACorrectionGateResolution({
        command: command("AUTHORIZE_FINAL", {
          payload: { ...command("AUTHORIZE_FINAL").payload, expectedPipelineRunVersion: 9 },
        }),
        ...gateContext,
      }),
    ).toThrow(
      expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_VERSION_CONFLICT" }),
    );

    const finalCorrection: QACorrectionRun = { ...exhaustedCorrection, id: "correction-3", ordinal: 3 };
    const finalSource: QARun = {
      ...sourceQARun,
      id: "qa-run-exhausting-correction-3",
      scope: { type: "RETEST", correctionRunId: finalCorrection.id, retestPlanId: "retest-3" },
    };
    const finalRequest: HumanRequest = {
      ...request,
      options: [
        {
          id: "option-cancel",
          label: "Cancel the delivery",
          consequence: "Stops this PipelineRun without acceptance.",
          recommended: false,
        },
      ],
    };
    const finalStage: StageAttempt = {
      ...waitingStage,
      correctionRunId: finalCorrection.id,
    };
    expect(() =>
      decideQACorrectionGateResolution({
        command: {
          ...command("AUTHORIZE_FINAL"),
          payload: {
            ...command("AUTHORIZE_FINAL").payload,
            correctionRunId: finalCorrection.id,
          },
        },
        ...gateContext,
        correctionRun: finalCorrection,
        stageAttempt: finalStage,
        sourceQARun: finalSource,
        sourceEvidence: {
          ...sourceEvidence,
          qaRunId: finalSource.id,
        },
        request: finalRequest,
        budgetUsage: { automaticUsed: 2, totalUsed: 3 },
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LIMIT_REACHED" }));
  });
});
