import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";

import {
  deploymentBranchSchema,
  githubActionsDeploymentTargetV2Schema,
  githubRepositorySlugSchema,
  type DeploymentDispatchOutcome,
  type DeploymentObservationOutcome,
  type GithubActionsDeploymentTarget,
} from "@loomrail/contracts";
import {
  runSupervisedProcess,
  type SupervisedProcessOptions,
  type SupervisedProcessResult,
} from "@loomrail/process-supervision";
import { inspectRepository, readCurrentBranch, runGit, treeOfWorktree } from "@loomrail/workspace";
import { z } from "zod";

import type { DeploymentDriver, DeploymentPreflightResult } from "./deployment-driver.js";

const workflowPathFor = (environmentKind: "PREVIEW" | "PRODUCTION") =>
  environmentKind === "PREVIEW"
    ? (".github/workflows/deploy-preview.yml" as const)
    : (".github/workflows/deploy-production.yml" as const);
const MAX_WORKFLOW_BYTES = 256 * 1_024;
const SMALL_OUTPUT_LIMIT = 4_096;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;
type ProcessRunner = (options: SupervisedProcessOptions) => Promise<SupervisedProcessResult>;

export const sameCanonicalPath = (left: string, right: string, platform: NodeJS.Platform): boolean => {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalizedLeft = pathApi.normalize(left);
  const normalizedRight = pathApi.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const cleanRepositoryPart = (value: string): string => (value.endsWith(".git") ? value.slice(0, -4) : value);

export const parseGithubRemote = (raw: string): string | null => {
  const value = raw.trim();
  let slug: string | null = null;
  const scp = /^git@github\.com:([^/:]+\/[^/]+)$/u.exec(value);
  if (scp !== null) slug = cleanRepositoryPart(scp[1] ?? "");
  if (slug === null) {
    try {
      const url = new URL(value);
      if (
        url.hostname !== "github.com" ||
        url.password !== "" ||
        (url.protocol === "https:" && url.username !== "") ||
        (url.protocol === "ssh:" && url.username !== "git") ||
        (url.protocol !== "https:" && url.protocol !== "ssh:") ||
        url.port !== "" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        return null;
      }
      slug = cleanRepositoryPart(url.pathname.replace(/^\//u, ""));
    } catch {
      return null;
    }
  }
  const parsed = githubRepositorySlugSchema.safeParse(slug);
  return parsed.success ? parsed.data : null;
};

const yamlKey = (name: string): string => `(?:${name}|"${name}"|'${name}')`;
const topLevelOnPattern = new RegExp(`^${yamlKey("on")}:\\s*(?:#.*)?$`, "u");
const inlineWorkflowDispatchPattern = new RegExp(
  `^${yamlKey("on")}:\\s*${yamlKey("workflow_dispatch")}\\s*(?:#.*)?$`,
  "u",
);
const workflowDispatchKeyPattern = new RegExp(
  `^( +)${yamlKey("workflow_dispatch")}:\\s*(?:\\{\\s*\\})?\\s*(?:#.*)?$`,
  "u",
);

/**
 * A deliberately narrow recognizer for the fixed workflow's dispatch authority.
 *
 * It accepts the two ordinary GitHub forms (`on: workflow_dispatch` and a direct
 * `workflow_dispatch:` child below top-level `on:`), while comments, nested keys, aliases and block
 * scalars cannot manufacture a match. Unknown valid YAML is refused rather than interpreted.
 */
export const hasWorkflowDispatchTrigger = (raw: string): boolean => {
  if (raw.includes("\t")) return false;
  const lines = raw.split(/\r?\n/gu);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (inlineWorkflowDispatchPattern.test(line)) return true;
    if (!topLevelOnPattern.test(line)) continue;

    const children: { indent: number; workflowDispatch: boolean }[] = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex] ?? "";
      if (child.trim() === "" || child.trimStart().startsWith("#")) continue;
      const indentation = /^( *)/u.exec(child)?.[1]?.length ?? 0;
      if (indentation === 0) break;
      children.push({
        indent: indentation,
        workflowDispatch: workflowDispatchKeyPattern.test(child),
      });
    }
    if (children.length === 0) return false;
    const directIndent = Math.min(...children.map(({ indent }) => indent));
    return children.some(({ indent, workflowDispatch }) => indent === directIndent && workflowDispatch);
  }
  return false;
};

const expectedRunUrl = (repositorySlug: string, runId: number): string =>
  `https://github.com/${repositorySlug}/actions/runs/${runId.toString()}`;

