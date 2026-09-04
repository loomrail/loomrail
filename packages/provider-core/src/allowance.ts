import {
  providerAllowanceAdvisorySchema,
  providerAllowanceSnapshotSchema,
  type ProviderAllowanceAdvisory,
  type ProviderAllowanceSnapshot,
} from "@loomrail/contracts";

export const PROVIDER_ALLOWANCE_LIVE_TTL_MS = 15 * 60 * 1_000;
export const PROVIDER_ALLOWANCE_FUTURE_SKEW_MS = 60 * 1_000;

/**
 * Re-evaluates a stored observation against the daemon clock. Restart never revives a stale row,
 * and a provider timestamp too far in the future is retained only as stale evidence instead of
 * extending its own TTL or being reclassified as a different provider failure.
 */
export const projectProviderAllowanceFreshness = (
  value: ProviderAllowanceSnapshot,
  now: Date,
): ProviderAllowanceSnapshot => {
  const snapshot = providerAllowanceSnapshotSchema.parse(value);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("The provider allowance clock must be valid");
  if (snapshot.freshness === "UNAVAILABLE") return snapshot;

  const observedAtMs = Date.parse(snapshot.observedAt);
  if (observedAtMs > nowMs + PROVIDER_ALLOWANCE_FUTURE_SKEW_MS) {
    return providerAllowanceSnapshotSchema.parse({ ...snapshot, freshness: "STALE" });
  }

  const expired = snapshot.buckets.some((bucket) => Date.parse(bucket.resetsAt) <= nowMs);
  const ttlElapsed = nowMs - observedAtMs > PROVIDER_ALLOWANCE_LIVE_TTL_MS;
  if (snapshot.freshness === "STALE" || expired || ttlElapsed) {
    return providerAllowanceSnapshotSchema.parse({ ...snapshot, freshness: "STALE" });
  }
  return snapshot;
};

/** Pure, advisory-only projection. It has no command or dispatch authority. */
export const projectProviderAllowanceAdvisory = (
  value: ProviderAllowanceSnapshot,
): ProviderAllowanceAdvisory => {
  const snapshot = providerAllowanceSnapshotSchema.parse(value);
  if (snapshot.freshness !== "LIVE") {
    return providerAllowanceAdvisorySchema.parse({ status: "UNKNOWN", deferUntil: null });
  }

  const reached = snapshot.buckets.filter((bucket) => bucket.limitReached);
  if (reached.length > 0) {
    const deferUntil = reached
      .map((bucket) => bucket.resetsAt)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    return providerAllowanceAdvisorySchema.parse({
      status: "LIMIT_REACHED",
      deferUntil: deferUntil ?? null,
    });
  }

  const low = snapshot.buckets.some((bucket) => bucket.remainingPercent <= 10);
  return providerAllowanceAdvisorySchema.parse({
    status: low ? "LOW_CAPACITY" : "CAPACITY_AVAILABLE",
    deferUntil: null,
  });
};
