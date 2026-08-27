import { describe, expect, it } from "vitest";

import { LOOMRAIL_PROVIDER_ENV_VAR, resolveDefaultProviderAdapter } from "../src/provider-selection.js";

// The daemon runs exactly one adapter for its whole lifetime (no per-stage routing -- see the
// module's own comment). These tests pin the one thing that chooses it: absent or unrecognised
// `LOOMRAIL_PROVIDER` must mean mock, and a value it does recognise must mean that adapter, never
// the other way around.
describe("resolveDefaultProviderAdapter", () => {
  it("defaults to mock when the environment variable is not set", () => {
    const adapter = resolveDefaultProviderAdapter({});
    expect(adapter.capabilities().provider).toBe("MOCK");
  });

  it("selects Codex when the environment variable names it", () => {
    const adapter = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "CODEX" });
    expect(adapter.capabilities().provider).toBe("CODEX");
  });

  it("selects Claude Code when the environment variable names it", () => {
    const adapter = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "CLAUDE_CODE" });
    expect(adapter.capabilities().provider).toBe("CLAUDE_CODE");
  });

  // A typo in the environment must not stop the daemon from starting -- an owner who mistypes the
  // provider name gets the same daemon they had before opting in, not a boot failure.
  it("falls back to mock on an unrecognised value, instead of throwing", () => {
    expect(() => resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "codex" })).not.toThrow();
    const adapter = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "codex" });
    expect(adapter.capabilities().provider).toBe("MOCK");
  });
});
