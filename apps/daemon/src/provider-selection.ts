import {
  projectProviderSelectionResponseSchema,
  type Project,
  type ProjectProviderSelectionResponse,
  type ProviderAuthentication,
  type ProviderAvailability,
  type ProviderCompatibility,
  type ProviderId,
  type ProviderPreference,
  type WorkflowStage,
} from "@loomrail/contracts";
import type {
  CliProviderDiagnostics,
  ProviderAdapter,
  ProviderVersionObservation,
} from "@loomrail/provider-core";
import { claudeCodeProviderDiagnostics, createClaudeCodeProvider } from "@loomrail/provider-claude-code";
import {
  codexProviderDiagnostics,
  codexRateLimitReportingTargetVerified,
  createCodexProvider,
  probeCodexAuthenticationMode,
  type CodexAuthenticationMode,
} from "@loomrail/provider-codex";
import { createMockProvider } from "@loomrail/provider-mock";

export const LOOMRAIL_PROVIDER_ENV_VAR = "LOOMRAIL_PROVIDER";
export const LOOMRAIL_PROVIDER_VALUES = ["MOCK", "CODEX", "CLAUDE_CODE"] as const;

const AUTH_PROBE_DEADLINE_MS = 3_000;
const LIVE_PROVIDER_IDS = ["CODEX", "CLAUDE_CODE"] as const;

type LiveProviderId = (typeof LIVE_PROVIDER_IDS)[number];
type ProviderAdapters = Readonly<Record<ProviderId, ProviderAdapter>>;

const providerDiagnostics: Readonly<Record<LiveProviderId, CliProviderDiagnostics>> = {
  CODEX: codexProviderDiagnostics,
  CLAUDE_CODE: claudeCodeProviderDiagnostics,
};

export type ProviderAuthProbe = (provider: LiveProviderId) => Promise<ProviderAuthentication>;
export type ProviderCompatibilityProbe = (provider: LiveProviderId) => Promise<ProviderVersionObservation>;
export type ProviderRateLimitVersionTargetProbe = (
  provider: LiveProviderId,
  observation: { compatibility: ProviderCompatibility; version: string | null },
) => boolean;
export type ProviderRateLimitAuthenticationModeProbe = (
  provider: LiveProviderId,
) => Promise<CodexAuthenticationMode>;

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

export const probeProviderAuthentication: ProviderAuthProbe = (provider) =>
  providerDiagnostics[provider].probeAuthentication({ deadlineMs: AUTH_PROBE_DEADLINE_MS });

const probeProviderRateLimitAuthenticationMode: ProviderRateLimitAuthenticationModeProbe = (provider) =>
  provider === "CODEX"
    ? probeCodexAuthenticationMode({ deadlineMs: AUTH_PROBE_DEADLINE_MS })
    : Promise.resolve("UNKNOWN");

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
const startupRateLimitAuthModeProbeCache = new Map<LiveProviderId, Promise<CodexAuthenticationMode>>();
const cachedStartupRateLimitAuthenticationModeProbe: ProviderRateLimitAuthenticationModeProbe = (
  provider,
) => {
  const existing = startupRateLimitAuthModeProbeCache.get(provider);
  if (existing !== undefined) return existing;
  const pending = probeProviderRateLimitAuthenticationMode(provider);
  startupRateLimitAuthModeProbeCache.set(provider, pending);
  return pending;
};

const adapterWithAvailability = (
  adapter: ProviderAdapter,
  availability: ProviderAvailability,
): ProviderAdapter => {
  const allowanceAdmitted =
    availability.canReportRateLimits && availability.authentication === "AUTHENTICATED";
  return {
    capabilities: () => ({
      ...adapter.capabilities(),
      start: availability.ready,
      canReportRateLimits: allowanceAdmitted,
    }),
    ...(adapter.modelMapping === undefined ? {} : { modelMapping: adapter.modelMapping }),
    ...(adapter.readAllowance === undefined || !allowanceAdmitted
      ? {}
      : { readAllowance: adapter.readAllowance }),
    start: (invocation, listener) => adapter.start(invocation, listener),
    requestHandoff: (sessionId) => adapter.requestHandoff(sessionId),
    abortSession: (sessionId) => adapter.abortSession(sessionId),
  };
};