export const parseGithubActionsDispatchOutput = (
  raw: string,
  repositorySlug: string,
): DeploymentDispatchOutcome => {
  const lines = raw
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return { type: "UNKNOWN" };
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)$/u.exec(
      lines[0] ?? "",
    );
  if (match?.[1] !== repositorySlug) return { type: "UNKNOWN" };
  const runId = Number(match[2]);
  if (!Number.isSafeInteger(runId) || runId <= 0) return { type: "UNKNOWN" };
  const runUrl = expectedRunUrl(repositorySlug, runId);
  return { type: "DISPATCHED", runId, runUrl };
};

const githubRunObservationSchema = z
  .object({
    databaseId: z.number().int().positive(),
    status: z.string().min(1).max(64),
    conclusion: z.string().max(64),
    headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    event: z.string().min(1).max(64),
    url: z.url().max(2_048),
  })
  .strict();

export const githubActionsObservationFromOutput = (
  raw: string,
  expected: { repositorySlug: string; commitSha: string; runId: number },
): DeploymentObservationOutcome => {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { type: "UNKNOWN" };
  }
  const parsed = githubRunObservationSchema.safeParse(parsedJson);
  if (!parsed.success) return { type: "UNKNOWN" };
  const run = parsed.data;
  if (
    run.databaseId !== expected.runId ||
    run.headSha !== expected.commitSha ||
    run.event !== "workflow_dispatch" ||
    run.url !== expectedRunUrl(expected.repositorySlug, expected.runId)
  ) {
    return { type: "UNKNOWN" };
  }
  if (["queued", "in_progress", "pending", "requested", "waiting"].includes(run.status)) {
    return { type: "RUNNING" };
  }
  if (run.status !== "completed") return { type: "UNKNOWN" };
  if (run.conclusion === "success") return { type: "SUCCEEDED" };
  if (run.conclusion === "cancelled") return { type: "FAILED", failureCode: "REMOTE_CANCELLED" };
  if (run.conclusion === "timed_out") return { type: "FAILED", failureCode: "REMOTE_TIMED_OUT" };
  if (["failure", "startup_failure"].includes(run.conclusion)) {
    return { type: "FAILED", failureCode: "REMOTE_FAILURE" };
  }
  if (["action_required", "neutral", "skipped", "stale"].includes(run.conclusion)) {
    return { type: "FAILED", failureCode: "REMOTE_ACTION_REQUIRED" };
  }
  return { type: "UNKNOWN" };
};

const copyEnvironment = (target: Record<string, string>, source: EnvironmentSource, key: string): void => {
  const value = source[key];
  if (value !== undefined && value !== "") target[key] = value;
};

