import { describe, expect, it } from "vitest";

import {
  createCarryInSnapshot,
  inspectRepository,
  runGit,
  type CarryInSnapshot,
  type RepositoryState,
} from "../src/index.js";

import {
  makeEmptyRepoWithUntrackedFile,
  makeRepoWithEveryKindOfChange,
  makeThrowawayRepo,
} from "./helpers.js";

// inspectRepository and createCarryInSnapshot both return `null` for cases that do not apply to
// these tests (a path that is not a repository at all; nothing left to carry). Narrowing that away
// with a real check -- rather than a non-null assertion -- keeps each test honest about what it is
// assuming.
const requireRepositoryState = (state: RepositoryState | null): RepositoryState => {
  if (state === null) {
    throw new Error("expected inspectRepository to find a repository");
  }
  return state;
};

const requireSnapshot = (snapshot: CarryInSnapshot | null): CarryInSnapshot => {
  if (snapshot === null) {
    throw new Error("expected createCarryInSnapshot to produce a snapshot");
  }
  return snapshot;
};

describe("createCarryInSnapshot", () => {
  it("carries the work the owner has not committed, and leaves the ignored files behind", async () => {
    const repo = await makeRepoWithEveryKindOfChange();
    const state = requireRepositoryState(await inspectRepository(repo));

    const snapshot = requireSnapshot(
      await createCarryInSnapshot({
        topLevel: state.topLevel,
        headCommit: state.headCommit,
        message: "loomrail: carry-in",
      }),
    );

    const listed = await runGit(["ls-tree", "-r", "--name-only", snapshot.commit], { cwd: repo });
    const paths = listed.stdout.trim().split("\n");

    expect(paths).toContain("tracked-modified.txt");
    expect(paths).toContain("staged.txt");
    expect(paths).toContain("untracked-new.txt");
    expect(paths).toContain("subdir/untracked-nested.txt");
    expect(paths).not.toContain("build/artifact.txt");
    expect(paths).not.toContain("deleted.txt");
  });

  it("leaves the owner's own working copy byte for byte as it was", async () => {
    const repo = await makeRepoWithEveryKindOfChange();
    const state = requireRepositoryState(await inspectRepository(repo));
    const before = await runGit(["status", "--porcelain"], { cwd: repo });

    await createCarryInSnapshot({
      topLevel: state.topLevel,
      headCommit: state.headCommit,
      message: "loomrail: carry-in",
    });

    const after = await runGit(["status", "--porcelain"], { cwd: repo });
    expect(after.stdout).toBe(before.stdout);

    const stash = await runGit(["rev-parse", "--verify", "refs/stash"], { cwd: repo });
    expect(stash.exitCode).not.toBe(0);
  });

  it("says there was nothing to carry rather than making an empty commit", async () => {
    const repo = await makeThrowawayRepo();
    const state = requireRepositoryState(await inspectRepository(repo));

    const snapshot = await createCarryInSnapshot({
      topLevel: state.topLevel,
      headCommit: state.headCommit,
      message: "loomrail: carry-in",
    });

    expect(snapshot).toBeNull();
  });

  it("commits a parentless snapshot when the repository has no commits yet", async () => {
    const repo = await makeEmptyRepoWithUntrackedFile();
    const state = requireRepositoryState(await inspectRepository(repo));
    expect(state.headCommit).toBeNull();

    const snapshot = requireSnapshot(
      await createCarryInSnapshot({
        topLevel: state.topLevel,
        headCommit: state.headCommit,
        message: "loomrail: carry-in",
      }),
    );

    const listed = await runGit(["ls-tree", "-r", "--name-only", snapshot.commit], { cwd: repo });
    expect(listed.stdout.trim().split("\n")).toContain("untracked-new.txt");

    const shown = await runGit(["cat-file", "-p", snapshot.commit], { cwd: repo });
    expect(shown.stdout).not.toContain("parent ");
  });
});
