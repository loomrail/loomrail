import type { ProviderAdapter, ProviderId } from "@loomrail/provider-core";
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

// The spellings this daemon accepts, in the exact case it accepts them. Exported so the warning
// below, the README and any future `--help` all name the same list rather than three copies of it
// that can drift.
export const LOOMRAIL_PROVIDER_VALUES = ["MOCK", "CODEX", "CLAUDE_CODE"] as const;

export type ProviderResolution = {
  /** Which adapter this daemon will run for its whole lifetime. */
  provider: ProviderId;
  adapter: ProviderAdapter;
  /**
   * `false` when the environment named a provider this daemon does not know. The daemon still
   * starts (on the mock), because a typo in the environment must not stop it -- but the caller has
   * to be able to say so out loud, which is the whole reason this is a value rather than a log
   * line buried in here.
   */
  recognised: boolean;
  /** The raw value that was read, so a warning can quote it back. `null` when it was unset. */
  requested: string | null;
};

// Running a live adapter must be something the owner did on purpose -- never a side effect of
// which CLIs happen to be on this machine's PATH -- so the default, and the fallback for any value
// this daemon does not recognise, is the mock adapter it has always run. A typo in the environment
// must not stop the daemon from starting, so an unrecognised value falls back to mock rather than
// throwing.
//
// It must not fall back SILENTLY, though, and it used to. `LOOMRAIL_PROVIDER=codex` -- the near
// certain typo, since the CLI itself is spelled lowercase -- started the mock, which then completed
// stages successfully, and the owner watched a full delivery run believing a live agent had done
// it. Hence `recognised`: the resolution is a value the caller reports, not a side effect nobody
// sees.
export const resolveDefaultProviderAdapter = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderResolution => {
  const raw = env[LOOMRAIL_PROVIDER_ENV_VAR];
  const requested = raw === undefined || raw.trim().length === 0 ? null : raw;
  if (requested === "CODEX") {
    return { provider: "CODEX", adapter: createCodexProvider(), recognised: true, requested };
  }
  if (requested === "CLAUDE_CODE") {
    return {
      provider: "CLAUDE_CODE",
      adapter: createClaudeCodeProvider(),
      recognised: true,
      requested,
    };
  }
  return {
    provider: "MOCK",
    adapter: createMockProvider(),
    // An unset variable is not a mistake; a value this daemon cannot read is.
    recognised: requested === null || requested === "MOCK",
    requested,
  };
};
