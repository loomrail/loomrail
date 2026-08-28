import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGitWithIndex } from "./git.js";

export type ChangeStatus = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";

export type ChangedFile = {
  path: string;
  // Only set for RENAMED; null otherwise. Named `previousPath` rather than `from` because the
  // record reads as a statement about this file, not about a pair.
  previousPath: string | null;
  status: ChangeStatus;
  // Null for a binary file, never zero: zero is a claim that nothing changed in it.
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type ChangeSummary = {
  files: readonly ChangedFile[];
  // `write-tree` over the very same temporary index the files were read from, so the two can
  // never disagree (spec D3).
  tree: string;
  truncated: boolean;
};

// The flags that make git's answer independent of the owner's config (spec D4). `-M` is passed
// explicitly rather than relying on `diff.renames`, and `core.quotepath=false` keeps non-ASCII
// paths as themselves instead of escape sequences. `--no-ext-diff` keeps the owner's external
// diff driver from being run at all, and `--no-color` keeps escape codes out of the parse.
const readArgs = [
  "-c",
  "core.quotepath=false",
  "diff-index",
  "--cached",
  "--no-ext-diff",
  "--no-color",
  "-M",
  "-z",
];

const splitNul = (text: string): readonly string[] => text.split("\0").filter((part) => part.length > 0);

// One `--numstat -z` record, before it is joined with the status that names what happened.
type CountedFile = {
  path: string;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
};

const parseCount = (field: string, record: string): number | null => {
  // `-` in place of a number is git saying "binary"; anything else must parse as a whole number,
  // because a silently-NaN count would render as a plausible-looking dash in the interface.
  if (field === "-") {
    return null;
  }
  if (!/^\d+$/.test(field)) {
    throw new Error(`git --numstat produced an unreadable line count in ${JSON.stringify(record)}`);
  }
  return Number.parseInt(field, 10);
};

// Parses `--numstat -z`, whose shape was established by running git rather than recalled: an
// ordinary record is a single token `ins\tdel\tpath`, a binary file has `-` for both counts, and a
// rename is a token `ins\tdel\t` with an empty third field followed by TWO further tokens -- the
// old path and then the new one. The old path is read only to stay in step with the stream; which
// file a rename came from is taken from `--name-status`, the reading that names statuses.
const parseNumstat = (stdout: string): readonly CountedFile[] => {
  const tokens = splitNul(stdout);
  const counted: CountedFile[] = [];

  let cursor = 0;
  while (cursor < tokens.length) {
    const record = tokens[cursor] ?? "";
    cursor += 1;

    const fields = record.split("\t");
    const [insertions, deletions, path] = fields;
    if (fields.length !== 3 || insertions === undefined || deletions === undefined || path === undefined) {
      throw new Error(`git --numstat produced an unreadable record ${JSON.stringify(record)}`);
    }

    let subject = path;
    if (subject === "") {
      const oldPath = tokens[cursor];
      const newPath = tokens[cursor + 1];
      if (oldPath === undefined || newPath === undefined) {
        throw new Error(`git --numstat ended mid-rename after ${JSON.stringify(record)}`);
      }
      cursor += 2;
      subject = newPath;
    }

    const binary = insertions === "-" || deletions === "-";
    counted.push({
      path: subject,
      insertions: parseCount(insertions, record),
      deletions: parseCount(deletions, record),
      binary,
    });
  }

  return counted;
};

type StatusRecord = {
  status: ChangeStatus;
  previousPath: string | null;
};

// Parses `--name-status -z`: a status token (`A`, `M`, `D`, `T`, or `R` with a similarity score)
// followed by one path, or by two paths -- old then new -- when it is a rename. Keyed by the new
// path, which is the only name both readings agree on.
const parseNameStatus = (stdout: string): ReadonlyMap<string, StatusRecord> => {
  const tokens = splitNul(stdout);
  const statuses = new Map<string, StatusRecord>();

  let cursor = 0;
  while (cursor < tokens.length) {
    const code = tokens[cursor] ?? "";
    cursor += 1;

    if (code.startsWith("R")) {
      const oldPath = tokens[cursor];
      const newPath = tokens[cursor + 1];
      if (oldPath === undefined || newPath === undefined) {
        throw new Error(`git --name-status ended mid-rename after ${JSON.stringify(code)}`);
      }
      cursor += 2;
      statuses.set(newPath, { status: "RENAMED", previousPath: oldPath });
      continue;
    }

    const path = tokens[cursor];
    if (path === undefined) {
      throw new Error(`git --name-status ended without a path after ${JSON.stringify(code)}`);
    }
    cursor += 1;

    // `T` is a type change (a file replaced by a symlink and the like). It is a modification of
    // that path and is reported as one; every other letter is a status this reading was never
    // asked to produce -- copies need `-C`, unmerged entries cannot occur in an index built from
    // a single tree -- so it is refused rather than guessed at (spec D7).
    const status: ChangeStatus =
      code === "A"
        ? "ADDED"
        : code === "M" || code === "T"
          ? "MODIFIED"
          : code === "D"
            ? "DELETED"
            : (() => {
                throw new Error(`git --name-status produced an unexpected status ${JSON.stringify(code)}`);
              })();

    statuses.set(path, { status, previousPath: null });
  }

  return statuses;
};

const expectSuccess = (result: { exitCode: number; stderr: string }, what: string): void => {
  if (result.exitCode !== 0) {
    throw new Error(`git ${what} failed (${String(result.exitCode)}): ${result.stderr}`);
  }
};

/**
 * What a work item has changed in its worktree, relative to `baseline`, plus the tree those
 * changes add up to.
 *
 * Computed through a temporary index -- `read-tree` the baseline, `add -A`, then read the index --
 * and never through a plain `git diff` against the working tree. That is not a style preference:
 * a working-tree diff does not see files that are not tracked yet (spec §2.1), so creating a file,
 * the single most common thing an agent does, would be invisible while the summary still looked
 * plausibly full. Spec D2 forbids the naive reading outright.
 *
 * `add -A` honours `.gitignore` by itself, which is why build output stays out of the summary
 * without this function carrying a list of exclusions. The index lives in the OS temp directory
 * and is removed in a `finally`, so nothing is ever written into the worktree for the sake of
 * displaying something (spec D10) and the owner's own index is never touched.
 *
 * `tree` comes from `write-tree` over that same index, so the file list and the stage's tree label
 * cannot disagree (spec D3).
 *
 * Rejects when the reading cannot be done -- an unresolvable baseline, a worktree that is gone,
 * git failing to run. It never degrades into an empty list, because an empty list is a claim that
 * the worktree is unchanged (spec D7).
 */
export const summariseChanges = async (context: {
  worktreePath: string;
  baseline: string;
  maxFiles: number;
}): Promise<ChangeSummary> => {
  const { worktreePath, baseline, maxFiles } = context;
  const indexDir = await mkdtemp(join(tmpdir(), "loomrail-changes-"));
  const indexFile = join(indexDir, "index");

  try {
    // `baseline` goes in as its own argv element, never concatenated into a string: it comes from
    // stored state, and an argv array is what keeps it an argument rather than syntax.
    const readTree = await runGitWithIndex(["read-tree", baseline], worktreePath, indexFile);
    expectSuccess(readTree, "read-tree");

    const add = await runGitWithIndex(["add", "-A"], worktreePath, indexFile);
    expectSuccess(add, "add -A");

    const writeTree = await runGitWithIndex(["write-tree"], worktreePath, indexFile);
    expectSuccess(writeTree, "write-tree");

    const numstat = await runGitWithIndex([...readArgs, "--numstat", baseline], worktreePath, indexFile);
    expectSuccess(numstat, "diff-index --numstat");

    const nameStatus = await runGitWithIndex(
      [...readArgs, "--name-status", baseline],
      worktreePath,
      indexFile,
    );
    expectSuccess(nameStatus, "diff-index --name-status");

    const statuses = parseNameStatus(nameStatus.stdout);
    const files = parseNumstat(numstat.stdout).map((counted): ChangedFile => {
      const record = statuses.get(counted.path);
      if (record === undefined) {
        // Two readings of one index that disagree about which paths changed. Refusing beats
        // inventing a status for a file whose fate is unknown.
        throw new Error(`git reported line counts for ${JSON.stringify(counted.path)} but no status`);
      }
      return {
        path: counted.path,
        previousPath: record.previousPath,
        status: record.status,
        insertions: counted.insertions,
        deletions: counted.deletions,
        binary: counted.binary,
      };
    });

    return {
      files: files.slice(0, maxFiles),
      tree: writeTree.stdout.trim(),
      truncated: files.length > maxFiles,
    };
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
};
