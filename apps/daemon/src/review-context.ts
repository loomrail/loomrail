import type { ContextSources } from "@loomrail/context-assembly";
import {
  reviewDiffLimits,
  type HumanRequestDraft,
  type ReviewDiffLimits,
  type WorkItemWorkspace,
} from "@loomrail/contracts";
import type { ReviewChangeSummary } from "@loomrail/workspace";

import { changeBaselineOf } from "./workspace-changes.js";

export type ReviewDiffReader = (
  input: {
    worktreePath: string;
    baseline: string;
  } & Omit<ReviewDiffLimits, "maxRenderedPathBytes">,
) => Promise<ReviewChangeSummary>;

export type ReviewContextPreparation =
  | { type: "READY"; sources: ContextSources }
  | {
      type: "REFUSED";
      reason:
        "WORKSPACE_MISSING" | "BASELINE_MISSING" | "DIFF_UNREADABLE" | "BASELINE_MISMATCH" | "TREE_CHANGED";
      request: HumanRequestDraft;
      cause: unknown;
    };

const refusal = (
  reason: Extract<ReviewContextPreparation, { type: "REFUSED" }>["reason"],
  context: string,
  recommendation: string,
  cause: unknown = null,
): ReviewContextPreparation => ({
  type: "REFUSED",
  reason,
  cause,
  request: {
    kind: "SINGLE_CHOICE",
    blocking: true,
    title: "The stable implementation diff is unavailable for review",
    context,
    recommendation,
    options: [
      {
        id: "retry-stable-review",
        label: "Retry review",
        consequence: "Measure the stable implementation tree again after the repository is repaired.",
        recommended: true,
      },
    ],
    allowOther: false,
  },
});

/**
 * Adds the infrastructure-derived half of REVIEW_INPUT without weakening its durable authority.
 *
 * Persistence supplies the immutable IMPLEMENT result tree and author identity. This seam reads a
 * bounded, content-bearing diff from the currently leased worktree against its carry-in baseline,
 * then accepts it only when Git's file list, patches and tree all came from the same temporary
 * index and the tree equals the persisted implementation result. The provider therefore never
 * receives plausible diff fragments for a different tree. Failures become a typed owner-facing
 * refusal rather than an empty summary, because an empty list claims no files changed while a
 * failed read knows no such thing.
 */
export const prepareReviewContext = async (input: {
  sources: ContextSources;
  workspace: WorkItemWorkspace | null;
  readDiff: ReviewDiffReader;
}): Promise<ReviewContextPreparation> => {
  const reviewInput = input.sources.reviewInput;
  if (reviewInput === null) return { type: "READY", sources: input.sources };
  if (input.workspace === null) {
    return refusal(
      "WORKSPACE_MISSING",
      "The completed implementation names a result tree, but its work item has no workspace from which Loomrail can measure the changed files.",
      "Restore the work item's repository workspace, then retry review.",
    );
  }

  const baseline = changeBaselineOf(input.workspace);
  if (baseline === null) {
    return refusal(
      "BASELINE_MISSING",
      "The completed implementation workspace records no carry-in or base commit, so Loomrail cannot state what changed without guessing a comparison point.",
      "Repair the workspace baseline, then retry review.",
    );
  }

  let summary: ReviewChangeSummary;
  try {
    summary = await input.readDiff({
      worktreePath: input.workspace.worktreePath,
      baseline,
      maxFiles: reviewDiffLimits.maxFiles,
      maxContentFiles: reviewDiffLimits.maxContentFiles,
      maxPatchBytesPerFile: reviewDiffLimits.maxPatchBytesPerFile,
      maxPatchBytesTotal: reviewDiffLimits.maxPatchBytesTotal,
    });
  } catch (error: unknown) {
    return refusal(
      "DIFF_UNREADABLE",
      "Git could not construct the bounded changed-file summary for the completed implementation. Review cannot start from an empty or guessed diff.",
      "Repair Git or the recorded workspace, then retry review.",
      error,
    );
  }

  if (summary.baseline !== baseline) {
    return refusal(
      "BASELINE_MISMATCH",
      `The review diff reports baseline ${summary.baseline}, but the work item's recorded change baseline is ${baseline}. Starting review would show a different change range than the workflow owns.`,
      "Restart Loomrail and retry review; if the mismatch persists, preserve the workspace and inspect its durable state.",
    );
  }

  if (summary.tree !== reviewInput.implementationAttempt.resultTree) {
    return refusal(
      "TREE_CHANGED",
      `The worktree now measures as ${summary.tree}, but the completed implementation was recorded as ${reviewInput.implementationAttempt.resultTree}. Starting review would show the reviewer a different tree than the one the workflow is judging.`,
      "Restore the worktree to the recorded implementation tree, then retry review.",
    );
  }

  return {
    type: "READY",
    sources: {
      ...input.sources,
      reviewInput: {
        ...reviewInput,
        diffSummary: { baseline: summary.baseline, files: summary.files, truncated: summary.truncated },
      },
    },
  };
};
