import { describe, expect, it } from "vitest";

import { providerCapabilitiesSchema } from "../src/index.js";

describe("provider capabilities", () => {
  it("requires explicit lifecycle support", () => {
    expect(
      providerCapabilitiesSchema.parse({
        provider: "MOCK",
        start: true,
        resume: true,
        interrupt: false,
        eventStream: true,
        usageReporting: true,
      }),
    ).toMatchObject({ provider: "MOCK", resume: true });
  });
});
