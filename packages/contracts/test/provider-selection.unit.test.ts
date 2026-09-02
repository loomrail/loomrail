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
} as const;

describe("provider availability compatibility", () => {
  it("accepts the built-in Mock invariant", () => {
    expect(
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        provider: "MOCK",
        version: null,
        compatibility: "BUILT_IN",
      }),
    ).toMatchObject({ provider: "MOCK", ready: true });
  });

  it("accepts an authenticated exact verified live provider", () => {
    expect(providerAvailabilitySchema.parse(liveAvailability)).toEqual(liveAvailability);
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

  it("rejects authentication claims made before exact version verification", () => {
    expect(() =>
      providerAvailabilitySchema.parse({
        ...liveAvailability,
        compatibility: "UNVERIFIED",
        authentication: "REQUIRED",
        ready: false,
      }),
    ).toThrow("Authentication is observed only for an exact verified live provider");
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
