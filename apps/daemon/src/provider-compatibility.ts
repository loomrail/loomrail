import { spawn } from "node:child_process";

import type { ProviderCompatibility } from "@loomrail/contracts";

const VERSION_PROBE_DEADLINE_MS = 3_000;
const VERSION_OUTPUT_LIMIT_BYTES = 96;
const NORMALIZED_VERSION_LIMIT = 48;

export type LiveProviderId = "CODEX" | "CLAUDE_CODE";

export type ProviderVersionObservation = {
  compatibility: Exclude<ProviderCompatibility, "BUILT_IN" | "MISSING">;
  version: string | null;
};

type SemanticVersion = {
  normalized: string;
  core: readonly [number, number, number];
  prerelease: boolean;
};

type VersionProbeOptions = {
  command?: string;
  commandArgsPrefix?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  deadlineMs?: number;
  outputLimitBytes?: number;
};

const versionCommand: Readonly<Record<LiveProviderId, string>> = {
  CODEX: "codex",
  CLAUDE_CODE: "claude",
};

// Empty by design: Q9 starts with no cross-platform, real-session-compatible live row. A future
// reviewed evidence slice may add exact strings here; never replace these arrays with semver ranges.
const verifiedVersions: Readonly<Record<LiveProviderId, readonly string[]>> = {
  CODEX: [],
  CLAUDE_CODE: [],
};

const CLAUDE_ADMISSION_FLOOR: SemanticVersion["core"] = [2, 1, 214];

const probeEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv => {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
};

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

const parseProviderVersion = (provider: LiveProviderId, output: string): SemanticVersion | null => {
  const trimmed = output.trim();
  const match =
    provider === "CODEX" ? /^codex-cli ([^\s]+)$/.exec(trimmed) : /^([^\s]+) \(Claude Code\)$/.exec(trimmed);
  return match?.[1] === undefined ? null : parseSemanticVersion(match[1]);
};

export const classifyProviderVersion = (
  provider: LiveProviderId,
  output: string,
): ProviderVersionObservation => {
  const parsed = parseProviderVersion(provider, output);
  if (parsed === null) return { compatibility: "VERSION_UNREADABLE", version: null };
  const floorComparison = compareCore(parsed.core, CLAUDE_ADMISSION_FLOOR);
  if (provider === "CLAUDE_CODE" && (floorComparison < 0 || (floorComparison === 0 && parsed.prerelease))) {
    return { compatibility: "TOO_OLD", version: parsed.normalized };
  }
  return {
    compatibility: verifiedVersions[provider].includes(parsed.normalized) ? "VERIFIED" : "UNVERIFIED",
    version: parsed.normalized,
  };
};

export const probeProviderVersion = (
  provider: LiveProviderId,
  options: VersionProbeOptions = {},
): Promise<ProviderVersionObservation> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        options.command ?? versionCommand[provider],
        [...(options.commandArgsPrefix ?? []), "--version"],
        {
          env: probeEnvironment(options.environment),
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ compatibility: "UNLAUNCHABLE", version: null });
    }, options.deadlineMs ?? VERSION_PROBE_DEADLINE_MS);
    const finish = (observation: ProviderVersionObservation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(observation);
    };
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
      if (output.byteLength + chunk.byteLength > (options.outputLimitBytes ?? VERSION_OUTPUT_LIMIT_BYTES)) {
        child.kill("SIGKILL");
        finish({ compatibility: "VERSION_UNREADABLE", version: null });
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.once("close", (code) => {
      finish(
        code === 0
          ? classifyProviderVersion(provider, output.toString("utf8"))
          : { compatibility: "VERSION_UNREADABLE", version: null },
      );
    });
  });
