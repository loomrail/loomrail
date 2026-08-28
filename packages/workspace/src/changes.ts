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

    // Split on the FIRST two tabs and take everything after them as the path, rather than on every
    // tab. A tab is an ordinary character in a POSIX filename (probed: git writes the record
    // `1\t0\ttab\there.txt` for one), so splitting on all of them yields four fields, and a record
    // count that has to be exactly three then turned one odd-but-legal filename anywhere in the
    // worktree into an error for the owner's whole change list.
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`git --numstat produced an unreadable record ${JSON.stringify(record)}`);
    }
    const insertions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);

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
// `baseline` is `null` for a reading that has none to seed from and wants the index to start
// empty -- `read-tree --empty` rather than omitting the step, so the index is reset even if a
// caller ever reused an index file (today none do; every caller still gets a fresh `mkdtemp`).
//
// `prefix` is the caller's own, so that a leftover scratch directory can be traced to the reading
// that leaked it rather than to whichever reading happened to run alongside it.
const withTemporaryIndex = async <T>(
  context: { worktreePath: string; baseline: string | null; prefix: string },
  body: (indexFile: string) => Promise<T>,
): Promise<T> => {
  const { worktreePath, baseline, prefix } = context;
  const indexDir = await mkdtemp(join(tmpdir(), prefix));
  const indexFile = join(indexDir, "index");

  try {
    // `baseline` goes in as its own argv element, never concatenated into a string: it comes from
    // stored state, and an argv array is what keeps it an argument rather than syntax.
    const readTree = await runGitWithIndex(
      baseline === null ? ["read-tree", "--empty"] : ["read-tree", baseline],
      worktreePath,
      indexFile,
    );
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
 * `tree` comes from `write-tree` over that same index, so `files` and `tree` are two readings of
 * one temporary index rather than two independent walks able to disagree about what changed (spec
 * D3). D3 governs pairing a summary with a tree; it says nothing about which tree a caller who
 * wants no summary should use -- that caller is {@link treeOfWorktree}, not this function.
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

/**
 * The tree a work item's worktree holds right now, with no baseline and no summary attached.
 *
 * Computed through a temporary index -- `read-tree --empty`, `add -A`, `write-tree` -- so the
 * result is a function of the working tree alone. That is not an approximation of
 * {@link summariseChanges}'s `tree`: seeding the index from any baseline and then `add -A`-ing
 * every current change on top produces the exact same tree as a from-empty index does, because
 * `add -A` restages every tracked path to its current worktree content and adds every untracked
 * one, which is already everything the baseline's entries could have contributed. A caller with no
 * baseline in hand, or with one it does not want to spend on a tree it already knows does not
 * depend on it, does not need to resolve or pass one.
 *
 * Rejects when the reading cannot be done -- the worktree is gone, git failing to run -- the same
 * way `summariseChanges` does, since it is built on the same temporary-index machinery.
 */
export const treeOfWorktree = async (context: { worktreePath: string }): Promise<string> => {
  const { worktreePath } = context;

  return withTemporaryIndex({ worktreePath, baseline: null, prefix: "loomrail-tree-" }, async (indexFile) => {
    const writeTree = await runGitWithIndex(["write-tree"], worktreePath, indexFile);
    expectSuccess(writeTree, "write-tree");
    return writeTree.stdout.trim();
  });
};

export type FileDiff = {
  path: string;
  // The commit this diff was read against (spec §4). Carried on the answer rather than left for
  // the caller to remember: the reading is where the baseline is known, and a patch whose base is
  // supplied from somewhere else can be shown beside the wrong one without either side noticing.
  baseline: string;
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

/**
 * The refusal for a path the filesystem cannot answer for at all, so that the boundary has one
 * named failure where it used to leak three internal ones (probed on this machine): a NUL byte in
 * the path throws `TypeError [ERR_INVALID_ARG_VALUE]` out of `realpath`, a symlink loop throws
 * `ELOOP`, and a directory with no search permission throws `EACCES`.
 *
 * None of the three ever read anything -- the resolution fails before git is started -- so this is
 * about what a caller mapping this boundary to a refusal is handed, not about exposure. The cause
 * is kept for the daemon's log; the message names only the path the client sent.
 */
export class PathUnresolvableError extends Error {
  readonly requestedPath: string;

  constructor(requestedPath: string, cause: unknown) {
    super(`path ${JSON.stringify(requestedPath)} could not be resolved inside the work item's worktree`, {
      cause,
    });
    this.name = "PathUnresolvableError";
    this.requestedPath = requestedPath;
  }
}

/**
 * The refusal for a path that does resolve inside the worktree and still names no single file this
 * reading can show: a path that is not there at all, a directory, or a file git is not carrying
 * (an ignored build artifact).
 *
 * Named rather than answered with `patch: ""`, which spec §7 now has a row for. An empty patch is
 * a statement about the world -- "this file is there and nothing in it changed" -- and a client's
 * typo is not evidence for it; the two were previously indistinguishable to the owner.
 */
export class PathNotAFileError extends Error {
  readonly requestedPath: string;

  constructor(requestedPath: string) {
    super(
      `path ${JSON.stringify(requestedPath)} does not name one file the work item's changes can be read for`,
    );
    this.name = "PathNotAFileError";
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
 * The request is judged on where it LANDS and reported as what it NAMES, and those are two
 * different paths whenever a symlink is involved. Canonicalising decides whether the request stays
 * inside the worktree -- `..` is resolved, an absolute path is judged on where it lands, and a
 * symlink inside the worktree that points out of it is caught, which a lexical check cannot do.
 * But the path handed back, and so the path git is given and the path the answer is about, is the
 * one the client named. Reporting the canonical form instead made the answer describe a different
 * file than the one asked for: measured in a worktree holding `alias.txt -> secret.txt`, the
 * summary listed `alias.txt` as ADDED while `readFileDiff({ path: "alias.txt" })` answered
 * `path: "secret.txt"` carrying secret.txt's patch -- so a file the summary lists had no reachable
 * body, and a caller rendering the answer under the row it asked from showed another file's diff.
 * A symlinked DIRECTORY segment (`linkdir/a.txt`) did the same. Handing git the named path is also
 * what git itself means by that path: it diffs index entries, and a symlink is an entry of its own
 * whose diff is the link, while `linkdir/a.txt` is no entry at all and is refused by name.
 *
 * The refusal is not weakened by this: an escape is still caught on the canonical form, so
 * `escape-link/secret.txt` is refused rather than answered for.
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
  // The worktree as the caller spells it, kept alongside its canonical form. A client that echoes
  // back the `worktreePath` Loomrail recorded names the same directory through whatever symlinks
  // stand above it -- on macOS every temp worktree is reached through `/var -> private/var` -- and
  // the request has to be readable against that spelling too, without that admitting anything the
  // canonical check below has not already cleared.
  const worktreeAsGiven = resolve(worktreePath);

  // `resolve` against the canonical worktree normalises `.` and `..` and leaves an absolute
  // request as itself, which is what makes an absolute path get judged rather than trusted. No
  // symlink is followed here: this is the path the client named.
  const named = resolve(worktree, requestedPath);

  // Only the CLIENT's side of the resolution is wrapped. A failure canonicalising `worktreePath`
  // itself is not a statement about the request -- it says the work item's worktree is gone or
  // unreadable, which spec §7 answers with its own row -- and dressing it up as a bad path would
  // point the owner at the wrong thing.
  let target: string;
  try {
    target = canonicalise(named);
  } catch (error) {
    throw new PathUnresolvableError(requestedPath, error);
  }

  if (!target.startsWith(worktree + sep)) {
    throw new PathOutsideWorktreeError(requestedPath);
  }

  // Where the request LANDS is inside the worktree; what it NAMES has to be inside it as well, or
  // there is no worktree-relative spelling of the name to hand back. This is what a path that
  // reaches in from outside through a symlink (`/tmp/elsewhere/link -> WT/a.txt`) fails: it lands
  // on a file of the work item's, but it is not a name for it that this worktree has.
  const base = named.startsWith(worktree + sep)
    ? worktree
    : named.startsWith(worktreeAsGiven + sep)
      ? worktreeAsGiven
      : null;
  if (base === null) {
    throw new PathOutsideWorktreeError(requestedPath);
  }

  // git wants forward slashes in a pathspec on every platform, and `relative` uses the platform's
  // separator.
  return relative(base, named).split(sep).join("/");
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
 * Wraps a worktree-relative path in git's `literal` pathspec magic, so that git is handed a path
 * rather than an expression.
 *
 * A pathspec is a small language, and the string reaching it comes from the client (spec D9).
 * Measured in a repository with `secret.txt` and `pkg/a.txt` changed, with the path passed through
 * as it was: `":/"` and `"*"` each answered with EVERY changed file's diff, `":(top)secret.txt"`
 * fetched a file the caller had not asked for, and `":(exclude)pkg/a.txt"` fetched the other one.
 * Nothing escaped the worktree -- git itself refuses `:(literal)../etc/passwd` -- but the promise
 * this reading makes, the diff of one file and only that file, was not being kept, and `path=":"`
 * had the whole repository's diff buffered in memory before the bound spec §8 asks for could run.
 *
 * `literal` makes every character in the rest of the string itself (probed: `:(literal)*` matches
 * nothing in a worktree with no file called `*`, and `:(literal)star*name` matches exactly the
 * file of that name).
 *
 * Deliberately NOT `:(literal,top)`. Without `top`, a pathspec is relative to the git process's
 * working directory, which {@link runGitWithIndex} sets to `worktreePath` -- the very directory
 * {@link resolveWorktreeRelativePath} returned a path relative to. `top` would anchor it at the
 * repository root instead, which is the same directory only for as long as a worktree is one.
 */
const literalPathspec = (relativePath: string): string => `:(literal)${relativePath}`;

// The answer for a path `--name-status` did not report: either a file that really is there and
// really did not change, or a path that names nothing this reading can show. The two are told
// apart by asking the temporary index -- the baseline with every current change staged over it --
// for that exact entry, and only an exact match counts: a pathspec matches a directory's contents
// as well (probed: `ls-files -- :(literal)pkg` lists `pkg/a.txt`), and a directory is not a file.
//
// `binary: false` here is about the patch, not about the file's bytes: nothing is being withheld,
// because git reported no change at all. Git's own `--numstat` stays the only source of a true
// `binary` (spec D8), and it has nothing to say about a file it did not report.
const readUnchangedFileOrRefuse = async (context: {
  worktreePath: string;
  indexFile: string;
  baseline: string;
  relativePath: string;
  requestedPath: string;
}): Promise<FileDiff> => {
  const { worktreePath, indexFile, baseline, relativePath, requestedPath } = context;

  const listed = await runGitWithIndex(
    ["-c", "core.quotepath=false", "ls-files", "--cached", "-z", "--", literalPathspec(relativePath)],
    worktreePath,
    indexFile,
  );
  expectSuccess(listed, "ls-files --cached");

  if (!splitNul(listed.stdout).includes(relativePath)) {
    throw new PathNotAFileError(requestedPath);
  }

  return { path: relativePath, baseline, binary: false, patch: "", truncated: false, omittedBytes: 0 };
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
 * first, before any scratch is created or any git process is started; a path that leaves the
 * worktree, and a path the filesystem cannot resolve at all, are each refused by name. It reaches
 * git after `--` and inside {@link literalPathspec}, so it is a path rather than a flag or a
 * pathspec expression.
 *
 * Which file the answer is about is decided by looking the resolved path up, by name, in an
 * unrestricted `--name-status` reading of the same index -- never by whatever a pathspec happened
 * to match. That is what keeps the answer to one file: a directory holding changed files is
 * refused rather than answered for, which it has to be, because a `binary` computed across
 * several matched records once reported a directory holding two changed text files and one
 * changed `.bin` as `{ binary: true, patch: null }` -- "there is nothing to show" about text
 * files that did change, the exact claim spec D8 exists to forbid.
 *
 * A binary file gets `patch: null`, never `""` (spec D8). Whether it is binary comes from git's own
 * `--numstat` record FOR THIS PATH, the same signal the summary reads, so the two views of one file
 * cannot disagree -- and not from matching git's "Binary files ... differ" wording, which is prose
 * that changes.
 *
 * Known bound, left as it is by this round: `maxBytes` is applied to the finished patch, so git's
 * whole output for the file is buffered before the cut. Limiting the read to one file is what
 * makes that bound "one file" rather than "the whole repository"; streaming it is a change to
 * `runGit` and belongs to its own task.
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
      // One unrestricted `--name-status` read, before anything is limited to a path. Its output is
      // one status and one path per CHANGED file and no content at all, so it does not bring back
      // the memory bound this reading exists to keep (spec §8); what it buys is the two things the
      // reads below cannot work out for themselves -- whether this path is a changed file, and
      // where it came from if it was renamed.
      const nameStatus = await runGitWithIndex(
        [...readArgs, "--name-status", baseline],
        worktreePath,
        indexFile,
      );
      expectSuccess(nameStatus, "diff-index --name-status");
      const status = parseNameStatus(nameStatus.stdout).get(relativePath);

      if (status === undefined) {
        return await readUnchangedFileOrRefuse({
          worktreePath,
          indexFile,
          baseline,
          relativePath,
          requestedPath: path,
        });
      }

      // A renamed file's body needs BOTH names after `--`. Pathspec limiting runs before rename
      // detection, so `-M` cannot fire on a read limited to the new path alone: measured, that
      // read answers `new file mode` plus the whole file as added, while the summary calls the
      // same file RENAMED and names where it came from. With both names given, git answers
      // `similarity index 100% / rename from ... / rename to ...`.
      const pathspecs =
        status.previousPath === null
          ? [literalPathspec(relativePath)]
          : [literalPathspec(status.previousPath), literalPathspec(relativePath)];

      const numstat = await runGitWithIndex(
        [...readArgs, "--numstat", baseline, "--", ...pathspecs],
        worktreePath,
        indexFile,
      );
      expectSuccess(numstat, "diff-index --numstat");

      const counted = parseNumstat(numstat.stdout).find((entry) => entry.path === relativePath);
      if (counted === undefined) {
        // Two readings of one index that disagree about which paths changed, the same way the
        // summary's own join can. Refusing beats reporting a file as text because the record that
        // would have called it binary went missing.
        throw new Error(`git reported a status for ${JSON.stringify(relativePath)} but no line counts`);
      }
      if (counted.binary) {
        return { path: relativePath, baseline, binary: true, patch: null, truncated: false, omittedBytes: 0 };
      }

      // `-z` comes back out for the patch read: it applies to the machine-readable listings, and a
      // patch is not one. The paths go after `--` so that a file named `-p` stays a path.
      const patch = await runGitWithIndex(
        [...readArgs.filter((arg) => arg !== "-z"), "-p", baseline, "--", ...pathspecs],
        worktreePath,
        indexFile,
      );
      expectSuccess(patch, "diff-index -p");

      return { path: relativePath, baseline, binary: false, ...clipPatch(patch.stdout, maxBytes) };
    },
  );
};
