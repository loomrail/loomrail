import { createCliProviderDiagnostics } from "@loomrail/provider-core";

// Claude Code versions below this documented floor lack the capabilities Loomrail's adapter uses.
// The floor is admission only: exact versions still need cross-platform live-session evidence.
const minimumVersion = "2.1.214";
const verifiedVersions: readonly string[] = [];

export const claudeCodeProviderDiagnostics = createCliProviderDiagnostics({
  command: "claude",
  versionArguments: ["--version"],
  authenticationArguments: ["auth", "status"],
  versionFromOutput: (output) => /^([^\s]+) \(Claude Code\)$/.exec(output.trim())?.[1] ?? null,
  minimumVersion,
  verifiedVersions,
});
