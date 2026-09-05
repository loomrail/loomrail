import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { VerificationRecipe } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { executeVerificationRecipe, verificationBaselineEnvironment } from "../src/index.js";

const execFileAsync = promisify(execFile);

const installRecipe = async (
  repositoryPath: string,
  source: string,
  executable: "npm" | "pnpm" = "npm",
): Promise<VerificationRecipe> => {
  const script = "node verification-fixture.cjs";
  const manifest = `${JSON.stringify({
    packageManager: `${executable}@1.0.0`,
    scripts: { test: script },
  })}\n`;
  await writeFile(join(repositoryPath, "verification-fixture.cjs"), `${source}\n`);
  await writeFile(join(repositoryPath, "package.json"), manifest);
  await execFileAsync("git", ["add", "package.json", "verification-fixture.cjs"], {
    cwd: repositoryPath,
  });
  await execFileAsync("git", ["commit", "--amend", "--no-edit"], { cwd: repositoryPath });
  return {
    schemaVersion: 1,
    id: "package-test",
    kind: "UNIT",
    label: "Tests",
    required: true,
    executable,
    argv: ["run", "test"],
    cwd: ".",
    timeoutSeconds: 2,
    outputLimitBytes: 4_096,
    environmentProfile: "VERIFICATION_BASELINE",
    networkPolicy: "INHERIT_HOST",
    provenance: {
      source: "PACKAGE_JSON_SCRIPT",
      manifestPath: "package.json",
      manifestContentHash: createHash("sha256").update(manifest).digest("hex"),
      scriptName: "test",
      scriptBodyPreview: script,
    },
  };
};

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
    const approvedRecipe = await installRecipe(
      repositoryPath,
      'process.stdout.write(`${process.env.SECRET_TOKEN ?? "absent"}|${process.env.HOME ?? "missing"}`);',
    );
    const result = await executeVerificationRecipe({
      recipe: approvedRecipe,
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
    const approvedRecipe = await installRecipe(
      repositoryPath,
      'process.stderr.write("intentional failure"); process.exit(7);',
    );
    const result = await executeVerificationRecipe({
      recipe: approvedRecipe,
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-failed",
    });

    expect(result.observation).toMatchObject({ status: "FAILED", exitCode: 7, signal: null });
  });

  it("turns a tracked tree mutation into typed ERROR even when the process exits zero", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const approvedRecipe = await installRecipe(
      repositoryPath,
      'require("node:fs").writeFileSync("tracked.txt", "changed\\n");',
    );
    const result = await executeVerificationRecipe({
      recipe: approvedRecipe,
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
    const approvedRecipe = await installRecipe(
      repositoryPath,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`,
    );
    const denied = await executeVerificationRecipe({
      recipe: { ...approvedRecipe, networkPolicy: "DENIED_UNAVAILABLE" },
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
      recipe: { ...approvedRecipe, cwd: "escaped" },
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
    const approvedRecipe = await installRecipe(
      repositoryPath,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`,
    );
    const result = await executeVerificationRecipe({
      recipe: approvedRecipe,
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
    const approvedRecipe = await installRecipe(
      repositoryPath,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`,
    );
    const result = await executeVerificationRecipe({
      recipe: approvedRecipe,
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-stale-tree",
      expectedTree: "f".repeat(40),
    });

    expect(result.observation).toMatchObject({ status: "ERROR", errorCode: "TREE_MUTATED" });
    await expect(access(marker)).rejects.toThrow();
  });

  it("refuses a changed manifest, hidden lifecycle hooks, and executable argv outside the preview", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const marker = join(repositoryPath, "must-not-run-unapproved");
    const approvedRecipe = await installRecipe(
      repositoryPath,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");`,
    );

    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({
        packageManager: "npm@1.0.0",
        scripts: { pretest: "node hidden.js", test: approvedRecipe.provenance.scriptBodyPreview },
      }),
    );
    const changed = await executeVerificationRecipe({
      recipe: approvedRecipe,
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-changed-manifest",
    });
    expect(changed.observation).toMatchObject({ status: "ERROR", errorCode: "RECIPE_NOT_APPROVED" });

    const currentRecipe = await installRecipe(repositoryPath, "process.exit(0);");
    const arbitrary = await executeVerificationRecipe({
      recipe: { ...currentRecipe, executable: "node", argv: ["-e", "process.exit(0)"] },
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-arbitrary-command",
    });
    expect(arbitrary.observation).toMatchObject({ status: "ERROR", errorCode: "RECIPE_NOT_APPROVED" });
    await expect(access(marker)).rejects.toThrow();
  });

  it("runs an exactly approved node argv from a relative package directory", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const packageDirectory = join(repositoryPath, "packages", "app with spaces-ёж");
    const script = "node verification-fixture.cjs";
    const manifest = `${JSON.stringify({ scripts: { test: script } })}\n`;
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), manifest);
    await writeFile(
      join(packageDirectory, "verification-fixture.cjs"),
      'process.stdout.write("relative-ok");\n',
    );
    await execFileAsync("git", ["add", "packages"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--amend", "--no-edit"], { cwd: repositoryPath });
    const recipe: VerificationRecipe = {
      schemaVersion: 1,
      id: "package-test-relative-node",
      kind: "UNIT",
      label: "Relative node test",
      required: true,
      executable: "node",
      argv: ["verification-fixture.cjs"],
      cwd: "packages/app with spaces-ёж",
      timeoutSeconds: 2,
      outputLimitBytes: 4_096,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: createHash("sha256").update(manifest).digest("hex"),
        scriptName: "test",
        scriptBodyPreview: script,
      },
    };

    const result = await executeVerificationRecipe({
      recipe,
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-relative-node",
    });

    expect(result.observation.status).toBe("PASSED");
    if (result.artifactPath === null) throw new Error("Relative node output artifact is missing");
    await expect(readFile(result.artifactPath, "utf8")).resolves.toContain("relative-ok");
  });

  it.skipIf(process.platform === "win32")(
    "does not resolve a repository launcher through a relative PATH entry",
    async () => {
      const { artifacts, repositoryPath } = await makeRepo();
      const marker = join(repositoryPath, "path-injection-marker");
      const approvedRecipe = await installRecipe(repositoryPath, "process.exit(0);", "pnpm");
      const forgedLauncher = join(repositoryPath, "pnpm");
      await writeFile(
        forgedLauncher,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad");\n`,
      );
      await chmod(forgedLauncher, 0o700);

      await executeVerificationRecipe({
        recipe: approvedRecipe,
        worktreePath: repositoryPath,
        artifactDirectory: artifacts,
        artifactId: "verification-output-relative-path",
        systemEnvironment: { PATH: "." },
      });

      await expect(access(marker)).rejects.toThrow();
    },
  );

  it("resolves a Windows package-manager shim to its trusted JavaScript launcher", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const approvedRecipe = await installRecipe(repositoryPath, "process.exit(0);", "pnpm");
    const tools = join(artifacts, "windows-tools");
    const launcher = join(tools, "node_modules", "corepack", "dist", "pnpm.js");
    await mkdir(join(tools, "node_modules", "corepack", "dist"), { recursive: true });
    await writeFile(join(tools, "pnpm.cmd"), "@echo off\r\n");
    await writeFile(launcher, 'process.stdout.write(process.argv.slice(2).join("|"));\n');

    const result = await executeVerificationRecipe({
      recipe: approvedRecipe,
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-windows-pnpm",
      platform: "win32",
      systemEnvironment: {
        PATH: tools,
        SystemRoot: "C:\\Windows",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
    });

    expect(result.observation.status).toBe("PASSED");
    if (result.artifactPath === null) throw new Error("Windows launcher output artifact is missing");
    await expect(readFile(result.artifactPath, "utf8")).resolves.toContain("run|test");
  });

  it("recognizes a standalone Windows pnpm executable", async () => {
    const { artifacts, repositoryPath } = await makeRepo();
    const approvedRecipe = {
      ...(await installRecipe(repositoryPath, "process.exit(0);", "pnpm")),
      timeoutSeconds: 10,
    } satisfies VerificationRecipe;
    const tools = join(artifacts, "windows-standalone-tools");
    await mkdir(tools, { recursive: true });
    await link(process.execPath, join(tools, "pnpm.exe")).catch(async () => {
      await copyFile(process.execPath, join(tools, "pnpm.exe"));
    });
    await chmod(join(tools, "pnpm.exe"), 0o700);

    const result = await executeVerificationRecipe({
      recipe: approvedRecipe,
      worktreePath: repositoryPath,
      artifactDirectory: artifacts,
      artifactId: "verification-output-windows-standalone-pnpm",
      platform: "win32",
      systemEnvironment: {
        PATH: tools,
        SystemRoot: "C:\\Windows",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
    });

    expect(result.observation).toMatchObject({ status: "FAILED", exitCode: 1 });
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
      runtimePath: ["/runtime/bin", "/usr/bin"],
      source,
    });
    const windows = verificationBaselineEnvironment({
      platform: "win32",
      isolatedHome: "C:\\isolated",
      runtimePath: ["C:\\runtime", "C:\\Windows\\System32"],
      source,
    });

    expect(posix).toMatchObject({
      PATH: "/runtime/bin:/usr/bin",
      HOME: "/private/isolated",
      CI: "1",
      NO_COLOR: "1",
      LOOMRAIL_VERIFICATION: "1",
    });
    expect(windows).toMatchObject({
      PATH: "C:\\runtime;C:\\Windows\\System32",
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
