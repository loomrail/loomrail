import type { ProviderAllowanceSnapshot, ProviderAvailability } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { projectProviderAllowanceResponse } from "../src/provider-allowance.js";

const availability = (
  provider: "CODEX" | "CLAUDE_CODE",
  overrides: Partial<ProviderAvailability> = {},
): ProviderAvailability => ({
  provider,
  installed: true,
  authentication: "AUTHENTICATED",
  version: provider === "CODEX" ? "0.153.0-alpha.5" : "2.1.260",
  compatibility: "VERIFIED",
  ready: true,
  stages: ["DISCOVERY"],
  checkpointOnRequest: false,
  contextWindowReporting: true,
  costReporting: provider === "CLAUDE_CODE",
  canReportRateLimits: true,
  models: { FAST: "fast", STANDARD: "standard", DEEP: "deep" },
  ...overrides,
});

const liveSnapshot: ProviderAllowanceSnapshot = {
  schemaVersion: 1,
  provider: "CODEX",
  observedAt: "2026-09-04T19:55:00.000Z",
  freshness: "LIVE",
  buckets: [
    {
      id: "codex:primary",
      name: "Codex",
      kind: "PRIMARY",
      usedPercent: 20,
      remainingPercent: 80,
      windowDurationMins: 300,
      resetsAt: "2026-09-05T00:00:00.000Z",
      limitReached: false,
    },
  ],
  unavailableReason: null,
};

describe("Project provider allowance response", () => {
  it("keeps provider capacity distinct and computes a live advisory", () => {
    const response = projectProviderAllowanceResponse({
      projectId: "project-1",
      effectiveProvider: "CODEX",
      snapshots: [liveSnapshot],
      availability: [availability("CODEX"), availability("CLAUDE_CODE")],
      now: new Date("2026-09-04T20:00:00.000Z"),
    });
    expect(response.current).toEqual(liveSnapshot);
    expect(response.advisory).toEqual({ status: "CAPACITY_AVAILABLE", deferUntil: null });
    expect(response.providers[1]).toMatchObject({
      provider: "CLAUDE_CODE",
      freshness: "UNAVAILABLE",
      unavailableReason: "DATA_NOT_PRESENT",
    });
  });

  it("recomputes stale freshness after restart time passes", () => {
    const response = projectProviderAllowanceResponse({
      projectId: "project-1",
      effectiveProvider: "CODEX",
      snapshots: [liveSnapshot],
      availability: [availability("CODEX"), availability("CLAUDE_CODE")],
      now: new Date("2026-09-04T20:11:00.001Z"),
    });
    expect(response.current).toMatchObject({ freshness: "STALE" });
    expect(response.advisory).toEqual({ status: "UNKNOWN", deferUntil: null });
  });

  it("distinguishes unverified, unauthenticated and unsupported providers from zero capacity", () => {
    const response = projectProviderAllowanceResponse({
      projectId: "project-1",
      effectiveProvider: "MOCK",
      snapshots: [],
      availability: [
        availability("CODEX", {
          compatibility: "UNVERIFIED",
          authentication: "UNKNOWN",
          ready: false,
          canReportRateLimits: false,
        }),
        availability("CLAUDE_CODE", {
          authentication: "REQUIRED",
          ready: false,
          canReportRateLimits: false,
        }),
      ],
      now: new Date("2026-09-04T20:00:00.000Z"),
    });
    expect(response.current).toMatchObject({
      provider: "MOCK",
      unavailableReason: "PROVIDER_UNSUPPORTED",
    });
    expect(response.providers.map(({ unavailableReason }) => unavailableReason)).toEqual([
      "TARGET_UNVERIFIED",
      "PROVIDER_UNSUPPORTED",
    ]);
  });

  it("reports authentication only after an exact allowance target is supported", () => {
    const response = projectProviderAllowanceResponse({
      projectId: "project-1",
      effectiveProvider: "CODEX",
      snapshots: [],
      availability: [
        availability("CODEX", {
          version: "0.153.1",
          compatibility: "UNVERIFIED",
          authentication: "REQUIRED",
          ready: false,
          canReportRateLimits: true,
        }),
        availability("CLAUDE_CODE", { canReportRateLimits: false }),
      ],
      now: new Date("2026-09-04T20:00:00.000Z"),
    });
    expect(response.current).toMatchObject({
      freshness: "UNAVAILABLE",
      unavailableReason: "NOT_AUTHENTICATED",
    });
  });

  it("hides a saved live snapshot when the current exact provider target is no longer admitted", () => {
    const response = projectProviderAllowanceResponse({
      projectId: "project-1",
      effectiveProvider: "CODEX",
      snapshots: [liveSnapshot],
      availability: [
        availability("CODEX", {
          version: "0.153.1",
          compatibility: "UNVERIFIED",
          authentication: "UNKNOWN",
          ready: false,
          canReportRateLimits: false,
        }),
        availability("CLAUDE_CODE", { canReportRateLimits: false }),
      ],
      now: new Date("2026-09-04T20:00:00.000Z"),
    });
    expect(response.current).toMatchObject({
      provider: "CODEX",
      freshness: "UNAVAILABLE",
      unavailableReason: "TARGET_UNVERIFIED",
      buckets: [],
    });
    expect(response.advisory).toEqual({ status: "UNKNOWN", deferUntil: null });
  });
});
