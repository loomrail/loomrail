export type StartupProvider = {
  /** The adapter this daemon will dispatch every stage to, for its whole lifetime. */
  provider: string;
  /** `capabilities().start` -- whether the adapter's CLI was actually found on this machine. */
  cliAvailable: boolean;
  /** `false` when LOOMRAIL_PROVIDER named something this daemon could not read. */
  recognised: boolean;
};

export type StartupReport = {
  baseUrl: string;
  bootstrapUrl: string;
  browserOpened: boolean;
  provider: StartupProvider;
};

// Which adapter is live is not a detail: MOCK completes every stage successfully, so an owner who
// mistyped `LOOMRAIL_PROVIDER` can watch a whole delivery run and believe a live agent did it. And
// an adapter whose CLI is missing is selected but cannot start -- something the owner would
// otherwise learn only from the first refused dispatch. Both facts are stated here, at the one
// moment the owner is definitely reading.
const providerLines = ({ provider, cliAvailable, recognised }: StartupProvider): readonly string[] => {
  const lines = [
    provider === "MOCK"
      ? "Provider: MOCK (the deterministic test double -- no real agent runs)."
      : `Provider: ${provider}${cliAvailable ? "" : " -- but its CLI was not found on this machine, so dispatches will be refused"}.`,
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
