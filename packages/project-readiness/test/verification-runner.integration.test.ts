import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { VerificationRecipe } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { executeVerificationRecipe, verificationBaselineEnvironment } from "../src/index.js";

const execFileAsync = promisify(execFile);

const recipe = (script: string): VerificationRecipe => ({
  schemaVersion: 1,
  id: "package-test",
  kind: "UNIT",
  label: "Tests",
  required: true,
  executable: "node",
  argv: ["-e", script],
  cwd: ".",
  timeoutSeconds: 2,
  outputLimitBytes: 4_096,
  environmentProfile: "VERIFICATION_BASELINE",
  networkPolicy: "INHERIT_HOST",
  provenance: {
    source: "PACKAGE_JSON_SCRIPT",
    manifestPath: "package.json",
    manifestContentHash: "a".repeat(64),
    scriptName: "test",
    scriptBodyPreview: "node fixture",
  },
});

describe("verification recipe runner", () => {
  const roots: string[] = [];

  const makeRepo = async (): Promise<{ artifacts: string; repositoryPath: string }> => {
    const root = await mkdtemp(join(tmpdir(), "loomrail verification runner "));
    roots.push(root);
    const repositoryPath = join(root, "worktree with spaces-ёж");
    const artifacts = join(root, "artifacts");
    await execFileAsync("git", ["init", repositoryPath]);
    await execFileAsync("git", ["config", "user.email", "loomrail@example.invalid"], {
      cwd: repositoryPath,
    });
    await execFileAsync("git", ["config", "user.name", "Loomrail Test"], { cwd: repositoryPath });
    await writeFile(join(repositoryPath, "tracked.txt"), "original\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repositoryPath });
    return { artifacts, repositoryPath };
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("runs one exact command with scrubbed environment and writes redacted output outside the repo", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const secret = "verification-secret-canary";
    const ownerHome = "/private/loomrail-fixture-home";
    const result = await executeVerificationRecipe({
      recipe: recipe(
        'process.stdout.write(`${process.env.SECRET_TOKEN ?? "absent"}|${process.env.HOME ?? "missing"}`)',
      ),
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-1",
      systemEnvironment: {
        PATH: process.env["PATH"] ?? "",
        HOME: ownerHome,
        SECRET_TOKEN: secret,
      },
    });

    expect(result.observation.status).toBe("PASSED");
    expect(result.beforeTree).toBe(result.afterTree);
    expect(result.artifactPath).not.toBeNull();
    if (result.artifactPath === null) throw new Error("Passing output artifact is missing");
    const output = await readFile(result.artifactPath, "utf8");
    expect(output).toContain("absent");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(ownerHome);
    expect(result.observation.output?.available).toBe(true);
  });

  it("records a real non-zero exit as FAILED", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const result = await executeVerificationRecipe({
      recipe: recipe('process.stderr.write("intentional failure"); process.exit(7)'),
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-failed",
    });

    expect(result.observation).toMatchObject({ status: "FAILED", exitCode: 7, signal: null });
  });

  it("turns a tracked tree mutation into typed ERROR even when the process exits zero", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const result = await executeVerificationRecipe({
      recipe: recipe('require("node:fs").writeFileSync("tracked.txt", "changed\\n")'),
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-mutated",
    });

    expect(result.beforeTree).not.toBe(result.afterTree);
    expect(result.observation).toMatchObject({ status: "ERROR", errorCode: "TREE_MUTATED" });
  });

  it("refuses denied-network and escaping cwd policies before spawn", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const marker = join(repositoryPath, "must-not-exist");
    const denied = await executeVerificationRecipe({
      recipe: {
        ...recipe(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`),
        networkPolicy: "DENIED_UNAVAILABLE",
      },
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-denied",
    });

    expect(denied.observation).toMatchObject({ status: "ERROR", errorCode: "POLICY_UNAVAILABLE" });
    await expect(access(marker)).rejects.toThrow();

    const outside = join(repositoryPath, "..", "outside");
    await mkdir(outside);
    await symlink(
      outside,
      join(repositoryPath, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const escaped = await executeVerificationRecipe({
      recipe: { ...recipe("process.exit(0)"), cwd: "escaped" },
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-escaped",
    });
    expect(escaped.observation).toMatchObject({ status: "ERROR", errorCode: "CWD_INVALID" });
  });

  it("refuses an artifact directory inside the worktree before running the command", async () => {
    const { repositoryPath } = await makeRepo();
    const artifactDirectory = join(repositoryPath, "must-not-create", "artifacts");
    const marker = join(repositoryPath, "must-not-run");
    const result = await executeVerificationRecipe({
      recipe: recipe(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`),
      worktreePath: repositoryPath,
      artifactDirectory,
      artifactId: "verification-output-inside-worktree",
    });

    expect(result.observation).toMatchObject({ status: "ERROR", errorCode: "OUTPUT_WRITE_FAILED" });
    await expect(access(marker)).rejects.toThrow();
    await expect(access(artifactDirectory)).rejects.toThrow();
  });

  it("refuses a stale reserved tree before running the command", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const marker = join(repositoryPath, "must-not-run-stale-tree");
    const result = await executeVerificationRecipe({
      recipe: recipe(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`),
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-stale-tree",
      expectedTree: "f".repeat(40),
    });

    expect(result.observation).toMatchObject({ status: "ERROR", errorCode: "TREE_MUTATED" });
    await expect(access(marker)).rejects.toThrow();
  });

  it("builds identical minimal baseline intent for POSIX and Windows without owner secrets", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/owner/home",
      USERPROFILE: "C:\\Users\\owner",
      SystemRoot: "C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SECRET_TOKEN: "do-not-inherit",
    };
    const posix = verificationBaselineEnvironment({
      platform: "darwin",
      isolatedHome: "/private/isolated",
      source,
    });
    const windows = verificationBaselineEnvironment({
      platform: "win32",
      isolatedHome: "C:\\isolated",
      source,
    });

    expect(posix).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/private/isolated",
      CI: "1",
      NO_COLOR: "1",
      LOOMRAIL_VERIFICATION: "1",
    });
    expect(windows).toMatchObject({
      PATH: "/usr/bin",
      HOME: "C:\\isolated",
      USERPROFILE: "C:\\isolated",
      SystemRoot: "C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    expect(JSON.stringify({ posix, windows })).not.toContain("do-not-inherit");
    expect(JSON.stringify({ posix, windows })).not.toContain("/owner/home");
    expect(JSON.stringify({ posix, windows })).not.toContain("Users\\owner");
  });
});
