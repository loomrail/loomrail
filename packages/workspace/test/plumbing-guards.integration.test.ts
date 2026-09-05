import { access, chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addWorktree, createCarryInSnapshot, inspectRepository, runGit } from "../src/index.js";

import { makeThrowawayRepo } from "./helpers.js";

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// The owner's Git configuration is not Loomrail's to obey while it runs plumbing on their behalf:
// a repository-controlled hook must not execute inside the daemon, and the owner's signing key must
// not be asked for a machine-generated transport commit.
describe("workspace plumbing runs with the owner's hooks and signing out of the way", () => {
  it("does not run a repository post-checkout hook while adding a worktree", async () => {
    const repo = await makeThrowawayRepo();
    const hooksDir = join(repo, ".husky");
    await mkdir(hooksDir);
    const hook = join(hooksDir, "post-checkout");
    await writeFile(hook, "#!/bin/sh\necho ran > hook-ran\n");
    await chmod(hook, 0o755);
    const configured = await runGit(["config", "core.hooksPath", ".husky"], { cwd: repo });
    expect(configured.exitCode).toBe(0);
    const parent = await realpath(await mkdtemp(join(tmpdir(), "loomrail-wt-hooks-")));

    const added = await addWorktree({
      topLevel: repo,
      branch: "loomrail/no-hooks",
      path: join(parent, "task"),
      startPoint: "HEAD",
    });

    expect(added.type).toBe("ADDED");
    expect(await pathExists(join(repo, "hook-ran"))).toBe(false);
  });

  it("creates the carry-in commit without the owner's signing configuration and keeps paths verbatim", async () => {
    const repo = await makeThrowawayRepo();
    // A signing setup that cannot possibly work: if commit-tree honoured it, the snapshot would
    // fail with exit code 128 instead of producing a commit.
    await runGit(["config", "commit.gpgsign", "true"], { cwd: repo });
    await runGit(["config", "gpg.program", join(repo, "no-such-gpg")], { cwd: repo });
    await runGit(["config", "user.signingkey", "DEADBEEF"], { cwd: repo });
    const spacedName = "файл с пробелом.txt";
    await writeFile(join(repo, spacedName), "untracked\n");
    const state = await inspectRepository(repo);
    expect(state, "inspectRepository should have found a repository").not.toBeNull();
    if (state === null) throw new Error("unreachable: the assertion above should already have failed");

    const snapshot = await createCarryInSnapshot({
      topLevel: state.topLevel,
      headCommit: state.headCommit,
      message: "Loomrail carry-in",
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(snapshot?.carriedPaths).toEqual([spacedName]);
  });
});
