import { createCliProviderDiagnostics } from "@loomrail/provider-core";

// Empty by design: no Codex version has completed the exact cross-platform live-session evidence
// gate yet. Add only exact strings backed by that evidence; never replace this with a semver range.
const verifiedVersions: readonly string[] = [];

export const codexProviderDiagnostics = createCliProviderDiagnostics({
  command: "codex",
  versionArguments: ["--version"],
  authenticationArguments: ["login", "status"],
  versionFromOutput: (output) => /^codex-cli ([^\s]+)$/.exec(output.trim())?.[1] ?? null,
  verifiedVersions,
});
