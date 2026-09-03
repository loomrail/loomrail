import type {
  AgentRun,
  QACorrectionRun,
  QADriverResult,
  QARetestPlan,
  QARun,
  ReserveQARunCommand,
  StageAttempt,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideQACompletion,
  decideQAReservation,
  QACompletionError,
  QAReservationError,
  qaWorkflowOutcome,
} from "../src/qa.js";

const tree = "a".repeat(40);

const qaRun: QARun = {
  schemaVersion: 1,
  id: "qa-run-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "pipeline-1",
  stageAttemptId: "qa-attempt-1",
  agentRunId: "agent-run-qa-1",
  driverId: "PLAYWRIGHT",
  testedTree: tree,
  targetOrigin: "http://127.0.0.1:4173",
  plan: {
    schemaVersion: 1,
    revision: 1,
    contentHash: `sha256:${"b".repeat(64)}`,
    targets: [
      { id: "desktop-light-en", viewport: { width: 1_280, height: 800 }, locale: "en-US", theme: "LIGHT" },
      { id: "mobile-dark-ru", viewport: { width: 320, height: 720 }, locale: "ru-RU", theme: "DARK" },
    ],
    scenarios: [
      {
        id: "task-cockpit",
        title: "Task Cockpit shows measured work state",
        steps: [{ id: "open", title: "Open the Task Cockpit", action: { type: "NAVIGATE", path: "/" } }],
        assertions: [
          {
            id: "state",
            title: "The current state is visible",
            rule: { type: "VISIBLE", locator: { by: "TEXT", value: "Current work" } },
          },
        ],
      },
    ],
  },
  scope: { type: "FULL" },
  status: "RUNNING",
  error: null,
  startedAt: "2026-09-02T10:00:00.000Z",
  completedAt: null,
  version: 1,
};

const environment = {
  osFamily: "MACOS" as const,
  runtimeName: "NODE" as const,
  runtimeVersion: "24.7.0",
  browserName: "CHROMIUM" as const,
  browserVersion: "140.0",
};

const stageAttempt: StageAttempt = {
  schemaVersion: 1,
  id: qaRun.stageAttemptId,
  projectId: qaRun.projectId,
  workItemId: qaRun.workItemId,
  pipelineRunId: qaRun.pipelineRunId,
  correctionRunId: null,
  stage: "QA",
  attempt: 1,
  status: "RUNNING",
  startedAt: qaRun.startedAt,
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  packShareBackoffs: 0,
  resultTree: null,
  version: 1,
};

const agentRun: AgentRun = {
  schemaVersion: 1,
  id: qaRun.agentRunId,
  projectId: qaRun.projectId,
  workItemId: qaRun.workItemId,
  pipelineRunId: qaRun.pipelineRunId,
  stageAttemptId: qaRun.stageAttemptId,
  ordinal: 1,
  squadAssignmentId: "squad-1",
  profile: { id: "builtin.browser-qa", revision: 1, role: "BROWSER_QA" },
  provider: "CODEX",
  status: "RUNNING",
  policySnapshot: null,
  policySnapshotHash: `sha256:${"d".repeat(64)}`,
  startedAt: qaRun.startedAt,
  finishedAt: null,
  version: 1,
};

const reserveCommand: ReserveQARunCommand = {
  schemaVersion: 1,
  commandId: "reserve-qa-run-1",
  correlationId: "correlation-reserve-qa-run-1",
  actor: { type: "SYSTEM", id: "local-daemon" },
  type: "RESERVE_QA_RUN",
  payload: {
    stageAttemptId: qaRun.stageAttemptId,
    agentRunId: qaRun.agentRunId,
    testedTree: tree,
    targetOrigin: qaRun.targetOrigin,
    plan: qaRun.plan,
    scope: qaRun.scope,
  },
};

const failedBaselineRun: QARun = {
  ...qaRun,
  status: "FAILED",
  completedAt: "2026-09-02T09:55:00.000Z",
  version: 2,
};

