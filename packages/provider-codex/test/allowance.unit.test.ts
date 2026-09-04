import { describe, expect, it } from "vitest";

import { normalizeCodexRateLimits } from "../src/index.js";

const observedAt = "2026-09-04T20:00:00.000Z";

describe("Codex provider allowance", () => {
  it("prefers the canonical multi-group map and orders its windows deterministically", () => {
    const snapshot = normalizeCodexRateLimits(
      {
        rateLimits: {
          limitId: "legacy",
          limitName: null,
          primary: { usedPercent: 99, windowDurationMins: 15, resetsAt: 1_788_560_000 },
          secondary: null,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: {
          zeta: {
            limitId: "zeta",
            limitName: "Zeta",
            primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: 1_788_560_600 },
            secondary: null,
            rateLimitReachedType: null,
          },
          codex: {
            limitId: "codex",
            limitName: null,
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_788_560_000 },
            secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_789_000_000 },
            rateLimitReachedType: null,
          },
        },
      },
      observedAt,
    );

    expect(snapshot.freshness).toBe("LIVE");
    expect(snapshot.buckets.map((bucket) => bucket.id)).toEqual([
      "codex:primary",
      "codex:secondary",
      "zeta:primary",
    ]);
    expect(snapshot.buckets[0]).toMatchObject({ usedPercent: 25, remainingPercent: 75 });
  });

  it("falls back to the legacy group without assigning a group-level cause to one window", () => {
    const snapshot = normalizeCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1_788_560_000 },
          secondary: null,
          rateLimitReachedType: "workspace_member_usage_limit_reached",
        },
        rateLimitsByLimitId: null,
      },
      observedAt,
    );
    expect(snapshot.buckets).toEqual([
      expect.objectContaining({ id: "codex:primary", limitReached: false, remainingPercent: 20 }),
    ]);
  });

  it("marks only the window whose own usage proves exhaustion", () => {
    const snapshot = normalizeCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_788_560_000 },
          secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_789_000_000 },
          rateLimitReachedType: "rate_limit_reached",
        },
        rateLimitsByLimitId: null,
      },
      observedAt,
    );
    expect(snapshot.buckets).toEqual([
      expect.objectContaining({ id: "codex:primary", limitReached: false }),
      expect.objectContaining({ id: "codex:secondary", limitReached: true }),
    ]);
  });

  it("reports absent windows as unavailable rather than zero capacity", () => {
    expect(normalizeCodexRateLimits({ rateLimits: null, rateLimitsByLimitId: {} }, observedAt)).toEqual({
      schemaVersion: 1,
      provider: "CODEX",
      observedAt,
      freshness: "UNAVAILABLE",
      buckets: [],
      unavailableReason: "DATA_NOT_PRESENT",
    });
  });

  it.each([
    { rateLimits: null, rateLimitsByLimitId: { codex: { limitId: "other" } } },
    {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: 1_788_560_000 },
        secondary: null,
      },
    },
    {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1_788_560_000 },
        secondary: null,
        rateLimitReachedType: "future_unknown_limit_cause",
      },
    },
    {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: Number.NaN, windowDurationMins: 300, resetsAt: 1_788_560_000 },
        secondary: null,
      },
    },
    { rateLimits: null, account: { email: "canary@example.test" } },
  ])("rejects malformed or expanded provider data", (value) => {
    expect(() => normalizeCodexRateLimits(value, observedAt)).toThrow();
  });
});
