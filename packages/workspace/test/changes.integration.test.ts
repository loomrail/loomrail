import { chmod, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PathNotAFileError,
  PathOutsideWorktreeError,
  PathUnresolvableError,
  readFileDiff,
  resolveWorktreeRelativePath,
  summariseChanges,
  type FileDiff,
} from "../src/index.js";

import {
  listTreePaths,
  makeWorktreeWithAwkwardPaths,
  makeWorktreeWithBracketPath,
  makeWorktreeWithEveryKindOfChange,
  makeWorktreeWithHostileGitConfig,
  readPorcelainDiff,
} from "./helpers.js";

// A filename may contain a tab or be a single `*` on POSIX and may not on Windows, where CI also
// runs this suite. The tests that need such a name skip there rather than being written in a way
// that cannot see the defect they name.
const onWindows = process.platform === "win32";

// git's canonical empty tree -- what `write-tree` produces from an index with nothing in it. A
// summary that reported this as the stage's tree would be claiming the worktree is empty.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Every path the owner can see in the worktree, sorted. `.git` is excluded because git writes
// objects and index metadata there as a matter of course; what spec D10 forbids is a file left in
// the working copy, which would show up in the very next summary as work the agent did.
const workingCopyPaths = async (worktree: string): Promise<readonly string[]> => {
  const entries = await readdir(worktree, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(worktree, join(entry.parentPath, entry.name)))
    .filter((path) => !path.startsWith(`.git${sep}`))
    .sort();
};

