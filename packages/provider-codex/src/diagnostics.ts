import { createCliProviderDiagnostics } from "@loomrail/provider-core";

// Every row is platform- and architecture-scoped; never replace this with versions alone or a
// semver range. Q14 evidence is recorded in docs/evidence/phase-8/Q14-MACOS-LIVE-PROVIDERS-EVIDENCE.md.
const verifiedTargets = [{ version: "0.153.0-alpha.5", platform: "darwin", architecture: "arm64" }] as const;

export const codexProviderDiagnostics = createCliProviderDiagnostics({
  command: "codex",
  versionArguments: ["--version"],
  authenticationArguments: ["login", "status"],
  versionFromOutput: (output) => /^codex-cli ([^\s]+)$/.exec(output.trim())?.[1] ?? null,
  verifiedTargets,
});