const availabilityFor = (
  provider: ProviderId,
  adapter: ProviderAdapter,
  installed: boolean,
  authentication: ProviderAuthentication,
  observation: { compatibility: ProviderCompatibility; version: string | null },
  rateLimitTargetVerified: boolean,
): ProviderAvailability => {
  const capabilities = adapter.capabilities();
  const ready =
    provider === "MOCK" ||
    (installed && observation.compatibility === "VERIFIED" && authentication === "AUTHENTICATED");
  return {
    provider,
    installed,
    authentication,
    version: observation.version,
    compatibility: observation.compatibility,
    ready,
    stages: capabilities.stages,
    checkpointOnRequest: capabilities.checkpointOnRequest,
    contextWindowReporting: capabilities.contextWindowReporting,
    costReporting: capabilities.costReporting,
    canReportRateLimits:
      rateLimitTargetVerified &&
      (capabilities.canReportRateLimits ?? false) &&
      adapter.readAllowance !== undefined,
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

const preferenceProvider = (preference: ProviderPreference): ProviderId | null =>
  preference === "AUTO" ? null : preference;

export const createProviderRegistry = (
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    adapters?: Partial<ProviderAdapters>;
    probeAuthentication?: ProviderAuthProbe;
    probeCompatibility?: ProviderCompatibilityProbe;
    rateLimitVersionTargetVerified?: ProviderRateLimitVersionTargetProbe;
    probeRateLimitAuthenticationMode?: ProviderRateLimitAuthenticationModeProbe;
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
  const compatibilityProbe =
    options.probeCompatibility ??
    ((provider: LiveProviderId) => providerDiagnostics[provider].probeVersion({ environment: env }));
  const executableAvailable =
    options.executableAvailable ??
    ((provider: LiveProviderId): boolean => providerDiagnostics[provider].executableAvailable(env));
  const rateLimitVersionTargetVerified =
    options.rateLimitVersionTargetVerified ??
    ((
      provider: LiveProviderId,
      observation: { compatibility: ProviderCompatibility; version: string | null },
    ): boolean => provider === "CODEX" && codexRateLimitReportingTargetVerified(observation.version));
  const customRateLimitAuthenticationModeProbe = options.probeRateLimitAuthenticationMode;
  let firstRefresh = true;
  let availability: Readonly<Record<ProviderId, ProviderAvailability>> = {
    MOCK: availabilityFor(
      "MOCK",
      adapters.MOCK,
      true,
      "AUTHENTICATED",
      {
        compatibility: "BUILT_IN",
        version: null,
      },
      false,
    ),
    CODEX: availabilityFor(
      "CODEX",
      adapters.CODEX,
      false,
      "UNKNOWN",
      {
        compatibility: "MISSING",
        version: null,
      },
      false,
    ),
    CLAUDE_CODE: availabilityFor(
      "CLAUDE_CODE",
      adapters.CLAUDE_CODE,
      false,
      "UNKNOWN",
      {
        compatibility: "MISSING",
        version: null,
      },
      false,
    ),
  };

  const refresh = async (): Promise<void> => {
    const authProbe = customAuthProbe ?? (firstRefresh ? cachedStartupProbe : probeProviderAuthentication);
    const rateLimitAuthenticationModeProbe =
      customRateLimitAuthenticationModeProbe ??
      (firstRefresh
        ? cachedStartupRateLimitAuthenticationModeProbe
        : probeProviderRateLimitAuthenticationMode);
    const installed = {
      CODEX: executableAvailable("CODEX"),
      CLAUDE_CODE: executableAvailable("CLAUDE_CODE"),
    } as const;
    const [codexCompatibility, claudeCompatibility] = await Promise.all([
      installed.CODEX
        ? compatibilityProbe("CODEX")
        : Promise.resolve({ compatibility: "MISSING" as const, version: null }),
      installed.CLAUDE_CODE
        ? compatibilityProbe("CLAUDE_CODE")
        : Promise.resolve({ compatibility: "MISSING" as const, version: null }),
    ]);
    const rateLimitVersionTargets = {
      CODEX: rateLimitVersionTargetVerified("CODEX", codexCompatibility),
      CLAUDE_CODE: rateLimitVersionTargetVerified("CLAUDE_CODE", claudeCompatibility),
    } as const;
    const [codexAuthentication, claudeAuthentication, codexRateLimitAuthMode, claudeRateLimitAuthMode] =
      await Promise.all([
        codexCompatibility.compatibility === "VERIFIED" || rateLimitVersionTargets.CODEX
          ? authProbe("CODEX")
          : Promise.resolve<ProviderAuthentication>("UNKNOWN"),
        claudeCompatibility.compatibility === "VERIFIED" || rateLimitVersionTargets.CLAUDE_CODE
          ? authProbe("CLAUDE_CODE")
          : Promise.resolve<ProviderAuthentication>("UNKNOWN"),
        rateLimitVersionTargets.CODEX
          ? rateLimitAuthenticationModeProbe("CODEX")
          : Promise.resolve<CodexAuthenticationMode>("UNKNOWN"),
        rateLimitVersionTargets.CLAUDE_CODE
          ? rateLimitAuthenticationModeProbe("CLAUDE_CODE")
          : Promise.resolve<CodexAuthenticationMode>("UNKNOWN"),
      ]);
    availability = {
      MOCK: availabilityFor(
        "MOCK",
        adapters.MOCK,
        true,
        "AUTHENTICATED",
        {
          compatibility: "BUILT_IN",
          version: null,
        },
        false,
      ),
      CODEX: availabilityFor(
        "CODEX",
        adapters.CODEX,
        installed.CODEX,
        codexAuthentication,
        codexCompatibility,
        rateLimitVersionTargets.CODEX && codexRateLimitAuthMode === "CHATGPT",
      ),
      CLAUDE_CODE: availabilityFor(
        "CLAUDE_CODE",
        adapters.CLAUDE_CODE,
        installed.CLAUDE_CODE,
        claudeAuthentication,
        claudeCompatibility,
        rateLimitVersionTargets.CLAUDE_CODE && claudeRateLimitAuthMode === "CHATGPT",
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
        ? "NO_READY_LIVE_PROVIDER"
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
      adapter: adapterWithAvailability(adapters[effectiveProvider], effectiveAvailability),
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
