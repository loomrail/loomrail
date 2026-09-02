import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

import {
  projectProviderSelectionResponseSchema,
  type Project,
  type ProjectProviderSelectionResponse,
  type ProviderAuthentication,
  type ProviderAvailability,
  type ProviderId,
  type ProviderPreference,
  type WorkflowStage,
} from "@loomrail/contracts";
import type { ProviderAdapter } from "@loomrail/provider-core";
import { createClaudeCodeProvider } from "@loomrail/provider-claude-code";
import { createCodexProvider } from "@loomrail/provider-codex";
import { createMockProvider } from "@loomrail/provider-mock";

export const LOOMRAIL_PROVIDER_ENV_VAR = "LOOMRAIL_PROVIDER";
export const LOOMRAIL_PROVIDER_VALUES = ["MOCK", "CODEX", "CLAUDE_CODE"] as const;

const AUTH_PROBE_DEADLINE_MS = 3_000;
const LIVE_PROVIDER_IDS = ["CODEX", "CLAUDE_CODE"] as const;

type LiveProviderId = (typeof LIVE_PROVIDER_IDS)[number];
type ProviderAdapters = Readonly<Record<ProviderId, ProviderAdapter>>;

export type ProviderAuthProbe = (provider: LiveProviderId) => Promise<ProviderAuthentication>;

export type ProviderResolution = {
  provider: ProviderId;
  adapter: ProviderAdapter;
  recognised: boolean;
  requested: string | null;
};

export type ProjectProviderResolution = {
  adapter: ProviderAdapter;
  response: ProjectProviderSelectionResponse;
};

export type ProviderRegistry = {
  refresh: () => Promise<void>;
  availability: () => readonly ProviderAvailability[];
  resolve: (
    project: Project,
    options?: { stage?: WorkflowStage | undefined; avoidProvider?: ProviderId | null | undefined },
  ) => ProjectProviderResolution;
  environment: {
    override: ProviderId | null;
    invalid: boolean;
    requested: string | null;
  };
};

const isProviderId = (value: string): value is ProviderId =>
  LOOMRAIL_PROVIDER_VALUES.some((provider) => provider === value);

const requestedEnvironmentProvider = (
  env: Readonly<Record<string, string | undefined>>,
): { override: ProviderId | null; invalid: boolean; requested: string | null } => {
  const raw = env[LOOMRAIL_PROVIDER_ENV_VAR];
  const requested = raw === undefined || raw.trim().length === 0 ? null : raw;
  if (requested === null) return { override: null, invalid: false, requested: null };
  return isProviderId(requested)
    ? { override: requested, invalid: false, requested }
    : { override: null, invalid: true, requested };
};

// Windows installs `codex` and `claude` as `codex.cmd`/`claude.cmd` (or `.exe`), and the file
// carrying the bare name usually does not exist at all, so probing the name alone reports every
// Windows machine as "not installed". `PATHEXT` is what the shell and `child_process.spawn`
// themselves append, so it is what a lookup that claims to answer "would this launch" must append
// too. The empty extension stays first for the POSIX case and for a name the owner already spelled
// with its extension.
const pathExtensions = (env: Readonly<Record<string, string | undefined>>): readonly string[] =>
  process.platform === "win32"
    ? [
        "",
        ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter((extension) => extension.length > 0),
      ]
    : [""];

