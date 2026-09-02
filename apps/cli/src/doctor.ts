import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { platform as runtimePlatform } from "node:os";
import { dirname, join } from "node:path";

import { inspectProviderAvailability, type ProviderAvailabilitySnapshot } from "@loomrail/daemon";
import { inspectStateDatabase, type StateDatabaseInspection } from "@loomrail/persistence-sqlite";

import { resolveLoomrailDataLocation, type LoomrailDataLocation } from "./app-data.js";

type CheckStatus = "PASS" | "WARN" | "FAIL";
type GitInspection = "AVAILABLE" | "MISSING" | "UNAVAILABLE";
type DataDirectoryInspection = "READY" | "NOT_CREATED" | "UNAVAILABLE";

export type DoctorReport = {
  schemaVersion: 1;
  status: CheckStatus;
  platform: "darwin" | "win32" | "linux" | "other";
  checks: {
    runtime: {
      status: CheckStatus;
      code: "RUNTIME_SUPPORTED" | "RUNTIME_UNSUPPORTED";
      nodeVersion: string;
    };
    git: {
      status: CheckStatus;
      code: "GIT_AVAILABLE" | "GIT_MISSING" | "GIT_UNAVAILABLE";
    };
    dataDirectory: {
      status: CheckStatus;
      code: "DATA_DIRECTORY_READY" | "DATA_DIRECTORY_NOT_CREATED" | "DATA_DIRECTORY_UNAVAILABLE";
      source: LoomrailDataLocation["source"];
    };
    stateDatabase: {
      status: CheckStatus;
      code: `STATE_${StateDatabaseInspection["status"]}`;
      appliedMigrations: number;
      expectedMigrations: number;
    };
    providers: {
      status: CheckStatus;
      code:
        "LIVE_PROVIDER_READY" | "MOCK_ONLY" | "INVALID_ENVIRONMENT_OVERRIDE" | "PROVIDER_PROBE_UNAVAILABLE";
      environmentOverride: ProviderAvailabilitySnapshot["environmentOverride"] | "UNKNOWN";
      items: ProviderAvailabilitySnapshot["providers"];
    };
  };
};

type DoctorDependencies = {
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  environment?: Readonly<Record<string, string | undefined>>;
  dataLocation?: LoomrailDataLocation;
  inspectGit?: () => Promise<GitInspection>;
  inspectDataDirectory?: (directory: string) => Promise<DataDirectoryInspection>;
  inspectStateDatabase?: (databasePath: string) => Promise<StateDatabaseInspection>;
  inspectProviders?: () => Promise<ProviderAvailabilitySnapshot>;
};

const normalizePlatform = (value: NodeJS.Platform): DoctorReport["platform"] =>
  value === "darwin" || value === "win32" || value === "linux" ? value : "other";

const missingPath = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const inspectExistingParent = async (directory: string): Promise<DataDirectoryInspection> => {
  let candidate = dirname(directory);
  for (;;) {
    try {
      const metadata = await stat(candidate);
      if (!metadata.isDirectory()) return "UNAVAILABLE";
      await access(candidate, constants.R_OK | constants.W_OK);
      return "NOT_CREATED";
    } catch (error: unknown) {
      if (!missingPath(error)) return "UNAVAILABLE";
    }
    const parent = dirname(candidate);
    if (parent === candidate) return "UNAVAILABLE";
    candidate = parent;
  }
};

export const inspectDataDirectory = async (directory: string): Promise<DataDirectoryInspection> => {
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) return "UNAVAILABLE";
    await access(directory, constants.R_OK | constants.W_OK);
    return "READY";
  } catch (error: unknown) {
    return missingPath(error) ? inspectExistingParent(directory) : "UNAVAILABLE";
  }
};

const gitProbeEnvironment = (
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

export const inspectGit = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GitInspection> =>
  new Promise((resolve) => {
    const child = spawn("git", ["--version"], {
      env: gitProbeEnvironment(environment),
      shell: false,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (result: GitInspection): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("UNAVAILABLE");
    }, 3_000);
    timer.unref();
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" ? "MISSING" : "UNAVAILABLE");
    });
    child.once("exit", (code) => {
      finish(code === 0 ? "AVAILABLE" : "UNAVAILABLE");
    });
  });

const runtimeCheck = (nodeVersion: string): DoctorReport["checks"]["runtime"] => {
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  const supported = major === 24 && minor >= 19;
  return {
    status: supported ? "PASS" : "FAIL",
    code: supported ? "RUNTIME_SUPPORTED" : "RUNTIME_UNSUPPORTED",
    nodeVersion,
  };
};

const gitCheck = (inspection: GitInspection): DoctorReport["checks"]["git"] => ({
  status: inspection === "AVAILABLE" ? "PASS" : "FAIL",
  code:
    inspection === "AVAILABLE"
      ? "GIT_AVAILABLE"
      : inspection === "MISSING"
        ? "GIT_MISSING"
        : "GIT_UNAVAILABLE",
});

const dataDirectoryCheck = (
  inspection: DataDirectoryInspection,
  source: LoomrailDataLocation["source"],
): DoctorReport["checks"]["dataDirectory"] => ({
  status: inspection === "READY" ? "PASS" : inspection === "NOT_CREATED" ? "WARN" : "FAIL",
  code: `DATA_DIRECTORY_${inspection}`,
  source,
});

