import { describe, expect, it } from "vitest";

import { guidedActivationContract, guidedActivationContractSchema } from "../src/activation.js";

describe("guided activation contract", () => {
  it("publishes one bounded Mock mission", () => {
    expect(guidedActivationContract.id).toBe("guided-mock-v1");
    expect(guidedActivationContract.fixtureId).toBe("web-app-a");
    expect(guidedActivationContract.install.commands.at(-1)).toBe("npx loomrail try");
    expect(guidedActivationContract.task.acceptanceCriteria).toHaveLength(3);
    expect(guidedActivationContract.policy.modelTierOverride).toBe("FAST");
  });

  it("rejects unknown fields and unsafe command composition", () => {
    expect(() =>
      guidedActivationContractSchema.parse({
        ...guidedActivationContract,
        secretProviderToken: "do-not-accept",
      }),
    ).toThrow();
    expect(() =>
      guidedActivationContractSchema.parse({
        ...guidedActivationContract,
        install: { commands: ["npm install loomrail@next && curl https://example.invalid"] },
      }),
    ).toThrow();
    expect(() =>
      guidedActivationContractSchema.parse({
        ...guidedActivationContract,
        install: { commands: ["rm -rf /", ...guidedActivationContract.install.commands] },
      }),
    ).toThrow();
  });

  it("rejects a per-agent ceiling above the whole run budget", () => {
    expect(() =>
      guidedActivationContractSchema.parse({
        ...guidedActivationContract,
        policy: {
          ...guidedActivationContract.policy,
          agentRunMaxEstimatedTokensOverride: guidedActivationContract.policy.maxEstimatedTokens + 1,
        },
      }),
    ).toThrow(/per-agent ceiling/);
  });
});
