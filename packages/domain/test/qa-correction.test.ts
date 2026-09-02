import type { QACorrectionRun, QADefect, QAEvidenceBundle, QAPlanSnapshot, QARun } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideQACorrectionLoop,
  decideQACorrectionOwnerAction,
  deriveQARetestPlan,
  QACorrectionError,
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
if (firstDefect === undefined) throw new Error("Expected the primary defect fixture");

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
  retestPlanId: `retest-${ordinal.toString()}`,
  status: "ACTIVE",
  createdAt: completedAt,
  completedAt: null,
  version: 1,
});

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
    expect(decideQACorrectionLoop({ qaRun: failedRun, now })).toEqual({
      action: "START_CORRECTION",
      automatic: true,
      nextOrdinal: 1,
      previousCorrection: null,
    });

    const second = decideQACorrectionLoop({ qaRun: failedRun, currentCorrection: correction(1), now });
    expect(second).toMatchObject({
      action: "START_CORRECTION",
      automatic: true,
      nextOrdinal: 2,
      previousCorrection: { status: "SUPERSEDED", version: 2, completedAt: now },
    });
  });

  it("requires the owner after correction two and never authorizes correction four", () => {
    const exhausted = decideQACorrectionLoop({ qaRun: failedRun, currentCorrection: correction(2), now });
    expect(exhausted).toMatchObject({
      action: "WAIT_FOR_OWNER",
      canAuthorizeFinal: true,
      correctionRun: { status: "EXHAUSTED", version: 2, completedAt: null },
    });
    if (exhausted.action !== "WAIT_FOR_OWNER") throw new Error("Expected exhausted correction");
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

    const finalFailure = decideQACorrectionLoop({ qaRun: failedRun, currentCorrection: correction(3), now });
    expect(finalFailure).toMatchObject({ action: "WAIT_FOR_OWNER", canAuthorizeFinal: false });
    if (finalFailure.action !== "WAIT_FOR_OWNER") throw new Error("Expected final exhausted correction");
    expect(() =>
      decideQACorrectionOwnerAction({
        correctionRun: finalFailure.correctionRun,
        action: "AUTHORIZE_FINAL",
        now,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_LIMIT_REACHED" }));
  });

  it("passes a correction, advances a green baseline, and retries ERROR without spending a correction", () => {
    const passedRun: QARun = { ...failedRun, status: "PASSED" };
    expect(decideQACorrectionLoop({ qaRun: passedRun, now })).toEqual({
      action: "ADVANCE_BASELINE_TO_ACCEPTANCE",
    });
    expect(decideQACorrectionLoop({ qaRun: passedRun, currentCorrection: correction(1), now })).toMatchObject(
      {
        action: "PASS_CORRECTION",
        correctionRun: { status: "PASSED", version: 2, completedAt: now },
      },
    );

    const errorRun: QARun = {
      ...failedRun,
      status: "ERROR",
      error: { code: "TIMEOUT", summary: "The target stopped responding." },
    };
    expect(decideQACorrectionLoop({ qaRun: errorRun, currentCorrection: correction(1), now })).toEqual({
      action: "RETRY_ENVIRONMENT",
      correctionRun: correction(1),
    });
  });

  it("rejects running QA and outcomes applied to a closed correction", () => {
    expect(() =>
      decideQACorrectionLoop({
        qaRun: { ...failedRun, status: "RUNNING", completedAt: null, version: 1 },
        now,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_SOURCE_INVALID" }));
    expect(() =>
      decideQACorrectionLoop({
        qaRun: failedRun,
        currentCorrection: { ...correction(1), status: "PASSED", completedAt: now, version: 2 },
        now,
      }),
    ).toThrow(expect.objectContaining<Partial<QACorrectionError>>({ code: "QA_CORRECTION_STATE_MISMATCH" }));
  });
});
