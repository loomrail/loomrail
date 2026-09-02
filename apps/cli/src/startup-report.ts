export type StartupProvider = {
  /** The adapter this daemon will dispatch every stage to, for its whole lifetime. */
  provider: string;
  /** `capabilities().start` -- whether the adapter is admitted to start a new managed session. */
  cliAvailable: boolean;
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

// Which adapter is live is not a detail: MOCK completes every stage successfully, so an owner who
// mistyped `LOOMRAIL_PROVIDER` can watch a whole delivery run and believe a live agent did it. And
// a live adapter can remain selected but not ready -- something the owner would
// otherwise learn only from the first refused dispatch. Both facts are stated here, at the one
// moment the owner is definitely reading.
//
// A live provider used to get LESS than the mock did -- one bare word, "Provider: CODEX.", while
// MOCK got a whole explanatory sentence. The two limits that actually shape a live run were in the
// JSON log and nowhere a human reads: which of the six stages the adapter serves, and what it can
// reach while it serves them. Both were learned from the first refused dispatch, mid-run, with
// money already spent.
//
// The second line used to be one sentence for every live adapter -- "no access to your repository
// until milestone E1". E1 has landed, and it landed for one adapter and not the other (spec D11:
// Codex declares all six stages, Claude Code still three), so a single sentence about "a live
// provider" is now false for whichever one it is not describing. It also used to bound the reach to
// "a stage that changes files", which was the milestone's own mistake: every stage but the owner's
// acceptance decision now runs in that worktree, and an owner told otherwise would underestimate
// what the agent reads. Worse, it is false in the
// dangerous direction for Codex: an owner told the agent cannot see their repository, while it is
// cutting a worktree from it and writing there, is being reassured about the exact thing they most
// need to know. The two cases are now stated apart, off a fact the daemon reads from the domain.
const providerLines = ({
  provider,
  cliAvailable,
  recognised,
  stages,
  worksInRepository,
}: StartupProvider): readonly string[] => {
  const lines =
    provider === "MOCK"
      ? ["Provider: MOCK (the deterministic test double -- no real agent runs)."]
      : [
          `Provider: ${provider}${cliAvailable ? "" : " -- but it is not ready for managed sessions, so dispatches will be refused; review its exact status in Settings"}.`,
          `It serves ${stages.join(", ")}; any other stage is refused to you as a question rather than dispatched.`,
          worksInRepository
            ? "Each stage it runs works in a Git worktree cut for that task, outside your repository and on a branch of its own -- reading your code as well as changing it. Your working copy is untouched, and Loomrail pushes nothing."
            : "It works in an empty temporary directory: it does not see your repository at all.",
        ];
  if (!recognised) {
    lines.push(
      "LOOMRAIL_PROVIDER named a provider Loomrail does not know; it fell back to MOCK. Accepted values: MOCK, CODEX, CLAUDE_CODE.",
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
