import {
  MAX_AUTOMATIC_REVIEW_ROUNDS,
  MAX_OPEN_REVIEW_FINDINGS,
  MAX_TOTAL_REVIEW_ROUNDS,
  reviewReportDraftSchema,
  type DisposeReviewFindingCommand,
  type ReviewFindingDraft,
  type ReviewFinding,
  type ReviewFindingResolvedEvent,
  type ReviewReportDraft,
} from "@loomrail/contracts";

export type ReviewLoopDecision =
  | {
      action: "ADVANCE_TO_QA";
      nextStage: "QA";
      nextAttempt: 1;
      newFindings: readonly [];
      resolveFindingIds: readonly string[];
    }
  | {
      action: "QUEUE_FIX";
      nextStage: "IMPLEMENT";
      nextAttempt: number;
      newFindings: readonly ReviewFindingDraft[];
      resolveFindingIds: readonly [];
    }
  | {
      action: "WAIT_FOR_OWNER";
      failureCode: "REVIEW_LOOP_EXHAUSTED";
      newFindings: readonly ReviewFindingDraft[];
      resolveFindingIds: readonly [];
    };

export type ReviewLoopErrorCode =
  "INVALID_REVIEW_ROUND" | "OPEN_FINDINGS_LIMIT_EXCEEDED" | "DUPLICATE_OPEN_FINDING" | "STALE_REVIEW_TREE";

export class ReviewLoopError extends Error {
  readonly code: ReviewLoopErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: ReviewLoopErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ReviewLoopError";
    this.code = code;
    this.details = details;
  }
}

export type ReviewFindingDispositionErrorCode =
  | "REVIEW_FINDING_NOT_FOUND"
  | "REVIEW_FINDING_ACTOR_FORBIDDEN"
  | "REVIEW_FINDING_VERSION_CONFLICT"
  | "REVIEW_FINDING_ALREADY_CLOSED";

export class ReviewFindingDispositionError extends Error {
  readonly code: ReviewFindingDispositionErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: ReviewFindingDispositionErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ReviewFindingDispositionError";
    this.code = code;
    this.details = details;
  }
}

export type ReviewFindingDispositionDecision = {
  finding: ReviewFinding;
  events: readonly {
    type: ReviewFindingResolvedEvent["type"];
    data: ReviewFindingResolvedEvent["data"];
  }[];
};

/** Records a terminal owner disposition without trusting provider output to choose lifecycle state. */
export const decideReviewFindingDisposition = (
  command: DisposeReviewFindingCommand,
  context: { finding?: ReviewFinding | undefined; now: string },
): ReviewFindingDispositionDecision => {
  if (command.actor.type !== "HUMAN") {
    throw new ReviewFindingDispositionError(
      "REVIEW_FINDING_ACTOR_FORBIDDEN",
      "Only the owner can waive a review finding or mark it as a false positive",
    );
  }
  if (context.finding?.id !== command.payload.findingId) {
    throw new ReviewFindingDispositionError("REVIEW_FINDING_NOT_FOUND", "The review finding does not exist");
  }
  if (context.finding.version !== command.payload.expectedVersion) {
    throw new ReviewFindingDispositionError(
      "REVIEW_FINDING_VERSION_CONFLICT",
      "The review finding changed before the disposition was recorded",
      { expectedVersion: command.payload.expectedVersion, actualVersion: context.finding.version },
    );
  }
  if (context.finding.status !== "OPEN") {
    throw new ReviewFindingDispositionError(
      "REVIEW_FINDING_ALREADY_CLOSED",
      "Only an open review finding can receive an owner disposition",
      { status: context.finding.status },
    );
  }
  const finding: ReviewFinding = {
    ...context.finding,
    status: command.payload.disposition,
    resolutionReason: command.payload.reason,
    resolvedBy: command.actor,
    resolvedAt: context.now,
    version: context.finding.version + 1,
  };
  return {
    finding,
    events: [{ type: "REVIEW_FINDING_RESOLVED", data: { finding } }],
  };
};

const validateOpenFindingIds = (ids: readonly string[]): readonly string[] => {
  if (ids.length > MAX_OPEN_REVIEW_FINDINGS) {
    throw new ReviewLoopError(
      "OPEN_FINDINGS_LIMIT_EXCEEDED",
      "The open review finding input is not bounded",
      {
        actual: ids.length,
        maximum: MAX_OPEN_REVIEW_FINDINGS,
      },
    );
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new ReviewLoopError("DUPLICATE_OPEN_FINDING", "The review loop received a duplicate finding ID");
  }
  return [...ids];
};

/**
 * Selects the only legal continuation after a structured review.
 *
 * This function deliberately does not create IDs, mutate findings, or choose a provider. Persistence
 * owns those authorities after rechecking the same tree inside the command transaction.
 */
export const decideReviewLoop = (input: {
  round: number;
  reviewedTree: string;
  currentTree: string;
  report: ReviewReportDraft;
  openFindingIds: readonly string[];
}): ReviewLoopDecision => {
  if (!Number.isInteger(input.round) || input.round < 1 || input.round > MAX_TOTAL_REVIEW_ROUNDS) {
    throw new ReviewLoopError("INVALID_REVIEW_ROUND", "The review round is outside its total bound", {
      round: input.round,
      maximum: MAX_TOTAL_REVIEW_ROUNDS,
    });
  }
  if (input.reviewedTree !== input.currentTree) {
    throw new ReviewLoopError("STALE_REVIEW_TREE", "The review result does not describe the current tree", {
      reviewedTree: input.reviewedTree,
      currentTree: input.currentTree,
    });
  }
  const report = reviewReportDraftSchema.parse(input.report);
  const openFindingIds = validateOpenFindingIds(input.openFindingIds);
  if (report.verdict === "PASSED") {
    return {
      action: "ADVANCE_TO_QA",
      nextStage: "QA",
      nextAttempt: 1,
      newFindings: [],
      resolveFindingIds: openFindingIds,
    };
  }
  if (input.round < MAX_AUTOMATIC_REVIEW_ROUNDS) {
    return {
      action: "QUEUE_FIX",
      nextStage: "IMPLEMENT",
      nextAttempt: input.round + 1,
      newFindings: report.findings,
      resolveFindingIds: [],
    };
  }
  return {
    action: "WAIT_FOR_OWNER",
    failureCode: "REVIEW_LOOP_EXHAUSTED",
    newFindings: report.findings,
    resolveFindingIds: [],
  };
};
