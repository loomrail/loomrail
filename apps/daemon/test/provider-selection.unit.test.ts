import { describe, expect, it } from "vitest";

import { LOOMRAIL_PROVIDER_ENV_VAR, resolveDefaultProviderAdapter } from "../src/provider-selection.js";

describe("resolveDefaultProviderAdapter", () => {
  it("defaults to the fail-closed local Codex adapter", () => {
    const resolution = resolveDefaultProviderAdapter({});
    expect(resolution.provider).toBe("CODEX");
    expect(resolution.adapter.capabilities()).toMatchObject({ provider: "CODEX", start: false });
    expect(resolution.recognised).toBe(true);
    expect(resolution.requested).toBeNull();
  });

  it("does not treat an OpenAI API key as local Codex readiness", () => {
    const resolution = resolveDefaultProviderAdapter({
      [LOOMRAIL_PROVIDER_ENV_VAR]: "CODEX",
      OPENAI_API_KEY: "test-key-not-sent",
    });
    expect(resolution.adapter.capabilities()).toMatchObject({ provider: "CODEX", start: false });
  });

  it("selects local Claude Code without treating an Anthropic API key as readiness", () => {
    const blocked = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "CLAUDE_CODE" });
    const ready = resolveDefaultProviderAdapter({
      [LOOMRAIL_PROVIDER_ENV_VAR]: "CLAUDE_CODE",
      ANTHROPIC_API_KEY: "test-key-not-sent",
    });
    expect(blocked.adapter.capabilities()).toMatchObject({ provider: "CLAUDE_CODE", start: false });
    expect(ready.adapter.capabilities()).toMatchObject({ provider: "CLAUDE_CODE", start: false });
  });

  it("marks the retired provider identifier and unknown values invalid", () => {
    for (const requested of ["MOCK", "codex", "unknown"]) {
      const resolution = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: requested });
      expect(resolution.provider).toBe("CODEX");
      expect(resolution.adapter.capabilities()).toMatchObject({ provider: "CODEX", start: false });
      expect(resolution.recognised).toBe(false);
      expect(resolution.requested).toBe(requested);
    }
  });

  it("treats an empty value as unset", () => {
    const resolution = resolveDefaultProviderAdapter({ [LOOMRAIL_PROVIDER_ENV_VAR]: "" });
    expect(resolution.provider).toBe("CODEX");
    expect(resolution.recognised).toBe(true);
  });
});
