import type { ProviderAllowanceBucket, ProviderAllowanceSnapshot } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  PROVIDER_ALLOWANCE_LIVE_TTL_MS,
  projectProviderAllowanceAdvisory,
  projectProviderAllowanceFreshness,
} from "../src/index.js";

type PresentProviderAllowanceSnapshot = Exclude<ProviderAllowanceSnapshot, { freshness: "UNAVAILABLE" }>;

const allowanceBucket: ProviderAllowanceBucket = {
  id: "codex:primary",
  name: "Codex",
  kind: "PRIMARY",
  usedPercent: 25,
  remainingPercent: 75,
  windowDurationMins: 300,
  resetsAt: "2026-09-04T22:00:00.000Z",
  limitReached: false,
};

const liveSnapshot = (
  overrides: Partial<PresentProviderAllowanceSnapshot> = {},
): PresentProviderAllowanceSnapshot => ({
  schemaVersion: 1,
  provider: "CODEX",
  observedAt: "2026-09-04T20:00:00.000Z",
  freshness: "LIVE",
  buckets: [allowanceBucket],
  unavailableReason: null,
  ...overrides,
});

describe("provider allowance projections", () => {
  it("keeps a fresh observation live and projects available capacity", () => {
    const snapshot = projectProviderAllowanceFreshness(liveSnapshot(), new Date("2026-09-04T20:14:59.999Z"));
    expect(snapshot.freshness).toBe("LIVE");
    expect(projectProviderAllowanceAdvisory(snapshot)).toEqual({
      status: "CAPACITY_AVAILABLE",
      deferUntil: null,
    });
  });

  it("makes a row stale after the TTL or any represented reset", () => {
    expect(
      projectProviderAllowanceFreshness(
        liveSnapshot(),
        new Date(Date.parse("2026-09-04T20:00:00.000Z") + PROVIDER_ALLOWANCE_LIVE_TTL_MS + 1),
      ).freshness,
    ).toBe("STALE");
    expect(
      projectProviderAllowanceFreshness(
        liveSnapshot({
          buckets: [{ ...allowanceBucket, resetsAt: "2026-09-04T20:05:00.000Z" }],
        }),
        new Date("2026-09-04T20:05:00.000Z"),
      ).freshness,
    ).toBe("STALE");
  });

  it("retains a future-skewed observation only as stale evidence", () => {
    expect(
      projectProviderAllowanceFreshness(
        liveSnapshot({ observedAt: "2026-09-04T20:01:00.001Z" }),
        new Date("2026-09-04T20:00:00.000Z"),
      ),
    ).toEqual({ ...liveSnapshot({ observedAt: "2026-09-04T20:01:00.001Z" }), freshness: "STALE" });
  });

  it("projects low and reached capacity without mutating a run policy", () => {
    const low = liveSnapshot({
      buckets: [{ ...allowanceBucket, usedPercent: 92, remainingPercent: 8 }],
    });
    expect(projectProviderAllowanceAdvisory(low)).toEqual({ status: "LOW_CAPACITY", deferUntil: null });

    const reached = liveSnapshot({
      buckets: [
        {
          ...allowanceBucket,
          usedPercent: 100,
          remainingPercent: 0,
          limitReached: true,
        },
      ],
    });
    expect(projectProviderAllowanceAdvisory(reached)).toEqual({
      status: "LIMIT_REACHED",
      deferUntil: "2026-09-04T22:00:00.000Z",
    });
  });

  it("never turns stale or unavailable data into a scheduling fact", () => {
    expect(projectProviderAllowanceAdvisory({ ...liveSnapshot(), freshness: "STALE" })).toEqual({
      status: "UNKNOWN",
      deferUntil: null,
    });
    expect(
      projectProviderAllowanceAdvisory({
        schemaVersion: 1,
        provider: "CLAUDE_CODE",
        observedAt: "2026-09-04T20:00:00.000Z",
        freshness: "UNAVAILABLE",
        buckets: [],
        unavailableReason: "DATA_NOT_PRESENT",
      }),
    ).toEqual({ status: "UNKNOWN", deferUntil: null });
  });
});
