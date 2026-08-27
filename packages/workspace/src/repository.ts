import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { runGit } from "./git.js";

export type InProgressOperation = "REBASE" | "MERGE" | "CHERRY_PICK" | "BISECT";

export type RepositoryState = {
  topLevel: string;
  headCommit: string | null; // null -- the repository has no commits yet
  inProgress: InProgressOperation | null;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// Detects an in-progress rebase/merge/cherry-pick/bisect by the marker files git itself leaves
// under the git directory. Deliberately takes an already-resolved git-dir rather than deriving
// one, because inside a linked worktree `.git` is a file (a `gitdir:` pointer), not the directory
// these markers actually live in -- joining `<repo>/.git` would look in the wrong place entirely.
const detectInProgressOperation = async (gitDir: string): Promise<InProgressOperation | null> => {
  if ((await pathExists(join(gitDir, "rebase-merge"))) || (await pathExists(join(gitDir, "rebase-apply")))) {
    return "REBASE";
  }
  if (await pathExists(join(gitDir, "MERGE_HEAD"))) {
    return "MERGE";
  }
  if (await pathExists(join(gitDir, "CHERRY_PICK_HEAD"))) {
    return "CHERRY_PICK";
  }
  if (await pathExists(join(gitDir, "BISECT_LOG"))) {
    return "BISECT";
  }
  return null;
};

// Pre-flight look at a repository before anything (e.g. a worktree) gets cut from it. Answers
// three questions a caller must have settled first: is this even a git repository, what commit
// would a fresh worktree be based on (or is there none yet), and is the repository mid an
// operation whose scratch state must never be mistaken for the owner's branch (spec D5 / §2.12).
//
// Fails closed: any question this function cannot actually settle -- including the in-progress
// check partway through, after the repository itself was already confirmed to exist -- resolves
// the whole call to null, the same "not a usable repository" answer given for a path that is not
// a git repository at all. It never reports a partial result with `inProgress` defaulted to
// clear, because a false "nothing in progress" is the one wrong answer worth refusing to give:
// it would let a caller base a workspace on a rebase's scratch commit without anyone deciding
// that on purpose.
export const inspectRepository = async (path: string): Promise<RepositoryState | null> => {
  const topLevelResult = await runGit(["rev-parse", "--show-toplevel"], { cwd: path });
  if (topLevelResult.exitCode !== 0) {
    return null;
  }
  const topLevel = topLevelResult.stdout.trim();

  const headResult = await runGit(["rev-parse", "HEAD"], { cwd: path });
  const headCommit = headResult.exitCode === 0 ? headResult.stdout.trim() : null;

  const gitDirResult = await runGit(["rev-parse", "--git-dir"], { cwd: path });
  if (gitDirResult.exitCode !== 0) {
    // --show-toplevel already succeeded above, so git-dir resolution failing here is an
    // unexpected environment change mid-inspection (e.g. the repository vanishing or losing
    // permissions between the two calls), not proof there is nothing in progress. Fail closed:
    // `inProgress` exists to keep a caller off a rebase/merge/cherry-pick/bisect's scratch state,
    // so an inspection that could not check for one must never report "clear" -- that is the one
    // wrong answer this function must never give. Returning null here is the same answer already
    // given for a path that is not a repository at all: "not a usable repository", so the caller
    // refuses to provision a workspace from it rather than proceeding on a base it never verified.
    return null;
  }
  const rawGitDir = gitDirResult.stdout.trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : join(path, rawGitDir);

  const inProgress = await detectInProgressOperation(gitDir);

  return { topLevel, headCommit, inProgress };
};
