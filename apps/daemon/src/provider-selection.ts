import type { ProviderAdapter } from "@loomrail/provider-core";
import { createClaudeCodeProvider } from "@loomrail/provider-claude-code";
import { createCodexProvider } from "@loomrail/provider-codex";
import { createMockProvider } from "@loomrail/provider-mock";

// Milestone A2 built two live adapters, but deliberately did not build a way to route different
// WorkflowStages of one run to different adapters -- one adapter serves every stage this daemon
// instance dispatches, for the life of the process. A stage the chosen adapter cannot serve
// (undeclared in `capabilities().stages`, or `start: false` because its CLI is not installed) is
// refused to the owner as a blocking HumanRequest by `decideDispatchStage` (`@loomrail/domain`),
// never silently retried against a different provider -- see
// docs/plans/11-a2-live-provider-adapters-spec.ru.md §4.
//
// This is the one environment variable that picks which adapter that is, read once at startup.
export const LOOMRAIL_PROVIDER_ENV_VAR = "LOOMRAIL_PROVIDER";

// Running a live adapter must be something the owner did on purpose -- never a side effect of
// which CLIs happen to be on this machine's PATH -- so the default, and the fallback for any
// value this daemon does not recognise, is the mock adapter it has always run. A typo in the
// environment must not stop the daemon from starting, so an unrecognised value falls back to mock
// rather than throwing.
export const resolveDefaultProviderAdapter = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderAdapter => {
  const selection = env[LOOMRAIL_PROVIDER_ENV_VAR];
  if (selection === "CODEX") return createCodexProvider();
  if (selection === "CLAUDE_CODE") return createClaudeCodeProvider();
  return createMockProvider();
};
