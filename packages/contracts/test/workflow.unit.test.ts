import { describe, expect, it } from "vitest";

import { providerUsageSchema } from "../src/index.js";

describe("provider usage contract", () => {
  const validUsage = { inputTokens: 1200, outputTokens: 340, quality: "ACTUAL" } as const;

  it("accepts a report without cost, because not every provider reports one", () => {
    expect(providerUsageSchema.parse(validUsage)).toEqual(validUsage);
  });

  it("accepts a report with cost", () => {
    expect(providerUsageSchema.parse({ ...validUsage, costUsd: 0.0412 }).costUsd).toBeCloseTo(0.0412);
  });

  // Each negative case breaks exactly one field of the proven-valid fixture, so a failure names the
  // rule that broke rather than "something in this object is wrong".
  it("rejects a negative token count", () => {
    expect(() => providerUsageSchema.parse({ ...validUsage, outputTokens: -1 })).toThrow();
  });

  it("rejects a fractional token count", () => {
    expect(() => providerUsageSchema.parse({ ...validUsage, inputTokens: 1.5 })).toThrow();
  });

  it("rejects a field beyond the schema, so a provider cannot smuggle content through usage", () => {
    expect(() => providerUsageSchema.parse({ ...validUsage, transcript: "…" })).toThrow();
  });
});
