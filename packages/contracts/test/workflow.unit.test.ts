import { describe, expect, it } from "vitest";

import { evidenceArtifactSchema, humanRequestDraftSchema, providerUsageSchema } from "../src/index.js";

describe("provider usage contract", () => {
  const validUsage = { inputTokens: 1200, outputTokens: 340, quality: "ACTUAL" } as const;

  it("accepts a report without cost, because not every provider reports one", () => {
    expect(providerUsageSchema.parse(validUsage)).toEqual(validUsage);
  });

  it("accepts a report with cost", () => {
    expect(providerUsageSchema.parse({ ...validUsage, costUsd: 0.0412 }).costUsd).toBeCloseTo(0.0412);
  });

  // Each negative case breaks exactly one field of the proven-valid fixture, so a failure names the
  // rule that broke rather than "something in this object is wrong".
  it("rejects a negative token count", () => {
    expect(() => providerUsageSchema.parse({ ...validUsage, outputTokens: -1 })).toThrow();
  });

  it("rejects a fractional token count", () => {
    expect(() => providerUsageSchema.parse({ ...validUsage, inputTokens: 1.5 })).toThrow();
  });

  it("rejects a field beyond the schema, so a provider cannot smuggle content through usage", () => {
    expect(() => providerUsageSchema.parse({ ...validUsage, transcript: "…" })).toThrow();
  });
});

describe("evidence provider contract", () => {
  const artifact = {
    schemaVersion: 1,
    id: "artifact-review",
    projectId: "project-1",
    workItemId: "work-item-1",
    pipelineRunId: "run-1",
    stageAttemptId: "attempt-review",
    stage: "REVIEW",
    kind: "REVIEW_REPORT",
    status: "PASSED",
    provider: "MOCK",
    title: "Independent review",
    summary: "No blocking findings remain.",
    checks: ["Acceptance criteria traced"],
    createdAt: "2026-08-29T10:00:00.000Z",
  } as const;

  it.each(["MOCK", "CODEX", "CLAUDE_CODE"] as const)("accepts evidence attributed to %s", (provider) => {
    expect(evidenceArtifactSchema.parse({ ...artifact, provider }).provider).toBe(provider);
  });

  it("rejects an adapter identity outside the closed provider set", () => {
    expect(() => evidenceArtifactSchema.parse({ ...artifact, provider: "GPT" })).toThrow();
  });

  it("accepts only complete measured provenance on a QA report", () => {
    const qaArtifact = {
      ...artifact,
      id: "artifact-qa",
      stageAttemptId: "attempt-qa",
      stage: "QA",
      kind: "QA_REPORT",
      title: "Deterministic browser QA",
      qaRunId: "qa-run-1",
      qaEvidenceBundleId: "qa-evidence-1",
      testedTree: "a".repeat(40),
    } as const;

    expect(evidenceArtifactSchema.parse(qaArtifact)).toMatchObject({
      qaRunId: "qa-run-1",
      qaEvidenceBundleId: "qa-evidence-1",
    });
    expect(() => evidenceArtifactSchema.parse({ ...qaArtifact, qaEvidenceBundleId: undefined })).toThrow();
    expect(() => evidenceArtifactSchema.parse({ ...artifact, qaRunId: "qa-run-1" })).toThrow();
  });
});

describe("provider Human Request draft contract", () => {
  const base = {
    blocking: true,
    title: "Resolve the blocker",
    context: "The stage cannot continue without owner input.",
    recommendation: null,
  } as const;

  it("rejects a confirmation that exposes no possible answer", () => {
    expect(() =>
      humanRequestDraftSchema.parse({
        ...base,
        kind: "CONFIRMATION",
        options: [],
        allowOther: false,
      }),
    ).toThrow();
  });

  it("accepts an enumerated choice and an actual free-text request", () => {
    expect(() =>
      humanRequestDraftSchema.parse({
        ...base,
        kind: "SINGLE_CHOICE",
        options: [
          {
            id: "proceed",
            label: "Proceed",
            consequence: "Continue the bounded stage.",
            recommended: true,
          },
        ],
        allowOther: false,
      }),
    ).not.toThrow();
    expect(() =>
      humanRequestDraftSchema.parse({
        ...base,
        kind: "FREE_TEXT",
        options: [],
        allowOther: true,
      }),
    ).not.toThrow();
  });
});
