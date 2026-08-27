import { describe, expect, it } from "vitest";

import { LOOMRAIL_PROVIDER_ENV_VAR, resolveDefaultProviderAdapter } from "../src/provider-selection.js";

// The daemon runs exactly one adapter for its whole lifetime (no per-stage routing -- see the
// module's own comment). These tests pin the one thing that chooses it: absent or unrecognised
// `LOOMRAIL_PROVIDER` must mean mock, and a value it does recognise must mean that adapter, never
// the other way around.
describe("resolveDefaultProviderAdapter", () => {
  it("defaults to mock when the environment variable is not set", () => {
    const resolution = resolveDefaultProviderAdapter({});
    expect(resolution.provider).toBe("MOCK");
    expect(resolution.adapter.capabilities().provider).toBe("MOCK");
    // Unset is not a mistake: nothing should be warned about.
    expect(resolution.recognised).toBe(true);
    expect(resolution.requested).toBeNull();
  });

  it("selects Codex when the environment variable names it", () => {
    const resolution = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "CODEX" });
    expect(resolution.provider).toBe("CODEX");
    expect(resolution.adapter.capabilities().provider).toBe("CODEX");
    expect(resolution.recognised).toBe(true);
  });

  it("selects Claude Code when the environment variable names it", () => {
    const resolution = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "CLAUDE_CODE" });
    expect(resolution.provider).toBe("CLAUDE_CODE");
    expect(resolution.adapter.capabilities().provider).toBe("CLAUDE_CODE");
    expect(resolution.recognised).toBe(true);
  });

  // A typo in the environment must not stop the daemon from starting -- an owner who mistypes the
  // provider name gets the same daemon they had before opting in, not a boot failure. But it must
  // not fall back SILENTLY: `LOOMRAIL_PROVIDER=codex` (lowercase, which is how the CLI itself is
  // spelled, so the likeliest typo there is) used to start the mock, which then completes stages
  // successfully -- and the owner watches a full delivery run believing a live agent did it.
  it("falls back to mock on an unrecognised value, and says the value was not recognised", () => {
    expect(() => resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "codex" })).not.toThrow();
    const resolution = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "codex" });
    expect(resolution.provider).toBe("MOCK");
    expect(resolution.recognised).toBe(false);
    // Quoted back so a warning can name what was actually set, not just that something was.
    expect(resolution.requested).toBe("codex");
  });

  // MOCK is a value the owner can set on purpose. It resolves to the same adapter an unset variable
  // does, but it is not a mistake and must not be warned about as one.
  it("treats an explicit MOCK as a recognised choice, not a typo", () => {
    const resolution = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "MOCK" });
    expect(resolution.provider).toBe("MOCK");
    expect(resolution.recognised).toBe(true);
  });

  // An empty string is what an owner gets from `LOOMRAIL_PROVIDER=` or from an unset shell
  // variable expanded into the environment. It means "unset", not "a provider named nothing".
  it("treats an empty value as unset rather than as an unrecognised provider", () => {
    const resolution = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "" });
    expect(resolution.provider).toBe("MOCK");
    expect(resolution.recognised).toBe(true);
  });
});
