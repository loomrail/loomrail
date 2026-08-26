import { describe, expect, it } from "vitest";

import { providerCapabilitiesSchema } from "../src/index.js";

const validCapabilities = {
  provider: "MOCK" as const,
  start: true,
  interrupt: true,
  eventStream: true,
  usageReporting: true,
  contextWindowReporting: true,
  checkpointOnRequest: true,
  contextWindowTokens: 128_000,
  stages: ["DISCOVERY", "PLAN"] as const,
  costReporting: false,
};

const withoutField = (field: keyof typeof validCapabilities) =>
  Object.fromEntries(Object.entries(validCapabilities).filter(([key]) => key !== field));

describe("provider capabilities", () => {
  it("accepts a fully declared capability set", () => {
    expect(providerCapabilitiesSchema.parse(validCapabilities)).toMatchObject({
      provider: "MOCK",
      contextWindowTokens: 128_000,
    });
  });

  it("requires a declared context window size", () => {
    // Without a window size the pack budget (spec §4.3) is unknowable, and §6.1 step 2 has
    // nothing to compute a share of.
    expect(() => providerCapabilitiesSchema.parse(withoutField("contextWindowTokens"))).toThrow();
  });

  it("rejects a non-positive context window size", () => {
    expect(() =>
      providerCapabilitiesSchema.parse({ ...validCapabilities, contextWindowTokens: 0 }),
    ).toThrow();
  });

  it("rejects a capability set that claims checkpointOnRequest without eventStream", () => {
    // Winding down on request is impossible without a channel to deliver the checkpoint on.
    // Built by breaking exactly one field (eventStream) off an otherwise-valid capability set,
    // so the rejection can only be attributed to that pairing.
    expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, eventStream: false })).toThrow();
  });

  it("accepts checkpointOnRequest when paired with eventStream, and accepts neither", () => {
    // The invariant only forbids one direction (checkpointOnRequest without eventStream); both
    // of these otherwise-plausible pairings must still be accepted.
    expect(
      providerCapabilitiesSchema.parse({
        ...validCapabilities,
        checkpointOnRequest: true,
        eventStream: true,
      }),
    ).toMatchObject({ checkpointOnRequest: true, eventStream: true });
    expect(
      providerCapabilitiesSchema.parse({
        ...validCapabilities,
        checkpointOnRequest: false,
        contextWindowReporting: false,
        eventStream: false,
      }),
    ).toMatchObject({ checkpointOnRequest: false, eventStream: false });
  });

  it("rejects a capability set that claims contextWindowReporting without eventStream", () => {
    // Occupancy has exactly one channel: onContextWindow on the session listener (spec §4.3
    // amended -- occupancy arrives only in the stream, never with the outcome). Isolated from
    // the checkpointOnRequest pairing above by proving a checkpointOnRequest: false baseline is
    // valid first, then breaking exactly eventStream off it, so the rejection can only be
    // attributed to the contextWindowReporting pairing.
    const validWindowReportingOnly = { ...validCapabilities, checkpointOnRequest: false };
    expect(() => providerCapabilitiesSchema.parse(validWindowReportingOnly)).not.toThrow();
    expect(() =>
      providerCapabilitiesSchema.parse({ ...validWindowReportingOnly, eventStream: false }),
    ).toThrow();
  });

  it("rejects an unknown capability field", () => {
    expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, resume: true })).toThrow();
  });

  it("accepts a live provider identity", () => {
    expect(providerCapabilitiesSchema.parse({ ...validCapabilities, provider: "CODEX" }).provider).toBe(
      "CODEX",
    );
  });

  it("rejects a provider identity outside the enum", () => {
    expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, provider: "GPT" })).toThrow();
  });

  // An adapter that serves no stage can never be dispatched to; declaring one is not optional.
  it("rejects capabilities that declare no stage at all", () => {
    expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, stages: [] })).toThrow();
  });

  it("rejects an unknown stage", () => {
    expect(() => providerCapabilitiesSchema.parse({ ...validCapabilities, stages: ["DEPLOY"] })).toThrow();
  });
});
