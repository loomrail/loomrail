import { describe, expect, it } from "vitest";

import {
  checkpointDraftSchema,
  checkpointSchema,
  contextPackRecipeSchema,
  contextWindowUsageSchema,
  providerSessionSchema,
} from "../src/index.js";

describe("session handoff contracts", () => {
  const session = (overrides: Record<string, unknown>) => ({
    schemaVersion: 1,
    id: "session-1",
    stageAttemptId: "attempt-1",
    ordinal: 1,
    status: "RUNNING",
    endReason: null,
    handoffRequestedAt: null,
    startedAt: "2026-08-25T18:00:00.000Z",
    endedAt: null,
    version: 1,
    // Neither test using this fixture is about a session that actually spawned a process -- both
    // are generic well-formed-shape checks (one RUNNING, one ENDED) -- so null is the honest value:
    // a running session that never started one.
    pid: null,
    ...overrides,
  });

  it("accepts a well-formed running session", () => {
    expect(providerSessionSchema.parse(session({}))).toBeTruthy();
  });

  it("accepts a well-formed ended session with a reason and an end timestamp", () => {
    expect(
      providerSessionSchema.parse(
        session({ status: "ENDED", endReason: "COMPLETED", endedAt: "2026-08-25T18:05:00.000Z" }),
      ),
    ).toBeTruthy();
  });

  it("rejects a session ordinal below one", () => {
    expect(() => providerSessionSchema.parse(session({ ordinal: 0 }))).toThrow();
  });

  it("requires an end reason once a session has ended", () => {
    // Завершённая сессия без причины делает аудит бесполезным именно там, где он нужен.
    expect(() =>
      providerSessionSchema.parse(
        session({ status: "ENDED", endReason: null, endedAt: "2026-08-25T18:05:00.000Z" }),
      ),
    ).toThrow();
  });

  it("rejects an end reason on a still-running session", () => {
    expect(() => providerSessionSchema.parse(session({ endReason: "HANDOFF" }))).toThrow();
  });

  it("requires an end timestamp once a session has ended", () => {
    // An ended session with no end timestamp makes the audit trail lie about when work stopped.
    expect(() =>
      providerSessionSchema.parse(session({ status: "ENDED", endReason: "COMPLETED", endedAt: null })),
    ).toThrow();
  });

  it("rejects an end timestamp on a still-running session", () => {
    expect(() => providerSessionSchema.parse(session({ endedAt: "2026-08-25T18:05:00.000Z" }))).toThrow();
  });

  it("accepts a checkpoint with no dead ends but not one with no summary", () => {
    expect(
      checkpointDraftSchema.parse({
        summary: "Wired the assembler into the daemon.",
        completed: ["Added the migration"],
        remaining: ["Wire the cockpit"],
        deadEnds: [],
        openQuestions: [],
      }),
    ).toBeTruthy();
    expect(() =>
      checkpointDraftSchema.parse({
        summary: "",
        completed: [],
        remaining: [],
        deadEnds: [],
        openQuestions: [],
      }),
    ).toThrow();
  });

  const checkpoint = (overrides: Record<string, unknown>) => ({
    schemaVersion: 1,
    id: "checkpoint-1",
    stageAttemptId: "attempt-1",
    providerSessionId: "session-1",
    ordinal: 1,
    summary: "Wired the assembler into the daemon.",
    completed: ["Added the migration"],
    remaining: ["Wire the cockpit"],
    deadEnds: [],
    openQuestions: [],
    createdAt: "2026-08-25T18:05:00.000Z",
    ...overrides,
  });

  it("accepts a well-formed persisted checkpoint", () => {
    expect(checkpointSchema.parse(checkpoint({}))).toBeTruthy();
  });

  it("rejects a persisted checkpoint with no summary", () => {
    expect(() => checkpointSchema.parse(checkpoint({ summary: "" }))).toThrow();
  });

  const usage = (overrides: Record<string, unknown>) => ({
    usedTokens: 500,
    windowTokens: 1_000,
    quality: "ACTUAL",
    ...overrides,
  });

  it("accepts usage exactly at the window ceiling", () => {
    expect(contextWindowUsageSchema.parse(usage({ usedTokens: 1_000 }))).toBeTruthy();
  });

  it("rejects usage that exceeds the window", () => {
    expect(() => contextWindowUsageSchema.parse(usage({ usedTokens: 1_001 }))).toThrow();
  });

  const recipe = (overrides: Record<string, unknown>) => ({
    schemaVersion: 1,
    id: "recipe-1",
    providerSessionId: "session-1",
    templateId: "template-1",
    templateVersion: 3,
    specSource: "WORKFLOW_TEMPLATE",
    sections: [
      {
        id: "WORK_ITEM_BRIEF",
        sources: [{ kind: "WORK_ITEM", id: "work-item-1", version: 1 }],
        bytes: 120,
      },
      {
        id: "DECISIONS",
        sources: [
          { kind: "DECISION", id: "decision-1", version: 1 },
          { kind: "DECISION", id: "decision-2", version: 2 },
        ],
        bytes: 240,
      },
      {
        id: "WORKFLOW_POSITION",
        sources: [],
        bytes: 60,
      },
    ],
    omitted: [{ id: "ACTIVITY", reason: "CONTEXT_BUDGET" }],
    contentHash: `sha256:${"a".repeat(64)}`,
    estimatedTokens: 100,
    budgetTokens: 200,
    estimateQuality: "LOOMRAIL_ESTIMATE",
    createdAt: "2026-08-25T18:00:00.000Z",
    ...overrides,
  });

  it("accepts a recipe whose section provenance carries zero, one, and many sources", () => {
    expect(contextPackRecipeSchema.parse(recipe({}))).toBeTruthy();
  });

  it("rejects a content hash missing the sha256 prefix", () => {
    expect(() => contextPackRecipeSchema.parse(recipe({ contentHash: "a".repeat(64) }))).toThrow();
  });
});
