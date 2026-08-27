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
  | { type: "PATH_EXISTS"; path: string }
  // The mutating `git worktree add` itself failed for a reason none of the three pre-flight
  // checks models -- a full disk, a permissions problem, a startpoint that does not resolve, a git
  // version quirk. Unlike the three refusals above, this one is not a named, anticipated state;
  // it is "git said no and we do not know why" (spec §2.11 enumerates only the three checked
  // reasons). Distinguish it by shape so a caller cannot mistake "git told us why, and the owner
  // can act on it" for this catch-all.
  | { type: "WORKTREE_ADD_FAILED"; exitCode: number; stderr: string };

const HEADS_PREFIX = "refs/heads/";

// `worktree list --porcelain` reports a branch as the full ref (`refs/heads/<name>`); every other
// consumer here (show-ref, the caller's `branch` argument) deals in the bare name, so this is the
// one place that translation happens.
const branchNameFromRef = (ref: string): string =>
  ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;

// `git worktree add`'s stderr, on the failure path this function does not otherwise model, is
// untrusted process output -- bounded the same way this repo bounds any other process/provider
// text placed into a typed result (see `PROVIDER_TEXT_LIMIT` in
// `packages/provider-core/src/session-diagnosis.ts`), so a pathological or chatty git build cannot
// inflate a refusal into something a caller cannot log or display. `slice` cuts by UTF-16 code
// unit, so a cut that lands inside a surrogate pair is repaired rather than left as an ill-formed
// string that would render as a replacement character.
const STDERR_LIMIT = 1_000;

const dropTrailingLoneSurrogate = (text: string): string => {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
};

const truncateStderr = (stderr: string): string =>
  stderr.length <= STDERR_LIMIT ? stderr : `${dropTrailingLoneSurrogate(stderr.slice(0, STDERR_LIMIT - 1))}…`;

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
//
// A pure function, deliberately separate from `listWorktrees` below: packages/persistence-sqlite's
// startup reconciliation runs inside a synchronous SQLite transaction and cannot await `runGit`'s
// spawned child, so it reads `git worktree list --porcelain`'s stdout with its own synchronous
// `execFileSync` call and hands the same text here rather than duplicating this parse.
export const parseWorktreeListPorcelain = (stdout: string): readonly WorktreeEntry[] => {
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

  for (const line of stdout.split("\n")) {
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

export const listWorktrees = async (topLevel: string): Promise<readonly WorktreeEntry[]> => {
  const result = await runGit(["worktree", "list", "--porcelain"], { cwd: topLevel });
  return parseWorktreeListPorcelain(result.stdout);
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
// Once all three checks pass, `git worktree add` is run for real, and its exit code is the ground
// truth about whether a worktree now exists -- not `ADDED` reported unconditionally. The three
// checks above exist to give the owner a named, actionable reason without parsing git's own error
// text; they do not, and cannot, enumerate every way the mutating command itself can fail (a full
// disk, a permissions problem, a startpoint that does not resolve, a git version quirk). A
// non-zero exit from that command is reported as `WORKTREE_ADD_FAILED`, carrying the exit code and
// a bounded copy of stderr, so a failure the pre-flight checks did not anticipate reaches the
// caller as a refusal rather than as a lie that says `ADDED`.
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

  const added = await runGit(["worktree", "add", "-b", branch, path, startPoint], { cwd: topLevel });
  if (added.exitCode !== 0) {
    return {
      type: "REFUSED",
      refusal: {
        type: "WORKTREE_ADD_FAILED",
        exitCode: added.exitCode,
        stderr: truncateStderr(added.stderr),
      },
    };
  }

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
