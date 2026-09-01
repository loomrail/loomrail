import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { assessProjectReadiness } from "../src/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const git = async (repositoryPath: string, args: readonly string[]): Promise<void> => {
  await execFileAsync("git", [...args], { cwd: repositoryPath });
};

const createRepository = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `loomrail-readiness-${name}-`));
  roots.push(root);
  await git(root, ["init", "--quiet", "-b", "main"]);
  await git(root, ["config", "user.name", "Loomrail test"]);
  await git(root, ["config", "user.email", "test@loomrail.local"]);
  return root;
};

const commitAll = async (repositoryPath: string): Promise<void> => {
  await git(repositoryPath, ["add", "-A"]);
  await git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("project readiness scanner", () => {
  it("passes bounded automated checks without executing a discovered package script", async () => {
    const repositoryPath = await createRepository("clean path-кириллица");
    const marker = join(repositoryPath, "must-not-exist");
    await mkdir(join(repositoryPath, ".github", "workflows"), { recursive: true });
    await writeFile(join(repositoryPath, ".gitignore"), ".env*\n.npmrc\n");
    await writeFile(join(repositoryPath, "LICENSE"), "test license\n");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ scripts: { security: `touch ${JSON.stringify(marker)}` } }),
    );
    await writeFile(
      join(repositoryPath, ".github", "workflows", "ci.yml"),
      `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n`,
    );
    await commitAll(repositoryPath);

    const assessment = await assessProjectReadiness(repositoryPath, { activeConstitution: true });

    expect(assessment.repositoryHead).toMatch(/^[0-9a-f]{40}$/);
    expect(assessment.workingTreeDirty).toBe(false);
    expect(assessment.checks).toHaveLength(8);
    expect(assessment.checks.filter((check) => check.mode === "AUTOMATED")).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "PASSED" })]),
    );
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("reports path-only secret and CI findings without retaining a secret value", async () => {
    const repositoryPath = await createRepository("findings");
    const canary = "super-secret-canary-must-never-escape";
    await mkdir(join(repositoryPath, ".github", "workflows"), { recursive: true });
    await writeFile(join(repositoryPath, ".env.production"), canary);
    await writeFile(
      join(repositoryPath, ".github", "workflows", "danger.yml"),
      "on:\n  pull_request_target:\npermissions: write-all\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@v4\n",
    );
    await git(repositoryPath, ["add", "-f", ".env.production", ".github/workflows/danger.yml"]);
    await git(repositoryPath, ["commit", "--quiet", "-m", "unsafe fixture"]);

    const assessment = await assessProjectReadiness(repositoryPath, { activeConstitution: false });
    const serialized = JSON.stringify(assessment);

    expect(serialized).not.toContain(canary);
    expect(serialized).toContain(".env.production");
    expect(serialized).toContain("CI_PULL_REQUEST_TARGET");
    expect(serialized).toContain("CI_WRITE_ALL_PERMISSIONS");
    expect(serialized).toContain("CI_ACTION_NOT_PINNED");
    expect(assessment.checks.every((check) => check.status === "ACTION_REQUIRED")).toBe(true);
  });

  it("fails closed for a symlinked workflow and a non-top-level path", async () => {
    const repositoryPath = await createRepository("symlink");
    const outside = join(repositoryPath, "outside.yml");
    await writeFile(outside, "on: push\n");
    await mkdir(join(repositoryPath, ".github", "workflows"), { recursive: true });
    await symlink(outside, join(repositoryPath, ".github", "workflows", "linked.yml"));
    await mkdir(join(repositoryPath, "nested"));
    await commitAll(repositoryPath);

    const assessment = await assessProjectReadiness(repositoryPath, { activeConstitution: true });
    expect(JSON.stringify(assessment)).toContain("CI_INPUT_UNVERIFIABLE");
    await expect(
      assessProjectReadiness(join(repositoryPath, "nested"), { activeConstitution: true }),
    ).rejects.toMatchObject({ code: "REPOSITORY_UNAVAILABLE" });
  });
});
