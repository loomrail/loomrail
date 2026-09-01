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

const ciFindings = async (repositoryPath: string): Promise<readonly SecurityFindingDraft[]> => {
  const directory = join(repositoryPath, ".github", "workflows");
  let entries: readonly import("node:fs").Dirent[];
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return [
        finding(
          "CI_INPUT_UNVERIFIABLE",
          "HIGH",
          ".github/workflows",
          "The CI workflow directory is not a regular directory and was not inspected.",
        ),
      ];
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => /\.ya?ml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const findings: SecurityFindingDraft[] = [];
  if (candidates.length > MAX_CI_FILES) {
    findings.push(
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
      findings.push(
        finding("CI_INPUT_UNVERIFIABLE", "HIGH", relativePath, "The CI workflow could not be inspected."),
      );
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CI_FILE_BYTES) {
      findings.push(
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
      findings.push(
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
      findings.push(
        finding("CI_INPUT_UNVERIFIABLE", "HIGH", relativePath, "The CI workflow could not be read safely."),
      );
      continue;
    }
    if (/^\s*pull_request_target\s*:/m.test(content)) {
      findings.push(
        finding(
          "CI_PULL_REQUEST_TARGET",
          "HIGH",
          relativePath,
          "The workflow uses pull_request_target and requires an explicit trust-boundary review.",
        ),
      );
    }
    if (/^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im.test(content)) {
      findings.push(
        finding(
          "CI_WRITE_ALL_PERMISSIONS",
          "HIGH",
          relativePath,
          "The workflow grants write-all permissions.",
        ),
      );
    }
    const actionPattern = /^\s*-?\s*uses\s*:\s*["']?([^\s"'#]+)@([^\s"'#]+)["']?/gim;
    for (const match of content.matchAll(actionPattern)) {
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
          relativePath,
          `The action ${target ?? "unknown"} is not pinned to a full commit SHA.`,
        ),
      );
    }
  }
  return findings;
};

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

  const [headResult, statusResult, trackedResult, envIgnored, envLocalIgnored, npmrcIgnored, hasLicense, ci] =
    await Promise.all([
      runBoundedGit(["rev-parse", "HEAD"], canonicalRoot),
      runBoundedGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], canonicalRoot),
      runBoundedGit(["ls-files", "-z"], canonicalRoot),
      ignoredByGit(canonicalRoot, ".env"),
      ignoredByGit(canonicalRoot, ".env.local"),
      ignoredByGit(canonicalRoot, ".npmrc"),
      licensePresent(canonicalRoot),
      ciFindings(canonicalRoot),
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
