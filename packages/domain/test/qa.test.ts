import type { QADriverResult, QARun } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { decideQACompletion, QACompletionError } from "../src/qa.js";

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
        steps: [{ id: "open", title: "Open the Task Cockpit" }],
        assertions: [{ id: "state", title: "The current state is visible" }],
      },
    ],
  },
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
  it("derives PASSED only from a complete green matrix", () => {
    const decision = decideQACompletion({
      qaRun,
      expectedVersion: 1,
      currentTree: tree,
      result: measuredResult(),
      now: "2026-09-02T10:05:00.000Z",
    });

    expect(decision).toMatchObject({
      status: "PASSED",
      qaRun: { status: "PASSED", completedAt: "2026-09-02T10:05:00.000Z", version: 2 },
      evidence: { verdict: "PASSED", defects: [] },
      requiresHumanRequest: false,
    });
  });

  it("derives FAILED from a failed assertion and keeps its reproducible defect", () => {
    const decision = decideQACompletion({
      qaRun,
      expectedVersion: 1,
      currentTree: tree,
      result: measuredResult("FAILED"),
      now: "2026-09-02T10:05:00.000Z",
    });

    expect(decision).toMatchObject({
      status: "FAILED",
      qaRun: { status: "FAILED", error: null, version: 2 },
      evidence: { verdict: "FAILED", defects: [{ severity: "HIGH" }] },
      requiresHumanRequest: true,
    });
  });

  it("records a driver error without inventing measured evidence", () => {
    const decision = decideQACompletion({
      qaRun,
      expectedVersion: 1,
      currentTree: tree,
      result: {
        outcome: "ERROR",
        code: "TARGET_UNHEALTHY",
        summary: "The loopback target refused connections.",
      },
      now: "2026-09-02T10:05:00.000Z",
    });

    expect(decision).toMatchObject({
      status: "ERROR",
      qaRun: { status: "ERROR", error: { code: "TARGET_UNHEALTHY" }, version: 2 },
      evidence: null,
      requiresHumanRequest: true,
    });
  });

  it("rejects stale trees and optimistic-version conflicts", () => {
    expect(() =>
      decideQACompletion({
        qaRun,
        expectedVersion: 1,
        currentTree: "c".repeat(40),
        result: measuredResult(),
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "STALE_QA_TREE" }));
    expect(() =>
      decideQACompletion({
        qaRun,
        expectedVersion: 2,
        currentTree: tree,
        result: measuredResult(),
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_RUN_VERSION_CONFLICT" }));
  });

  it("rejects missing matrix cells, reordered checks, and failures without defects", () => {
    const complete = measuredResult();
    if (complete.outcome !== "MEASURED") throw new Error("Expected measured result fixture");
    expect(() =>
      decideQACompletion({
        qaRun,
        expectedVersion: 1,
        currentTree: tree,
        result: { ...complete, executions: complete.executions.slice(0, 1) },
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_MATRIX_INCOMPLETE" }));
    const firstExecution = complete.executions[0];
    const secondExecution = complete.executions[1];
    if (!firstExecution || !secondExecution) throw new Error("Expected complete matrix fixture");
    expect(() =>
      decideQACompletion({
        qaRun,
        expectedVersion: 1,
        currentTree: tree,
        result: {
          ...complete,
          executions: [
            { ...firstExecution, assertions: [{ id: "unknown", status: "PASSED", details: null }] },
            secondExecution,
          ],
        },
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_MATRIX_INCOMPLETE" }));
    const failed = measuredResult("FAILED");
    if (failed.outcome !== "MEASURED") throw new Error("Expected measured result fixture");
    expect(() =>
      decideQACompletion({
        qaRun,
        expectedVersion: 1,
        currentTree: tree,
        result: { ...failed, defects: [] },
        now: "2026-09-02T10:05:00.000Z",
      }),
    ).toThrow(expect.objectContaining<Partial<QACompletionError>>({ code: "QA_EVIDENCE_INCONSISTENT" }));
  });
});
