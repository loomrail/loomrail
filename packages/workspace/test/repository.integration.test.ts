import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectRepository, runGit } from "../src/index.js";

import { makeRepoMidRebase, makeThrowawayRepo } from "./helpers.js";

describe("inspectRepository", () => {
  it("reports the commit a fresh worktree would be cut from", async () => {
    const repo = await makeThrowawayRepo();

    const state = await inspectRepository(repo);

    expect(state?.topLevel).toBe(await realpath(repo));
    expect(state?.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(state?.inProgress).toBeNull();
  });

  it("says a repository with no commits has no head, rather than failing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "loomrail-empty-"));
    await runGit(["init"], { cwd: repo });

    const state = await inspectRepository(repo);

    expect(state).not.toBeNull();
    expect(state?.headCommit).toBeNull();
  });

  it("refuses to call a rebase's scratch commit a base", async () => {
    const repo = await makeRepoMidRebase();

    const state = await inspectRepository(repo);

    expect(state?.inProgress).toBe("REBASE");
  });

  it("reports null for a path that is not a git repository at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loomrail-notrepo-"));

    const state = await inspectRepository(dir);

    expect(state).toBeNull();
  });
});
