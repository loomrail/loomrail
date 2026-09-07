export type StartupProvider = {
  /** The adapter this daemon will dispatch every stage to, for its whole lifetime. */
  provider: string;
  /** `capabilities().start` -- whether the adapter is admitted to start a new managed session. */
  providerReady: boolean;
  /** Whether the selected adapter can stop before Loomrail's immutable token ceiling. */
  tokenBudgetEnforcement: "HARD" | "POST_SESSION";
  /** `false` when LOOMRAIL_PROVIDER named something this daemon could not read. */
  recognised: boolean;
  /**
   * `capabilities().stages` -- the WorkflowStages this adapter serves. Never empty
   * (`providerCapabilitiesSchema` requires at least one), and in A2 always fewer than the six a
   * delivery run has.
   */
  stages: readonly string[];
  /**
   * Whether this adapter works in the owner's repository at all. Computed by the daemon from
   * `adapterWorksInWorkspace` (@loomrail/domain) rather than re-derived from `stages` here: the
   * domain owns the answer, and a second copy of it in the launcher would be free to drift from the
   * one the dispatcher reads. When true, every stage that adapter runs except the owner's own
   * acceptance decision is given the work item's worktree -- not only the ones that change files.
   */
  worksInRepository: boolean;
};

export type StartupReport = {
  baseUrl: string;
  bootstrapUrl: string;
  browserOpened: boolean;
  provider: StartupProvider;
};

// Provider readiness and stage reach are stated at startup so an owner does not discover a missing
// API key or unsupported writing stage only after starting a paid workflow.
const providerLines = ({
  provider,
  providerReady,
  tokenBudgetEnforcement,
  recognised,
  stages,
  worksInRepository,
}: StartupProvider): readonly string[] => {
  const providerLabel = provider === "CLAUDE_CODE" ? "Anthropic Messages" : "OpenAI Responses";
  const lines = [
    `Provider: ${providerLabel}${providerReady ? "" : " -- API credential missing; managed dispatches are refused"}.`,
    ...(tokenBudgetEnforcement === "POST_SESSION"
      ? ["It cannot enforce Loomrail's hard token budget, so no provider request will start."]
      : []),
    `It serves ${stages.join(", ")}; any other stage is refused before provider dispatch.`,
    worksInRepository
      ? "Each stage it runs works in a task-specific Git worktree. Your working copy is untouched, and Loomrail pushes nothing."
      : "This adapter currently receives the bounded context pack only; workspace-writing stages are refused.",
  ];
  if (!recognised) {
    lines.push(
      "LOOMRAIL_PROVIDER named an unknown provider; Loomrail selected OpenAI Responses but left it blocked without OPENAI_API_KEY. Accepted values: CODEX, CLAUDE_CODE.",
    );
  }
  return lines;
};

/**
 * Builds the launcher's stdout lines.
 *
 * The one-time bootstrap URL is the only way to authenticate a browser against the loopback daemon.
 * When the launcher opens the browser itself the URL stays out of the terminal; when it does not, the
 * operator has to receive it here or the run is unusable. See `docs/security/THREAT-MODEL.md`.
 */
export const formatStartupReport = ({
  baseUrl,
  bootstrapUrl,
  browserOpened,
  provider,
}: StartupReport): readonly string[] => {
  if (browserOpened) {
    return [
      `Loomrail is ready at ${baseUrl}`,
      ...providerLines(provider),
      "Opened Loomrail in your default browser.",
    ];
  }

  return [
    `Loomrail is ready at ${baseUrl}`,
    ...providerLines(provider),
    "Open this one-time sign-in URL in a browser on this machine within 60 seconds:",
    `  ${bootstrapUrl}`,
    "The link signs in a single browser and then stops working. Restart Loomrail to get a new one.",
  ];
};