describe("summariseChanges", () => {
  it("sees a file the agent created, which a plain `git diff` against the baseline does not", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    const created = summary.files.find((file) => file.path === "added.txt");
    expect(created).toEqual({
      path: "added.txt",
      previousPath: null,
      status: "ADDED",
      insertions: 1,
      deletions: 0,
      binary: false,
    });
  });

  it("reports a rename as a rename, naming where the file came from", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    expect(summary.files.find((file) => file.path === "renamed-to.txt")).toMatchObject({
      status: "RENAMED",
      previousPath: "renamed-from.txt",
    });
    expect(summary.files.some((file) => file.path === "renamed-from.txt")).toBe(false);
  });

  it("marks a binary file binary and refuses to invent line counts for it", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    expect(summary.files.find((file) => file.path === "pic.bin")).toMatchObject({
      binary: true,
      insertions: null,
      deletions: null,
    });
  });

  it("tells an edit apart from a removal instead of lumping both under one status", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    expect(summary.files.find((file) => file.path === "modified.txt")).toEqual({
      path: "modified.txt",
      previousPath: null,
      status: "MODIFIED",
      insertions: 1,
      deletions: 0,
      binary: false,
    });
    expect(summary.files.find((file) => file.path === "deleted.txt")).toEqual({
      path: "deleted.txt",
      previousPath: null,
      status: "DELETED",
      insertions: 0,
      deletions: 1,
      binary: false,
    });
  });

  it("leaves an ignored file out of the summary while still listing the work", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    // The positive comes first because the negative alone passes vacuously: a summary that listed
    // nothing at all would satisfy "no build/ file is in it" while telling the owner the agent
    // changed nothing.
    expect(summary.files.map((file) => file.path)).toContain("added.txt");
    expect(summary.files.some((file) => file.path.startsWith("build/"))).toBe(false);
  });

  it.skipIf(onWindows)(
    "summarises a file whose name contains a tab instead of failing on the whole list",
    async () => {
      const { worktreePath, baseline, tabPath } = await makeWorktreeWithAwkwardPaths();

      // Asserted through `.resolves` on purpose: under the defect this call rejects -- the record
      // `1\t0\ttab\there.txt` split on every tab is four fields -- and one odd-but-legal filename
      // anywhere in the worktree made the owner's whole change list an error. `.resolves` turns that
      // into a failing assertion rather than a test that dies on its own await.
      const listed = summariseChanges({ worktreePath, baseline, maxFiles: 2_000 }).then((summary) =>
        summary.files.map((file) => `${file.status} ${file.path}`),
      );

      await expect(listed).resolves.toContain(`ADDED ${tabPath}`);
    },
  );

  it("says the summary was truncated instead of quietly returning fewer files", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 1 });

    expect(summary.files).toHaveLength(1);
    expect(summary.truncated).toBe(true);
  });

  it("does not claim truncation when every changed file fits", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    expect(summary.truncated).toBe(false);
  });

  it("does not claim truncation when the file count lands exactly on the limit", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    // The limit is taken from the fixture rather than written down, so that adding a file to the
    // fixture cannot quietly move the test off the boundary it exists to sit on. `> maxFiles` and
    // `>= maxFiles` agree on every other count and disagree here, which is why the two cases
    // either side of it -- one file over, hundreds under -- both passed while the boundary was
    // unpinned.
    const whole = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });
    const exact = await summariseChanges({ worktreePath, baseline, maxFiles: whole.files.length });

    expect(exact.files).toHaveLength(whole.files.length);
    expect(exact.truncated).toBe(false);
  });

  it("hands back the tree of the same index the files were read from", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    expect(summary.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(summary.tree).not.toBe(EMPTY_TREE);
    // What the label CONTAINS, which is the part the two lines above cannot see: a `write-tree`
    // over a second index holding only the baseline returns the BASELINE's tree -- 40 hex
    // characters, not the empty tree -- and that is a label meaning "nothing changed" printed
    // beside a list of nine changed files. Named here by the file the agent created, which the
    // baseline's tree does not hold, and the ignored one, which no correct tree holds.
    const paths = await listTreePaths(worktreePath, summary.tree);
    expect(paths).toContain("added.txt");
    expect(paths).toContain("nested/deep/created.txt");
    expect(paths).not.toContain("build/artifact.txt");
    expect(paths).not.toContain("deleted.txt");
  });

  it("refuses a baseline it cannot resolve rather than summarising against nothing", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();

    await expect(
      summariseChanges({
        worktreePath,
        baseline: "0000000000000000000000000000000000000000",
        maxFiles: 2_000,
      }),
    ).rejects.toThrow(/read-tree/);
  });

  it("keeps its own scratch out of both the worktree and the summary", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();
    const before = await workingCopyPaths(worktreePath);

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    // Two assertions because spec D10 can be broken two ways, and each hides the other. Scratch
    // left behind shows up in the working copy; scratch that is cleaned up but lived inside the
    // worktree while git ran shows up in the summary instead -- probed: `add -A` reports
    // `<scratch>/index` and `<scratch>/index.lock` as ADDED, and the `finally` then removes the
    // evidence before any listing taken after the call could see it.
    expect(await workingCopyPaths(worktreePath)).toEqual(before);
    expect(summary.files.map((file) => file.path).toSorted()).toEqual([
      "added.txt",
      "deleted.txt",
      "modified.txt",
      "nested/deep/created.txt",
      "pic.bin",
      "pkg/a.txt",
      "pkg/b.txt",
      "pkg/pic2.bin",
      "renamed-to.txt",
    ]);
  });
});

// Big enough that nothing in these fixtures comes near it, so a test that is not about truncation
// never accidentally becomes one.
const MAX_BYTES = 512 * 1024;

// The prefix `readFileDiff` gives its own scratch directory. Known to the test on purpose: a
// leftover has to be attributable to this reading, not to whichever other reading happened to be
// running in a parallel worker at the same moment.
const DIFF_SCRATCH_PREFIX = "loomrail-file-diff-";

// Narrows `patch` to a string. The `expect` comes first so that a null patch fails as an
// assertion naming the field, rather than as a TypeError thrown further down the test.
const patchOf = (diff: FileDiff): string => {
  expect(diff.patch).not.toBeNull();
  if (diff.patch === null) {
    throw new Error("unreachable: the patch was asserted non-null above");
  }
  return diff.patch;
};

const scratchDirectories = async (prefix: string): Promise<readonly string[]> =>
  (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)).sort();

