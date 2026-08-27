import { describe, expect, it } from "vitest";

import { GitMissingError, runGit } from "../src/index.js";

import { makeThrowawayRepo } from "./helpers.js";

describe("runGit", () => {
  it("hands a failing git command back as a result, not as a throw", async () => {
    const repo = await makeThrowawayRepo();

    const result = await runGit(["rev-parse", "--verify", "refs/heads/nope"], { cwd: repo });

    expect(result.exitCode).toBe(128);
    expect(result.stdout).toBe("");
  });

  it("says git is missing rather than failing as if the command did", async () => {
    const repo = await makeThrowawayRepo();

    await expect(runGit(["--version"], { cwd: repo, env: { PATH: "/nonexistent" } })).rejects.toBeInstanceOf(
      GitMissingError,
    );
  });
});
