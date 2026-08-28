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
 * It lives in one module because it has two callers on different paths: the two change handles in
 * `server.ts`, which answer the owner, and the stage-end tree label in `session-loop.ts`. Restating
 * it in the second place is how the two would come to measure from different points without anyone
 * noticing -- the label barely moves when the base is wrong (`write-tree` over an index seeded from
 * a base and then `add -A`'d describes the working tree either way), so a drifted second copy would
 * not show up as a failing tree assertion. It shows up, if at all, as a summary and a label that
 * disagree about what the stage was measured against.
 *
 * `null` means the workspace records no commit at all, which is not a degraded baseline: it is the
 * absence of one, and each caller says what it does about that.
 */
export const changeBaselineOf = (workspace: WorkItemWorkspace): string | null =>
  workspace.snapshotCommit ?? workspace.baseCommit;
