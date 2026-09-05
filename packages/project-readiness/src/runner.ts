import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
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

import { verificationRecipeAuthorityIsCurrent } from "./verification.js";

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
  runtimePath: readonly string[];
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
  environment["PATH"] = input.runtimePath.join(input.platform === "win32" ? ";" : ":");
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

type VerificationInvocation = {
  command: string;
  args: readonly string[];
  runtimePath: readonly string[];
};

const canonicalRegularFile = async (path: string): Promise<string | null> => {
  const canonical = await realpath(path).catch(() => null);
  if (canonical === null) return null;
  const details = await lstat(canonical).catch(() => null);
  return details?.isFile() === true && !details.isSymbolicLink() ? canonical : null;
};

const baselineRuntimeDirectories = (
  platform: VerificationPlatform,
  source: EnvironmentSource,
): readonly string[] => {
  const systemRoot = source["SystemRoot"] ?? source["WINDIR"];
  const candidates =
    platform === "win32"
      ? [dirname(process.execPath), ...(systemRoot === undefined ? [] : [join(systemRoot, "System32")])]
      : [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"];
  return [...new Set(candidates.filter((candidate) => isAbsolute(candidate)))];
};

const executableSearchDirectories = async (input: {
  canonicalWorktree: string;
  platform: VerificationPlatform;
  runtimeDirectories: readonly string[];
  source: EnvironmentSource;
}): Promise<readonly string[]> => {
  const sourcePath = input.source["PATH"] ?? input.source["Path"] ?? input.source["path"] ?? "";
  const candidates = [
    ...input.runtimeDirectories,
    ...sourcePath
      .split(input.platform === "win32" ? ";" : ":")
      .slice(0, 128)
      .map((entry) => entry.trim().replace(/^"|"$/gu, "")),
  ];
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.length === 0 || candidate.length > 4_096 || !isAbsolute(candidate)) continue;
    const canonical = await realpath(candidate).catch(() => null);
    if (canonical === null || inside(input.canonicalWorktree, canonical, input.platform)) continue;
    const key = input.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(canonical);
  }
  return directories;
};

const invocationForFile = async (input: {
  candidate: string;
  args: readonly string[];
  canonicalWorktree: string;
  platform: VerificationPlatform;
  runtimeDirectories: readonly string[];
}): Promise<VerificationInvocation | null> => {
  const command = await canonicalRegularFile(input.candidate);
  if (command === null || inside(input.canonicalWorktree, command, input.platform)) return null;
  return {
    command,
    args: input.args,
    runtimePath: [...new Set([dirname(process.execPath), dirname(command), ...input.runtimeDirectories])],
  };
};

const resolveWindowsInvocation = async (
  recipe: VerificationRecipe,
  canonicalWorktree: string,
  directories: readonly string[],
  runtimeDirectories: readonly string[],
): Promise<VerificationInvocation | null> => {
  for (const directory of directories) {
    if (recipe.executable === "bun") {
      const invocation = await invocationForFile({
        candidate: join(directory, "bun.exe"),
        args: recipe.argv,
        canonicalWorktree,
        platform: "win32",
        runtimeDirectories,
      });
      if (invocation !== null) return invocation;
      continue;
    }
    if (recipe.executable === "pnpm") {
      const standalone = await invocationForFile({
        candidate: join(directory, "pnpm.exe"),
        args: recipe.argv,
        canonicalWorktree,
        platform: "win32",
        runtimeDirectories,
      });
      if (standalone !== null) return standalone;
    }
    const launcherCandidates: readonly string[] =
      recipe.executable === "npm"
        ? [join(directory, "node_modules", "npm", "bin", "npm-cli.js")]
        : recipe.executable === "pnpm"
          ? [
              join(directory, "node_modules", "corepack", "dist", "pnpm.js"),
              join(directory, "node_modules", "pnpm", "bin", "pnpm.cjs"),
            ]
          : [
              join(directory, "node_modules", "corepack", "dist", "yarn.js"),
              join(directory, "node_modules", "yarn", "bin", "yarn.js"),
            ];
    for (const candidate of launcherCandidates) {
      const launcher = await canonicalRegularFile(candidate);
      if (launcher === null || inside(canonicalWorktree, launcher, "win32")) continue;
      return {
        command: process.execPath,
        args: [launcher, ...recipe.argv],
        runtimePath: [...new Set([dirname(process.execPath), dirname(launcher), ...runtimeDirectories])],
      };
    }
  }
  return null;
};

const resolvePosixInvocation = async (
  recipe: VerificationRecipe,
  canonicalWorktree: string,
  directories: readonly string[],
  runtimeDirectories: readonly string[],
  platform: Extract<VerificationPlatform, "darwin" | "linux">,
): Promise<VerificationInvocation | null> => {
  if (recipe.executable === "node") {
    return {
      command: process.execPath,
      args: recipe.argv,
      runtimePath: [...new Set([dirname(process.execPath), ...runtimeDirectories])],
    };
  }
  for (const directory of directories) {
    const invocation = await invocationForFile({
      candidate: join(directory, recipe.executable),
      args: recipe.argv,
      canonicalWorktree,
      platform,
      runtimeDirectories,
    });
    if (invocation !== null) return invocation;
  }
  return null;
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
  if (
    !(await verificationRecipeAuthorityIsCurrent({
      canonicalCwd,
      canonicalWorktree,
      recipe: input.recipe,
    }))
  ) {
    return {
      observation: errorObservation("RECIPE_NOT_APPROVED", completedNow()),
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
    const runtimeDirectories = baselineRuntimeDirectories(platform, source);
    const directories = await executableSearchDirectories({
      canonicalWorktree,
      platform,
      runtimeDirectories,
      source,
    });
    const invocation =
      platform === "win32"
        ? input.recipe.executable === "node"
          ? {
              command: process.execPath,
              args: input.recipe.argv,
              runtimePath: runtimeDirectories,
            }
          : await resolveWindowsInvocation(input.recipe, canonicalWorktree, directories, runtimeDirectories)
        : await resolvePosixInvocation(
            input.recipe,
            canonicalWorktree,
            directories,
            runtimeDirectories,
            platform,
          );
    if (invocation === null) {
      return {
        observation: errorObservation("EXECUTABLE_NOT_FOUND", completedNow()),
        artifactPath: null,
        beforeTree,
        afterTree: beforeTree,
      };
    }
    const processResult = await runSupervisedProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: canonicalCwd,
      env: verificationBaselineEnvironment({
        platform,
        isolatedHome,
        runtimePath: invocation.runtimePath,
        source,
      }),
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
