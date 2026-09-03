import { describe, expect, it } from "vitest";

import {
  evidenceArtifactSchema,
  humanRequestDraftSchema,
  providerUsageReportSchema,
  providerUsageSchema,
  stateCommandSchema,
} from "../src/index.js";

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

  it("accepts only the session-scoped internal command", () => {
    expect(
      stateCommandSchema.parse({
        schemaVersion: 1,
        commandId: "provider-usage-command",
        correlationId: "provider-usage-correlation",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "RECORD_PROVIDER_USAGE",
        payload: { providerSessionId: "provider-session-1", usage: validUsage },
      }).type,
    ).toBe("RECORD_PROVIDER_USAGE");
  });

  it("keeps total tokens and the positive ledger link consistent", () => {
    const report = {
      schemaVersion: 1,
      id: "provider-usage-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      pipelineRunId: "pipeline-1",
      stageAttemptId: "attempt-1",
      agentRunId: "agent-run-1",
      providerSessionId: "provider-session-1",
      usageRecordId: "usage-record-1",
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: 1540,
      costUsd: null,
      quality: "ACTUAL",
      usageDigest: `sha256:${"a".repeat(64)}`,
      recordedAt: "2026-09-03T10:00:00.000Z",
    } as const;
    expect(providerUsageReportSchema.parse(report).totalTokens).toBe(1540);
    expect(() => providerUsageReportSchema.parse({ ...report, totalTokens: 1541 })).toThrow();
    expect(() => providerUsageReportSchema.parse({ ...report, usageRecordId: null })).toThrow();
    expect(() =>
      providerUsageReportSchema.parse({
        ...report,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        usageRecordId: "usage-record-zero",
      }),
    ).toThrow();
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
    correctionRunId: null,
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

  it("requires exact authority provenance for correction evidence", () => {
    const reviewArtifact = {
      ...artifact,
      correctionRunId: "correction-run-1",
      reviewReportId: "review-report-1",
      testedTree: "b".repeat(40),
    } as const;
    expect(evidenceArtifactSchema.parse(reviewArtifact)).toMatchObject({
      correctionRunId: "correction-run-1",
      reviewReportId: "review-report-1",
    });
    expect(() => evidenceArtifactSchema.parse({ ...reviewArtifact, reviewReportId: undefined })).toThrow();

    const qaArtifact = {
      ...artifact,
      id: "artifact-correction-qa",
      stageAttemptId: "attempt-correction-qa",
      correctionRunId: "correction-run-1",
      stage: "QA",
      kind: "QA_REPORT",
      qaRunId: "qa-run-1",
      qaEvidenceBundleId: "qa-evidence-1",
      testedTree: "c".repeat(40),
    } as const;
    expect(evidenceArtifactSchema.parse(qaArtifact).correctionRunId).toBe("correction-run-1");
    expect(() => evidenceArtifactSchema.parse({ ...qaArtifact, qaEvidenceBundleId: undefined })).toThrow();
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