const stateDatabaseCheck = (
  inspection: StateDatabaseInspection,
): DoctorReport["checks"]["stateDatabase"] => ({
  status:
    inspection.status === "READY"
      ? "PASS"
      : inspection.status === "MISSING" ||
          inspection.status === "UNINITIALIZED" ||
          inspection.status === "UPGRADE_REQUIRED"
        ? "WARN"
        : "FAIL",
  code: `STATE_${inspection.status}`,
  appliedMigrations: inspection.appliedMigrations,
  expectedMigrations: inspection.expectedMigrations,
});

const providerCheck = (
  snapshot: ProviderAvailabilitySnapshot | null,
): DoctorReport["checks"]["providers"] => {
  if (snapshot === null) {
    return {
      status: "WARN",
      code: "PROVIDER_PROBE_UNAVAILABLE",
      environmentOverride: "UNKNOWN",
      items: [],
    };
  }
  if (snapshot.environmentOverride === "INVALID") {
    return {
      status: "WARN",
      code: "INVALID_ENVIRONMENT_OVERRIDE",
      environmentOverride: snapshot.environmentOverride,
      items: snapshot.providers,
    };
  }
  const liveReady = snapshot.providers.some(({ provider, ready }) => provider !== "MOCK" && ready);
  return {
    status: liveReady ? "PASS" : "WARN",
    code: liveReady ? "LIVE_PROVIDER_READY" : "MOCK_ONLY",
    environmentOverride: snapshot.environmentOverride,
    items: snapshot.providers,
  };
};

const reportStatus = (statuses: readonly CheckStatus[]): CheckStatus =>
  statuses.includes("FAIL") ? "FAIL" : statuses.includes("WARN") ? "WARN" : "PASS";

export const collectDoctorReport = async (dependencies: DoctorDependencies = {}): Promise<DoctorReport> => {
  const environment = dependencies.environment ?? process.env;
  const dataLocation = dependencies.dataLocation ?? resolveLoomrailDataLocation({ environment });
  const [git, dataDirectory, stateDatabase, providers] = await Promise.all([
    (dependencies.inspectGit ?? (() => inspectGit(environment)))(),
    (dependencies.inspectDataDirectory ?? inspectDataDirectory)(dataLocation.directory),
    (dependencies.inspectStateDatabase ?? inspectStateDatabase)(join(dataLocation.directory, "state.sqlite")),
    (dependencies.inspectProviders ?? (() => inspectProviderAvailability(environment)))().catch(() => null),
  ]);
  const checks: DoctorReport["checks"] = {
    runtime: runtimeCheck(dependencies.nodeVersion ?? process.versions.node),
    git: gitCheck(git),
    dataDirectory: dataDirectoryCheck(dataDirectory, dataLocation.source),
    stateDatabase: stateDatabaseCheck(stateDatabase),
    providers: providerCheck(providers),
  };
  return {
    schemaVersion: 1,
    status: reportStatus(Object.values(checks).map(({ status }) => status)),
    platform: normalizePlatform(dependencies.platform ?? runtimePlatform()),
    checks,
  };
};

const line = (status: CheckStatus, label: string, detail: string): string =>
  `[${status}] ${label}: ${detail}`;

export const formatDoctorReport = (report: DoctorReport): readonly string[] => [
  `Loomrail doctor: ${report.status}`,
  line(
    report.checks.runtime.status,
    "Runtime",
    `${report.checks.runtime.code} (Node ${report.checks.runtime.nodeVersion})`,
  ),
  line(report.checks.git.status, "Git", report.checks.git.code),
  line(
    report.checks.dataDirectory.status,
    "Data directory",
    `${report.checks.dataDirectory.code} (${report.checks.dataDirectory.source})`,
  ),
  line(
    report.checks.stateDatabase.status,
    "State database",
    `${report.checks.stateDatabase.code} (${report.checks.stateDatabase.appliedMigrations.toString()}/${report.checks.stateDatabase.expectedMigrations.toString()} migrations)`,
  ),
  line(
    report.checks.providers.status,
    "Providers",
    `${report.checks.providers.code} (override ${report.checks.providers.environmentOverride})`,
  ),
  ...report.checks.providers.items.map(({ provider, installed, authentication, ready, stages }) =>
    line(
      ready ? "PASS" : "WARN",
      `Provider ${provider}`,
      `installed=${String(installed)}, authentication=${authentication}, stages=${stages.join(",")}`,
    ),
  ),
  "Run `loomrail data-path` only when you need the exact local storage path.",
];

export const serializeDoctorReport = (report: DoctorReport): string => JSON.stringify(report, null, 2);

export const formatCliHelp = (): readonly string[] => [
  "Usage: loomrail [command] [options]",
  "",
  "Commands:",
  "  start [--no-open] [--port N]  Start the local daemon and Workbench (default).",
  "  setup [--mode mock|live] [--json]  Check and guide the first full local walkthrough.",
  "  doctor [--json]               Inspect runtime, Git, local state, and providers read-only.",
  "  logs export                   Write a redacted NDJSON log export to stdout.",
  "  logs delete                   Delete only Loomrail-owned operational log segments.",
  "  data-path                     Print the exact local data directory.",
  "  help                          Show this help.",
];
