import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addWorktree, listWorktrees, removeWorktree, runGit } from "../src/index.js";

import { makeThrowawayRepo } from "./helpers.js";

// `git worktree` resolves the path it is given (and the paths it reports back) against the real
// filesystem, symlinks and all. On macOS the OS temp directory is `/var/...`, a symlink to
// `/private/var/...`, so a path built straight from `tmpdir()` would never string-match what git
// hands back. Resolving through the parent (which `mkdtemp` actually creates) sidesteps that --
// the child path itself does not exist yet for `realpath` to resolve.
const outsideDir = async (name: string): Promise<string> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "loomrail-wt-")));
  return join(parent, name);
};

describe("addWorktree", () => {
  it("puts the worktree where the owner's repository will not see it", async () => {
    const repo = await makeThrowawayRepo();
    const outside = await outsideDir("task-1");

    const added = await addWorktree({
      topLevel: repo,
      branch: "loomrail/task-1",
      path: outside,
      startPoint: "HEAD",
    });

    expect(added.type).toBe("ADDED");
    const status = await runGit(["status", "--porcelain"], { cwd: repo });
    expect(status.stdout).toBe("");
  });

  it("names the branch it will not take over", async () => {
    const repo = await makeThrowawayRepo();
    await runGit(["branch", "loomrail/task-1"], { cwd: repo });
    const outside = await outsideDir("task-1");

    const added = await addWorktree({
      topLevel: repo,
      branch: "loomrail/task-1",
      path: outside,
      startPoint: "HEAD",
    });

    expect(added).toEqual({ type: "REFUSED", refusal: { type: "BRANCH_EXISTS", branch: "loomrail/task-1" } });
  });

  it("names the worktree already holding a branch it will not take over", async () => {
    const repo = await makeThrowawayRepo();
    const firstPath = await outsideDir("task-1");
    const first = await addWorktree({
      topLevel: repo,
      branch: "loomrail/task-1",
      path: firstPath,
      startPoint: "HEAD",
    });
    expect(first.type).toBe("ADDED");

    const secondPath = await outsideDir("task-1-again");
    const second = await addWorktree({
      topLevel: repo,
      branch: "loomrail/task-1",
      path: secondPath,
      startPoint: "HEAD",
    });

    expect(second).toEqual({
      type: "REFUSED",
      refusal: { type: "BRANCH_CHECKED_OUT", branch: "loomrail/task-1", occupiedBy: firstPath },
    });
  });

  it("names the path it will not overwrite", async () => {
    const repo = await makeThrowawayRepo();
    // A plain directory that git never registered as a worktree -- the branch is unoccupied, but
    // the target path itself already exists on disk.
    const preexisting = await mkdtemp(join(tmpdir(), "loomrail-wt-"));

    const added = await addWorktree({
      topLevel: repo,
      branch: "loomrail/task-1",
      path: preexisting,
      startPoint: "HEAD",
    });

    expect(added).toEqual({ type: "REFUSED", refusal: { type: "PATH_EXISTS", path: preexisting } });
  });
});

describe("listWorktrees", () => {
  it("lists the repository's own worktree alongside any it creates", async () => {
    const repo = await makeThrowawayRepo();
    const outside = await outsideDir("task-1");
    await addWorktree({ topLevel: repo, branch: "loomrail/task-1", path: outside, startPoint: "HEAD" });

    const entries = await listWorktrees(repo);

    const created = entries.find((entry) => entry.path === outside);
    expect(created).toEqual({ path: outside, branch: "loomrail/task-1", prunable: false });
  });

  it("marks a worktree whose directory was deleted from under git", async () => {
    const repo = await makeThrowawayRepo();
    const dir = await outsideDir("task-1");
    await addWorktree({ topLevel: repo, branch: "loomrail/task-1", path: dir, startPoint: "HEAD" });

    await rm(dir, { recursive: true, force: true });

    const entries = await listWorktrees(repo);
    expect(entries.find((entry) => entry.path === dir)?.prunable).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes a worktree the repository can see", async () => {
    const repo = await makeThrowawayRepo();
    const dir = await outsideDir("task-1");
    await addWorktree({ topLevel: repo, branch: "loomrail/task-1", path: dir, startPoint: "HEAD" });

    await removeWorktree({ topLevel: repo, path: dir });

    const entries = await listWorktrees(repo);
    expect(entries.find((entry) => entry.path === dir)).toBeUndefined();
  });

  it("succeeds even when the directory is already gone, and leaves the branch behind", async () => {
    const repo = await makeThrowawayRepo();
    const dir = await outsideDir("task-1");
    await addWorktree({ topLevel: repo, branch: "loomrail/task-1", path: dir, startPoint: "HEAD" });
    await rm(dir, { recursive: true, force: true });

    await expect(removeWorktree({ topLevel: repo, path: dir })).resolves.toBeUndefined();

    const branch = await runGit(["show-ref", "--verify", "--quiet", "refs/heads/loomrail/task-1"], {
      cwd: repo,
    });
    expect(branch.exitCode).toBe(0);
  });
});