const isExecutableOnDisk = (
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const bases =
    isAbsolute(command) || command.includes(sep)
      ? [command]
      : (env["PATH"] ?? "")
          .split(delimiter)
          .filter((directory) => directory.length > 0)
          .map((directory) => join(directory, command));
  const extensions = pathExtensions(env);
  return bases.some((base) =>
    extensions.some((extension) => {
      try {
        accessSync(`${base}${extension}`, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
};

// Only filesystem/auth locations needed by an official status command cross into the probe.
// API keys and arbitrary project environment never do. stdout/stderr are ignored below, so the
// daemon learns only the exit outcome and cannot accidentally retain account metadata.
const probeEnvironment = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv => {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
};

const statusCommand: Readonly<Record<LiveProviderId, { command: string; args: readonly string[] }>> = {
  CODEX: { command: "codex", args: ["login", "status"] },
  CLAUDE_CODE: { command: "claude", args: ["auth", "status"] },
};

export const probeProviderAuthentication: ProviderAuthProbe = (provider) =>
  new Promise((resolve) => {
    const command = statusCommand[provider];
    const child = spawn(command.command, command.args, {
      env: probeEnvironment(),
      shell: false,
      stdio: "ignore",
    });
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
    }, AUTH_PROBE_DEADLINE_MS);
    timer.unref();
    child.once("error", () => {
      finish("UNKNOWN");
    });
    child.once("exit", (code) => {
      finish(code === 0 ? "AUTHENTICATED" : code === 1 ? "REQUIRED" : "UNKNOWN");
    });
  });

// One process may open many in-memory daemons in integration tests. Re-running two real CLI probes
// for every instance would make unrelated suites depend on local login latency. Production opens
// one daemon; an explicit Settings refresh bypasses this startup cache below.
const startupProbeCache = new Map<LiveProviderId, Promise<ProviderAuthentication>>();
const cachedStartupProbe: ProviderAuthProbe = (provider) => {
  const existing = startupProbeCache.get(provider);
  if (existing !== undefined) return existing;
  const pending = probeProviderAuthentication(provider);
  startupProbeCache.set(provider, pending);
  return pending;
};

const adapterWithStart = (adapter: ProviderAdapter, start: boolean): ProviderAdapter => ({
  capabilities: () => ({ ...adapter.capabilities(), start }),
  start: (invocation, listener) => adapter.start(invocation, listener),
  requestHandoff: (sessionId) => adapter.requestHandoff(sessionId),
  abortSession: (sessionId) => adapter.abortSession(sessionId),
});

const availabilityFor = (
  provider: ProviderId,
  adapter: ProviderAdapter,
  installed: boolean,
  authentication: ProviderAuthentication,
): ProviderAvailability => {
  const capabilities = adapter.capabilities();
  const ready = provider === "MOCK" || (installed && authentication === "AUTHENTICATED");
  return {
    provider,
    installed,
    authentication,
    ready,
    stages: capabilities.stages,
    checkpointOnRequest: capabilities.checkpointOnRequest,
    contextWindowReporting: capabilities.contextWindowReporting,
    costReporting: capabilities.costReporting,
  };
};

const selectionProjection = (project: Project) => ({
  schemaVersion: 1 as const,
  projectId: project.id,
  preference: project.providerPreference,
  projectVersion: project.version,
  updatedAt: project.updatedAt,
});

const preferenceProvider = (preference: ProviderPreference): ProviderId | null =>
  preference === "AUTO" ? null : preference;

export const createProviderRegistry = (
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    adapters?: Partial<ProviderAdapters>;
    probeAuthentication?: ProviderAuthProbe;
    executableAvailable?: (provider: LiveProviderId) => boolean;
  } = {},
): ProviderRegistry => {
  const env = options.env ?? process.env;
  const environment = requestedEnvironmentProvider(env);
  const adapters: ProviderAdapters = {
    MOCK: options.adapters?.MOCK ?? createMockProvider(),
    CODEX: options.adapters?.CODEX ?? createCodexProvider(),
    CLAUDE_CODE: options.adapters?.CLAUDE_CODE ?? createClaudeCodeProvider(),
  };
  const customAuthProbe = options.probeAuthentication;
  const executableAvailable =
    options.executableAvailable ??
    ((provider: LiveProviderId): boolean => isExecutableOnDisk(statusCommand[provider].command, env));
  let firstRefresh = true;
  let availability: Readonly<Record<ProviderId, ProviderAvailability>> = {
    MOCK: availabilityFor("MOCK", adapters.MOCK, true, "AUTHENTICATED"),
    CODEX: availabilityFor("CODEX", adapters.CODEX, false, "UNKNOWN"),
    CLAUDE_CODE: availabilityFor("CLAUDE_CODE", adapters.CLAUDE_CODE, false, "UNKNOWN"),
  };

  const refresh = async (): Promise<void> => {
    const authProbe = customAuthProbe ?? (firstRefresh ? cachedStartupProbe : probeProviderAuthentication);
    const installed = {
      CODEX: executableAvailable("CODEX"),
      CLAUDE_CODE: executableAvailable("CLAUDE_CODE"),
    } as const;
    const [codexAuthentication, claudeAuthentication] = await Promise.all([
      installed.CODEX ? authProbe("CODEX") : Promise.resolve<ProviderAuthentication>("UNKNOWN"),
      installed.CLAUDE_CODE ? authProbe("CLAUDE_CODE") : Promise.resolve<ProviderAuthentication>("UNKNOWN"),
    ]);
    availability = {
      MOCK: availabilityFor("MOCK", adapters.MOCK, true, "AUTHENTICATED"),
      CODEX: availabilityFor("CODEX", adapters.CODEX, installed.CODEX, codexAuthentication),
      CLAUDE_CODE: availabilityFor(
        "CLAUDE_CODE",
        adapters.CLAUDE_CODE,
        installed.CLAUDE_CODE,
        claudeAuthentication,
      ),
    };
    firstRefresh = false;
  };

  const resolve = (
    project: Project,
    resolveOptions: { stage?: WorkflowStage | undefined; avoidProvider?: ProviderId | null | undefined } = {},
  ): ProjectProviderResolution => {
    const preferred = environment.invalid
      ? "MOCK"
      : (environment.override ?? preferenceProvider(project.providerPreference));
    const source =
      environment.override || environment.invalid
        ? "ENVIRONMENT_OVERRIDE"
        : preferred === null
          ? "AUTO"
          : "PROJECT_PREFERENCE";
    const autoCandidates = LIVE_PROVIDER_IDS.map((provider) => availability[provider])
      .filter(
        (candidate) =>
          candidate.ready &&
          (resolveOptions.stage === undefined || candidate.stages.includes(resolveOptions.stage)),
      )
      .sort(
        (left, right) =>
          Number(right.provider !== resolveOptions.avoidProvider) -
            Number(left.provider !== resolveOptions.avoidProvider) ||
          right.stages.length - left.stages.length ||
          left.provider.localeCompare(right.provider),
      );
    const effectiveProvider = preferred ?? autoCandidates[0]?.provider ?? "MOCK";
    const effectiveAvailability = availability[effectiveProvider];
    const fallbackReason =
      preferred === null && effectiveProvider === "MOCK"
        ? "NO_AUTHENTICATED_LIVE_PROVIDER"
        : preferred !== null && !effectiveAvailability.ready
          ? "LIVE_PROVIDER_UNAVAILABLE"
          : null;
    const response = projectProviderSelectionResponseSchema.parse({
      schemaVersion: 1,
      selection: selectionProjection(project),
      effectiveProvider,
      source,
      fallbackReason,
      environmentOverride: environment.override,
      environmentOverrideLocked: environment.override !== null || environment.invalid,
      environmentOverrideInvalid: environment.invalid,
      providers: [availability.MOCK, availability.CODEX, availability.CLAUDE_CODE],
    });
    return {
      response,
      adapter: adapterWithStart(adapters[effectiveProvider], effectiveAvailability.ready),
    };
  };

  const readAvailability = (): readonly ProviderAvailability[] => [
    availability.MOCK,
    availability.CODEX,
    availability.CLAUDE_CODE,
  ];

  return { refresh, availability: readAvailability, resolve, environment };
};

export type ProviderAvailabilitySnapshot = {
  environmentOverride: "NONE" | "VALID" | "INVALID";
  providers: readonly ProviderAvailability[];
};

export const inspectProviderAvailability = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ProviderAvailabilitySnapshot> => {
  const registry = createProviderRegistry({ env });
  await registry.refresh();
  return {
    environmentOverride: registry.environment.invalid
      ? "INVALID"
      : registry.environment.override === null
        ? "NONE"
        : "VALID",
    providers: registry.availability(),
  };
};

// Compatibility projection for launchers/tests that still ask for the startup environment alone.
// Production dispatch uses createProviderRegistry().resolve(project), never this process-wide value.
export const resolveDefaultProviderAdapter = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderResolution => {
  const environment = requestedEnvironmentProvider(env);
  const requested = environment.requested;
  if (environment.override === "CODEX") {
    return { provider: "CODEX", adapter: createCodexProvider(), recognised: true, requested };
  }
  if (environment.override === "CLAUDE_CODE") {
    return {
      provider: "CLAUDE_CODE",
      adapter: createClaudeCodeProvider(),
      recognised: true,
      requested,
    };
  }
  return {
    provider: "MOCK",
    adapter: createMockProvider(),
    recognised: !environment.invalid,
    requested,
  };
};
