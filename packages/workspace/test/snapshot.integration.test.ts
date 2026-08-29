import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

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
//
// The narrowing is done by an `expect` FIRST, and the throw is only what tells TypeScript the check
// happened -- the same shape worktree.integration.test.ts uses. A bare throw would report the very
// defect these tests exist to catch as a crash with a sentence of our own, instead of as the named
// assertion that says which value was null and where.
const requireRepositoryState = (state: RepositoryState | null): RepositoryState => {
  expect(state, "inspectRepository should have found a repository").not.toBeNull();
  if (state === null) {
    throw new Error("unreachable: the assertion above should already have failed");
  }
  return state;
};

const requireSnapshot = (snapshot: CarryInSnapshot | null): CarryInSnapshot => {
  expect(snapshot, "createCarryInSnapshot should have produced a snapshot").not.toBeNull();
  if (snapshot === null) {
    throw new Error("unreachable: the assertion above should already have failed");
  }
  return snapshot;
};

/**
 * Every file the owner can see in their repository, keyed by its path, with its exact bytes.
 *
 * Base64 rather than text, and every file rather than a chosen few: the promise this suite makes
 * about the owner's working copy is "byte for byte", and a comparison that decodes as UTF-8 or
 * picks its own list of paths cannot keep it. `.git` is excluded because the snapshot is a commit
 * -- it writes objects, and is meant to.
 *
 * `git status --porcelain` used to stand in for this. It cannot: status reports the *codes* ` M`,
 * `A `, `??`, and every one of them stays exactly the same when the file's content is overwritten.
 * A line inserted into `createCarryInSnapshot` that replaced a modified tracked file with
 * "CLOBBERED BY LOOMRAIL\n" left all four tests in this file passing.
 */
const workingCopyBytes = async (repo: string): Promise<Record<string, string>> => {
  const entries = await readdir(repo, { recursive: true, withFileTypes: true });
  const contents: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(repo, absolute);
    if (path === ".git" || path.startsWith(`.git${sep}`)) continue;
    contents[path] = (await readFile(absolute)).toString("base64");
  }
  return contents;
};

describe("createCarryInSnapshot", () => {
  it("does not need the owner's Git identity to create its internal commit", async () => {
    const repo = await makeRepoWithEveryKindOfChange();
    const state = requireRepositoryState(await inspectRepository(repo));

    // Empty repository-local values override any global identity on the machine. The snapshot is
    // Loomrail's internal plumbing commit, so its ability to exist must not depend on who runs it
    // or on whether that person has configured Git at all.
    await runGit(["config", "user.name", ""], { cwd: repo });
    await runGit(["config", "user.email", ""], { cwd: repo });

    const snapshot = requireSnapshot(
      await createCarryInSnapshot({
        topLevel: state.topLevel,
        headCommit: state.headCommit,
        message: "loomrail: carry-in",
      }),
    );

    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);

    const identity = await runGit(["show", "-s", "--format=%an%n%ae%n%cn%n%ce", snapshot.commit], {
      cwd: repo,
    });
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.trim()).toBe(
      ["Loomrail", "loomrail@localhost", "Loomrail", "loomrail@localhost"].join("\n"),
    );
  });

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

  // Acceptance criterion 4 of the spec, and the one the suite used to claim without checking.
  it("leaves the owner's own working copy and index byte for byte as they were", async () => {
    const repo = await makeRepoWithEveryKindOfChange();
    const state = requireRepositoryState(await inspectRepository(repo));

    const bytesBefore = await workingCopyBytes(repo);
    // The index, at content level: `ls-files --stage` prints each entry's mode, blob SHA and stage
    // number, so a staged file whose content changed changes this line even though its status code
    // (`A `) does not. The temporary-index trick is what is meant to keep this identical, and
    // nothing asserted it.
    const indexBefore = await runGit(["ls-files", "--stage"], { cwd: repo });
    const statusBefore = await runGit(["status", "--porcelain"], { cwd: repo });

    // Named literally, so this test cannot pass by comparing two empty maps to each other, and so
    // the modified tracked file's exact bytes are pinned rather than merely "unchanged from
    // whatever they were".
    expect(bytesBefore["tracked-modified.txt"]).toBe(Buffer.from("changed\n").toString("base64"));
    expect(bytesBefore["staged.txt"]).toBe(Buffer.from("staged\n").toString("base64"));
    expect(bytesBefore[join("build", "artifact.txt")]).toBe(Buffer.from("artifact\n").toString("base64"));

    await createCarryInSnapshot({
      topLevel: state.topLevel,
      headCommit: state.headCommit,
      message: "loomrail: carry-in",
    });

    expect(await workingCopyBytes(repo)).toEqual(bytesBefore);
    expect((await runGit(["ls-files", "--stage"], { cwd: repo })).stdout).toBe(indexBefore.stdout);
    // Kept alongside the two above rather than replaced by them: status is the only one of the
    // three that notices a *deletion* staged behind the owner's back, since a removed entry leaves
    // no bytes and no index line to differ.
    expect((await runGit(["status", "--porcelain"], { cwd: repo })).stdout).toBe(statusBefore.stdout);

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
