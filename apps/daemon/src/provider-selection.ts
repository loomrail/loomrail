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
import { claudeCodeProviderDiagnostics, createClaudeCodeProvider } from "@loomrail/provider-claude-code";
import { codexProviderDiagnostics, createCodexProvider } from "@loomrail/provider-codex";

export const LOOMRAIL_PROVIDER_ENV_VAR = "LOOMRAIL_PROVIDER";
export const LOOMRAIL_PROVIDER_VALUES = ["CODEX", "CLAUDE_CODE"] as const;

const LIVE_PROVIDER_IDS = LOOMRAIL_PROVIDER_VALUES;
type LiveProviderId = (typeof LIVE_PROVIDER_IDS)[number];
type ProviderAdapters = Readonly<Record<LiveProviderId, ProviderAdapter>>;

export type ProviderAuthProbe = (provider: LiveProviderId) => Promise<ProviderAuthentication>;
export type ProviderRuntimeProbe = (provider: LiveProviderId) => Promise<{
  installed: boolean;
  compatibility: ProviderAvailability["compatibility"];
  version: string | null;
}>;

export type ProviderResolution = {
  provider: LiveProviderId;
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
    override: LiveProviderId | null;
    invalid: boolean;
    requested: string | null;
  };
};

const isLiveProviderId = (value: string): value is LiveProviderId =>
  LOOMRAIL_PROVIDER_VALUES.some((provider) => provider === value);

const requestedEnvironmentProvider = (
  env: Readonly<Record<string, string | undefined>>,
): { override: LiveProviderId | null; invalid: boolean; requested: string | null } => {
  const raw = env[LOOMRAIL_PROVIDER_ENV_VAR];
  const requested = raw === undefined || raw.trim().length === 0 ? null : raw;
  if (requested === null) return { override: null, invalid: false, requested: null };
  return isLiveProviderId(requested)
    ? { override: requested, invalid: false, requested }
    : { override: null, invalid: true, requested };
};

const adapterWithAvailability = (
  adapter: ProviderAdapter,
  availability: ProviderAvailability,
): ProviderAdapter => {
  const readAllowance = adapter.readAllowance;
  return {
    capabilities: () => ({ ...adapter.capabilities(), start: availability.ready }),
    ...(adapter.modelMapping === undefined ? {} : { modelMapping: adapter.modelMapping }),
    ...(readAllowance === undefined ? {} : { readAllowance: () => readAllowance() }),
    start: (invocation, listener) => adapter.start(invocation, listener),
    requestHandoff: (sessionId) => adapter.requestHandoff(sessionId),
    abortSession: (sessionId) => adapter.abortSession(sessionId),
  };
};

const availabilityFor = (
  provider: LiveProviderId,
  adapter: ProviderAdapter,
  authentication: ProviderAuthentication,
  runtime: Awaited<ReturnType<ProviderRuntimeProbe>>,
): ProviderAvailability => {
  const capabilities = adapter.capabilities();
  return {
    provider,
    installed: runtime.installed,
    authentication,
    version: runtime.version,
    compatibility: runtime.compatibility,
    ready:
      capabilities.start &&
      runtime.installed &&
      runtime.compatibility === "VERIFIED" &&
      authentication === "AUTHENTICATED",
    stages: capabilities.stages,
    checkpointOnRequest: capabilities.checkpointOnRequest,
    contextWindowReporting: capabilities.contextWindowReporting,
    costReporting: capabilities.costReporting,
    tokenBudgetEnforcement: capabilities.tokenBudgetEnforcement,
    canReportRateLimits: capabilities.canReportRateLimits ?? false,
    models: adapter.modelMapping?.() ?? null,
  };
};

const selectionProjection = (project: Project) => ({
  schemaVersion: 1 as const,
  projectId: project.id,
  preference: project.providerPreference,
  projectVersion: project.version,
  updatedAt: project.updatedAt,
});

const preferenceProvider = (preference: ProviderPreference): LiveProviderId | null =>
  preference === "AUTO" ? null : preference;

