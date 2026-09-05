import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import type {
  VerificationCheckErrorCode,
  VerificationCheckObservation,
  VerificationOutputSummary,
  VerificationPlatform,
  VerificationRecipe,
} from "@loomrail/contracts";
import { runSupervisedProcess, type SupervisedProcessResult } from "@loomrail/process-supervision";
import { treeOfWorktree } from "@loomrail/workspace";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type VerificationRecipeExecution = {
  observation: VerificationCheckObservation;
  artifactPath: string | null;
  beforeTree: string | null;
  afterTree: string | null;
};

export type ExecuteVerificationRecipeInput = {
  recipe: VerificationRecipe;
  worktreePath: string;
  artifactDirectory: string;
  artifactId: string;
  expectedTree?: string;
  systemEnvironment?: EnvironmentSource;
  platform?: VerificationPlatform;
  signal?: AbortSignal;
};

const samePath = (left: string, right: string, platform: VerificationPlatform): boolean => {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const inside = (root: string, candidate: string, platform: VerificationPlatform): boolean => {
  if (samePath(root, candidate, platform)) return true;
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const supportedPlatform = (platform: NodeJS.Platform): VerificationPlatform => {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new Error("Project verification is unavailable on this platform");
};

const prospectiveCanonicalPath = async (path: string): Promise<string> => {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch (error: unknown) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
};

const copyEnvironmentValue = (
  target: Record<string, string>,
  source: EnvironmentSource,
  key: string,
): void => {
  const value = source[key];
  if (value !== undefined && value !== "") target[key] = value;
};

export const verificationBaselineEnvironment = (input: {
  platform: VerificationPlatform;
  isolatedHome: string;
  source: EnvironmentSource;
}): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {
    CI: "1",
    NO_COLOR: "1",
    LOOMRAIL_VERIFICATION: "1",
    HOME: input.isolatedHome,
    USERPROFILE: input.isolatedHome,
    XDG_CACHE_HOME: join(input.isolatedHome, "cache"),
    npm_config_cache: join(input.isolatedHome, "npm-cache"),
    COREPACK_HOME: join(input.isolatedHome, "corepack"),
    TMPDIR: join(input.isolatedHome, "tmp"),
    TEMP: join(input.isolatedHome, "tmp"),
    TMP: join(input.isolatedHome, "tmp"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  const sourcePath = input.source["PATH"] ?? input.source["Path"] ?? input.source["path"];
  if (sourcePath !== undefined && sourcePath !== "") environment["PATH"] = sourcePath;
  if (input.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
      copyEnvironmentValue(environment, input.source, key);
    }
  } else {
    copyEnvironmentValue(environment, input.source, "LANG");
    copyEnvironmentValue(environment, input.source, "LC_ALL");
  }
  return environment;
};

const errorObservation = (
  errorCode: VerificationCheckErrorCode,
  completedAt: string,
  durationMs = 0,
): VerificationCheckObservation => ({
  status: "ERROR",
  completedAt,
  durationMs,
  exitCode: null,
  signal: null,
  errorCode,
  output: null,
});

const outputRedactions = (source: EnvironmentSource, paths: readonly string[]): readonly string[] => {
  const secretValues = Object.entries(source)
    .filter(
      ([key, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSCODE|COOKIE|AUTH|PRIVATE_KEY)/iu.test(key) &&
        typeof value === "string" &&
        value.length >= 6,
    )
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);
  return [source["HOME"], source["USERPROFILE"], ...paths, ...secretValues].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
};

const persistOutput = async (input: {
  artifactDirectory: string;
  artifactId: string;
  canonicalWorktree: string;
  platform: VerificationPlatform;
  processResult: SupervisedProcessResult;
}): Promise<{ artifactPath: string; output: VerificationOutputSummary }> => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(input.artifactId)) {
    throw new Error("Invalid verification output artifact id");
  }
  await mkdir(input.artifactDirectory, { recursive: true, mode: 0o700 });
  const canonicalArtifacts = await realpath(input.artifactDirectory);
  if (inside(input.canonicalWorktree, canonicalArtifacts, input.platform)) {
    throw new Error("Verification output artifacts must stay outside the Project worktree");
  }
  const artifactPath = join(canonicalArtifacts, `${input.artifactId}.txt`);
  const handle = await open(artifactPath, "wx", 0o600);
  try {
    await handle.writeFile(input.processResult.output.text, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await rm(artifactPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return {
    artifactPath,
    output: {
      schemaVersion: 1,
      artifactId: input.artifactId,
      sha256: createHash("sha256").update(input.processResult.output.text, "utf8").digest("hex"),
      capturedBytes: input.processResult.output.capturedBytes,
      stdoutBytes: input.processResult.output.stdoutBytes,
      stderrBytes: input.processResult.output.stderrBytes,
      truncated: input.processResult.output.truncated,
      available: true,
    },
  };
};

const observationFor = (
  processResult: SupervisedProcessResult,
  completedAt: string,
  output: VerificationOutputSummary,
  treeChanged: boolean,
): VerificationCheckObservation => {
  if (treeChanged) {
    return {
      status: "ERROR",
      completedAt,
      durationMs: processResult.durationMs,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      errorCode: "TREE_MUTATED",
      output,
    };
  }
  if (processResult.termination === "CANCELLED") {
    return {
      status: "INTERRUPTED",
      completedAt,
      durationMs: processResult.durationMs,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      reason: "OWNER_CANCELLED",
      output,
    };
  }
  const errorCode: VerificationCheckErrorCode | null =
    processResult.termination === "TIMED_OUT"
      ? "TIMED_OUT"
      : processResult.termination === "OUTPUT_LIMIT_REACHED"
        ? "OUTPUT_LIMIT_REACHED"
        : processResult.termination === "TERMINATION_FAILED"
          ? "PROCESS_TERMINATION_FAILED"
          : processResult.termination === "SPAWN_FAILED"
            ? processResult.spawnErrorCode === "ENOENT"
              ? "EXECUTABLE_NOT_FOUND"
              : "SPAWN_FAILED"
            : processResult.exitCode === null || processResult.signal !== null
              ? "EXIT_UNOBSERVED"
              : null;
  if (errorCode !== null) {
    return {
      status: "ERROR",
      completedAt,
      durationMs: processResult.durationMs,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      errorCode,
      output,
    };
  }
  if (processResult.exitCode === 0) {
    return {
      status: "PASSED",
      completedAt,
      durationMs: processResult.durationMs,
      exitCode: 0,
      signal: null,
      output,
    };
  }
  if (processResult.exitCode === null) {
    throw new Error("A supervised process without an exit code must have a typed error");
  }
  return {
    status: "FAILED",
    completedAt,
    durationMs: processResult.durationMs,
    exitCode: processResult.exitCode,
    signal: null,
    output,
  };
};

export const executeVerificationRecipe = async (
  input: ExecuteVerificationRecipeInput,
): Promise<VerificationRecipeExecution> => {
  const platform = input.platform ?? supportedPlatform(process.platform);
  const completedNow = (): string => new Date().toISOString();
  let canonicalWorktree: string;
  let beforeTree: string;
  try {
    canonicalWorktree = await realpath(input.worktreePath);
    beforeTree = await treeOfWorktree({ worktreePath: canonicalWorktree });
  } catch {
    return {
      observation: errorObservation("TREE_UNAVAILABLE", completedNow()),
      artifactPath: null,
      beforeTree: null,
      afterTree: null,
    };
  }
  if (input.expectedTree !== undefined && input.expectedTree !== beforeTree) {
    return {
      observation: errorObservation("TREE_MUTATED", completedNow()),
      artifactPath: null,
      beforeTree,
      afterTree: beforeTree,
    };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(input.artifactId)) {
    return {
      observation: errorObservation("OUTPUT_WRITE_FAILED", completedNow()),
      artifactPath: null,
      beforeTree,
      afterTree: beforeTree,
    };
  }
  const prospectiveArtifacts = await prospectiveCanonicalPath(input.artifactDirectory).catch(() => null);
  if (prospectiveArtifacts === null || inside(canonicalWorktree, prospectiveArtifacts, platform)) {
    return {
      observation: errorObservation("OUTPUT_WRITE_FAILED", completedNow()),
      artifactPath: null,
      beforeTree,
      afterTree: beforeTree,
    };
  }
  if (input.recipe.networkPolicy === "DENIED_UNAVAILABLE") {
    return {
      observation: errorObservation("POLICY_UNAVAILABLE", completedNow()),
      artifactPath: null,
      beforeTree,
      afterTree: beforeTree,
    };
  }
  const requestedCwd =
    input.recipe.cwd === "." ? canonicalWorktree : join(canonicalWorktree, input.recipe.cwd);
  const canonicalCwd = await realpath(requestedCwd).catch(() => null);
  if (canonicalCwd === null || !inside(canonicalWorktree, canonicalCwd, platform)) {
    return {
      observation: errorObservation("CWD_INVALID", completedNow()),
      artifactPath: null,
      beforeTree,
      afterTree: beforeTree,
    };
  }

  const isolatedHome = await mkdtemp(join(tmpdir(), "loomrail-verification-"));
  try {
    await Promise.all([
      mkdir(join(isolatedHome, "cache"), { recursive: true }),
      mkdir(join(isolatedHome, "npm-cache"), { recursive: true }),
      mkdir(join(isolatedHome, "corepack"), { recursive: true }),
      mkdir(join(isolatedHome, "tmp"), { recursive: true }),
    ]);
    const source = input.systemEnvironment ?? process.env;
    const processResult = await runSupervisedProcess({
      command: input.recipe.executable,
      args: input.recipe.argv,
      cwd: canonicalCwd,
      env: verificationBaselineEnvironment({ platform, isolatedHome, source }),
      deadlineMs: input.recipe.timeoutSeconds * 1_000,
      outputLimitBytes: input.recipe.outputLimitBytes,
      redactValues: outputRedactions(source, [
        canonicalWorktree,
        canonicalCwd,
        isolatedHome,
        input.artifactDirectory,
      ]),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    let afterTree: string | null;
    try {
      afterTree = await treeOfWorktree({ worktreePath: canonicalWorktree });
    } catch {
      afterTree = null;
    }
    let persisted: Awaited<ReturnType<typeof persistOutput>>;
    try {
      persisted = await persistOutput({
        artifactDirectory: input.artifactDirectory,
        artifactId: input.artifactId,
        canonicalWorktree,
        platform,
        processResult,
      });
    } catch {
      return {
        observation: errorObservation("OUTPUT_WRITE_FAILED", completedNow(), processResult.durationMs),
        artifactPath: null,
        beforeTree,
        afterTree,
      };
    }
    if (afterTree === null) {
      return {
        observation: {
          ...errorObservation("TREE_UNAVAILABLE", completedNow(), processResult.durationMs),
          output: persisted.output,
        },
        artifactPath: persisted.artifactPath,
        beforeTree,
        afterTree,
      };
    }
    return {
      observation: observationFor(processResult, completedNow(), persisted.output, beforeTree !== afterTree),
      artifactPath: persisted.artifactPath,
      beforeTree,
      afterTree,
    };
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
};
