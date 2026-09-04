import type { DisposeReviewFindingCommand, ReviewFinding } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideReviewFindingDisposition,
  decideReviewLoop,
  ReviewFindingDispositionError,
  ReviewLoopError,
} from "../src/review.js";

const tree = "a".repeat(40);
const finding = {
  severity: "HIGH" as const,
  title: "Expected-version is ignored",
  description: "The mutation writes even when the aggregate version changed.",
  path: "packages/domain/src/review.ts",
  startLine: 20,
  endLine: 24,
  reproduction: "Submit a command using the previous version and observe a successful write.",
  criterion: "Concurrent edits fail closed.",
  suggestedFix: "Include expected version in the guarded update.",
};

const report = (verdict: "PASSED" | "CHANGES_REQUESTED") => ({
  kind: "REVIEW_REPORT" as const,
  title: verdict === "PASSED" ? "Review passed" : "Changes requested",
  summary: verdict === "PASSED" ? "No blocking findings remain." : "One blocking finding remains.",
  checks: ["Compared the change with the acceptance criteria."],
  verdict,
  findings: verdict === "PASSED" ? [] : [finding],
});

const durableFinding: ReviewFinding = {
  schemaVersion: 1,
  id: "finding-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "pipeline-1",
  stageAttemptId: "review-attempt-1",
  correctionRunId: null,
  reviewArtifactId: "report-1",
  reviewedTree: tree,
  ordinal: 1,
  status: "OPEN",
  resolutionReason: null,
  resolvedBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  resolvedAt: null,
  version: 1,
  ...finding,
};

const dispositionCommand = (
  overrides: Partial<DisposeReviewFindingCommand> = {},
): DisposeReviewFindingCommand => ({
  schemaVersion: 1,
  commandId: "dispose-finding-1",
  correlationId: "correlation-dispose-finding-1",
  actor: { type: "HUMAN", id: "owner-1" },
  type: "DISPOSE_REVIEW_FINDING",
  payload: {
    findingId: durableFinding.id,
    expectedVersion: 1,
    disposition: "WAIVED",
    reason: "The owner accepts this documented risk for the bounded release.",
  },
  ...overrides,
});

describe("review loop", () => {
  it("advances a passing independent re-review and closes earlier findings", () => {
    expect(
      decideReviewLoop({
        round: 2,
        reviewedTree: tree,
        currentTree: tree,
        report: report("PASSED"),
        openFindingIds: ["finding-1", "finding-2"],
      }),
    ).toEqual({
      action: "ADVANCE_TO_QA",
      nextStage: "QA",
      newFindings: [],
      resolveFindingIds: ["finding-1", "finding-2"],
    });
  });

  it("returns the first failed review to a second implementation attempt", () => {
    expect(
      decideReviewLoop({
        round: 1,
        reviewedTree: tree,
        currentTree: tree,
        report: report("CHANGES_REQUESTED"),
        openFindingIds: [],
      }),
    ).toMatchObject({ action: "QUEUE_FIX", nextStage: "IMPLEMENT" });
  });

  it("stops after the second failed review instead of creating a third automatic round", () => {
    expect(
      decideReviewLoop({
        round: 2,
        reviewedTree: tree,
        currentTree: tree,
        report: report("CHANGES_REQUESTED"),
        openFindingIds: ["finding-1"],
      }),
    ).toMatchObject({ action: "WAIT_FOR_OWNER", failureCode: "REVIEW_LOOP_EXHAUSTED" });
  });

  it("rejects a report for a tree that changed during review", () => {
    expect(() =>
      decideReviewLoop({
        round: 1,
        reviewedTree: tree,
        currentTree: "b".repeat(40),
        report: report("PASSED"),
        openFindingIds: [],
      }),
    ).toThrow(expect.objectContaining<Partial<ReviewLoopError>>({ code: "STALE_REVIEW_TREE" }));
  });

  it("keeps the owner-authorized final round bounded", () => {
    expect(
      decideReviewLoop({
        round: 3,
        reviewedTree: tree,
        currentTree: tree,
        report: report("CHANGES_REQUESTED"),
        openFindingIds: ["finding-1"],
      }),
    ).toMatchObject({ action: "WAIT_FOR_OWNER", failureCode: "REVIEW_LOOP_EXHAUSTED" });
  });

  it("rejects duplicate finding identities and a round beyond the owner-authorized bound", () => {
    expect(() =>
      decideReviewLoop({
        round: 1,
        reviewedTree: tree,
        currentTree: tree,
        report: report("PASSED"),
        openFindingIds: ["finding-1", "finding-1"],
      }),
    ).toThrow(expect.objectContaining<Partial<ReviewLoopError>>({ code: "DUPLICATE_OPEN_FINDING" }));
    expect(() =>
      decideReviewLoop({
        round: 4,
        reviewedTree: tree,
        currentTree: tree,
        report: report("PASSED"),
        openFindingIds: [],
      }),
    ).toThrow(expect.objectContaining<Partial<ReviewLoopError>>({ code: "INVALID_REVIEW_ROUND" }));
  });
});

describe("review finding owner disposition", () => {
  it("records an attributed terminal owner disposition", () => {
    const decision = decideReviewFindingDisposition(dispositionCommand(), {
      finding: durableFinding,
      now: "2026-09-02T01:00:00.000Z",
    });

    expect(decision).toMatchObject({
      finding: {
        id: durableFinding.id,
        status: "WAIVED",
        resolutionReason: "The owner accepts this documented risk for the bounded release.",
        resolvedBy: { type: "HUMAN", id: "owner-1" },
        resolvedAt: "2026-09-02T01:00:00.000Z",
        version: 2,
      },
      events: [{ type: "REVIEW_FINDING_RESOLVED", data: { finding: { status: "WAIVED" } } }],
    });
  });

  it("rejects provider disposition, stale versions and already-closed findings", () => {
    expect(() =>
      decideReviewFindingDisposition(dispositionCommand({ actor: { type: "SYSTEM", id: "provider" } }), {
        finding: durableFinding,
        now: "2026-09-02T01:00:00.000Z",
      }),
    ).toThrow(
      expect.objectContaining<Partial<ReviewFindingDispositionError>>({
        code: "REVIEW_FINDING_ACTOR_FORBIDDEN",
      }),
    );
    expect(() =>
      decideReviewFindingDisposition(
        dispositionCommand({ payload: { ...dispositionCommand().payload, expectedVersion: 2 } }),
        { finding: durableFinding, now: "2026-09-02T01:00:00.000Z" },
      ),
    ).toThrow(
      expect.objectContaining<Partial<ReviewFindingDispositionError>>({
        code: "REVIEW_FINDING_VERSION_CONFLICT",
      }),
    );
    expect(() =>
      decideReviewFindingDisposition(
        dispositionCommand({ payload: { ...dispositionCommand().payload, expectedVersion: 2 } }),
        {
          finding: {
            ...durableFinding,
            status: "RESOLVED",
            resolutionReason: "A later review passed.",
            resolvedBy: { type: "SYSTEM", id: "local-daemon" },
            resolvedAt: "2026-09-02T00:30:00.000Z",
            version: 2,
          },
          now: "2026-09-02T01:00:00.000Z",
        },
      ),
    ).toThrow(
      expect.objectContaining<Partial<ReviewFindingDispositionError>>({
        code: "REVIEW_FINDING_ALREADY_CLOSED",
      }),
    );
  });
});