const correctionRun: QACorrectionRun = {
  schemaVersion: 1,
  id: "correction-1",
  projectId: qaRun.projectId,
  workItemId: qaRun.workItemId,
  pipelineRunId: qaRun.pipelineRunId,
  ordinal: 1,
  sourceQARunId: failedBaselineRun.id,
  baselineQARunId: failedBaselineRun.id,
  sourceEvidenceBundleId: "evidence-baseline-1",
  sourceTestedTree: failedBaselineRun.testedTree,
  defectIds: ["defect-1"],
  status: "ACTIVE",
  createdAt: qaRun.startedAt,
  completedAt: null,
  version: 1,
};

const retestPlan: QARetestPlan = {
  schemaVersion: 1,
  id: "retest-plan-1",
  projectId: qaRun.projectId,
  workItemId: qaRun.workItemId,
  pipelineRunId: qaRun.pipelineRunId,
  correctionRunId: correctionRun.id,
  baselineQARunId: failedBaselineRun.id,
  sourceQARunId: failedBaselineRun.id,
  sourceEvidenceBundleId: correctionRun.sourceEvidenceBundleId,
  baselinePlanRevision: failedBaselineRun.plan.revision,
  baselinePlanContentHash: failedBaselineRun.plan.contentHash,
  cells: [
    {
      targetId: "desktop-light-en",
      scenarioId: "task-cockpit",
      reasons: ["FAILED_CHECK", "OPEN_DEFECT"],
    },
  ],
  createdAt: qaRun.startedAt,
};

const execution = (targetId: string, status: "PASSED" | "FAILED" = "PASSED") => ({
  targetId,
  scenarioId: "task-cockpit",
  durationMs: 100,
  steps: [{ id: "open", status: "PASSED" as const, durationMs: 60 }],
  assertions: [
    {
      id: "state",
      status,
      details: status === "FAILED" ? "The state section was missing." : null,
    },
  ],
});

const measuredResult = (status: "PASSED" | "FAILED" = "PASSED"): QADriverResult => ({
  outcome: "MEASURED",
  environment,
  executions: [execution("desktop-light-en", status), execution("mobile-dark-ru")],
  observations: [],
  attachments: [],
  defects:
    status === "FAILED"
      ? [
          {
            severity: "HIGH",
            title: "Current work state is missing",
            description: "The required current state is absent on the desktop target.",
            reproduction: ["Open the Task Cockpit at 1280x800.", "Inspect the current work section."],
            targetId: "desktop-light-en",
            scenarioId: "task-cockpit",
          },
        ]
      : [],
});

