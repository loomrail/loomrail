import { describe, expect, it } from "vitest";

import {
  projectProviderAllowanceResponseSchema,
  providerAllowanceBucketSchema,
  providerAllowanceSnapshotSchema,
} from "../src/index.js";

const bucket = {
  id: "codex:primary",
  name: "Codex",
  kind: "PRIMARY",
  usedPercent: 25,
  remainingPercent: 75,
  windowDurationMins: 300,
  resetsAt: "2026-09-04T21:00:00.000Z",
  limitReached: false,
} as const;

describe("provider allowance contract", () => {
  it("accepts an explicitly labelled live provider window", () => {
    expect(
      providerAllowanceSnapshotSchema.parse({
        schemaVersion: 1,
        provider: "CODEX",
        observedAt: "2026-09-04T20:00:00.000Z",
        freshness: "LIVE",
        buckets: [bucket],
        unavailableReason: null,
      }),
    ).toMatchObject({ provider: "CODEX", freshness: "LIVE" });
  });

  it("accepts a spent-over-limit bucket while clamping remaining capacity to zero", () => {
    expect(
      providerAllowanceBucketSchema.parse({
        ...bucket,
        id: "claude:spend",
        kind: "SPEND_LIMIT",
        usedPercent: 112.5,
        remainingPercent: 0,
        limitReached: true,
      }),
    ).toMatchObject({ usedPercent: 112.5, remainingPercent: 0 });
  });

  it.each([
    [{ ...bucket, usedPercent: Number.NaN }],
    [{ ...bucket, usedPercent: Number.POSITIVE_INFINITY }],
    [{ ...bucket, usedPercent: -1, remainingPercent: 101 }],
    [{ ...bucket, usedPercent: 101, remainingPercent: 0 }],
    [{ ...bucket, remainingPercent: 74 }],
    [{ ...bucket, usedPercent: 100, remainingPercent: 0, limitReached: false }],
    [{ ...bucket, id: "../../secret" }],
    [{ ...bucket, rawResponse: "sensitive" }],
  ])("rejects an invalid or authority-expanding bucket", (candidate) => {
    expect(providerAllowanceBucketSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects duplicate buckets and live Mock allowance", () => {
    expect(
      providerAllowanceSnapshotSchema.safeParse({
        schemaVersion: 1,
        provider: "CODEX",
        observedAt: "2026-09-04T20:00:00.000Z",
        freshness: "LIVE",
        buckets: [bucket, bucket],
        unavailableReason: null,
      }).success,
    ).toBe(false);
    expect(
      providerAllowanceSnapshotSchema.safeParse({
        schemaVersion: 1,
        provider: "MOCK",
        observedAt: "2026-09-04T20:00:00.000Z",
        freshness: "LIVE",
        buckets: [bucket],
        unavailableReason: null,
      }).success,
    ).toBe(false);
  });

  it("requires Mock to use the explicit unsupported unavailable state", () => {
    expect(
      providerAllowanceSnapshotSchema.parse({
        schemaVersion: 1,
        provider: "MOCK",
        observedAt: "2026-09-04T20:00:00.000Z",
        freshness: "UNAVAILABLE",
        buckets: [],
        unavailableReason: "PROVIDER_UNSUPPORTED",
      }),
    ).toMatchObject({ provider: "MOCK", freshness: "UNAVAILABLE" });
    expect(
      providerAllowanceSnapshotSchema.safeParse({
        schemaVersion: 1,
        provider: "MOCK",
        observedAt: "2026-09-04T20:00:00.000Z",
        freshness: "UNAVAILABLE",
        buckets: [],
        unavailableReason: "DATA_NOT_PRESENT",
      }).success,
    ).toBe(false);
  });

  it("keeps current and canonical provider rows coherent", () => {
    const unavailable = (provider: "CODEX" | "CLAUDE_CODE") => ({
      schemaVersion: 1 as const,
      provider,
      observedAt: "2026-09-04T20:00:00.000Z",
      freshness: "UNAVAILABLE" as const,
      buckets: [],
      unavailableReason: "DATA_NOT_PRESENT" as const,
    });
    const response = {
      schemaVersion: 1,
      projectId: "project-1",
      effectiveProvider: "CODEX",
      current: unavailable("CODEX"),
      advisory: { status: "UNKNOWN", deferUntil: null },
      providers: [unavailable("CODEX"), unavailable("CLAUDE_CODE")],
    };
    expect(projectProviderAllowanceResponseSchema.parse(response)).toEqual(response);
    expect(
      projectProviderAllowanceResponseSchema.safeParse({
        ...response,
        providers: [unavailable("CLAUDE_CODE"), unavailable("CODEX")],
      }).success,
    ).toBe(false);
  });
});
