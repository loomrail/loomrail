import type { WorkItemWorkspace } from "@loomrail/contracts";

/**
 * The bounds E1.5's plan names once ("Пределы", spec §12.1) for the two change reads.
 *
 * Neither is a measurement: they are working values, and the plan says in so many words that
 * changing them is allowed only after measuring on a genuinely large repository. What matters at
 * the boundary is that exceeding either is visible in the answer -- `truncated` on the summary,
 * `truncated` plus `omittedBytes` on a body (spec D8) -- rather than silently shortening what the
 * owner is shown.
 */
export const MAX_SUMMARY_FILES = 2_000;
export const MAX_PATCH_BYTES = 512 * 1_024;

/**
 * The commit a work item's changes are measured against (spec D1), and the line that decides
 * whether this milestone tells the truth.
 *
 * The base is the carry-in snapshot when there was one, and the repository's HEAD only when there
 * was not. `baseCommit` alone would attribute every uncommitted edit the owner had open when the
 * stage started -- carried into the worktree by design -- to the agent, producing a
 * plausible-looking file list that is a lie. That is the exact failure this milestone exists to
 * prevent, so it is not a preference.
 *
 * It lives in one module because the two owner-facing change handles and the REVIEW context use
 * the same baseline. Restating it at either boundary is how the cockpit and reviewer would
 * silently assess different changes.
 *
 * The stage-end tree label in `session-loop.ts` is NOT a third caller, on purpose. That label
 * comes from `treeOfWorktree` (`@loomrail/workspace`), which has no baseline parameter at all: an
 * index seeded from any baseline and then `add -A`'d over describes the working tree either way
 * (`read-tree <anything>` + `add -A` + `write-tree` depends only on what is currently on disk), so
 * there is no baseline for the label to measure from being wrong about, and citing this function
 * there would be citing a decision this value does not affect.
 *
 * `null` means the workspace records no commit at all, which is not a degraded baseline: it is the
 * absence of one, and each caller says what it does about that.
 */
export const changeBaselineOf = (workspace: WorkItemWorkspace): string | null =>
  workspace.snapshotCommit ?? workspace.baseCommit;
