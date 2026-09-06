import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, normalize } from "node:path";

import {
  readinessCheckDraftSchema,
  type ReadinessCheckDraft,
  type SecurityFindingDraft,
} from "@loomrail/contracts";

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CI_FILES = 32;
const MAX_CI_FILE_BYTES = 256 * 1024;
const MAX_CI_TOTAL_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

type BoundedGitResult = {
  exitCode: number;
  output: Buffer;
  overflowed: boolean;
};

export type ProjectReadinessAssessmentDraft = {
  repositoryHead: string | null;
  sourceDigest: string;
  workingTreeDirty: boolean;
  checks: readonly ReadinessCheckDraft[];
};

export type ProjectReadinessScanErrorCode = "REPOSITORY_UNAVAILABLE" | "GIT_UNAVAILABLE";

export class ProjectReadinessScanError extends Error {
  readonly code: ProjectReadinessScanErrorCode;

  constructor(code: ProjectReadinessScanErrorCode, message: string) {
    super(message);
    this.name = "ProjectReadinessScanError";
    this.code = code;
  }
}

const samePath = (left: string, right: string): boolean => {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const runBoundedGit = (args: readonly string[], cwd: string): Promise<BoundedGitResult> =>
  new Promise((resolve, reject) => {
    const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
    const child = spawn("git", ["-c", `core.hooksPath=${hooksPath}`, ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    const timer = setTimeout(() => {
      overflowed = true;
      child.kill();
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= MAX_GIT_OUTPUT_BYTES) chunks.push(chunk);
      else {
        overflowed = true;
        child.kill();
      }
    });
    child.on("error", (_cause: unknown) => {
      clearTimeout(timer);
      reject(new ProjectReadinessScanError("GIT_UNAVAILABLE", "Git is unavailable for the readiness check"));
    });
    child.on("close", (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, output: Buffer.concat(chunks), overflowed });
    });
  });

const outputText = (result: BoundedGitResult): string => result.output.toString("utf8").trim();

const splitNullPaths = (result: BoundedGitResult): readonly string[] =>
  result.output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"));

const isSecretLikePath = (path: string): boolean => {
  const name = basename(path).toLowerCase();
  if (/^\.env(?:\..+)?$/.test(name) && !/(?:example|sample|template|dist)$/.test(name)) return true;
  return [
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "service-account.json",
    "id_rsa",
    "id_dsa",
    "id_ed25519",
    "private.pem",
    "private.key",
  ].includes(name);
};

const ROOT_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
] as const;

export const lockfileFindings = (trackedPaths: readonly string[] | null): readonly SecurityFindingDraft[] => {
  if (trackedPaths === null) {
    return [
      finding(
        "DEPENDENCY_INPUT_UNVERIFIABLE",
        "HIGH",
        null,
        "Tracked paths exceeded the safe inspection bound, so lockfile coverage was not checked.",
      ),
    ];
  }
  const rootPaths = new Set(trackedPaths.filter((path) => !path.includes("/")));
  if (!rootPaths.has("package.json")) return [];
  const present = ROOT_LOCKFILES.filter((name) => rootPaths.has(name));
  if (present.length === 0) {
    return [
      finding(
        "LOCKFILE_MISSING",
        "HIGH",
        "package.json",
        "A tracked manifest has no tracked lockfile, so installed versions are not reproducible.",
      ),
    ];
  }
  if (present.length === 1) return [];
  return present.map((name) =>
    finding(
      "LOCKFILE_AMBIGUOUS",
      "MEDIUM",
      name,
      "More than one package manager lockfile is tracked, so the installed tree is ambiguous.",
    ),
  );
};

const finding = (
  code: SecurityFindingDraft["code"],
  severity: SecurityFindingDraft["severity"],
  path: string | null,
  message: string,
): SecurityFindingDraft => ({ code, severity, path, message });

const automatedCheck = (
  key: ReadinessCheckDraft["key"],
  category: ReadinessCheckDraft["category"],
  passedSummary: string,
  requiredSummary: string,
  findings: readonly SecurityFindingDraft[],
): ReadinessCheckDraft =>
  readinessCheckDraftSchema.parse({
    key,
    category,
    mode: "AUTOMATED",
    status: findings.length === 0 ? "PASSED" : "ACTION_REQUIRED",
    summary: findings.length === 0 ? passedSummary : requiredSummary,
    findings,
  });

