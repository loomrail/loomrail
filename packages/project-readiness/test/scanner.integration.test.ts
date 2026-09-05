import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { assessProjectReadiness } from "../src/index.js";
import {
  inlineSecretFindings,
  launchOwnerChecks,
  lockfileFindings,
  prodEnvFindings,
} from "../src/scanner.js";

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
    expect(assessment.checks).toHaveLength(14);
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
    await writeFile(join(repositoryPath, "package.json"), JSON.stringify({ name: "unsafe-fixture" }));
    await writeFile(
      join(repositoryPath, ".github", "workflows", "danger.yml"),
      "on:\n  pull_request_target:\npermissions: write-all\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@v4\n",
    );
    await git(repositoryPath, [
      "add",
      "-f",
      ".env.production",
      "package.json",
      ".github/workflows/danger.yml",
    ]);
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

  it("marks ENV_PROD_SEPARATION action-required when CI workflows are unverifiable", async () => {
    const repositoryPath = await createRepository("env-ci-unverifiable");
    const outside = join(repositoryPath, "outside.yml");
    await writeFile(outside, "on: push\n");
    await mkdir(join(repositoryPath, ".github", "workflows"), { recursive: true });
    await symlink(outside, join(repositoryPath, ".github", "workflows", "linked.yml"));
    await commitAll(repositoryPath);

    const assessment = await assessProjectReadiness(repositoryPath, { activeConstitution: true });

    const envProdSeparation = assessment.checks.find((check) => check.key === "ENV_PROD_SEPARATION");
    expect(envProdSeparation?.status).toBe("ACTION_REQUIRED");
    expect(envProdSeparation?.findings).toEqual([expect.objectContaining({ code: "CI_INPUT_UNVERIFIABLE" })]);
  });
});

describe("production environment separation", () => {
  it("passes when no production env file exists", () => {
    expect(prodEnvFindings([{ path: ".env.production", exists: false, ignored: false }])).toEqual([]);
  });

  it("reports an existing production env file that is not ignored", () => {
    const findings = prodEnvFindings([{ path: ".env.production", exists: true, ignored: false }]);
    expect(findings).toEqual([
      expect.objectContaining({ code: "PROD_ENV_NOT_IGNORED", severity: "HIGH", path: ".env.production" }),
    ]);
  });

  it("reports an existing production env file whose ignore state is unknown", () => {
    const findings = prodEnvFindings([{ path: ".env.production", exists: true, ignored: null }]);
    expect(findings.map((entry) => entry.code)).toEqual(["PROD_ENV_NOT_IGNORED"]);
  });

  it("passes an existing production env file that is ignored", () => {
    expect(prodEnvFindings([{ path: ".env.production", exists: true, ignored: true }])).toEqual([]);
  });

  it("passes a workflow that references managed secrets", () => {
    const files = [
      {
        path: ".github/workflows/ci.yml",
        content: "env:\n  API_TOKEN: ${{ secrets.API_TOKEN }}\n  DB_PASSWORD: $DB_PASSWORD\n",
      },
    ];
    expect(inlineSecretFindings(files)).toEqual([]);
  });

  it("reports one finding per workflow that assigns a literal secret value", () => {
    const files = [
      {
        path: ".github/workflows/deploy.yml",
        content: 'env:\n  DEPLOY_TOKEN: "kx7Qm2ZpLr9TvWs4"\n  OTHER_SECRET: aVeryLongLiteralValue\n',
      },
    ];
    const findings = inlineSecretFindings(files);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "INLINE_SECRET_IN_CI",
      severity: "CRITICAL",
      path: ".github/workflows/deploy.yml",
    });
  });

  it("never repeats the observed value in the message", () => {
    const files = [
      { path: ".github/workflows/deploy.yml", content: 'env:\n  DEPLOY_TOKEN: "kx7Qm2ZpLr9TvWs4"\n' },
    ];
    expect(inlineSecretFindings(files)[0]?.message).not.toContain("kx7Qm2ZpLr9TvWs4");
  });

  it("ignores a short placeholder and a variable without a secret-shaped name", () => {
    const files = [
      { path: ".github/workflows/ci.yml", content: "env:\n  API_TOKEN: todo\n  NODE_VERSION: 24.19.0\n" },
    ];
    expect(inlineSecretFindings(files)).toEqual([]);
  });
});

describe("lockfile findings", () => {
  it("passes a repository without a tracked manifest", () => {
    expect(lockfileFindings(["README.md", "src/index.ts"])).toEqual([]);
  });

  it("passes a manifest with exactly one lockfile", () => {
    expect(lockfileFindings(["package.json", "pnpm-lock.yaml"])).toEqual([]);
  });

  it("reports a manifest without any lockfile", () => {
    const findings = lockfileFindings(["package.json"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: "LOCKFILE_MISSING", severity: "HIGH", path: "package.json" });
  });

  it("reports every lockfile when more than one package manager is tracked", () => {
    const findings = lockfileFindings(["package.json", "pnpm-lock.yaml", "package-lock.json"]);
    expect(findings.map((entry) => entry.code)).toEqual(["LOCKFILE_AMBIGUOUS", "LOCKFILE_AMBIGUOUS"]);
  });

  it("ignores a lockfile that is not at the repository root", () => {
    const findings = lockfileFindings(["package.json", "packages/api/pnpm-lock.yaml"]);
    expect(findings.map((entry) => entry.code)).toEqual(["LOCKFILE_MISSING"]);
  });

  it("reports unverifiable inputs instead of guessing", () => {
    const findings = lockfileFindings(null);
    expect(findings).toEqual([
      expect.objectContaining({ code: "DEPENDENCY_INPUT_UNVERIFIABLE", severity: "HIGH", path: null }),
    ]);
  });
});

describe("launch owner checks", () => {
  it("starts every launch owner check unresolved and without findings", () => {
    for (const draft of launchOwnerChecks()) {
      expect(draft.mode).toBe("OWNER");
      expect(draft.status).toBe("ACTION_REQUIRED");
      expect(draft.findings).toEqual([]);
      expect(draft.summary.length).toBeGreaterThan(0);
    }
    expect(launchOwnerChecks().map((draft) => draft.key)).toEqual([
      "SECURITY_HEADERS_OWNER_REVIEW",
      "OPS_HEALTH_ENDPOINT_DECLARED",
      "OPS_ROLLBACK_PLAN",
      "OPS_BACKUP",
    ]);
  });
});