describe("readFileDiff", () => {
  it("returns the unified diff of one file, and only that file", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const diff = await readFileDiff({ worktreePath, baseline, path: "modified.txt", maxBytes: MAX_BYTES });

    const patch = patchOf(diff);
    expect(patch).toContain("--- a/modified.txt");
    expect(patch).toContain("+two");
    expect(patch).toContain(" one");
    // The file the agent created is a change too, and it is not the one that was asked for.
    expect(patch).not.toContain("added.txt");
    expect(diff).toMatchObject({ path: "modified.txt", binary: false, truncated: false, omittedBytes: 0 });
  });

  it("says which commit the patch was read against", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const diff = await readFileDiff({ worktreePath, baseline, path: "modified.txt", maxBytes: MAX_BYTES });

    // Spec §4 puts `baseline` on FileDiff, and this is where it is known. A patch handed on
    // without it can be shown beside the wrong base by a caller that remembered a different one,
    // and nothing in the answer would contradict that.
    expect(diff.baseline).toBe(baseline);
  });

  it("shows a renamed file as a rename rather than as a whole file added", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const diff = await readFileDiff({ worktreePath, baseline, path: "renamed-to.txt", maxBytes: MAX_BYTES });

    // Pathspec limiting runs before rename detection, so a read limited to the new path alone
    // cannot let `-M` fire: git answers `new file mode` and the five lines of an unchanged file as
    // additions, while the summary calls the same file RENAMED and names where it came from. The
    // two views of one file have to agree (D3's principle, one file down).
    const patch = patchOf(diff);
    expect(patch).toContain("rename from renamed-from.txt");
    expect(patch).toContain("rename to renamed-to.txt");
    expect(patch).not.toContain("+r1");
  });

  // Five pathspec expressions, each measured answering with something other than the one file it
  // was supposed to name: `":/"` and `"*"` with EVERY changed file's diff, `":(top)modified.txt"`
  // with a file the caller did not ask for, `":(exclude)pkg/a.txt"` with all the others, and
  // `":"` with the whole repository's diff buffered before the truncation of spec §8 could run.
  // On POSIX none of these exists as a file, so the path check that came before them concluded
  // "inside the worktree" and passed them straight to git as the small language they are.
  it.each([":/", ":(top)modified.txt", ":(exclude)pkg/a.txt", "*", ":(glob)**/*.txt"])(
    "refuses %s, which is a pathspec expression and not a file",
    async (expression) => {
      const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

      await expect(
        readFileDiff({ worktreePath, baseline, path: expression, maxBytes: MAX_BYTES }),
      ).rejects.toThrow(PathNotAFileError);
    },
  );

  it.skipIf(onWindows)("reads a file whose name is a glob character as that one file", async () => {
    const { worktreePath, baseline, starPath, otherPath } = await makeWorktreeWithAwkwardPaths();

    // The other half of the pathspec fix, and the half a refusal cannot show: a file really named
    // `*` has to be readable AS that file. Without `:(literal)`, git evaluates the name and the
    // patch comes back holding every changed file in the worktree (probed).
    const diff = await readFileDiff({ worktreePath, baseline, path: starPath, maxBytes: MAX_BYTES });

    const patch = patchOf(diff);
    expect(patch).toContain(`--- a/${starPath}`);
    expect(patch).toContain("+s2");
    expect(patch).not.toContain(otherPath);
  });

  // The same half of the pathspec fix, on a name that exists on EVERY platform this suite runs on.
  // The test above can only run where a file may be called `*`, so on Windows -- where CI also
  // runs -- `:(literal)` could be deleted and the suite would stay green: the five refusals above
  // guard the NAME LOOKUP, which happens before any pathspec is built, and none of them notices
  // whether the pathspec that follows is literal.
  //
  // Brackets are legal in an NTFS filename and are still a pathspec expression. Probed: with the
  // name passed through as it was, `diff-index -p HEAD -- 'a[b].txt'` answers with BOTH `a[b].txt`
  // and `ab.txt` -- git matches the exact name AND the glob -- so the caller who asked about one
  // file is handed another file's patch alongside it.
  it("reads a file whose name is a bracket expression as that one file", async () => {
    const { worktreePath, baseline, bracketPath, decoyPath } = await makeWorktreeWithBracketPath();

    const diff = await readFileDiff({ worktreePath, baseline, path: bracketPath, maxBytes: MAX_BYTES });

    const patch = patchOf(diff);
    expect(diff.path).toBe(bracketPath);
    expect(patch).toContain(`--- a/${bracketPath}`);
    expect(patch).toContain("+x2");
    // The decoy, by name and by the line only it has: a patch holding either is a patch about a
    // file the caller did not ask about.
    expect(patch).not.toContain(decoyPath);
    expect(patch).not.toContain("+y2");
  });

  // Resolution is the other way a reading that promised "the diff of one file, and only that file"
  // can answer about a different one. Canonicalising is right -- it is how a symlink pointing out
  // of the worktree is caught -- but computing the worktree-relative path from the TARGET made the
  // answer describe the target: measured in this worktree, `readFileDiff({ path: "alias.txt" })`
  // answered `path: "modified.txt"` carrying modified.txt's patch, while the summary listed
  // `alias.txt` as a file of its own. A file the summary lists must have a body reachable under
  // the name the summary gave it.
  it.skipIf(onWindows)(
    "answers about the symlink the caller named, not about what it points at",
    async () => {
      const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();
      await symlink("modified.txt", join(worktreePath, "alias.txt"));

      // The premise, asserted rather than assumed: the summary really does offer this name.
      const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });
      expect(summary.files.map((file) => file.path)).toContain("alias.txt");

      const diff = await readFileDiff({ worktreePath, baseline, path: "alias.txt", maxBytes: MAX_BYTES });

      expect(diff.path).toBe("alias.txt");
      // git diffs index entries, and a symlink is an entry of its own: its patch is the link, whose
      // whole content is the name it points at. What it is NOT is modified.txt's edit.
      expect(patchOf(diff)).not.toContain("+two");
    },
  );

  it.skipIf(onWindows)(
    "refuses a path through a symlinked directory instead of answering for the directory it points at",
    async () => {
      const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();
      await symlink("pkg", join(worktreePath, "linkdir"));

      // `linkdir/a.txt` is no entry of git's at all -- `linkdir` is a symlink blob, and nothing is
      // tracked beneath it -- so the honest answer is the same refusal any other path that names no
      // file gets. Reporting `pkg/a.txt`'s patch instead answers a question nobody asked.
      await expect(
        readFileDiff({ worktreePath, baseline, path: "linkdir/a.txt", maxBytes: MAX_BYTES }),
      ).rejects.toThrow(PathNotAFileError);
    },
  );

  it("refuses a directory instead of calling the text files inside it binary", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    // `pkg` holds two changed text files and one changed binary. Reading `binary` as a disjunction
    // over however many records a pathspec matched answered `{ binary: true, patch: null }` for
    // it -- "there is nothing to show" about two text files that did change, which is the exact
    // claim spec D8 exists to forbid.
    await expect(readFileDiff({ worktreePath, baseline, path: "pkg", maxBytes: MAX_BYTES })).rejects.toThrow(
      PathNotAFileError,
    );
  });

  it("refuses a path that is not there rather than reporting it as an unchanged file", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    // `patch: ""` for a path that does not exist is a client's mistake turned into a positive
    // claim about the world, and indistinguishable from the answer for a file that really is
    // there and really did not change (spec §7's new row).
    await expect(
      readFileDiff({ worktreePath, baseline, path: "nope.txt", maxBytes: MAX_BYTES }),
    ).rejects.toThrow(PathNotAFileError);
  });

  it("still answers an unchanged file with an empty patch rather than refusing it", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    // The other side of the refusal above, which would otherwise be free to swallow the case it
    // has to keep: `.gitignore` is committed in the baseline and untouched since.
    const diff = await readFileDiff({ worktreePath, baseline, path: ".gitignore", maxBytes: MAX_BYTES });

    expect(diff).toEqual({
      path: ".gitignore",
      baseline,
      binary: false,
      patch: "",
      truncated: false,
      omittedBytes: 0,
    });
  });

  it("refuses an ignored file, which the summary never showed in the first place", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    await expect(
      readFileDiff({ worktreePath, baseline, path: "build/artifact.txt", maxBytes: MAX_BYTES }),
    ).rejects.toThrow(PathNotAFileError);
  });

  it("marks a binary file binary instead of handing back an empty patch", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const diff = await readFileDiff({ worktreePath, baseline, path: "pic.bin", maxBytes: MAX_BYTES });

    expect(diff).toMatchObject({ binary: true, patch: null, truncated: false, omittedBytes: 0 });
  });

  it("says a patch was truncated and how much was left out", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const whole = await readFileDiff({ worktreePath, baseline, path: "modified.txt", maxBytes: MAX_BYTES });
    // 60 bytes keeps the `diff --git` line and stops before the `index` line, so the cut lands on
    // a line boundary with something on either side of it.
    const clipped = await readFileDiff({ worktreePath, baseline, path: "modified.txt", maxBytes: 60 });

    const wholePatch = patchOf(whole);
    const clippedPatch = patchOf(clipped);
    expect(clipped.truncated).toBe(true);
    expect(clipped.omittedBytes).toBeGreaterThan(0);
    // The count is the whole point: "truncated" without a number is the silent cut D8 forbids,
    // dressed up. What was kept plus what was left out has to add back up to what there was.
    expect(clipped.omittedBytes).toBe(Buffer.byteLength(wholePatch) - Buffer.byteLength(clippedPatch));
    expect(wholePatch.startsWith(clippedPatch)).toBe(true);
    expect(clippedPatch.endsWith("\n")).toBe(true);
    expect(whole.truncated).toBe(false);
  });

  it("keeps the owner's git config from changing what the patch says", async () => {
    const { worktreePath, baseline, nonAsciiPath } = await makeWorktreeWithHostileGitConfig();

    // The config really is hostile, and this is what it does to the owner's own `git diff` in that
    // same repository. Without this line the assertions below could pass against a config that
    // turned out to change nothing.
    expect(await readPorcelainDiff(worktreePath, baseline, nonAsciiPath)).toContain("PWNED");

    const diff = await readFileDiff({ worktreePath, baseline, path: nonAsciiPath, maxBytes: MAX_BYTES });

    const patch = patchOf(diff);
    // `core.quotepath` is true in that repository, as it is by default: without the flag every
    // path in the patch comes back octal-escaped, as `"a/\303\251-\321\204..."`.
    expect(patch).toContain(`--- a/${nonAsciiPath}`);
    expect(patch).not.toContain("\\303\\251");
    expect(patch).not.toContain("PWNED");
    expect(patch).not.toContain("\u001b[");
    expect(patch).toContain("+two");
  });

  it("reads a diff without needing to write anything into the worktree", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    // Taking write permission off the worktree root is the assertion. Comparing the working copy
    // before and after would not be one: a temporary index built inside the worktree and removed
    // in a `finally` leaves the two listings identical (spec D10, and the finding Task 1 recorded).
    // Probed: `read-tree`, `add -A` and `diff-index` all succeed against a root at 0555, because
    // git writes its objects under `.git`, whose own permissions this does not touch.
    await chmod(worktreePath, 0o555);
    try {
      await expect(
        readFileDiff({ worktreePath, baseline, path: "modified.txt", maxBytes: MAX_BYTES }),
      ).resolves.toMatchObject({ binary: false, truncated: false });
    } finally {
      await chmod(worktreePath, 0o755);
    }
  });

  it("removes its temporary index even when the read fails", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();
    const before = await scratchDirectories(DIFF_SCRATCH_PREFIX);

    await expect(
      readFileDiff({
        worktreePath,
        baseline: "0000000000000000000000000000000000000000",
        path: "modified.txt",
        maxBytes: MAX_BYTES,
      }),
    ).rejects.toThrow(/read-tree/);

    expect(await scratchDirectories(DIFF_SCRATCH_PREFIX)).toEqual(before);
  });

  it("refuses to read a diff for a path that leaves the worktree", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    await expect(
      readFileDiff({ worktreePath, baseline, path: "../../etc/passwd", maxBytes: MAX_BYTES }),
    ).rejects.toThrow(PathOutsideWorktreeError);
  });
});

