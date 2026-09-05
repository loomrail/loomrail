import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { runGit, runGitWithIndex } from "./git.js";

export type CarryInSnapshot = {
  commit: string;
  carriedPaths: readonly string[];
};

// The SHA of git's canonical empty tree -- what `write-tree` produces from an empty index. It is
// constant across every repository, which is what lets an empty repository (no HEAD to diff
// against) still be told "nothing to carry" without special-casing the comparison.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// A carry-in commit is Loomrail's internal transport artifact, not a commit authored by the
// repository owner. Pinning its identity keeps the operation independent of global/local Git
// config and avoids attributing machine-generated plumbing to a person.
const SNAPSHOT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Loomrail",
  GIT_AUTHOR_EMAIL: "loomrail@localhost",
  GIT_COMMITTER_NAME: "Loomrail",
  GIT_COMMITTER_EMAIL: "loomrail@localhost",
} as const;

// NUL-separated output (`-z`): a path with a space, a quote or a non-ASCII character reaches the
// event log verbatim instead of as git's double-quoted octal escape, and a path containing a
// newline cannot masquerade as two.
const splitRecords = (text: string): readonly string[] =>
  text.split("\0").filter((record) => record.length > 0);

// Loomrail runs these as plumbing on the owner's behalf: the carry-in commit must never trigger the
// owner's signing key (a passphrase prompt or an unreachable agent in a headless daemon turns into
// "commit-tree failed (128)"), and quoting must stay off so `-z` output is the raw path.
const PLUMBING_CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.quotepath=false"] as const;

// Carries everything the owner has not committed -- edits to tracked files, whatever is already
// staged, untracked files including nested ones, and deletions -- into a standalone commit that
// never touches the owner's real index or working copy and never creates refs/stash. Built with a
// temporary index and the plumbing sequence from spec §2.9, deliberately not `git stash create`:
// that command's `--include-untracked` exits 0 while silently dropping every untracked file (spec
// §2.8), which is exactly the loss this function exists to prevent.
//
// Returns null when there is nothing to carry. That is decided by comparing the tree the temporary
// index would produce against the tree HEAD already points at (or git's canonical empty tree, for
// a repository with no commits yet) -- never by parsing `git status` output.
export const createCarryInSnapshot = async (context: {
  topLevel: string;
  headCommit: string | null;
  message: string;
}): Promise<CarryInSnapshot | null> => {
  const { topLevel, headCommit, message } = context;
  const indexDir = await mkdtemp(join(tmpdir(), "loomrail-carry-in-"));
  const indexFile = join(indexDir, "index");

  try {
    if (headCommit !== null) {
      const readTree = await runGitWithIndex(["read-tree", headCommit], topLevel, indexFile);
      if (readTree.exitCode !== 0) {
        throw new Error(`git read-tree failed (${String(readTree.exitCode)}): ${readTree.stderr}`);
      }
    }

    const add = await runGitWithIndex(["add", "-A"], topLevel, indexFile);
    if (add.exitCode !== 0) {
      throw new Error(`git add -A failed (${String(add.exitCode)}): ${add.stderr}`);
    }

    const writeTree = await runGitWithIndex(["write-tree"], topLevel, indexFile);
    if (writeTree.exitCode !== 0) {
      throw new Error(`git write-tree failed (${String(writeTree.exitCode)}): ${writeTree.stderr}`);
    }
    const tree = writeTree.stdout.trim();

    const baselineTree =
      headCommit === null
        ? EMPTY_TREE
        : (await runGit(["rev-parse", `${headCommit}^{tree}`], { cwd: topLevel })).stdout.trim();

    if (tree === baselineTree) {
      return null;
    }

    const commitTreeArgs =
      headCommit === null
        ? [...PLUMBING_CONFIG, "commit-tree", tree, "-m", message]
        : [...PLUMBING_CONFIG, "commit-tree", tree, "-p", headCommit, "-m", message];
    const commitTree = await runGit(commitTreeArgs, {
      cwd: topLevel,
      env: { ...process.env, ...SNAPSHOT_GIT_IDENTITY },
    });
    if (commitTree.exitCode !== 0) {
      throw new Error(`git commit-tree failed (${String(commitTree.exitCode)}): ${commitTree.stderr}`);
    }
    const commit = commitTree.stdout.trim();

    // `--no-renames`: the owner's `diff.renames` would otherwise fold a moved file into its new
    // name only, and the path that disappeared would be missing from what the owner is shown.
    const carriedPathsResult =
      headCommit === null
        ? await runGit([...PLUMBING_CONFIG, "ls-tree", "-r", "-z", "--name-only", commit], {
            cwd: topLevel,
          })
        : await runGit(
            [...PLUMBING_CONFIG, "diff", "-z", "--no-renames", "--name-only", headCommit, commit],
            { cwd: topLevel },
          );

    return {
      commit,
      carriedPaths: splitRecords(carriedPathsResult.stdout),
    };
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
};