export const createProviderRegistry = (
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    adapters?: Partial<ProviderAdapters>;
    probeAuthentication?: ProviderAuthProbe;
    probeRuntime?: ProviderRuntimeProbe;
  } = {},
): ProviderRegistry => {
  const env = options.env ?? process.env;
  const environment = requestedEnvironmentProvider(env);
  const adapters: ProviderAdapters = {
    CODEX: options.adapters?.CODEX ?? createCodexProvider({ environment: env }),
    CLAUDE_CODE: options.adapters?.CLAUDE_CODE ?? createClaudeCodeProvider({ environment: env }),
  };
  const diagnostics = {
    CODEX: codexProviderDiagnostics,
    CLAUDE_CODE: claudeCodeProviderDiagnostics,
  } as const;
  const defaultRuntimeProbe: ProviderRuntimeProbe = async (provider) => {
    const diagnostic = diagnostics[provider];
    if (!diagnostic.executableAvailable(env)) {
      return { installed: false, compatibility: "MISSING", version: null };
    }
    const observed = await diagnostic.probeVersion({ environment: env });
    return { installed: true, ...observed };
  };
  const defaultAuthenticationProbe: ProviderAuthProbe = (provider) =>
    diagnostics[provider].probeAuthentication({ environment: env });
  const probeAuthentication = options.probeAuthentication ?? defaultAuthenticationProbe;
  const probeRuntime = options.probeRuntime ?? defaultRuntimeProbe;
  const unknownRuntime = { installed: false, compatibility: "MISSING", version: null } as const;
  let availability: Readonly<Record<LiveProviderId, ProviderAvailability>> = {
    CODEX: availabilityFor("CODEX", adapters.CODEX, "UNKNOWN", unknownRuntime),
    CLAUDE_CODE: availabilityFor("CLAUDE_CODE", adapters.CLAUDE_CODE, "UNKNOWN", unknownRuntime),
  };

  const refresh = async (): Promise<void> => {
    const [codexRuntime, claudeRuntime] = await Promise.all([
      probeRuntime("CODEX"),
      probeRuntime("CLAUDE_CODE"),
    ]);
    const [codexAuthentication, claudeAuthentication] = await Promise.all([
      codexRuntime.compatibility === "VERIFIED"
        ? probeAuthentication("CODEX")
        : Promise.resolve("UNKNOWN" as const),
      claudeRuntime.compatibility === "VERIFIED"
        ? probeAuthentication("CLAUDE_CODE")
        : Promise.resolve("UNKNOWN" as const),
    ]);
    availability = {
      CODEX: availabilityFor("CODEX", adapters.CODEX, codexAuthentication, codexRuntime),
      CLAUDE_CODE: availabilityFor("CLAUDE_CODE", adapters.CLAUDE_CODE, claudeAuthentication, claudeRuntime),
    };
  };

  const resolve = (
    project: Project,
    resolveOptions: { stage?: WorkflowStage | undefined; avoidProvider?: ProviderId | null | undefined } = {},
  ): ProjectProviderResolution => {
    const preferred = environment.invalid
      ? null
      : (environment.override ?? preferenceProvider(project.providerPreference));
    const source =
      environment.override !== null || environment.invalid
        ? "ENVIRONMENT_OVERRIDE"
        : preferred === null
          ? "AUTO"
          : "PROJECT_PREFERENCE";
    const eligible = LIVE_PROVIDER_IDS.filter((provider) => {
      const candidate = availability[provider];
      return (
        candidate.ready &&
        (resolveOptions.stage === undefined || candidate.stages.includes(resolveOptions.stage))
      );
    }).sort(
      (left, right) =>
        Number(right !== resolveOptions.avoidProvider) - Number(left !== resolveOptions.avoidProvider) ||
        availability[right].stages.length - availability[left].stages.length ||
        LIVE_PROVIDER_IDS.indexOf(left) - LIVE_PROVIDER_IDS.indexOf(right),
    );
    const effectiveProvider: LiveProviderId = preferred ?? eligible[0] ?? "CODEX";
    const effectiveAvailability = availability[effectiveProvider];
    const fallbackReason =
      preferred === null && eligible.length === 0
        ? "NO_READY_LIVE_PROVIDER"
        : preferred !== null &&
            (!effectiveAvailability.ready ||
              (resolveOptions.stage !== undefined &&
                !effectiveAvailability.stages.includes(resolveOptions.stage)))
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
      providers: [availability.CODEX, availability.CLAUDE_CODE],
    });
    return {
      response,
      adapter: adapterWithAvailability(adapters[effectiveProvider], effectiveAvailability),
    };
  };

  return {
    refresh,
    availability: () => [availability.CODEX, availability.CLAUDE_CODE],
    resolve,
    environment,
  };
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

export const resolveDefaultProviderAdapter = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderResolution => {
  const environment = requestedEnvironmentProvider(env);
  const provider = environment.override ?? "CODEX";
  return {
    provider,
    adapter:
      provider === "CODEX"
        ? createCodexProvider({ environment: env })
        : createClaudeCodeProvider({ environment: env }),
    recognised: !environment.invalid,
    requested: environment.requested,
  };
};
