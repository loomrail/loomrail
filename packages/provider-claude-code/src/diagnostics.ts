import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliProviderDiagnostics,
  type CliProviderDiagnostics,
  type ProviderDiagnosticProbeOptions,
} from "@loomrail/provider-core";

// Claude Code versions below this documented floor lack the capabilities Loomrail's adapter uses.
// The floor is admission only: exact runtime targets still need live-session evidence.
const minimumVersion = "2.1.248";
const verifiedTargets = [{ version: "2.1.260", platform: "darwin", architecture: "arm64" }] as const;

const diagnostics = createCliProviderDiagnostics({
  command: "claude",
  // The native launcher can answer a bare `--version` itself while real `-p` sessions are
  // delegated to another bundled engine. Enter the inert settings-option parser first so the
  // observed version belongs to the engine that will enforce the production argv (ADR-0018).
  versionArguments: ["--setting-sources", "", "--version"],
  // Claude's launcher selects the bundled session engine through provider-owned state under these
  // roots. API keys and arbitrary owner variables remain outside the probe environment.
  versionEnvironmentKeys: [
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "LANG",
    "LC_ALL",
  ],
  authenticationArguments: ["auth", "status"],
  versionFromOutput: (output) => /^([^\s]+) \(Claude Code\)$/.exec(output.trim())?.[1] ?? null,
  minimumVersion,
  verifiedTargets,
});

export const claudeCodeProviderDiagnostics = {
  ...diagnostics,
  probeVersion: async (options: ProviderDiagnosticProbeOptions = {}) => {
    let scratchDirectory: string;
    try {
      scratchDirectory = await mkdtemp(join(tmpdir(), "loomrail-claude-version-"));
    } catch {
      return { compatibility: "UNLAUNCHABLE" as const, version: null };
    }
    try {
      return await diagnostics.probeVersion({ ...options, cwd: scratchDirectory });
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  },
} satisfies CliProviderDiagnostics;
