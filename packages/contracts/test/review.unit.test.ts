import { describe, expect, it } from "vitest";

import { reviewFindingDraftSchema, reviewFindingSchema, reviewReportDraftSchema } from "../src/review.js";
import { stateCommandSchema } from "../src/work-management.js";

const finding = {
  severity: "HIGH" as const,
  title: "The retry can apply twice",
  description: "The command receipt is written after the mutable row.",
  path: "packages/domain/src/review.ts",
  startLine: 40,
  endLine: 44,
  reproduction: "Submit the same command concurrently and inspect both accepted results.",
  criterion: "A retry is idempotent.",
  suggestedFix: "Write the receipt in the same transaction before returning.",
};

describe("review contracts", () => {
  it("keeps verdict and finding cardinality consistent", () => {
    expect(
      reviewReportDraftSchema.safeParse({
        kind: "REVIEW_REPORT",
        title: "Review passed",
        summary: "No blocking defects remain.",
        checks: ["Compared the implementation with the acceptance criteria."],
        verdict: "PASSED",
        findings: [],
      }).success,
    ).toBe(true);
    expect(
      reviewReportDraftSchema.safeParse({
        kind: "REVIEW_REPORT",
        title: "Contradictory pass",
        summary: "The report claims both outcomes.",
        checks: ["Inspected the change."],
        verdict: "PASSED",
        findings: [finding],
      }).success,
    ).toBe(false);
    expect(
      reviewReportDraftSchema.safeParse({
        kind: "REVIEW_REPORT",
        title: "Empty rejection",
        summary: "No actionable defect was supplied.",
        checks: ["Inspected the change."],
        verdict: "CHANGES_REQUESTED",
        findings: [],
      }).success,
    ).toBe(false);
  });

  it("accepts only portable, coherent source locations", () => {
    expect(reviewFindingDraftSchema.safeParse({ ...finding, path: "../secret" }).success).toBe(false);
    expect(reviewFindingDraftSchema.safeParse({ ...finding, path: "src\\file.ts" }).success).toBe(false);
    expect(
      reviewFindingDraftSchema.safeParse({ ...finding, path: null, startLine: 1, endLine: 1 }).success,
    ).toBe(false);
    expect(reviewFindingDraftSchema.safeParse({ ...finding, startLine: 44, endLine: 40 }).success).toBe(
      false,
    );
  });

  it("requires complete attribution when a finding leaves OPEN", () => {
    const durable = {
      ...finding,
      schemaVersion: 1,
      id: "finding-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      pipelineRunId: "run-1",
      stageAttemptId: "attempt-review-1",
      reviewArtifactId: "artifact-review-1",
      reviewedTree: "a".repeat(40),
      ordinal: 1,
      status: "OPEN",
      resolutionReason: null,
      resolvedBy: null,
      createdAt: "2026-09-02T10:00:00.000Z",
      resolvedAt: null,
      version: 1,
    } as const;
    expect(reviewFindingSchema.safeParse(durable).success).toBe(true);
    expect(reviewFindingSchema.safeParse({ ...durable, status: "RESOLVED" }).success).toBe(false);
    expect(
      reviewFindingSchema.safeParse({
        ...durable,
        status: "RESOLVED",
        resolutionReason: "The independent re-review passed the new tree.",
        resolvedBy: { type: "SYSTEM", id: "local-daemon" },
        resolvedAt: "2026-09-02T10:10:00.000Z",
        version: 2,
      }).success,
    ).toBe(true);
  });

  it("requires a bounded reason and optimistic version for an owner disposition", () => {
    const command = {
      schemaVersion: 1,
      commandId: "dispose-finding-1",
      correlationId: "correlation-dispose-finding-1",
      actor: { type: "HUMAN", id: "owner-1" },
      type: "DISPOSE_REVIEW_FINDING",
      payload: {
        findingId: "finding-1",
        expectedVersion: 1,
        disposition: "FALSE_POSITIVE",
        reason: "The reported path is unreachable under the validated command schema.",
      },
    } as const;
    expect(stateCommandSchema.safeParse(command).success).toBe(true);
    expect(
      stateCommandSchema.safeParse({ ...command, payload: { ...command.payload, reason: "" } }).success,
    ).toBe(false);
    expect(
      stateCommandSchema.safeParse({ ...command, payload: { ...command.payload, expectedVersion: 0 } })
        .success,
    ).toBe(false);
  });
});
