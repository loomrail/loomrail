import { describe, expect, it } from "vitest";

import { claudeCodeProviderDiagnostics } from "../src/index.js";

describe("Claude Code provider diagnostics", () => {
  it("enforces the adapter's admission floor without treating the floor as verified", () => {
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.213 (Claude Code)\n")).toEqual({
      compatibility: "TOO_OLD",
      version: "2.1.213",
    });
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.214 (Claude Code)\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "2.1.214",
    });
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.214-rc.1 (Claude Code)\n")).toEqual({
      compatibility: "TOO_OLD",
      version: "2.1.214-rc.1",
    });
  });

  it("verifies the recorded version only on its exact macOS arm64 target", () => {
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.260 (Claude Code)\n")).toEqual({
      compatibility: process.platform === "darwin" && process.arch === "arm64" ? "VERIFIED" : "UNVERIFIED",
      version: "2.1.260",
    });
  });

  it("rejects ambiguous SemVer and does not echo unknown provider output", () => {
    const canary = "/private/owner/claude-version-canary";
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.214-rc.01 (Claude Code)\n")).toEqual({
      compatibility: "VERSION_UNREADABLE",
      version: null,
    });
    const observation = claudeCodeProviderDiagnostics.classifyVersion(canary);
    expect(observation).toEqual({ compatibility: "VERSION_UNREADABLE", version: null });
    expect(JSON.stringify(observation)).not.toContain(canary);
  });
});
