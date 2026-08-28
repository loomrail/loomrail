import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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

// Runs `body` against a temporary index holding `baseline` with every current change staged on
// top of it -- the reading E1.5 is built on (spec D2, §2.2), and the one place the index's
// lifetime is decided. The index lives in the OS temp directory and is removed in a `finally` that
// covers the failure path too, so nothing is ever written into the worktree for the sake of
// displaying something (spec D10) and the owner's own index is never touched.
//
// `prefix` is the caller's own, so that a leftover scratch directory can be traced to the reading
// that leaked it rather than to whichever reading happened to run alongside it.
const withTemporaryIndex = async <T>(
  context: { worktreePath: string; baseline: string; prefix: string },
  body: (indexFile: string) => Promise<T>,
): Promise<T> => {
  const { worktreePath, baseline, prefix } = context;
  const indexDir = await mkdtemp(join(tmpdir(), prefix));
  const indexFile = join(indexDir, "index");

  try {
    // `baseline` goes in as its own argv element, never concatenated into a string: it comes from
    // stored state, and an argv array is what keeps it an argument rather than syntax.
    const readTree = await runGitWithIndex(["read-tree", baseline], worktreePath, indexFile);
    expectSuccess(readTree, "read-tree");

    // `add -A` honours `.gitignore` by itself, which is why build output stays out of the reading
    // without this module carrying a list of exclusions.
    const add = await runGitWithIndex(["add", "-A"], worktreePath, indexFile);
    expectSuccess(add, "add -A");

    return await body(indexFile);
  } finally {
    await rm(indexDir, { recursive: true, force: true });
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

  return withTemporaryIndex({ worktreePath, baseline, prefix: "loomrail-changes-" }, async (indexFile) => {
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
  });
};

export type FileDiff = {
  path: string;
  binary: boolean;
  // Null for a binary file: there is no text to show, and an empty string would read as "no
  // change" (spec D8).
  patch: string | null;
  truncated: boolean;
  omittedBytes: number;
};

// The refusal spec D9 asks for: a path that leaves the work item's worktree is named back, not
// read. Carries the path the client asked for -- the one the owner can be shown -- rather than
// the resolved form, which says more about this machine than about the request.
export class PathOutsideWorktreeError extends Error {
  readonly requestedPath: string;

  constructor(requestedPath: string) {
    super(`path ${JSON.stringify(requestedPath)} is outside the work item's worktree`);
    this.name = "PathOutsideWorktreeError";
    this.requestedPath = requestedPath;
  }
}

// The canonical form of `target`: `realpath` of the longest prefix of it that exists, with the
// segments that do not exist appended lexically. Asking `realpath` for the whole path would throw
// for a file that is only in the baseline -- a deleted file is exactly the case a diff has to be
// able to show -- and refusing to canonicalise at all would let a symlink inside the worktree
// point out of it while the string still looked like it stayed in.
//
// Only ENOENT and ENOTDIR walk up: those two mean "this name is not there", which is the case the
// walk exists for. Anything else (an unreadable directory, most of all) is rethrown rather than
// answered with a lexical guess that could name a different file than the one the client asked for.
const canonicalise = (target: string): string => {
  const missing: string[] = [];
  let head = target;

  for (;;) {
    try {
      const real = realpathSync(head);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(head);
      if (parent === head) {
        return join(head, ...missing);
      }
      missing.unshift(basename(head));
      head = parent;
    }
  }
};

/**
 * Resolves a path the client asked for against `worktreePath` and hands back the worktree-relative
 * path git should be given, or throws {@link PathOutsideWorktreeError} naming the request.
 *
 * Exported because the daemon refuses before doing any work, and the refusal has to be the same
 * one the read would have produced (spec D9).
 *
 * Both sides are canonicalised before they are compared, so the check is about which file is being
 * named rather than about how it was spelled: `..` is resolved, an absolute path is judged on where
 * it lands, and a symlink inside the worktree that points out of it is caught, which a lexical
 * check cannot do.
 *
 * The comparison is `startsWith(worktree + sep)` -- by path separator, never by string prefix, so
 * that `/tmp/wt-evil` is not read as living inside `/tmp/wt` -- and it compares the two strings
 * exactly, without folding case. Folding would be wrong on a case-sensitive filesystem, where
 * `/tmp/WT` and `/tmp/wt` are two different directories and folding would admit one as the other.
 * That choice costs something on a case-insensitive filesystem, and the cost is deliberate: macOS
 * `realpath` returns the spelling it was handed rather than the one on disk (probed: `realpath` of
 * an upper-cased temp directory comes back upper-cased), so a differently-cased spelling of a
 * worktree that does resolve to it is refused here. Refusing a legitimate spelling is a visible,
 * harmless failure; admitting a path that leaves the worktree is not.
 *
 * The worktree itself is not a file and does not resolve to a path that can be diffed, so it is
 * refused along with everything above it.
 */
export const resolveWorktreeRelativePath = (worktreePath: string, requestedPath: string): string => {
  const worktree = canonicalise(worktreePath);
  // `resolve` against the canonical worktree normalises `.` and `..` and leaves an absolute
  // request as itself, which is what makes an absolute path get judged rather than trusted.
  const target = canonicalise(resolve(worktree, requestedPath));

  if (!target.startsWith(worktree + sep)) {
    throw new PathOutsideWorktreeError(requestedPath);
  }

  // git wants forward slashes in a pathspec on every platform, and `relative` uses the platform's
  // separator.
  return relative(worktree, target).split(sep).join("/");
};

// Cuts a patch down to `maxBytes`, on a line boundary, and says how many bytes that left out.
// Counted in bytes of the finished patch rather than characters, because the limit exists to bound
// what crosses the daemon's boundary (spec §8) and a multi-byte character costs more than one.
// Silent truncation is forbidden by D8: it turns "there are two hundred more lines" into "that is
// all of it".
const clipPatch = (
  patch: string,
  maxBytes: number,
): { patch: string; truncated: boolean; omittedBytes: number } => {
  const totalBytes = Buffer.byteLength(patch, "utf8");
  if (totalBytes <= maxBytes) {
    return { patch, truncated: false, omittedBytes: 0 };
  }

  let keptBytes = 0;
  let end = 0;
  let cursor = 0;
  while (cursor < patch.length) {
    const newline = patch.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? patch.length : newline + 1;
    const lineBytes = Buffer.byteLength(patch.slice(cursor, lineEnd), "utf8");
    if (keptBytes + lineBytes > maxBytes) {
      break;
    }
    keptBytes += lineBytes;
    end = lineEnd;
    cursor = lineEnd;
  }

  return { patch: patch.slice(0, end), truncated: true, omittedBytes: totalBytes - keptBytes };
};

/**
 * The unified diff of one file in a work item's worktree, relative to `baseline`.
 *
 * Separate from {@link summariseChanges} on purpose (spec D5): the summary is cheap and reread
 * often, a body is expensive and read only for the file the owner expanded, and one call returning
 * both would make the cheap reading hostage to the expensive one. It is read through the same
 * temporary index for the same reason (spec D2): a file the agent created has no diff against the
 * working tree at all.
 *
 * `path` comes from the client and is not trusted (spec D9). It is resolved against the worktree
 * first, before any scratch is created or any git process is started, and a path that leaves the
 * worktree is refused by name. It reaches git after `--`, so a path beginning with a dash is an
 * argument rather than a flag.
 *
 * A binary file gets `patch: null`, never `""` (spec D8). Whether it is binary comes from git's own
 * `--numstat`, the same signal the summary reads, so the two views of one file cannot disagree --
 * and not from matching git's "Binary files ... differ" wording, which is prose that changes.
 */
export const readFileDiff = async (context: {
  worktreePath: string;
  baseline: string;
  path: string;
  maxBytes: number;
}): Promise<FileDiff> => {
  const { worktreePath, baseline, path, maxBytes } = context;
  const relativePath = resolveWorktreeRelativePath(worktreePath, path);

  return withTemporaryIndex(
    { worktreePath, baseline, prefix: "loomrail-file-diff-" },
    async (indexFile): Promise<FileDiff> => {
      const numstat = await runGitWithIndex(
        [...readArgs, "--numstat", baseline, "--", relativePath],
        worktreePath,
        indexFile,
      );
      expectSuccess(numstat, "diff-index --numstat");

      // No record at all means this file did not change against the baseline -- a text file with
      // an empty diff, which is not the same thing as a binary one.
      const binary = parseNumstat(numstat.stdout).some((counted) => counted.binary);
      if (binary) {
        return { path: relativePath, binary: true, patch: null, truncated: false, omittedBytes: 0 };
      }

      // `-z` comes back out for the patch read: it applies to the machine-readable listings, and a
      // patch is not one. The path goes after `--` so that a file named `-p` stays a path.
      const patch = await runGitWithIndex(
        [...readArgs.filter((arg) => arg !== "-z"), "-p", baseline, "--", relativePath],
        worktreePath,
        indexFile,
      );
      expectSuccess(patch, "diff-index -p");

      return { path: relativePath, binary: false, ...clipPatch(patch.stdout, maxBytes) };
    },
  );
};