describe("resolveWorktreeRelativePath", () => {
  it("refuses a path that leaves the worktree, naming the path it refused", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();

    const refuse = (): string => resolveWorktreeRelativePath(worktreePath, "../../etc/passwd");

    expect(refuse).toThrow(PathOutsideWorktreeError);
    expect(refuse).toThrow(expect.objectContaining({ requestedPath: "../../etc/passwd" }));
  });

  it("refuses a sibling directory whose name merely starts with the worktree's", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();

    expect(() => resolveWorktreeRelativePath(worktreePath, `${worktreePath}-evil/secret.txt`)).toThrow(
      PathOutsideWorktreeError,
    );
  });

  it("refuses a path that leaves through a symlink inside the worktree", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();
    const outside = await mkdtemp(join(tmpdir(), "loomrail-workspace-outside-"));
    await writeFile(join(outside, "secret.txt"), "not the agent's work\n");
    await symlink(outside, join(worktreePath, "escape-link"));

    // Lexically this path never leaves the worktree; only asking the filesystem what it resolves
    // to says otherwise.
    expect(() => resolveWorktreeRelativePath(worktreePath, "escape-link/secret.txt")).toThrow(
      PathOutsideWorktreeError,
    );
  });

  it("refuses a differently-cased spelling of the worktree instead of folding case", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();
    const shouted = join(dirname(worktreePath), basename(worktreePath).toUpperCase());

    // On a case-insensitive filesystem this names the very same directory, and it is still
    // refused: macOS `realpath` hands the shouted spelling straight back rather than correcting it
    // to what is on disk (probed), and folding case in the comparison instead would, on a
    // case-sensitive filesystem, let `/tmp/WT` pass as `/tmp/wt` -- two different directories.
    // Refusing a legitimate spelling is a visible, harmless failure; the other way round is not.
    expect(() => resolveWorktreeRelativePath(worktreePath, join(shouted, "modified.txt"))).toThrow(
      PathOutsideWorktreeError,
    );
  });

  it("accepts an absolute path that does land inside the worktree", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();

    // An absolute path is judged on where it lands, not refused for being absolute: what git is
    // handed either way is the path relative to the worktree.
    expect(resolveWorktreeRelativePath(worktreePath, join(worktreePath, "modified.txt"))).toBe(
      "modified.txt",
    );
  });

  // The three inputs that used to leave this boundary as somebody else's error object: a
  // `TypeError [ERR_INVALID_ARG_VALUE]` from `realpath`, a bare `ELOOP`, a bare `EACCES` (all
  // three probed on this machine). Each fails closed either way -- nothing is read -- so what
  // these pin is that a caller mapping this boundary to a refusal has one named failure to map
  // rather than three internal ones.
  it("refuses a path with a NUL byte in it as a named refusal", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();

    expect(() => resolveWorktreeRelativePath(worktreePath, `a${String.fromCharCode(0)}b.txt`)).toThrow(
      PathUnresolvableError,
    );
  });

  it.skipIf(onWindows)("refuses a path that runs into a symlink loop as a named refusal", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();
    await symlink("loop", join(worktreePath, "loop"));

    expect(() => resolveWorktreeRelativePath(worktreePath, "loop/inside.txt")).toThrow(PathUnresolvableError);
  });

  it.skipIf(onWindows)("refuses a path under a directory it cannot read as a named refusal", async () => {
    const { worktreePath } = await makeWorktreeWithEveryKindOfChange();
    const locked = join(worktreePath, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);

    try {
      expect(() => resolveWorktreeRelativePath(worktreePath, "locked/inside.txt")).toThrow(
        PathUnresolvableError,
      );
    } finally {
      // Put the mode back so the fixture can be cleaned up by whatever removes the temp directory.
      await chmod(locked, 0o755);
    }
  });
});
