import { access } from "node:fs/promises";

import { runGit } from "./git.js";

export type WorktreeEntry = {
  path: string;
  branch: string | null;
  prunable: boolean;
};

export type AddWorktreeRefusal =
  | { type: "BRANCH_EXISTS"; branch: string }
  | { type: "BRANCH_CHECKED_OUT"; branch: string; occupiedBy: string }
  | { type: "PATH_EXISTS"; path: string };

const HEADS_PREFIX = "refs/heads/";

// `worktree list --porcelain` reports a branch as the full ref (`refs/heads/<name>`); every other
// consumer here (show-ref, the caller's `branch` argument) deals in the bare name, so this is the
// one place that translation happens.
const branchNameFromRef = (ref: string): string =>
  ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// Parses `git worktree list --porcelain`: records are separated by a blank line, and within a
// record each line is a `<key> <value>` pair (`worktree`, `branch`, `detached`) or a bare
// machine-readable key (`prunable`, `bare`, `locked`) with no value. A worktree left `detached`
// carries no `branch` line at all, and one whose directory was deleted from under git carries a
// `prunable` line whose trailing message is prose that changes across git versions -- only the key
// is read, never the text after it.
export const listWorktrees = async (topLevel: string): Promise<readonly WorktreeEntry[]> => {
  const result = await runGit(["worktree", "list", "--porcelain"], { cwd: topLevel });

  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  let prunable = false;

  const flush = () => {
    if (path !== null) {
      entries.push({ path, branch, prunable });
    }
    path = null;
    branch = null;
    prunable = false;
  };

  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = branchNameFromRef(line.slice("branch ".length));
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      prunable = true;
    }
  }
  flush();

  return entries;
};

// Creates a branch and a worktree for it in one step, but only after confirming -- via
// `show-ref` and `listWorktrees`, never by parsing the prose of a failed `git worktree add` --
// that none of the three ways this can be refused apply (spec §2.11): the branch name is already
// checked out somewhere else, the branch name already exists (but is not checked out anywhere),
// or the target path is already occupied. Detecting occupancy after the fact would mean parsing
// error text that changes between git versions -- an existing branch exits 255, a branch already
// checked out elsewhere exits 128, and neither message is stable enough to match on.
//
// A branch that is checked out in another worktree also exists as a ref, so `BRANCH_CHECKED_OUT`
// is checked before `BRANCH_EXISTS` -- checking `show-ref` first would report every occupied
// branch as merely "exists" and the more specific, more actionable refusal would never surface.
//
// Once all three checks pass, the actual `git worktree add` is trusted to succeed: its exit code
// is not inspected. The three refusal reasons above are the only ways this repository is allowed
// to say no, and they have already been ruled out; re-deriving a fourth outcome from the mutating
// command's exit code would be exactly the error-text parsing this function exists to avoid.
export const addWorktree = async (context: {
  topLevel: string;
  branch: string;
  path: string;
  startPoint: string;
}): Promise<{ type: "ADDED" } | { type: "REFUSED"; refusal: AddWorktreeRefusal }> => {
  const { topLevel, branch, path, startPoint } = context;

  const existing = await listWorktrees(topLevel);

  const occupiedBy = existing.find((entry) => entry.branch === branch);
  if (occupiedBy !== undefined) {
    return { type: "REFUSED", refusal: { type: "BRANCH_CHECKED_OUT", branch, occupiedBy: occupiedBy.path } };
  }

  const showRef = await runGit(["show-ref", "--verify", "--quiet", `${HEADS_PREFIX}${branch}`], {
    cwd: topLevel,
  });
  if (showRef.exitCode === 0) {
    return { type: "REFUSED", refusal: { type: "BRANCH_EXISTS", branch } };
  }

  if (await pathExists(path)) {
    return { type: "REFUSED", refusal: { type: "PATH_EXISTS", path } };
  }

  await runGit(["worktree", "add", "-b", branch, path, startPoint], { cwd: topLevel });

  return { type: "ADDED" };
};

// `git worktree remove` exits 0 even when the worktree's directory has already been deleted from
// under git (spec §2.11) -- that is treated as success here too, not as a special case, since
// there is nothing left to remove either way. The branch itself is left untouched: neither this
// operation nor `git worktree remove` deletes it.
export const removeWorktree = async (context: { topLevel: string; path: string }): Promise<void> => {
  const { topLevel, path } = context;

  const result = await runGit(["worktree", "remove", "--force", path], { cwd: topLevel });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree remove failed (${String(result.exitCode)}): ${result.stderr}`);
  }
};
