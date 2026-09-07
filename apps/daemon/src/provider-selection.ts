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
import { createAnthropicMessagesProvider } from "@loomrail/provider-claude-code";
import { createOpenAIResponsesProvider } from "@loomrail/provider-codex";

export const LOOMRAIL_PROVIDER_ENV_VAR = "LOOMRAIL_PROVIDER";
export const LOOMRAIL_PROVIDER_VALUES = ["CODEX", "CLAUDE_CODE"] as const;

const LIVE_PROVIDER_IDS = LOOMRAIL_PROVIDER_VALUES;
type LiveProviderId = (typeof LIVE_PROVIDER_IDS)[number];
type ProviderAdapters = Readonly<Record<LiveProviderId, ProviderAdapter>>;

export type ProviderAuthProbe = (provider: LiveProviderId) => Promise<ProviderAuthentication>;

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
): ProviderAvailability => {
  const capabilities = adapter.capabilities();
  return {
    provider,
    installed: true,
    authentication,
    version: null,
    compatibility: "BUILT_IN",
    ready: capabilities.start && authentication === "AUTHENTICATED",
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
  } = {},
): ProviderRegistry => {
  const env = options.env ?? process.env;
  const environment = requestedEnvironmentProvider(env);
  const adapters: ProviderAdapters = {
    CODEX: options.adapters?.CODEX ?? createOpenAIResponsesProvider({ apiKey: env["OPENAI_API_KEY"] }),
    CLAUDE_CODE:
      options.adapters?.CLAUDE_CODE ?? createAnthropicMessagesProvider({ apiKey: env["ANTHROPIC_API_KEY"] }),
  };
  const defaultAuthenticationProbe: ProviderAuthProbe = (provider) =>
    Promise.resolve(adapters[provider].capabilities().start ? "AUTHENTICATED" : "REQUIRED");
  const probeAuthentication = options.probeAuthentication ?? defaultAuthenticationProbe;
  let availability: Readonly<Record<LiveProviderId, ProviderAvailability>> = {
    CODEX: availabilityFor("CODEX", adapters.CODEX, "UNKNOWN"),
    CLAUDE_CODE: availabilityFor("CLAUDE_CODE", adapters.CLAUDE_CODE, "UNKNOWN"),
  };

  const refresh = async (): Promise<void> => {
    const [openAIAuthentication, anthropicAuthentication] = await Promise.all([
      probeAuthentication("CODEX"),
      probeAuthentication("CLAUDE_CODE"),
    ]);
    availability = {
      CODEX: availabilityFor("CODEX", adapters.CODEX, openAIAuthentication),
      CLAUDE_CODE: availabilityFor("CLAUDE_CODE", adapters.CLAUDE_CODE, anthropicAuthentication),
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
        candidate.tokenBudgetEnforcement === "HARD" &&
        (resolveOptions.stage === undefined || candidate.stages.includes(resolveOptions.stage))
      );
    }).sort(
      (left, right) =>
        Number(right !== resolveOptions.avoidProvider) - Number(left !== resolveOptions.avoidProvider) ||
        availability[right].stages.length - availability[left].stages.length ||
        left.localeCompare(right),
    );
    const effectiveProvider: LiveProviderId = preferred ?? eligible[0] ?? "CODEX";
    const effectiveAvailability = availability[effectiveProvider];
    const fallbackReason =
      preferred === null && eligible.length === 0
        ? "NO_READY_LIVE_PROVIDER"
        : preferred !== null &&
            (!effectiveAvailability.ready ||
              effectiveAvailability.tokenBudgetEnforcement !== "HARD" ||
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
        ? createOpenAIResponsesProvider({ apiKey: env["OPENAI_API_KEY"] })
        : createAnthropicMessagesProvider({ apiKey: env["ANTHROPIC_API_KEY"] }),
    recognised: !environment.invalid,
    requested: environment.requested,
  };
};
