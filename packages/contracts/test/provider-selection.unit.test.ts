import { describe, expect, it } from "vitest";

import { providerAvailabilitySchema } from "../src/provider-selection.js";

const liveAvailability = {
  provider: "CODEX",
  installed: true,
  authentication: "AUTHENTICATED",
  version: "0.152.1",
  compatibility: "VERIFIED",
  ready: true,
  stages: ["DISCOVERY"],
  checkpointOnRequest: false,
  contextWindowReporting: true,
  costReporting: false,
  tokenBudgetEnforcement: "HARD",
  canReportRateLimits: false,
  models: {
    FAST: "gpt-5.6-luna",
    STANDARD: "gpt-5.6-terra",
    DEEP: "gpt-5.6-sol",
  },
} as const;

describe("provider availability compatibility", () => {
  it("accepts the built-in Mock invariant", () => {
    expect(
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        provider: "MOCK",
        version: null,
        compatibility: "BUILT_IN",
        models: null,
      }),
    ).toMatchObject({ provider: "MOCK", ready: true });
  });

  it("accepts an authenticated exact verified live provider", () => {
    expect(providerAvailabilitySchema.parse(liveAvailability)).toEqual(liveAvailability);
  });

  it("keeps provider readiness separate from post-session-only budget reporting", () => {
    expect(
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        tokenBudgetEnforcement: "POST_SESSION",
      }),
    ).toMatchObject({ ready: true, tokenBudgetEnforcement: "POST_SESSION" });
  });

  it("requires the built-in Mock to preserve hard-budget safety", () => {
    expect(() =>
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        provider: "MOCK",
        version: null,
        compatibility: "BUILT_IN",
        models: null,
        tokenBudgetEnforcement: "POST_SESSION",
      }),
    ).toThrow("The Mock provider is always ready");
  });

  it("rejects ready=true for an unverified live version", () => {
    expect(() =>
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        compatibility: "UNVERIFIED",
        authentication: "UNKNOWN",
      }),
    ).toThrow("Live provider readiness must match install, compatibility and auth state");
  });

  it("allows authentication on a separately verified read-only capability target", () => {
    expect(
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        compatibility: "UNVERIFIED",
        authentication: "REQUIRED",
        ready: false,
        canReportRateLimits: true,
      }),
    ).toMatchObject({ authentication: "REQUIRED", ready: false, canReportRateLimits: true });
  });

  it("rejects authentication claims for a missing or unversioned executable", () => {
    expect(() =>
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        installed: false,
        version: null,
        compatibility: "MISSING",
        authentication: "REQUIRED",
        ready: false,
      }),
    ).toThrow("Authentication is observed only for an installed, versioned live provider target");
  });

  it("binds version presence and missing state to compatibility", () => {
    expect(() =>
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        installed: false,
        authentication: "UNKNOWN",
        version: null,
        compatibility: "UNVERIFIED",
        ready: false,
      }),
    ).toThrow();
    expect(() =>
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        version: null,
        compatibility: "VERIFIED",
      }),
    ).toThrow("Live provider version presence must match its compatibility state");
  });
});
