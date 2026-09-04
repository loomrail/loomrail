import {
  projectProviderAllowanceResponseSchema,
  providerAllowanceSnapshotSchema,
  type ProjectProviderAllowanceResponse,
  type ProviderAllowanceSnapshot,
  type ProviderAllowanceUnavailableReason,
  type ProviderAvailability,
  type ProviderId,
} from "@loomrail/contracts";
import { projectProviderAllowanceAdvisory, projectProviderAllowanceFreshness } from "@loomrail/provider-core";

const LIVE_PROVIDERS = ["CODEX", "CLAUDE_CODE"] as const;

const unavailableReasonFor = (availability: ProviderAvailability): ProviderAllowanceUnavailableReason => {
  if (!availability.installed) return "PROVIDER_UNAVAILABLE";
  if (!availability.canReportRateLimits) {
    // Codex allowance has its own exact target matrix, independent from execution compatibility.
    // Claude Code's current headless/Desktop route has no machine-readable delivery seam at all.
    return availability.provider === "CODEX" ? "TARGET_UNVERIFIED" : "PROVIDER_UNSUPPORTED";
  }
  if (availability.authentication !== "AUTHENTICATED") return "NOT_AUTHENTICATED";
  return "DATA_NOT_PRESENT";
};

const unavailableSnapshot = (
  provider: ProviderId,
  observedAt: string,
  reason: ProviderAllowanceUnavailableReason,
): ProviderAllowanceSnapshot =>
  providerAllowanceSnapshotSchema.parse({
    schemaVersion: 1,
    provider,
    observedAt,
    freshness: "UNAVAILABLE",
    buckets: [],
    unavailableReason: reason,
  });

export const projectProviderAllowanceResponse = (input: {
  projectId: string;
  effectiveProvider: ProviderId;
  snapshots: readonly ProviderAllowanceSnapshot[];
  availability: readonly ProviderAvailability[];
  now: Date;
}): ProjectProviderAllowanceResponse => {
  const observedAt = input.now.toISOString();
  const providers = LIVE_PROVIDERS.map((provider) => {
    const availability = input.availability.find((candidate) => candidate.provider === provider);
    const unavailableReason =
      availability === undefined ? "PROVIDER_UNAVAILABLE" : unavailableReasonFor(availability);
    if (unavailableReason !== "DATA_NOT_PRESENT") {
      return unavailableSnapshot(provider, observedAt, unavailableReason);
    }
    const saved = input.snapshots.find((snapshot) => snapshot.provider === provider);
    return saved === undefined
      ? unavailableSnapshot(provider, observedAt, "DATA_NOT_PRESENT")
      : projectProviderAllowanceFreshness(saved, input.now);
  });
  const current =
    input.effectiveProvider === "MOCK"
      ? unavailableSnapshot("MOCK", observedAt, "PROVIDER_UNSUPPORTED")
      : providers.find((snapshot) => snapshot.provider === input.effectiveProvider);
  if (current === undefined) throw new Error("The effective provider has no allowance projection");
  return projectProviderAllowanceResponseSchema.parse({
    schemaVersion: 1,
    projectId: input.projectId,
    effectiveProvider: input.effectiveProvider,
    current,
    advisory: projectProviderAllowanceAdvisory(current),
    providers,
  });
};