describe("deterministic Browser QA completion", () => {
  it("reserves QA only for the local daemon, current tree, and active Browser QA role", () => {
    expect(
      decideQAReservation(reserveCommand, {
        newQARunId: "qa-run-reserved",
        now: qaRun.startedAt,
        currentTree: tree,
        stageAttempt,
        agentRun,
      }),
    ).toMatchObject({
      id: "qa-run-reserved",
      stageAttemptId: stageAttempt.id,
      agentRunId: agentRun.id,
      status: "RUNNING",
      testedTree: tree,
    });
    expect(() =>
      decideQAReservation(
        { ...reserveCommand, actor: { type: "HUMAN", id: "owner-1" } },
        {
          newQARunId: "qa-run-refused",
          now: qaRun.startedAt,
          currentTree: tree,
          stageAttempt,
          agentRun,
        },
      ),
    ).toThrow(expect.objectContaining<Partial<QAReservationError>>({ code: "QA_RUN_ACTOR_FORBIDDEN" }));
    expect(() =>
      decideQAReservation(reserveCommand, {
        newQARunId: "qa-run-stale",
        now: qaRun.startedAt,
        currentTree: "e".repeat(40),
        stageAttempt,
        agentRun,
      }),
    ).toThrow(expect.objectContaining<Partial<QAReservationError>>({ code: "STALE_QA_TREE" }));
  });

  it("requires FULL scope outside a correction and the exact correction identity for a retest", () => {
    const retestScope = {
      type: "RETEST" as const,
      correctionRunId: "correction-1",
      retestPlanId: "retest-plan-1",
    };
    expect(() =>
      decideQAReservation(
        { ...reserveCommand, payload: { ...reserveCommand.payload, scope: retestScope } },
        {
          newQARunId: "qa-run-invalid-retest",
          now: qaRun.startedAt,
          currentTree: tree,
          stageAttempt,
          agentRun,
        },
      ),
    ).toThrow(expect.objectContaining<Partial<QAReservationError>>({ code: "QA_SCOPE_MISMATCH" }));

    const correctionStage = { ...stageAttempt, correctionRunId: "correction-1" };
    expect(() =>
      decideQAReservation(reserveCommand, {
        newQARunId: "qa-run-invalid-full",
        now: qaRun.startedAt,
        currentTree: tree,
        stageAttempt: correctionStage,
        agentRun,
      }),
    ).toThrow(expect.objectContaining<Partial<QAReservationError>>({ code: "QA_SCOPE_MISMATCH" }));
    expect(
      decideQAReservation(
        { ...reserveCommand, payload: { ...reserveCommand.payload, scope: retestScope } },
        {
          newQARunId: "qa-run-retest",
          now: qaRun.startedAt,
          currentTree: tree,
          stageAttempt: correctionStage,
          agentRun,
          currentCorrection: correctionRun,
          retestPlan,
          baselineQARun: failedBaselineRun,
        },
      ),
    ).toMatchObject({ scope: retestScope });
  });

  it("accepts only the ordered cells in the immutable retest plan", () => {
    const retestRun: QARun = {
      ...qaRun,
      scope: {
        type: "RETEST",
        correctionRunId: correctionRun.id,
        retestPlanId: retestPlan.id,
      },
    };
    const result = measuredResult();
    if (result.outcome !== "MEASURED") throw new Error("Expected measured result fixture");
    const retestDecision = decideQACompletion({
      qaRun: retestRun,
      agentRun,
      expectedVersion: 1,
      currentTree: tree,
      result: { ...result, executions: [execution("desktop-light-en")] },
      finalizedAttachments: [],
      retestPlan,
      now: "2026-09-02T10:05:00.000Z",
    });
    expect(retestDecision).toMatchObject({
      status: "PASSED",
      evidence: { executions: [{ targetId: "desktop-light-en" }] },
    });
    expect(qaWorkflowOutcome(retestDecision)).toMatchObject({
      type: "COMPLETED",
      summary: "The locked QA correction retest passed.",
    });

    expect(() =>
      decideQACompletion({
        qaRun: retestRun,
        agentRun,
        expectedVersion: 1,
        currentTree: tree,
        result,
        finalizedAttachments: [],
        retestPlan,
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_MATRIX_INCOMPLETE" }));
    expect(() =>
      decideQACompletion({
        qaRun: retestRun,
        agentRun,
        expectedVersion: 1,
        currentTree: tree,
        result: { ...result, executions: [execution("desktop-light-en")] },
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_MATRIX_INCOMPLETE" }));
  });

  it("derives PASSED only from a complete green matrix", () => {
    const decision = decideQACompletion({
      qaRun,
      agentRun,
      expectedVersion: 1,
      currentTree: tree,
      result: measuredResult(),
      finalizedAttachments: [],
      now: "2026-09-02T10:05:00.000Z",
    });

    expect(decision).toMatchObject({
      status: "PASSED",
      qaRun: { status: "PASSED", completedAt: "2026-09-02T10:05:00.000Z", version: 2 },
      evidence: { verdict: "PASSED", defects: [] },
      requiresHumanRequest: false,
    });
    expect(qaWorkflowOutcome(decision)).toMatchObject({
      type: "COMPLETED",
      artifacts: [{ kind: "QA_REPORT", title: "Deterministic browser QA" }],
    });
  });

  it("derives FAILED from a failed assertion and keeps its reproducible defect", () => {
    const decision = decideQACompletion({
      qaRun,
      agentRun,
      expectedVersion: 1,
      currentTree: tree,
      result: measuredResult("FAILED"),
      finalizedAttachments: [],
      now: "2026-09-02T10:05:00.000Z",
    });

    expect(decision).toMatchObject({
      status: "FAILED",
      qaRun: { status: "FAILED", error: null, version: 2 },
      evidence: { verdict: "FAILED", defects: [{ severity: "HIGH" }] },
      requiresHumanRequest: true,
    });
    expect(qaWorkflowOutcome(decision)).toMatchObject({
      type: "NEEDS_HUMAN",
      request: { title: "Browser QA found blocking defects" },
    });
  });

  it("records a driver error without inventing measured evidence", () => {
    const decision = decideQACompletion({
      qaRun,
      agentRun,
      expectedVersion: 1,
      currentTree: tree,
      result: {
        outcome: "ERROR",
        code: "TARGET_UNHEALTHY",
        summary: "The loopback target refused connections.",
      },
      finalizedAttachments: [],
      now: "2026-09-02T10:05:00.000Z",
    });

    expect(decision).toMatchObject({
      status: "ERROR",
      qaRun: { status: "ERROR", error: { code: "TARGET_UNHEALTHY" }, version: 2 },
      evidence: null,
      requiresHumanRequest: true,
    });
    expect(qaWorkflowOutcome(decision)).toMatchObject({
      type: "NEEDS_HUMAN",
      request: { title: "Browser QA could not prove the implementation" },
    });
  });

  it("rejects stale trees and optimistic-version conflicts", () => {
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun,
        expectedVersion: 1,
        currentTree: "c".repeat(40),
        result: measuredResult(),
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "STALE_QA_TREE" }));
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun,
        expectedVersion: 2,
        currentTree: tree,
        result: measuredResult(),
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_RUN_VERSION_CONFLICT" }));
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun: { ...agentRun, status: "SUCCEEDED", finishedAt: qaRun.startedAt, version: 2 },
        expectedVersion: 1,
        currentTree: tree,
        result: measuredResult(),
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_AGENT_RUN_MISMATCH" }));
  });

  it("rejects missing matrix cells, reordered checks, and failures without defects", () => {
    const complete = measuredResult();
    if (complete.outcome !== "MEASURED") throw new Error("Expected measured result fixture");
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun,
        expectedVersion: 1,
        currentTree: tree,
        result: { ...complete, executions: complete.executions.slice(0, 1) },
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_MATRIX_INCOMPLETE" }));
    const firstExecution = complete.executions[0];
    const secondExecution = complete.executions[1];
    if (!firstExecution || !secondExecution) throw new Error("Expected complete matrix fixture");
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun,
        expectedVersion: 1,
        currentTree: tree,
        result: {
          ...complete,
          executions: [
            { ...firstExecution, assertions: [{ id: "unknown", status: "PASSED", details: null }] },
            secondExecution,
          ],
        },
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_MATRIX_INCOMPLETE" }));
    const failed = measuredResult("FAILED");
    if (failed.outcome !== "MEASURED") throw new Error("Expected measured result fixture");
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun,
        expectedVersion: 1,
        currentTree: tree,
        result: { ...failed, defects: [] },
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_EVIDENCE_INCONSISTENT" }));
  });

  it("rejects missing or mismatched finalized attachment metadata", () => {
    const result = measuredResult();
    if (result.outcome !== "MEASURED") throw new Error("Expected measured result fixture");
    const draft = {
      handle: "quarantine-screenshot-1",
      kind: "SCREENSHOT" as const,
      contentHash: `sha256:${"f".repeat(64)}`,
      byteSize: 4_096,
      targetId: "desktop-light-en",
      scenarioId: "task-cockpit",
      capturedAt: "2026-09-02T10:04:00.000Z",
    };
    const withAttachment: QADriverResult = { ...result, attachments: [draft] };
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun,
        expectedVersion: 1,
        currentTree: tree,
        result: withAttachment,
        finalizedAttachments: [],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_EVIDENCE_INCONSISTENT" }));
    expect(() =>
      decideQACompletion({
        qaRun,
        agentRun,
        expectedVersion: 1,
        currentTree: tree,
        result: withAttachment,
        finalizedAttachments: [
          {
            handle: draft.handle,
            ref: {
              schemaVersion: 1,
              id: "attachment-1",
              qaRunId: qaRun.id,
              kind: draft.kind,
              contentHash: `sha256:${"0".repeat(64)}`,
              byteSize: draft.byteSize,
              targetId: draft.targetId,
              scenarioId: draft.scenarioId,
              capturedAt: draft.capturedAt,
              retentionClass: "STANDARD_30_DAYS",
              storageKey: "qa-run-1/screenshot.png",
            },
          },
        ],
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_EVIDENCE_INCONSISTENT" }));
  });
});
