import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { summariseChanges } from "../src/index.js";

import { makeWorktreeWithEveryKindOfChange } from "./helpers.js";

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
