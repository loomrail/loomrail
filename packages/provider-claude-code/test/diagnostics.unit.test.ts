import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { claudeCodeProviderDiagnostics } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "fake-claude.mjs");

describe("Claude Code provider diagnostics", () => {
  it("enforces the adapter's admission floor without treating the floor as verified", () => {
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.247 (Claude Code)\n")).toEqual({
      compatibility: "TOO_OLD",
      version: "2.1.247",
    });
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.248 (Claude Code)\n")).toEqual({
      compatibility: "UNVERIFIED",
      version: "2.1.248",
    });
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.248-rc.1 (Claude Code)\n")).toEqual({
      compatibility: "TOO_OLD",
      version: "2.1.248-rc.1",
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
    expect(claudeCodeProviderDiagnostics.classifyVersion("2.1.248-rc.01 (Claude Code)\n")).toEqual({
      compatibility: "VERSION_UNREADABLE",
      version: null,
    });
    const observation = claudeCodeProviderDiagnostics.classifyVersion(canary);
    expect(observation).toEqual({ compatibility: "VERSION_UNREADABLE", version: null });
    expect(JSON.stringify(observation)).not.toContain(canary);
  });

  it("probes the session engine parser instead of trusting the bare launcher version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-claude-version-"));
    const recordPath = join(directory, "probe.json");
    try {
      await expect(
        claudeCodeProviderDiagnostics.probeVersion({
          command: process.execPath,
          commandArgsPrefix: [
            fixture,
            "--fixture-record",
            recordPath,
            "--fixture-version",
            "2.1.247 (Claude Code)",
          ],
          environment: {
            ...process.env,
            HOME: "synthetic-provider-home",
            LANG: "en_US.UTF-8",
            ANTHROPIC_API_KEY: "must-not-reach-version-probe",
            PROJECT_SECRET: "must-not-reach-version-probe",
          },
        }),
      ).resolves.toEqual({ compatibility: "TOO_OLD", version: "2.1.247" });

      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        args: string[];
        cwd: string;
        environmentKeys: string[];
      };
      expect(record.args.slice(-3)).toEqual(["--setting-sources", "", "--version"]);
      expect(record.cwd).toContain("loomrail-claude-version-");
      expect(record.environmentKeys).toContain("HOME");
      expect(record.environmentKeys).toContain("LANG");
      expect(record.environmentKeys).not.toContain("ANTHROPIC_API_KEY");
      expect(record.environmentKeys).not.toContain("PROJECT_SECRET");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
