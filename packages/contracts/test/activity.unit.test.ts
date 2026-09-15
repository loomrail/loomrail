import { describe, expect, it } from "vitest";

import { providerActivityEntrySchema } from "../src/activity.js";

const valid = {
  actionKey: "call_1",
  kind: "TOOL_CALL",
  label: "pnpm test",
  detail: null,
  status: null,
  terminal: false,
  truncated: false,
} as const;

describe("providerActivityEntrySchema", () => {
  it("accepts a started tool call", () => {
    expect(providerActivityEntrySchema.parse(valid)).toEqual(valid);
  });

  it("rejects a label past the bound instead of silently keeping it", () => {
    const result = providerActivityEntrySchema.safeParse({ ...valid, label: "x".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field so a later addition cannot ride along", () => {
    const result = providerActivityEntrySchema.safeParse({ ...valid, extra: "1" });
    expect(result.success).toBe(false);
  });
});
