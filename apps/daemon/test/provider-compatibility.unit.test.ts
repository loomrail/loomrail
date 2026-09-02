import { describe, expect, it } from "vitest";

import { classifyProviderVersion, probeProviderVersion } from "../src/provider-compatibility.js";

const nodeProbe = (script: string, options: { deadlineMs?: number; outputLimitBytes?: number } = {}) =>
  probeProviderVersion("CODEX", {
    command: process.execPath,
    commandArgsPrefix: ["-e", script, "--"],
    environment: { PATH: process.env["PATH"] },
    ...options,
  });

describe("provider compatibility", () => {
  it("keeps recorded and current Codex versions unverified until an exact cross-platform row exists", () => {
    expect(classifyProviderVersion("CODEX", "codex-cli 0.144.1\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "0.144.1",
    });
    expect(classifyProviderVersion("CODEX", "codex-cli 0.151.0-alpha.7.2\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "0.151.0-alpha.7.2",
    });
  });

  it("enforces the documented Claude admission floor without treating the floor as verified", () => {
    expect(classifyProviderVersion("CLAUDE_CODE", "2.1.213 (Claude Code)\n")).toEqual({
      compatibility: "TOO_OLD",
      version: "2.1.213",
    });
    expect(classifyProviderVersion("CLAUDE_CODE", "2.1.214 (Claude Code)\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "2.1.214",
    });
    expect(classifyProviderVersion("CLAUDE_CODE", "2.1.214-rc.1 (Claude Code)\n")).toEqual({
      compatibility: "TOO_OLD",
      version: "2.1.214-rc.1",
    });
  });

  it("rejects unknown shapes without returning their raw path or error text", () => {
    const canary = "/private/owner/provider-version-canary";
    expect(classifyProviderVersion("CODEX", canary)).toEqual({
      compatibility: "VERSION_UNREADABLE",
      version: null,
    });
    expect(JSON.stringify(classifyProviderVersion("CLAUDE_CODE", canary))).not.toContain(canary);
  });

  it("accepts exact SemVer syntax and rejects ambiguous leading-zero forms", () => {
    expect(classifyProviderVersion("CODEX", "codex-cli 1.2.3-rc.1+native.win\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "1.2.3-rc.1+native.win",
    });
    expect(classifyProviderVersion("CODEX", "codex-cli 01.2.3\n")).toEqual({
      compatibility: "VERSION_UNREADABLE",
      version: null,
    });
    expect(classifyProviderVersion("CLAUDE_CODE", "2.1.214-rc.01 (Claude Code)\n")).toEqual({
      compatibility: "VERSION_UNREADABLE",
      version: null,
    });
  });

  it("observes a fixed version process with closed stdin and bounded normalized output", async () => {
    await expect(nodeProbe('process.stdout.write("codex-cli 0.152.1\\n")')).resolves.toEqual({
      compatibility: "UNVERIFIED",
      version: "0.152.1",
    });
  });

  it("fails closed when output exceeds the byte ceiling", async () => {
    await expect(
      nodeProbe('process.stdout.write("x".repeat(17))', { outputLimitBytes: 16 }),
    ).resolves.toEqual({ compatibility: "VERSION_UNREADABLE", version: null });
  });

  it("fails closed when the version process exceeds its deadline", async () => {
    await expect(nodeProbe("setInterval(() => {}, 1000)", { deadlineMs: 25 })).resolves.toEqual({
      compatibility: "UNLAUNCHABLE",
      version: null,
    });
  });

  it("turns a missing executable into a typed observation", async () => {
    await expect(
      probeProviderVersion("CODEX", { command: "/definitely/missing/loomrail-provider-cli" }),
    ).resolves.toEqual({ compatibility: "UNLAUNCHABLE", version: null });
  });
});
