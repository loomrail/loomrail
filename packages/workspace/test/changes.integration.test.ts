import { chmod, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PathOutsideWorktreeError,
  readFileDiff,
  resolveWorktreeRelativePath,
  summariseChanges,
  type FileDiff,
} from "../src/index.js";

import {
  makeWorktreeWithEveryKindOfChange,
  makeWorktreeWithHostileGitConfig,
  readPorcelainDiff,
} from "./helpers.js";

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

  it("leaves an ignored file out of the summary", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    expect(summary.files.some((file) => file.path.startsWith("build/"))).toBe(false);
  });

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

  it("hands back the tree of the same index the files were read from", async () => {
    const { worktreePath, baseline } = await makeWorktreeWithEveryKindOfChange();

    const summary = await summariseChanges({ worktreePath, baseline, maxFiles: 2_000 });

    expect(summary.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(summary.tree).not.toBe(EMPTY_TREE);
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
      "pic.bin",
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
});
