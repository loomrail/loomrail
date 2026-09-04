import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

import type { ProviderAuthentication, ProviderCompatibility } from "@loomrail/contracts";

const DEFAULT_PROBE_DEADLINE_MS = 3_000;
const DEFAULT_VERSION_OUTPUT_LIMIT_BYTES = 96;
const NORMALIZED_VERSION_LIMIT = 48;

export type ProviderVersionObservation = {
  compatibility: Exclude<ProviderCompatibility, "BUILT_IN" | "MISSING">;
  version: string | null;
};

type SemanticVersion = {
  normalized: string;
  core: readonly [number, number, number];
  prerelease: boolean;
};

export type ProviderDiagnosticProbeOptions = {
  command?: string;
  commandArgsPrefix?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  deadlineMs?: number;
  outputLimitBytes?: number;
};

export type ProviderRuntimeTarget = {
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
};

export type VerifiedProviderTarget = ProviderRuntimeTarget & {
  version: string;
};

export type CliProviderDiagnostics = {
  executableAvailable: (environment?: Readonly<Record<string, string | undefined>>) => boolean;
  classifyVersion: (output: string) => ProviderVersionObservation;
  probeVersion: (options?: ProviderDiagnosticProbeOptions) => Promise<ProviderVersionObservation>;
  probeAuthentication: (options?: ProviderDiagnosticProbeOptions) => Promise<ProviderAuthentication>;
};

type CliProviderDiagnosticDefinition = {
  command: string;
  versionArguments: readonly string[];
  authenticationArguments: readonly string[];
  versionFromOutput: (output: string) => string | null;
  minimumVersion?: string;
  verifiedTargets: readonly VerifiedProviderTarget[];
};

const targetKey = (target: VerifiedProviderTarget): string =>
  `${target.version}\0${target.platform}\0${target.architecture}`;

const pathExtensions = (environment: Readonly<Record<string, string | undefined>>): readonly string[] =>
  process.platform === "win32"
    ? [
        "",
        ...(environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter((extension) => extension.length > 0),
      ]
    : [""];

const executableAvailable = (
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
): boolean => {
  const bases =
    isAbsolute(command) || command.includes(sep)
      ? [command]
      : (environment["PATH"] ?? environment["Path"] ?? "")
          .split(delimiter)
          .filter((directory) => directory.length > 0)
          .map((directory) => join(directory, command));
  return bases.some((base) =>
    pathExtensions(environment).some((extension) => {
      try {
        accessSync(`${base}${extension}`, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
};

const allowEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );

const versionProbeEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv =>
  allowEnvironment(environment, [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]);

const authenticationProbeEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv =>
  allowEnvironment(environment, [
    "PATH",
    "Path",
    "PATHEXT",
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]);

const parseSemanticVersion = (value: string): SemanticVersion | null => {
  if (value.length > NORMALIZED_VERSION_LIMIT) return null;
  const match =
    /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (match === null) return null;
  const [, majorText, minorText, patchText, prerelease] = match;
  if (majorText === undefined || minorText === undefined || patchText === undefined) return null;
  if (
    prerelease
      ?.split(".")
      .some((identifier) => /^\d+$/.test(identifier) && identifier.startsWith("0") && identifier !== "0")
  ) {
    return null;
  }
  return {
    normalized: value,
    core: [Number(majorText), Number(minorText), Number(patchText)],
    prerelease: prerelease !== undefined,
  };
};

const compareCore = (left: SemanticVersion["core"], right: SemanticVersion["core"]): number => {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const createCliProviderDiagnostics = (
  definition: CliProviderDiagnosticDefinition,
  runtimeTarget: ProviderRuntimeTarget = {
    platform: process.platform,
    architecture: process.arch,
  },
): CliProviderDiagnostics => {
  const minimum =
    definition.minimumVersion === undefined ? null : parseSemanticVersion(definition.minimumVersion);
  if (definition.minimumVersion !== undefined && minimum === null) {
    throw new Error("The provider diagnostic minimum version is not valid SemVer");
  }
  const verified = new Set(
    definition.verifiedTargets.map((target) => {
      const parsed = parseSemanticVersion(target.version);
      if (parsed === null) throw new Error("A verified provider version is not valid SemVer");
      return targetKey({ ...target, version: parsed.normalized });
    }),
  );

  const classifyVersion = (output: string): ProviderVersionObservation => {
    const observed = definition.versionFromOutput(output);
    const parsed = observed === null ? null : parseSemanticVersion(observed);
    if (parsed === null) return { compatibility: "VERSION_UNREADABLE", version: null };
    if (minimum !== null) {
      const floorComparison = compareCore(parsed.core, minimum.core);
      if (floorComparison < 0 || (floorComparison === 0 && parsed.prerelease && !minimum.prerelease)) {
        return { compatibility: "TOO_OLD", version: parsed.normalized };
      }
    }
    return {
      compatibility: verified.has(targetKey({ ...runtimeTarget, version: parsed.normalized }))
        ? "VERIFIED"
        : "UNVERIFIED",
      version: parsed.normalized,
    };
  };

  const probeVersion = (options: ProviderDiagnosticProbeOptions = {}): Promise<ProviderVersionObservation> =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          options.command ?? definition.command,
          [...(options.commandArgsPrefix ?? []), ...definition.versionArguments],
          {
            env: versionProbeEnvironment(options.environment),
            shell: false,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
      } catch {
        resolve({ compatibility: "UNLAUNCHABLE", version: null });
        return;
      }
      let settled = false;
      let output = Buffer.alloc(0);
      const finish = (observation: ProviderVersionObservation): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(observation);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ compatibility: "UNLAUNCHABLE", version: null });
      }, options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS);
      timer.unref();
      child.once("error", () => {
        finish({ compatibility: "UNLAUNCHABLE", version: null });
      });
      const stdout = child.stdout;
      if (stdout === null) {
        child.kill("SIGKILL");
        finish({ compatibility: "UNLAUNCHABLE", version: null });
        return;
      }
      stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (
          output.byteLength + chunk.byteLength >
          (options.outputLimitBytes ?? DEFAULT_VERSION_OUTPUT_LIMIT_BYTES)
        ) {
          child.kill("SIGKILL");
          finish({ compatibility: "VERSION_UNREADABLE", version: null });
          return;
        }
        output = Buffer.concat([output, chunk]);
      });
      child.once("close", (code) => {
        finish(
          code === 0
            ? classifyVersion(output.toString("utf8"))
            : { compatibility: "VERSION_UNREADABLE", version: null },
        );
      });
    });

  const probeAuthentication = (
    options: ProviderDiagnosticProbeOptions = {},
  ): Promise<ProviderAuthentication> =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          options.command ?? definition.command,
          [...(options.commandArgsPrefix ?? []), ...definition.authenticationArguments],
          {
            env: authenticationProbeEnvironment(options.environment),
            shell: false,
            stdio: "ignore",
          },
        );
      } catch {
        resolve("UNKNOWN");
        return;
      }
      let settled = false;
      const finish = (result: ProviderAuthentication): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish("UNKNOWN");
      }, options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS);
      timer.unref();
      child.once("error", () => {
        finish("UNKNOWN");
      });
      child.once("exit", (code) => {
        finish(code === 0 ? "AUTHENTICATED" : code === 1 ? "REQUIRED" : "UNKNOWN");
      });
    });

  return {
    executableAvailable: (environment = process.env) => executableAvailable(definition.command, environment),
    classifyVersion,
    probeVersion,
    probeAuthentication,
  };
};
