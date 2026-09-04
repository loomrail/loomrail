import { createCliProviderDiagnostics } from "@loomrail/provider-core";

// Claude Code versions below this documented floor lack the capabilities Loomrail's adapter uses.
// The floor is admission only: exact runtime targets still need live-session evidence.
const minimumVersion = "2.1.214";
const verifiedTargets = [{ version: "2.1.260", platform: "darwin", architecture: "arm64" }] as const;

export const claudeCodeProviderDiagnostics = createCliProviderDiagnostics({
  command: "claude",
  versionArguments: ["--version"],
  authenticationArguments: ["auth", "status"],
  versionFromOutput: (output) => /^([^\s]+) \(Claude Code\)$/.exec(output.trim())?.[1] ?? null,
  minimumVersion,
  verifiedTargets,
});
