import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitInputError, GitMissingError, runGit } from "../src/index.js";

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

  it("drains large output while retaining only the configured byte prefix", async () => {
    const repo = await makeThrowawayRepo();
    const content = `${"x".repeat(128 * 1_024)}\n`;
    await writeFile(join(repo, "large.txt"), content, "utf8");
    expect((await runGit(["add", "large.txt"], { cwd: repo })).exitCode).toBe(0);
    expect(
      (
        await runGit(
          [
            "-c",
            "user.email=loomrail-test@example.com",
            "-c",
            "user.name=Loomrail Test",
            "commit",
            "--quiet",
            "-m",
            "large",
          ],
          { cwd: repo },
        )
      ).exitCode,
    ).toBe(0);

    const result = await runGit(["show", "--format=", "HEAD:large.txt"], {
      cwd: repo,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 128,
    });

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1_024);
    expect(result.stdoutBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrBytes).toBe(0);
    expect(result.stderrTruncated).toBe(false);
  });

  it("rejects invalid capture limits with a typed input error", async () => {
    const repo = await makeThrowawayRepo();

    await expect(runGit(["--version"], { cwd: repo, maxStdoutBytes: -1 })).rejects.toBeInstanceOf(
      GitInputError,
    );
  });
});