export const githubCliEnvironment = (
  source: EnvironmentSource,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {
    NO_COLOR: "1",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "",
  };
  for (const key of platform === "win32"
    ? (["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "USERPROFILE", "APPDATA"] as const)
    : (["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL"] as const)) {
    copyEnvironment(environment, source, key);
  }
  return environment;
};

const processSucceeded = (result: SupervisedProcessResult): boolean =>
  result.termination === "EXITED" &&
  result.exitCode === 0 &&
  result.signal === null &&
  !result.output.truncated;

const argvDigest = (args: readonly string[]): string =>
  createHash("sha256").update(args.join("\0"), "utf8").digest("hex");

const dispatchArgs = (input: {
  workflowPath: string;
  branch: string;
  repositorySlug: string;
}): readonly string[] => [
  "workflow",
  "run",
  input.workflowPath,
  "--ref",
  input.branch,
  "--repo",
  input.repositorySlug,
];

const sameTarget = (left: GithubActionsDeploymentTarget, right: GithubActionsDeploymentTarget): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const createGithubActionsDeploymentDriver = (
  options: {
    runProcess?: ProcessRunner;
    systemEnvironment?: EnvironmentSource;
    platform?: NodeJS.Platform;
  } = {},
): DeploymentDriver => {
  const runProcess = options.runProcess ?? runSupervisedProcess;
  const sourceEnvironment = options.systemEnvironment ?? process.env;
  const platform = options.platform ?? process.platform;
  const environment = githubCliEnvironment(sourceEnvironment, platform);
  const redactValues = Object.entries(sourceEnvironment)
    .filter(
      ([key, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSCODE|COOKIE|AUTH|PRIVATE_KEY)/iu.test(key) &&
        typeof value === "string" &&
        value.length >= 6,
    )
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);

  const runGh = (
    args: readonly string[],
    input: { cwd: string; deadlineMs: number; outputLimitBytes: number; signal?: AbortSignal },
  ): Promise<SupervisedProcessResult> =>
    runProcess({
      command: "gh",
      args,
      cwd: input.cwd,
      env: environment,
      deadlineMs: input.deadlineMs,
      outputLimitBytes: input.outputLimitBytes,
      redactValues,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

  const preflight: DeploymentDriver["preflight"] = async (input): Promise<DeploymentPreflightResult> => {
    const workflowPath = workflowPathFor(input.environmentKind);
    const repository = await inspectRepository(input.repositoryPath).catch(() => null);
    if (repository === null) {
      return { type: "BLOCKED", code: "REPOSITORY_UNAVAILABLE" };
    }
    if (repository.headCommit === null) {
      return { type: "BLOCKED", code: "REPOSITORY_UNAVAILABLE" };
    }
    const [canonicalInput, canonicalTopLevel, registeredPathDetails] = await Promise.all([
      realpath(resolve(input.repositoryPath)).catch(() => null),
      realpath(repository.topLevel).catch(() => null),
      lstat(resolve(input.repositoryPath)).catch(() => null),
    ]);
    if (
      canonicalInput === null ||
      canonicalTopLevel === null ||
      registeredPathDetails === null ||
      registeredPathDetails.isSymbolicLink() ||
      !sameCanonicalPath(canonicalInput, canonicalTopLevel, platform)
    ) {
      return { type: "BLOCKED", code: "REPOSITORY_PATH_NOT_CANONICAL" };
    }
    if (repository.inProgress !== null) {
      return { type: "BLOCKED", code: "REPOSITORY_OPERATION_IN_PROGRESS" };
    }
    const [sourceTree, headTreeResult, branch, remoteResult, workflowTreeResult] = await Promise.all([
      treeOfWorktree({ worktreePath: canonicalTopLevel }).catch(() => null),
      runGit(["rev-parse", `${repository.headCommit}^{tree}`], {
        cwd: canonicalTopLevel,
        maxStdoutBytes: 128,
        maxStderrBytes: SMALL_OUTPUT_LIMIT,
      }).catch(() => null),
      readCurrentBranch(canonicalTopLevel).catch(() => null),
      runGit(["remote", "get-url", "origin"], {
        cwd: canonicalTopLevel,
        maxStdoutBytes: SMALL_OUTPUT_LIMIT,
        maxStderrBytes: SMALL_OUTPUT_LIMIT,
      }).catch(() => null),
      runGit(["ls-tree", "-z", "HEAD", "--", workflowPath], {
        cwd: canonicalTopLevel,
        maxStdoutBytes: SMALL_OUTPUT_LIMIT,
        maxStderrBytes: SMALL_OUTPUT_LIMIT,
      }).catch(() => null),
    ]);
    const headTree = headTreeResult?.stdout.trim() ?? "";
    if (
      sourceTree === null ||
      headTreeResult?.exitCode !== 0 ||
      headTreeResult.stdoutTruncated ||
      !/^[0-9a-f]{40}$/u.test(headTree) ||
      sourceTree !== headTree ||
      sourceTree !== input.releaseTree
    ) {
      return { type: "BLOCKED", code: "SOURCE_DIRTY" };
    }
    if (branch === null || !deploymentBranchSchema.safeParse(branch).success) {
      return { type: "BLOCKED", code: "DETACHED_HEAD" };
    }
    const repositorySlug =
      remoteResult?.exitCode === 0 && !remoteResult.stdoutTruncated
        ? parseGithubRemote(remoteResult.stdout)
        : null;
    if (repositorySlug === null) return { type: "BLOCKED", code: "REMOTE_INVALID" };

    if (workflowTreeResult?.exitCode !== 0 || workflowTreeResult.stdoutTruncated) {
      return { type: "BLOCKED", code: "WORKFLOW_MISSING" };
    }
    const workflowRecord = workflowTreeResult.stdout.replace(/\0$/u, "");
    if (workflowRecord.length === 0) return { type: "BLOCKED", code: "WORKFLOW_MISSING" };
    const workflowMatch = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(workflowRecord);
    if (workflowMatch?.[3] !== workflowPath) {
      return { type: "BLOCKED", code: "WORKFLOW_NOT_REGULAR" };
    }
    const workflowResult = await runGit(["show", `HEAD:${workflowPath}`], {
      cwd: canonicalTopLevel,
      maxStdoutBytes: MAX_WORKFLOW_BYTES + 1,
      maxStderrBytes: SMALL_OUTPUT_LIMIT,
    }).catch(() => null);
    if (workflowResult?.exitCode !== 0 || workflowResult.stdoutTruncated) {
      return { type: "BLOCKED", code: "WORKFLOW_TOO_LARGE" };
    }
    if (workflowResult.stdoutBytes > MAX_WORKFLOW_BYTES) {
      return { type: "BLOCKED", code: "WORKFLOW_TOO_LARGE" };
    }
    if (!hasWorkflowDispatchTrigger(workflowResult.stdout)) {
      return { type: "BLOCKED", code: "WORKFLOW_TRIGGER_MISSING" };
    }

    const auth = await runGh(["auth", "status", "--hostname", "github.com"], {
      cwd: canonicalTopLevel,
      deadlineMs: 5_000,
      outputLimitBytes: SMALL_OUTPUT_LIMIT,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }).catch(() => null);
    if (auth === null || auth.termination === "SPAWN_FAILED") {
      return { type: "BLOCKED", code: "CLI_UNAVAILABLE" };
    }
    if (!processSucceeded(auth)) return { type: "BLOCKED", code: "AUTH_REQUIRED" };

    const remoteBranch = await runGh(
      ["api", `repos/${repositorySlug}/git/ref/heads/${encodeURIComponent(branch)}`, "--jq", ".object.sha"],
      {
        cwd: canonicalTopLevel,
        deadlineMs: 10_000,
        outputLimitBytes: 256,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    ).catch(() => null);
    if (remoteBranch === null || !processSucceeded(remoteBranch)) {
      return { type: "BLOCKED", code: "REMOTE_BRANCH_UNAVAILABLE" };
    }
    const remoteCommit = remoteBranch.output.text.trim();
    if (!/^[0-9a-f]{40}$/u.test(remoteCommit) || remoteCommit !== repository.headCommit) {
      return { type: "BLOCKED", code: "REMOTE_COMMIT_MISMATCH" };
    }

    const target = githubActionsDeploymentTargetV2Schema.parse({
      presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2",
      presetRevision: 2,
      environmentKind: input.environmentKind,
      repositorySlug,
      branch,
      commitSha: repository.headCommit,
      workflowPath,
      workflowContentHash: createHash("sha256").update(workflowResult.stdout, "utf8").digest("hex"),
      argvDigest: argvDigest(dispatchArgs({ workflowPath, branch, repositorySlug })),
      dispatchTimeoutSeconds: 30,
      observeTimeoutSeconds: 15,
      outputLimitBytes: 32_768,
      observeOutputLimitBytes: 65_536,
    });
    return { type: "READY", target };
  };

  return {
    preflight,
    dispatch: async (input) => {
      if (input.target.presetId !== "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2") {
        return { type: "REFUSED" };
      }
      const current = await preflight({
        repositoryPath: input.repositoryPath,
        releaseTree: input.releaseTree,
        environmentKind: input.target.environmentKind,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (current.type !== "READY" || !sameTarget(current.target, input.target)) {
        return { type: "REFUSED" };
      }
      const result = await runGh(dispatchArgs(input.target), {
        cwd: input.repositoryPath,
        deadlineMs: input.target.dispatchTimeoutSeconds * 1_000,
        outputLimitBytes: input.target.outputLimitBytes,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }).catch(() => null);
      if (result === null) return { type: "UNKNOWN" };
      if (result.termination === "SPAWN_FAILED") return { type: "REFUSED" };
      if (!processSucceeded(result)) return { type: "UNKNOWN" };
      return parseGithubActionsDispatchOutput(result.output.text, input.target.repositorySlug);
    },
    observe: async (input) => {
      const result = await runGh(
        [
          "run",
          "view",
          input.runId.toString(),
          "--repo",
          input.target.repositorySlug,
          "--json",
          "databaseId,status,conclusion,headSha,event,url",
        ],
        {
          cwd: process.cwd(),
          deadlineMs: input.target.observeTimeoutSeconds * 1_000,
          outputLimitBytes: input.target.observeOutputLimitBytes,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      ).catch(() => null);
      if (result === null || !processSucceeded(result)) return { type: "UNKNOWN" };
      return githubActionsObservationFromOutput(result.output.text, {
        repositorySlug: input.target.repositorySlug,
        commitSha: input.target.commitSha,
        runId: input.runId,
      });
    },
  };
};
