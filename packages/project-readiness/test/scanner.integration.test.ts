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
    ["a schemeless authority with no userinfo under a location name", "TOKEN_URL: //auth.example.com/token"],
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
    [
      "a connection string carrying userinfo under a location name",
      "TOKEN_URL: postgres://u:secret@db.example.com/app",
    ],
    [
      "a connection string whose password carries a slash",
      "POSTGRES_PASSWORD_URL: postgres://app:aB3/xYz9pQ@db.example.com:5432/app",
    ],
    [
      "a connection string with an empty username and a slash in the password",
      "PASSWORD_URL: redis://:hun/ter2@cache.example.com:6379/0",
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
    ["a connection string that embeds its password", "DB_PASSWORD: postgres://u:secret@db.example.com/app"],
  ])("reports %s", (_description, line) => {
    const files = [{ path: ".github/workflows/deploy.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(["INLINE_SECRET_IN_CI"]);
  });

  // A hyphen is the ordinary separator in an action input, so the name reader admits one. Every
  // suffix rule has to admit it too, or the two spellings of the same name disagree: the underscore
  // spelling keeps its excuse while the hyphen spelling is reported, on identical values. Each rule
  // is pinned in both spellings over a value that only that rule excuses.
  it.each([
    ["_NAME", "SECRET_NAME: my-app-prod-secret"],
    ["-NAME", "secret-name: my-app-prod-secret"],
    ["_FILE", "CREDENTIALS_FILE: kx7Qm2ZpLr9TvWs4.pem"],
    ["-file", "credentials-file: kx7Qm2ZpLr9TvWs4.pem"],
    ["_PATH", "CREDENTIALS_PATH: kx7Qm2ZpLr9TvWs4.pem"],
    ["-path", "credentials-path: kx7Qm2ZpLr9TvWs4.pem"],
    ["_DIR", "CREDENTIALS_DIR: kx7Qm2ZpLr9TvWs4.pem"],
    ["-dir", "credentials-dir: kx7Qm2ZpLr9TvWs4.pem"],
    ["_URL", "CREDENTIALS_URL: kx7Qm2ZpLr9TvWs4.pem"],
    ["-url", "credentials-url: kx7Qm2ZpLr9TvWs4.pem"],
  ])("passes a suffix rule spelled %s", (_separator, line) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files)).toEqual([]);
  });

  // Admitting the hyphen brings GitHub's own hyphenated keys to the secret-name test for the first
  // time. `id-token` and `persist-credentials` appear in this repository's own workflows, so a report
  // on either would block READY here permanently. MIN_LITERAL_SECRET_LENGTH is the only rule holding
  // them, and the last row pins exactly where that bound sits.
  it.each([
    ["a permissions scope", "id-token: write", []],
    ["a checkout input", "persist-credentials: false", []],
    ["a quoted checkout input", "persist-credentials: 'false'", []],
    ["a workflow key only the hyphen admits", "runs-on: ubuntu-latest", []],
    [
      "a hyphenated location name over a mounted secret file",
      "credentials-file: /run/secrets/db_password",
      [],
    ],
    ["a hyphenated URL name over an http URL", "token-url: https://auth.example.com/token", []],
    [
      "the input this heuristic could never see before",
      "aws-secret-access-key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "the first value over the length bound under a permissions scope",
      "id-token: write-all",
      ["INLINE_SECRET_IN_CI"],
    ],
  ])("reads a hyphenated name: %s", (_description, line, codes) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(codes);
  });

  // The name pattern's own inner separators accept either, so the two spellings of a multi-word name
  // behave alike. `private-key` is the documented input of `actions/create-github-app-token` and
  // `ssh-private-key` of `webfactory/ssh-agent`; under the underscore-only shape a literal parked in
  // either was reported as `PRIVATE_KEY` and clean as `private-key`, which is the more common half of
  // the gap. The widening admits exactly a name containing `api-key`, `access-key` or `private-key`
  // and nothing else, so the near-miss rows stay clean -- and `deploy-key` is a genuine credential
  // this heuristic still misses, pinned so the widening is not read as having closed that. The last
  // two rows are the cost, pinned in both spellings: the hyphen spelling inherits a false positive
  // the underscore spelling already paid, rather than opening a new class.
  it.each([
    ["api-key", "api-key: kx7Qm2ZpLr9TvWs4", ["INLINE_SECRET_IN_CI"]],
    ["private-key", "private-key: kx7Qm2ZpLr9TvWs4", ["INLINE_SECRET_IN_CI"]],
    ["ssh-private-key", "ssh-private-key: kx7Qm2ZpLr9TvWs4", ["INLINE_SECRET_IN_CI"]],
    ["aws-access-key-id", "aws-access-key-id: AKIAIOSFODNN7EXAMPLE", ["INLINE_SECRET_IN_CI"]],
    ["api-key over a managed reference", "api-key: ${{ secrets.API_KEY }}", []],
    ["private-key over a managed reference", "private-key: ${{ secrets.APP_PRIVATE_KEY }}", []],
    ["ssh-private-key over a managed reference", "ssh-private-key: ${{ secrets.SSH_KEY }}", []],
    ["aws-access-key-id over a managed reference", "aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}", []],
    ["a near-miss the qualifying word keeps out", "cache-key: node-modules-v2-abc123", []],
    ["a near-miss that is a real miss, unchanged here", "deploy-key: kx7Qm2ZpLr9TvWs4", []],
    ["a camel-case name, which offers no separator to match", "apiKey: kx7Qm2ZpLr9TvWs4", []],
    ["a modifier form held by the length bound", "api-key-required: false", []],
    ["a modifier form held by the reference-name rule", "api-key-name: my-app-prod-key", []],
    ["a modifier form held by the location-value rule", "private-key-path: ~/.ssh/id_rsa", []],
    [
      "the accepted false positive the underscore spelling already paid",
      "API_KEY_HEADER: X-Custom-Api-Key",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "the accepted false positive the hyphen spelling now inherits",
      "api-key-header: X-Custom-Api-Key",
      ["INLINE_SECRET_IN_CI"],
    ],
  ])("reads either separator inside a multi-word name: %s", (_description, line, codes) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(codes);
  });

  // Admitting the hyphen made a documented class of `secret-*` action inputs visible for the first
  // time. Each names a store entry or lists a mapping, none holds a secret value, and none was
  // reachable in the underscore spelling -- so each was a new false positive rather than an inherited
  // one, and each is an unclearable READY block. No value rule reaches them: `MY_SECRET=MY_ENV_VAR`
  // carries no separator and no extension, and `prod/db/credentials` sits under a name the location
  // rule does not end-match. The reported rows are the boundary of the two arms: a singular location
  // name still needs the value half, an access key id is a credential half rather than a handle to
  // one, and a name ending in neither an identifier nor a location word is not excused at all.
  it.each([
    ["a secret store id list", "secret-ids: prod/db/credentials", []],
    ["a single secret store id", "secret-id: mysecret", []],
    ["a build secret file mapping", "secret-files: MY_SECRET=./secret.txt", []],
    ["a build secret env mapping", "secret-envs: MY_SECRET=MY_ENV_VAR", []],
    ["a plural of the reference form", "secret-names: db-password,api-token", []],
    ["an OAuth record id, which the identifier arm covers", "client-secret-id: kx7Qm2ZpLr9TvWs4", []],
    ["the singular, clean by the location rule it already used", "secret-file: kx7Qm2ZpLr9TvWs4.pem", []],
    ["the accepted cost of the plural arm", "SECRET_FILES: kx7Qm2ZpLr9TvWs4", []],
    [
      "the singular, which still needs the value half",
      "SECRET_FILE: kx7Qm2ZpLr9TvWs4",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "another singular location name, unchanged",
      "CREDENTIALS_PATH: kx7Qm2ZpLr9TvWs4",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "an access key id, which the identifier arm must not cover",
      "aws-access-key-id: AKIAIOSFODNN7EXAMPLE",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a name outside both arms, which stays reported",
      "secret-manager-project: my-gcp-project",
      ["INLINE_SECRET_IN_CI"],
    ],
  ])("excuses a name that locates a secret rather than holding one: %s", (_description, line, codes) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `    with:\n      ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(codes);
  });

  // A `user:password` authority is a stored credential whatever the variable is called, so this
  // trigger skips the name gate and the value-shape rules. It is the only way `DATABASE_URL` and
  // `REDIS_URL` are seen at all, and the alternative -- a growing list of driver names in
  // SECRET_NAME_PATTERN -- is wrong again with the next driver. The clean rows pin its placement --
  // after MANAGED_REFERENCE_PATTERN (a reference in the password position stores nothing) and after
  // the length bound -- and its two limits: a password position must hold a password, and a pair
  // written under a nested `jdbc:` scheme is the same pair.
  //
  // Every host here is dotted, deliberately. The host rule below excuses a loopback or single-label
  // host, so a bare host would make each of these rows pass for a reason it was not written to test.
  it.each([
    [
      "a Postgres URL under a name with no secret token",
      "DATABASE_URL: postgres://u:secret@db.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a Redis URL whose username is empty",
      "REDIS_URL: redis://:hunter2@cache.internal.example.com:6379/0",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a datasource URL in the spelling Spring actually accepts",
      "SPRING_DATASOURCE_URL: jdbc:mysql://root:hunter2@db.example.com:3306/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "the JDBC spelling under the name Heroku sets",
      "JDBC_DATABASE_URL: jdbc:postgresql://u:hunter2@db.example.com:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "the JDBC spelling under the name Quarkus sets",
      "QUARKUS_DATASOURCE_JDBC_URL: jdbc:postgresql://u:hunter2@db.example.com:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "an https endpoint, which LOCATION_VALUE_PATTERN would otherwise excuse",
      "MY_SERVICE_ENDPOINT: https://u:secret@host.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a schemeless authority, which LOCATION_VALUE_PATTERN would otherwise excuse",
      "MY_SERVICE_ENDPOINT: //u:secret@host.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a location name, which no longer keeps its excuse",
      "PASSWORD_FILE: postgres://u:secret@db.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a bare shell reference in the password position, still open",
      "DATABASE_URL: postgres://u:$PASSWORD@db.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    ["the first userinfo value over the length bound", "DATABASE_URL: //:b@c.d", ["INLINE_SECRET_IN_CI"]],
    [
      "a single password character, which is still a password",
      "POSTGRES_URL: postgres://user:x@db.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "an empty password, which declares that there is none",
      "POSTGRES_URL: postgres://user:@db.example.com/app",
      [],
    ],
    ["an empty password on a loopback service", "REDIS_URL: redis://:@localhost:6379", []],
    ["an empty password on a loopback address", "MYSQL_URL: mysql://root:@127.0.0.1:3306/test", []],
    ["an empty password on a container alias", "POSTGRES_URL: postgres://user:@db/app", []],
    [
      "a bare username, which is a host's companion far more often than a secret",
      "DATABASE_URL: postgres://u@db.example.com/app",
      [],
    ],
    ["a managed reference, which stores nothing", "DATABASE_URL: ${{ secrets.DATABASE_URL }}", []],
    [
      "a managed reference in the password position",
      "DATABASE_URL: postgres://u:${{ secrets.PW }}@db.example.com/app",
      [],
    ],
    [
      "a braced shell reference in the password position",
      "DATABASE_URL: postgres://u:${DB_PASSWORD}@db.example.com/app",
      [],
    ],
    ["a userinfo value one character under the length bound", "DATABASE_URL: //:b@c.", []],
  ])("reads userinfo without consulting the name: %s", (_description, line, codes) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(codes);
  });

  // The most common userinfo-bearing line in real CI is a service-container DSN: a password for a
  // container the workflow started a few lines above and destroys when the job ends. The companion
  // `POSTGRES_PASSWORD: test` is below the length bound, so in a typical file the DSN is the only
  // line this function would report at all -- the check would block READY permanently on a credential
  // it watched the workflow invent, for a project that was clean before the trigger existed. Two
  // signals excuse it, both bounded by the CI runtime rather than by the ecosystem: a loopback host,
  // and a host with no dot in it. The reported rows are the boundary -- one dot is enough to keep the
  // report whatever the host resolves to -- and the `vault-prod` row is the accepted cost written as
  // a test: a real credential for an internal host named without a dot is not reported.
  it.each([
    ["a Postgres service container", "DATABASE_URL: postgres://postgres:postgres@localhost:5432/test", []],
    ["the same under the postgresql scheme", "DATABASE_URL: postgresql://test:test@localhost:5432/test", []],
    ["a RabbitMQ service container", "AMQP_URL: amqp://guest:guest@localhost:5672", []],
    ["a Mongo service container", "MONGO_URL: mongodb://root:example@localhost:27017", []],
    [
      "a container addressed by its Compose alias",
      "DATABASE_URL: postgres://postgres:postgres@db:5432/test",
      [],
    ],
    ["a single-label cache alias", "REDIS_URL: redis://:hunter2@cache:6379/0", []],
    ["a loopback address", "DATABASE_URL: postgres://u:hunter2@127.0.0.1:5432/app", []],
    ["the all-interfaces address", "DATABASE_URL: postgres://u:hunter2@0.0.0.0:5432/app", []],
    ["a bracketed IPv6 loopback", "REDIS_URL: redis://:hunter2@[::1]:6379/0", []],
    ["an authority with no host at all", "DATABASE_URL: postgres://u:secret@:5432/app", []],
    [
      "the accepted cost: an internal host named without a dot",
      "DATABASE_URL: postgres://svc:hunter2@vault-prod/app",
      [],
    ],
    [
      "a dotted host, which keeps its report",
      "DATABASE_URL: postgres://u:hunter2@db.example.com:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "an internal FQDN, dotted and therefore reported",
      "REDIS_URL: redis://:hunter2@cache.internal.example.com:6379/0",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a private address written out, dotted and therefore reported",
      "DATABASE_URL: postgres://u:hunter2@10.0.0.5:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a bracketed public IPv6 literal, which the single-label arm must not excuse",
      "POSTGRES_URL: postgres://u:hunter2@[2001:db8::1]:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a host that merely begins with the loopback name",
      "DATABASE_URL: postgres://u:hunter2@localhost.example.com:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    ["an underscore in the host, still one label", "DATABASE_URL: postgres://u:hunter2@my_db:5432/app", []],
    [
      "a scheme carrying a plus, over a hosted cluster",
      "MONGO_URL: mongodb+srv://u:hunter2@cluster0.abcd.mongodb.net/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "an unencoded at-sign in the password, which the host span reads through",
      "DATABASE_URL: postgres://u:p@ss@db.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "the cost of reading through it: the same password over a loopback address",
      "DATABASE_URL: postgres://u:p@ss@127.0.0.1:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "the cost of the closed loopback list: an IPv6 spelling that is not ::1",
      "DATABASE_URL: postgres://u:hunter2@[::ffff:127.0.0.1]:5432/app",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "a secret-shaped name, which reaches the name gate on its own terms",
      "DB_PASSWORD: postgres://postgres:postgres@localhost:5432/test",
      ["INLINE_SECRET_IN_CI"],
    ],
  ])("declines a userinfo credential whose host cannot be public: %s", (_description, line, codes) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `env:\n  ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(codes);
  });

  // Dropping the name gate widened the rule's accepted false positive from `_URL`-suffixed names to
  // every name, and the reachable new instance was a digest-pinned action on a ported registry: the
  // port supplies the colon and the digest supplies the at-sign. A `uses:` value holds an action or
  // image reference and never a credential, so that report carried nothing and was an unclearable
  // READY block for any project pinning a Docker action on a self-hosted registry.
  // USES_KEYWORD_NAME_PATTERN exists for exactly this, and it is tested before the userinfo trigger --
  // which consults no name and would otherwise report the line whatever the keyword rule said. The
  // host rule now reaches that same line by a second route, because a digest algorithm (`sha256`) is
  // a single-label host, but the exemption is what the accepted-cost row rests on: it holds a
  // userinfo-bearing value under `uses` whose host is dotted, and that is not a shape a `uses:` value
  // can legally take. The `uses-token` row pins that the pattern is still anchored, so only the
  // keyword itself is excused -- that line reaches the trigger, the host rule declines it on
  // `sha256`, and the name gate reports it on `token`. `secrets` gets no exemption here at all: it is
  // tested only inside the name-gated branch, after this trigger has already run, so the last row is
  // a guard rather than a cost -- `secrets: postgres://u:secret@db.example.com/app` is reported,
  // exactly as before `uses` needed an exemption of its own, and it is pinned so the two keywords
  // cannot be widened back together silently.
  it.each([
    ["an unported registry", "- uses: docker://ghcr.io/org/image@sha256:0123456789abcdef", []],
    [
      "a ported registry, the false positive this exemption removes",
      "- uses: docker://registry.example.com:5000/image@sha256:0123456789abcdef",
      [],
    ],
    ["a plain action reference", "- uses: actions/checkout@v4", []],
    ["a tagged Docker image", "- uses: docker://alpine:3.18", []],
    [
      "a name that merely begins with the keyword, which is not exempt",
      "uses-token: docker://registry.example.com:5000/image@sha256:0123456789abcdef",
      ["INLINE_SECRET_IN_CI"],
    ],
    [
      "the accepted cost: a credential parked in a uses value",
      "- uses: docker://user:hunter2@registry.example.com/image@sha256:0123456789abcdef",
      [],
    ],
    [
      "a credential parked in a secrets value, which gets no such exemption",
      "secrets: postgres://u:secret@db.example.com/app",
      ["INLINE_SECRET_IN_CI"],
    ],
  ])("exempts the uses keyword from the userinfo trigger: %s", (_description, line, codes) => {
    const files = [{ path: ".github/workflows/ci.yml", content: `    steps:\n      ${line}\n` }];
    expect(inlineSecretFindings(files).map((entry) => entry.code)).toEqual(codes);
  });

  it("names the embedded password without repeating the connection string", () => {
    const files = [
      {
        path: ".github/workflows/deploy.yml",
        content: "env:\n  DATABASE_URL: postgres://u:hunter2@db.example.com/app\n",
      },
    ];
    const message = inlineSecretFindings(files)[0]?.message ?? "";
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("embeds a password");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("postgres://");
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
