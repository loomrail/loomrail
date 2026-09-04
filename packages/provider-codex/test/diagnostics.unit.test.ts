import { describe, expect, it } from "vitest";

import {
  classifyCodexAuthenticationMode,
  codexProviderDiagnostics,
  codexRateLimitReportingTargetVerified,
  probeCodexAuthenticationMode,
} from "../src/index.js";

const nodeProbe = (script: string, options: { deadlineMs?: number; outputLimitBytes?: number } = {}) =>
  codexProviderDiagnostics.probeVersion({
    command: process.execPath,
    commandArgsPrefix: ["-e", script, "--"],
    environment: { PATH: process.env["PATH"] },
    ...options,
  });

describe("Codex provider diagnostics", () => {
  it("classifies only the live-verified ChatGPT login mode", () => {
    expect(classifyCodexAuthenticationMode("Logged in using ChatGPT\n")).toBe("CHATGPT");
    expect(classifyCodexAuthenticationMode("Logged in using another mode\n")).toBe("OTHER");
  });

  it("reads the bounded login mode through fixed argv", async () => {
    await expect(
      probeCodexAuthenticationMode({
        command: process.execPath,
        commandArgsPrefix: ["-e", 'process.stderr.write("Logged in using ChatGPT\\n")', "--"],
        environment: { PATH: process.env["PATH"] },
        deadlineMs: 1_000,
      }),
    ).resolves.toBe("CHATGPT");
    await expect(
      probeCodexAuthenticationMode({
        command: process.execPath,
        commandArgsPrefix: ["-e", 'process.stdout.write("Logged in using ChatGPT\\n")', "--"],
        environment: { PATH: process.env["PATH"] },
        deadlineMs: 1_000,
      }),
    ).resolves.toBe("CHATGPT");
    await expect(
      probeCodexAuthenticationMode({
        command: process.execPath,
        commandArgsPrefix: [
          "-e",
          'process.stdout.write("Logged in using ChatGPT\\n"); process.stderr.write("warning")',
          "--",
        ],
        environment: { PATH: process.env["PATH"] },
        deadlineMs: 1_000,
      }),
    ).resolves.toBe("UNKNOWN");
    await expect(
      probeCodexAuthenticationMode({
        command: process.execPath,
        commandArgsPrefix: ["-e", 'process.stdout.write("x".repeat(97))', "--"],
        environment: { PATH: process.env["PATH"] },
        deadlineMs: 1_000,
      }),
    ).resolves.toBe("UNKNOWN");
  });

  it("scopes rate-limit reporting to its independently verified exact target", () => {
    expect(
      codexRateLimitReportingTargetVerified("0.153.1", { platform: "darwin", architecture: "arm64" }),
    ).toBe(true);
    expect(
      codexRateLimitReportingTargetVerified("0.153.0-alpha.5", {
        platform: "darwin",
        architecture: "arm64",
      }),
    ).toBe(false);
    expect(codexRateLimitReportingTargetVerified("0.153.1", { platform: "win32", architecture: "x64" })).toBe(
      false,
    );
  });
  it("keeps versions without an exact runtime target unverified", () => {
    expect(codexProviderDiagnostics.classifyVersion("codex-cli 0.144.1\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "0.144.1",
    });
    expect(codexProviderDiagnostics.classifyVersion("codex-cli 0.151.0-alpha.7.2\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "0.151.0-alpha.7.2",
    });
  });

  it("verifies the recorded version only on its exact macOS arm64 target", () => {
    expect(codexProviderDiagnostics.classifyVersion("codex-cli 0.153.0-alpha.5\n")).toEqual({
      compatibility: process.platform === "darwin" && process.arch === "arm64" ? "VERIFIED" : "UNVERIFIED",
      version: "0.153.0-alpha.5",
    });
  });

  it("rejects unknown shapes without returning their raw path or error text", () => {
    const canary = "/private/owner/provider-version-canary";
    const observation = codexProviderDiagnostics.classifyVersion(canary);
    expect(observation).toEqual({ compatibility: "VERSION_UNREADABLE", version: null });
    expect(JSON.stringify(observation)).not.toContain(canary);
  });

  it("accepts exact SemVer syntax and rejects ambiguous leading-zero forms", () => {
    expect(codexProviderDiagnostics.classifyVersion("codex-cli 1.2.3-rc.1+native.win\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "1.2.3-rc.1+native.win",
    });
    expect(codexProviderDiagnostics.classifyVersion("codex-cli 01.2.3\n")).toEqual({
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
      codexProviderDiagnostics.probeVersion({ command: "/definitely/missing/loomrail-provider-cli" }),
    ).resolves.toEqual({ compatibility: "UNLAUNCHABLE", version: null });
  });
});