const ownerCheck = (
  key: ReadinessCheckDraft["key"],
  category: ReadinessCheckDraft["category"],
  summary: string,
): ReadinessCheckDraft =>
  readinessCheckDraftSchema.parse({
    key,
    category,
    mode: "OWNER",
    status: "ACTION_REQUIRED",
    summary,
    findings: [],
  });

const ignoredByGit = async (repositoryPath: string, path: string): Promise<boolean | null> => {
  const result = await runBoundedGit(["check-ignore", "--no-index", "--quiet", "--", path], repositoryPath);
  if (result.overflowed) return null;
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
};

const pathExists = async (repositoryPath: string, path: string): Promise<boolean> => {
  try {
    await lstat(join(repositoryPath, path));
    return true;
  } catch {
    return false;
  }
};

const licensePresent = async (repositoryPath: string): Promise<boolean> => {
  const accepted = new Set(["license", "license.md", "license.txt", "copying", "copying.md", "copying.txt"]);
  try {
    for (const entry of await readdir(repositoryPath, { withFileTypes: true })) {
      if (!accepted.has(entry.name.toLowerCase()) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const metadata = await lstat(join(repositoryPath, entry.name));
      if (metadata.isFile() && !metadata.isSymbolicLink()) return true;
    }
  } catch {
    return false;
  }
  return false;
};

type CiWorkflowFile = { path: string; content: string };

const readBoundedCiWorkflows = async (
  repositoryPath: string,
): Promise<{ files: readonly CiWorkflowFile[]; unverifiable: readonly SecurityFindingDraft[] }> => {
  const directory = join(repositoryPath, ".github", "workflows");
  let entries: readonly import("node:fs").Dirent[];
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return {
        files: [],
        unverifiable: [
          finding(
            "CI_INPUT_UNVERIFIABLE",
            "HIGH",
            ".github/workflows",
            "The CI workflow directory is not a regular directory and was not inspected.",
          ),
        ],
      };
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { files: [], unverifiable: [] };
  }

  const candidates = entries
    .filter((entry) => /\.ya?ml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: CiWorkflowFile[] = [];
  const unverifiable: SecurityFindingDraft[] = [];
  if (candidates.length > MAX_CI_FILES) {
    unverifiable.push(
      finding(
        "CI_INPUT_UNVERIFIABLE",
        "HIGH",
        ".github/workflows",
        "The CI workflow file limit was exceeded, so the full workflow set was not inspected.",
      ),
    );
  }

  let totalBytes = 0;
  for (const entry of candidates.slice(0, MAX_CI_FILES)) {
    const relativePath = `.github/workflows/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    let metadata: import("node:fs").Stats;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      unverifiable.push(
        finding("CI_INPUT_UNVERIFIABLE", "HIGH", relativePath, "The CI workflow could not be inspected."),
      );
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CI_FILE_BYTES) {
      unverifiable.push(
        finding(
          "CI_INPUT_UNVERIFIABLE",
          "HIGH",
          relativePath,
          "The CI workflow is not a bounded regular file and was not inspected.",
        ),
      );
      continue;
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_CI_TOTAL_BYTES) {
      unverifiable.push(
        finding(
          "CI_INPUT_UNVERIFIABLE",
          "HIGH",
          relativePath,
          "The CI workflow byte limit was exceeded, so remaining workflows were not inspected.",
        ),
      );
      break;
    }
    let content: string;
    try {
      content = (await readFile(absolutePath)).toString("utf8");
    } catch {
      unverifiable.push(
        finding("CI_INPUT_UNVERIFIABLE", "HIGH", relativePath, "The CI workflow could not be read safely."),
      );
      continue;
    }
    files.push({ path: relativePath, content });
  }
  return { files, unverifiable };
};

const ciFindings = (files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[] => {
  const findings: SecurityFindingDraft[] = [];
  for (const file of files) {
    if (/^\s*pull_request_target\s*:/m.test(file.content)) {
      findings.push(
        finding(
          "CI_PULL_REQUEST_TARGET",
          "HIGH",
          file.path,
          "The workflow uses pull_request_target and requires an explicit trust-boundary review.",
        ),
      );
    }
    if (/^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im.test(file.content)) {
      findings.push(
        finding("CI_WRITE_ALL_PERMISSIONS", "HIGH", file.path, "The workflow grants write-all permissions."),
      );
    }
    const actionPattern = /^\s*-?\s*uses\s*:\s*["']?([^\s"'#]+)@([^\s"'#]+)["']?/gim;
    for (const match of file.content.matchAll(actionPattern)) {
      const target = match[1];
      const reference = match[2];
      if (
        target?.startsWith("./") ||
        target?.startsWith("docker://") ||
        /^[0-9a-f]{40}$/i.test(reference ?? "")
      ) {
        continue;
      }
      findings.push(
        finding(
          "CI_ACTION_NOT_PINNED",
          "MEDIUM",
          file.path,
          `The action ${target ?? "unknown"} is not pinned to a full commit SHA.`,
        ),
      );
    }
  }
  return findings;
};

const SECRET_NAME_PATTERN = /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS/i;
// A `_NAME` suffix denotes what a credential is called, not the credential itself.
const REFERENCE_NAME_PATTERN = /_NAME$/i;
// `secrets` is a workflow keyword, not a variable: it introduces a mapping, or carries the managed
// literal `inherit`. Entries nested under it are still read as lines of their own. Matched
// case-sensitively, because the keyword is lowercase and `SECRETS` is an ordinary variable name.
// `inherit` is below the length bound and would pass without this rule; what needs it is the same
// key used as an action input, such as a `hashicorp/vault-action` step listing store paths.
const WORKFLOW_KEYWORD_NAME_PATTERN = /^secrets$/;
// A braced reference -- `${{ … }}` or `${VAR}` -- means the value is interpolated at run time rather
// than stored here, so a suffix such as `/gcp.json` does not make the assignment a literal. It is
// honoured at the start of the value or after any character outside `[A-Za-z0-9]`, which is what the
// leading `(?:^|[^A-Za-z0-9])` requires: `pre-${{ … }}`, `pre_${{ … }}` and `.${VAULT_PATH}` are
// clean, but a reference glued straight onto an alphanumeric prefix is not read as one, so
// `DB_PASSWORD: prefix${{ secrets.PW }}`, `DB_PASSWORD: v2${{ secrets.PW }}` and
// `TOKEN: ghp${{ secrets.X }}` are all reported. That error points at a false positive, so it ships
// no credential -- but it is a permanent READY block, and a reader should not be surprised by it.
// A bare `$VAR` has no closing delimiter, so it is honoured in exactly two places: as the entire
// value, and where a `/` follows it. Both arms are knowingly open and neither can be closed. On the
// whole-value arm a literal made only of `[A-Za-z0-9_]` after a leading `$` --
// `$ecretPassword`, `$uper_Secret_1` -- is indistinguishable from `$DB_PASSWORD`, which has to stay
// clean. The `/` arm is open in the same way and just as wide, not narrower: the `/` ends this
// pattern's inspection, so whatever follows it is never read, and the prefix before it may be a
// single letter. `$a/hunter2hunter2`, `$ecret/Password1`, `$Kx7Qm/2ZpLr9TvWs4` and
// `$x/ghp_16C7e42F292c6912E77` are all excused here, and nothing in their shape separates them from
// `$RUNNER_TEMP/gcp.json`, which has to stay clean. What this pattern does not excuse is a `$`-led
// value holding no `/` and no braced reference that carries any character outside `[A-Za-z0-9_]`
// after that `$`; `$tr0ngP@ssw0rd!` under `DB_PASSWORD` is reported.
const MANAGED_REFERENCE_PATTERN =
  /(?:^|[^A-Za-z0-9])\$(?:\{\{.*?\}\}|\{[^}]+\})|^\$[A-Za-z_][A-Za-z0-9_]*(?:$|\/)/;
// A value whose own shape is a location: home-relative, explicitly relative, absolute, or an http(s)
// URL. Only a leading match counts. `~/`, `./` and `../` need no further evidence, because base64
// contains neither `~` nor `.`. A bare leading `/` does: it is read as a path only when a second
// separator follows. That test is deliberately partial. It reports a base64 secret that begins with
// `/` and holds no other `/` -- for a 40-character key about 54% of those that begin with `/` --
// and excuses the remaining ~46% as paths. Nothing in the shape of a value separates those two
// cases, so the class stays open rather than being closed by a guess in either direction.
const LOCATION_VALUE_PATTERN = /^(?:~\/|\.{1,2}\/|\/[^\s]*\/|https?:\/\/)/i;
// A name ending `_FILE`, `_PATH`, `_DIR` or `_URL` says the value is where a credential lives. Each
// half alone is wrong: the name alone excuses any literal parked under it, and shape alone cannot
// read a store-relative path such as `secret/data/ci/deploy` or `gs://bucket/creds.json`. Required
// together, they are decisive. The value half reads: contains a `/` or a `\` anywhere, or is a bare
// filename with a dotted extension. `\` is accepted alongside `/` so a Windows path such as
// `C:\Users\runneradmin\id_rsa` is recognised the same way a POSIX one already is, and it carries
// the same accepted cost as `/`, not a smaller one. Neither character has to sit where a separator
// would -- one anywhere in the value is enough -- so `API_TOKEN_PATH: \ghp_16C7e42F292c6912E77` and
// `PRIVATE_KEY_DIR: kx7Qm2ZpLr9TvWs4\` both pass, exactly as the already-excused
// `API_TOKEN_PATH: /ghp_16C7e42F292c6912E77` does. The base64 alphabet (`A-Za-z0-9+/=`) has no
// backslash, so no raw base64 secret carries one, but that does not close the arm: `storedScalar`
// leaves YAML escapes uninterpreted, so a double-quoted scalar arrives with its `\n` escapes intact,
// and a PEM key flattened onto one line passes on the `\` arm even when its base64 body holds no
// `/`. The `/` arm's own cost is unchanged: base64 does contain `/`, so
// `AWS_SECRET_ACCESS_KEY_FILE: wJalrXUtnFEMI/K7MDENG/b` passes. Both are accepted for the same
// reason -- a location-suffixed name over a separator-bearing value is overwhelmingly a location,
// and the false positives this prevents block READY permanently while these misses do not.
const LOCATION_NAME_PATTERN = /_(?:FILE|PATH|DIR|URL)$/i;
const NAMED_LOCATION_VALUE_PATTERN = /[/\\]|^[^\s/\\]+\.[A-Za-z0-9]{1,8}$/;
// The `_URL` suffix is narrower than the other three. A URL whose authority carries a `user:password`
// pair before an `@` is not a location; it is a credential with a hostname attached, and
// `postgres://u:secret@db/app` is the exact value this check exists to report. Without this arm any
// `_URL` name -- `TOKEN_URL`, `PASSWORD_URL`, `SECRET_URL`, `DB_PASSWORD_URL`,
// `DATABASE_CREDENTIALS_URL` -- excused one. The span searched for that pair begins after `//` and is
// deliberately wider than RFC 3986's authority: it runs straight through `/` and ends at the first
// `?`, `#` or `@`, and it is a match only when that terminator is an `@` with a `:` somewhere before
// it. A value with no `//` has no span to inspect, which is why
// `TOKEN_URL: auth.example.com/token` stays clean.
//
// Running through `/` is the whole point. An unencoded password containing one would otherwise put
// the `@` past the authority and go unreported, and `/` is in the base64 alphabet
// (`A-Za-z0-9+/=`), so `openssl rand -base64` puts one in roughly every other password it generates.
// `POSTGRES_PASSWORD_URL: postgres://app:aB3/xYz9pQ@db:5432/app`,
// `PASSWORD_URL: redis://:hun/ter2@cache:6379/0` and
// `DATABASE_CREDENTIALS_URL: mysql://root:pa/ss@db:3306/app` are all reported, as is the same
// password percent-encoded (`aB3%2FxYz9pQ`) and one holding several slashes
// (`postgres://u:a/b/c/d@db:5432/app`).
//
// The one false positive in this rule is what that buys, and it is a permanent READY block on a
// correct line. The shape is exact: a `:` and, after it, an `@`, both before the value's first `?` or
// `#`, with no `@` in between, under a scheme that is not `http`/`https` (LOCATION_VALUE_PATTERN
// excuses those above before this rule is reached, as it does a value starting with a bare `//`).
// The colon has three ordinary sources -- a port, `CREDENTIALS_URL: gs://my-bucket:8080/creds@2026.json`
// and `TOKEN_URL: ssh://github.com:22/org/repo@v1.git`; a path segment,
// `CREDENTIALS_URL: gs://my-bucket/2026:07/creds@2026.json` and
// `CREDENTIALS_URL: s3://bucket/2026-01-01T00:00:00Z/creds@v1.json`; and a Windows drive letter,
// `CREDENTIALS_URL: file:///c:/keys/creds@2026.json`. All five are reported and none is a secret.
// Both halves are needed, in that order, uninterrupted: `gs://my-bucket:8080/creds.json`,
// `gs://my-bucket/2026:07/creds.json`, `gs://my-bucket/creds@2026.json`,
// `gs://my-bucket/creds@2026/v:1.json` (colon after the at-sign) and
// `gs://my-bucket@zone/2026:07/creds@v1.json` (an earlier `@` the span cannot cross) all stay clean.
// The shape is scoped to `_URL` as well: that same ported bucket URL under `CREDENTIALS_FILE`,
// `CREDENTIALS_PATH` or `CREDENTIALS_DIR` is clean.
//
// Four limits, all deliberate, and each one is a way a stored credential goes unreported.
// 1. A colon inside the userinfo is required, so a URL whose *username alone* is the credential --
//    `TOKEN_URL: postgres://ghp_16C7e42F292c6912E77@db/app` -- is not reported by this arm. That is
//    the price of keeping `TOKEN_URL: ssh://git@github.com/org/repo.git`, the ordinary spelling of a
//    Git remote, and `DATABASE_CREDENTIALS_URL: mysql://root@db:3306/app` clean: a bare username
//    before an `@` is a host's companion far more often than it is a secret, and reporting one is an
//    unclearable READY block.
// 2. The span still stops at `?` and `#`, so a password holding either is not reported:
//    `TOKEN_URL: postgres://u:sec?ret@db/app` and `TOKEN_URL: postgres://u:sec#ret@db/app` are clean.
//    Unlike `/`, neither character is in the base64 alphabet, so a generated password does not carry
//    one -- while a query string is an ordinary part of a storage URL and hands the pattern both
//    halves for free. Running the span on would report
//    `TOKEN_URL: gs://my-bucket/creds.json?url=https://cdn.example.com/x@1`,
//    `CREDENTIALS_URL: gs://my-bucket/creds.json?ts=2026-01-01T00:00:00Z&owner=a@b.example`,
//    `CREDENTIALS_URL: gs://my-bucket/2026:07/creds.json?owner=a@b.example` and
//    `SECRET_URL: s3://bucket/key.json#frag:1@rev`, all of which are clean today. That trade is worse
//    than the one above it, so `?` and `#` keep terminating and this limit stays open.
// 3. The narrowing is scoped to the `_URL` suffix as ruled, so
//    `PASSWORD_FILE: postgres://u:secret@db/app` and
//    `PASSWORD_FILE: postgres://app:aB3/xYz9pQ@db:5432/app` keep the `/` arm's excuse.
// 4. It only sees values that reach this rule, so an `https://` URL carrying userinfo --
//    `DB_PASSWORD_URL: https://u:secret@db.example.com/app` -- is excused above by
//    LOCATION_VALUE_PATTERN and never tested here.
const URL_NAME_PATTERN = /_URL$/i;
const USERINFO_PASSWORD_AUTHORITY_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^?#@]*:[^?#@]*@/;
const MIN_LITERAL_SECRET_LENGTH = 8;

// Reduces a YAML scalar to the characters actually stored: the body of a quoted string, otherwise
// the value with its trailing `#` comment removed.
const storedScalar = (rawValue: string): string => {
  const quoted = /^(["'])([\s\S]*?)\1\s*(?:#.*)?$/.exec(rawValue);
  if (quoted?.[2] !== undefined) return quoted[2];
  return rawValue
    .replace(/(?:^|\s)#.*$/, "")
    .trim()
    .replace(/^["']/, "")
    .replace(/["']$/, "");
};

export const inlineSecretFindings = (files: readonly CiWorkflowFile[]): readonly SecurityFindingDraft[] => {
  const findings: SecurityFindingDraft[] = [];
  for (const file of files) {
    for (const line of file.content.split(/\r?\n/)) {
      const match = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
      const name = match?.[1];
      const rawValue = match?.[2];
      if (!name || !rawValue || !SECRET_NAME_PATTERN.test(name)) continue;
      if (REFERENCE_NAME_PATTERN.test(name) || WORKFLOW_KEYWORD_NAME_PATTERN.test(name)) continue;
      const value = storedScalar(rawValue);
      if (
        value.length < MIN_LITERAL_SECRET_LENGTH ||
        MANAGED_REFERENCE_PATTERN.test(value) ||
        LOCATION_VALUE_PATTERN.test(value) ||
        (LOCATION_NAME_PATTERN.test(name) &&
          NAMED_LOCATION_VALUE_PATTERN.test(value) &&
          !(URL_NAME_PATTERN.test(name) && USERINFO_PASSWORD_AUTHORITY_PATTERN.test(value)))
      ) {
        continue;
      }
      findings.push(
        finding(
          "INLINE_SECRET_IN_CI",
          "CRITICAL",
          file.path,
          `The workflow assigns ${name} a literal value instead of referencing a managed secret.`,
        ),
      );
      break;
    }
  }
  return findings;
};

export const prodEnvFindings = (
  entries: readonly { path: string; exists: boolean; ignored: boolean | null }[],
): readonly SecurityFindingDraft[] =>
  entries
    .filter((entry) => entry.exists && entry.ignored !== true)
    .map((entry) =>
      finding(
        "PROD_ENV_NOT_IGNORED",
        "HIGH",
        entry.path,
        entry.ignored === null
          ? "Ignore coverage could not be verified for an existing production environment file."
          : "An existing production environment file is not covered by Git ignore rules.",
      ),
    );

export const launchOwnerChecks = (): readonly ReadinessCheckDraft[] => [
  ownerCheck(
    "SECURITY_HEADERS_OWNER_REVIEW",
    "SECURITY",
    "Confirm the security header decision for this project, or mark it not applicable.",
  ),
  ownerCheck(
    "OPS_HEALTH_ENDPOINT_DECLARED",
    "OPERATIONS",
    "Confirm a health or readiness path exists, or mark it not applicable.",
  ),
  ownerCheck(
    "OPS_ROLLBACK_PLAN",
    "OPERATIONS",
    "Confirm what happens when a release fails and how the previous state is restored.",
  ),
  ownerCheck(
    "OPS_BACKUP",
    "OPERATIONS",
    "Confirm how project data is backed up and restored, or mark it not applicable.",
  ),
];

export const assessProjectReadiness = async (
  repositoryPath: string,
  options: { activeConstitution: boolean },
): Promise<ProjectReadinessAssessmentDraft> => {
  const canonicalRoot = await realpath(repositoryPath).catch(() => null);
  if (canonicalRoot === null) {
    throw new ProjectReadinessScanError("REPOSITORY_UNAVAILABLE", "The Project repository is unavailable");
  }
  const topLevel = await runBoundedGit(["rev-parse", "--show-toplevel"], canonicalRoot);
  if (topLevel.overflowed || topLevel.exitCode !== 0 || !samePath(outputText(topLevel), canonicalRoot)) {
    throw new ProjectReadinessScanError(
      "REPOSITORY_UNAVAILABLE",
      "The Project repository is not available at its registered top-level path",
    );
  }

  const [
    headResult,
    statusResult,
    trackedResult,
    envIgnored,
    envLocalIgnored,
    npmrcIgnored,
    hasLicense,
    workflows,
    prodEnvExists,
    prodEnvLocalExists,
    prodEnvIgnored,
    prodEnvLocalIgnored,
  ] = await Promise.all([
    runBoundedGit(["rev-parse", "HEAD"], canonicalRoot),
    runBoundedGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], canonicalRoot),
    runBoundedGit(["ls-files", "-z"], canonicalRoot),
    ignoredByGit(canonicalRoot, ".env"),
    ignoredByGit(canonicalRoot, ".env.local"),
    ignoredByGit(canonicalRoot, ".npmrc"),
    licensePresent(canonicalRoot),
    readBoundedCiWorkflows(canonicalRoot),
    pathExists(canonicalRoot, ".env.production"),
    pathExists(canonicalRoot, ".env.production.local"),
    ignoredByGit(canonicalRoot, ".env.production"),
    ignoredByGit(canonicalRoot, ".env.production.local"),
  ]);

  const repositoryHead =
    headResult.exitCode === 0 && !headResult.overflowed && /^[0-9a-f]{40,64}$/.test(outputText(headResult))
      ? outputText(headResult)
      : null;
  if (statusResult.exitCode !== 0 || statusResult.overflowed) {
    throw new ProjectReadinessScanError("REPOSITORY_UNAVAILABLE", "Git could not inspect repository status");
  }

  const secretFindings: SecurityFindingDraft[] = [];
  if (trackedResult.exitCode !== 0 || trackedResult.overflowed) {
    secretFindings.push(
      finding(
        "TRACKED_SECRET_PATH",
        "HIGH",
        null,
        "Tracked paths exceeded the safe inspection bound, so secret-like filenames were not fully checked.",
      ),
    );
  } else {
    for (const path of splitNullPaths(trackedResult).filter(isSecretLikePath).slice(0, 128)) {
      secretFindings.push(
        finding("TRACKED_SECRET_PATH", "CRITICAL", path, "Git tracks a filename commonly used for secrets."),
      );
    }
  }

  const ignoreFindings: SecurityFindingDraft[] = [];
  for (const [path, ignored] of [
    [".env", envIgnored],
    [".env.local", envLocalIgnored],
    [".npmrc", npmrcIgnored],
  ] as const) {
    if (ignored !== true) {
      ignoreFindings.push(
        finding(
          "ENV_NOT_IGNORED",
          "HIGH",
          path,
          ignored === null
            ? "Git ignore coverage could not be verified for this secret-bearing path."
            : "Git ignore rules do not cover this secret-bearing path.",
        ),
      );
    }
  }

  const ci = [...workflows.unverifiable, ...ciFindings(workflows.files)];

  const checks: readonly ReadinessCheckDraft[] = [
    automatedCheck(
      "SECURITY_ACTIVE_CONSTITUTION",
      "SECURITY",
      "An active owner-approved Project Constitution is present.",
      "Approve and publish a Project Constitution before launch.",
      options.activeConstitution
        ? []
        : [
            finding(
              "ACTIVE_CONSTITUTION_MISSING",
              "HIGH",
              ".loomrail/constitution.md",
              "The Project has no active owner-approved Constitution.",
            ),
          ],
    ),
    automatedCheck(
      "SECURITY_SECRET_PATHS",
      "SECURITY",
      "Git does not track known secret-like filenames.",
      "Remove or explicitly review tracked secret-like paths.",
      secretFindings,
    ),
    automatedCheck(
      "SECURITY_ENV_IGNORED",
      "SECURITY",
      "Git ignore rules cover common local secret files.",
      "Add ignore coverage for common local secret files.",
      ignoreFindings,
    ),
    automatedCheck(
      "SECURITY_CI_HARDENING",
      "SECURITY",
      "No known high-risk CI patterns were found in the bounded workflow scan.",
      "Review the reported CI trust and pinning findings.",
      ci,
    ),
    automatedCheck(
      "LEGAL_LICENSE",
      "LEGAL",
      "A root license marker is present.",
      "Add or explicitly decide the repository license before launch.",
      hasLicense
        ? []
        : [finding("LICENSE_MISSING", "MEDIUM", null, "No regular root LICENSE or COPYING file was found.")],
    ),
    ownerCheck(
      "LEGAL_OWNER_REVIEW",
      "LEGAL",
      "Confirm applicable license, privacy, terms, and data-processing obligations.",
    ),
    ownerCheck(
      "PAYMENTS_OWNER_REVIEW",
      "PAYMENTS",
      "Confirm payment, tax, refund, and provider obligations, or mark them not applicable.",
    ),
    ownerCheck(
      "ANALYTICS_OWNER_REVIEW",
      "ANALYTICS",
      "Confirm consent, retention, disclosure, and analytics data handling, or mark them not applicable.",
    ),
    automatedCheck(
      "DEPS_LOCKFILE_PRESENT",
      "DEPENDENCIES",
      "No missing or ambiguous lockfiles were found for tracked dependency manifests.",
      "Track a single lockfile so installs are reproducible.",
      lockfileFindings(
        trackedResult.exitCode !== 0 || trackedResult.overflowed ? null : splitNullPaths(trackedResult),
      ),
    ),
    automatedCheck(
      "ENV_PROD_SEPARATION",
      "ENVIRONMENT",
      "No unignored production env file or literal CI secret was found in the bounded scan.",
      "Keep production values out of the repository and out of CI literals.",
      [
        ...prodEnvFindings([
          { path: ".env.production", exists: prodEnvExists, ignored: prodEnvIgnored },
          { path: ".env.production.local", exists: prodEnvLocalExists, ignored: prodEnvLocalIgnored },
        ]),
        ...inlineSecretFindings(workflows.files),
        ...workflows.unverifiable,
      ],
    ),
    ...launchOwnerChecks(),
  ];
  const sourceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        repositoryHead,
        status: statusResult.output.toString("base64"),
        checks,
      }),
    )
    .digest("hex");

  return {
    repositoryHead,
    sourceDigest,
    workingTreeDirty: statusResult.output.byteLength > 0,
    checks,
  };
};
