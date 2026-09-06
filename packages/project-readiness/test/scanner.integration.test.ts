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

  // ENV_PROD_SEPARATION is AUTOMATED, and the domain refuses to attest a non-OWNER check. A false
  // positive here is therefore a permanent block on READY that the owner cannot clear, so every
  // correct line that once tripped the heuristic stays pinned as its own case.
  it.each([
    ["a managed reference followed by a comment", "API_TOKEN: ${{ secrets.API_TOKEN }} # rotated 2026-01"],
    ["a managed reference with a path suffix", "GOOGLE_APPLICATION_CREDENTIALS: ${{ runner.temp }}/gcp.json"],
    ["an absolute path to a credentials file", "GOOGLE_APPLICATION_CREDENTIALS: /tmp/gcp-key.json"],
    ["a name that denotes a reference", "SECRET_NAME: my-app-prod-secret"],
    ["a URL", "TOKEN_URL: https://auth.example.com/token"],
    ["a whole-value shell reference", "DB_PASSWORD: $DB_PASSWORD"],
    ["a path to a mounted secret file", "PASSWORD_FILE: /run/secrets/db_password"],
    ["a shell reference used as a path prefix", "GOOGLE_APPLICATION_CREDENTIALS: $RUNNER_TEMP/gcp.json"],
    ["a shell reference prefixing a home-relative path", "SSH_PRIVATE_KEY_PATH: $HOME/.ssh/id_rsa"],
    [
      "a shell reference prefixing a workspace-relative path",
      "GOOGLE_APPLICATION_CREDENTIALS: $GITHUB_WORKSPACE/creds.json",
    ],
    ["a home-relative path", "SSH_PRIVATE_KEY_PATH: ~/.ssh/deploy_key"],
    ["a home-relative config file", "DOCKER_PASSWORD_FILE: ~/.docker/config.json"],
    ["an explicitly relative path", "GOOGLE_APPLICATION_CREDENTIALS: ./gcp-key.json"],
    ["a secret-store path under a location name", "VAULT_SECRET_PATH: secret/data/ci/deploy"],
    [
      "a secret-manager resource name under a location name",
      "SECRET_PATH: projects/1234/secrets/db/versions/latest",
    ],
    ["a root-level file under a location name", "PASSWORD_FILE: /gcp-key.json"],
    ["a non-http bucket URL under a location name", "CREDENTIALS_URL: gs://my-bucket/creds.json"],
    [
      "a bucket URL whose path, not its authority, carries an at-sign",
      "CREDENTIALS_URL: gs://my-bucket/creds@2026.json",
    ],
    ["a Git remote whose userinfo is a bare username", "TOKEN_URL: ssh://git@github.com/org/repo.git"],
    ["a bare filename under a location name", "CREDENTIALS_FILE: credentials.json"],
    ["a schemeless URL under a location name", "TOKEN_URL: auth.example.com/token"],
    ["a Windows-style path under a location name", "SSH_PRIVATE_KEY_PATH: C:\\Users\\runneradmin\\id_rsa"],
  ])("passes %s", (_description, line) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files)).toEqual([]);
  });

  // `secrets: inherit` is seven characters and the length bound alone would pass it, so it pins
  // nothing about the workflow-keyword rule. The rule's reachable case is the same key read as an
  // action input, where the value is a list of store paths well over the bound.
  it.each([
    ["the reusable-workflow keyword, which the length bound alone would also pass", "secrets: inherit"],
    [
      "the same keyword carrying an action input, which only the keyword rule passes",
      "secrets: secret/data/ci/aws accessKey | AWS_ACCESS_KEY_ID",
    ],
  ])("passes %s", (_description, line) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `    with:\n      ${line}\n` }];
    expect(inlineSecretFindings(files)).toEqual([]);
  });

  // The rules that keep the cases above clean each have a narrower form that costs no false
  // positive. Without these counter-examples pinned, the broader form reads as equally correct and
  // the check silently stops reporting credentials it should catch. The last two rows are the set's
  // one exception, and they are false positives: the `_URL` userinfo rule searches for
  // `user:password` past any `/`, because `openssl rand -base64` puts a `/` in roughly every other
  // password it generates, and the price is that a `_URL` value carrying a `:` and a later `@` is
  // reported too. They are pinned so that cost stays visible and priced, not so it stays unexamined.
  it.each([
    ["a base64 literal that happens to start with a slash", "AWS_SECRET_ACCESS_KEY: /JalrXUtnFEMIK7MDENGb"],
    ["a literal that happens to start with a dollar", "DB_PASSWORD: $tr0ngP@ssw0rd!"],
    ["a literal under a name that merely sounds like a location", "API_TOKEN_FILE: ghp_16C7e42F292c6912E77"],
    ["a connection string carrying userinfo under a location name", "TOKEN_URL: postgres://u:secret@db/app"],
    [
      "a connection string whose password carries a slash",
      "POSTGRES_PASSWORD_URL: postgres://app:aB3/xYz9pQ@db:5432/app",
    ],
    [
      "a connection string with an empty username and a slash in the password",
      "PASSWORD_URL: redis://:hun/ter2@cache:6379/0",
    ],
    ["a literal under a variable named like the workflow keyword", "SECRETS: kx7Qm2ZpLr9TvWs4"],
    [
      "the accepted false positive: a bucket URL whose port supplies a colon before a path at-sign",
      "CREDENTIALS_URL: gs://my-bucket:8080/creds@2026.json",
    ],
    [
      "the accepted false positive: a bucket URL whose path carries both a colon and a later at-sign",
      "CREDENTIALS_URL: gs://my-bucket/2026:07/creds@2026.json",
    ],
  ])("reports %s", (_description, line) => {
    const files = [{ path: ".github/workflows/deploy.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(["INLINE_SECRET_IN_CI"]);
  });

  // No exclusion comes close to these two: both are reported by every version of the heuristic so
  // far. They are here as standing guards against a future broadening -- un-anchoring the location
  // pattern would excuse the first, and a generic `scheme://` exclusion would excuse the second
  // along with every other credential-bearing connection string.
  it.each([
    ["a literal that carries a slash part-way through", "AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI/K7MDENG/b"],
    ["a connection string that embeds its password", "DB_PASSWORD: postgres://u:secret@db/app"],
  ])("reports %s", (_description, line) => {
    const files = [{ path: ".github/workflows/deploy.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(["INLINE_SECRET_IN_CI"]);
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
