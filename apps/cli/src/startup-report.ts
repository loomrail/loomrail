export type StartupReport = {
  baseUrl: string;
  bootstrapUrl: string;
  browserOpened: boolean;
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
}: StartupReport): readonly string[] => {
  if (browserOpened) {
    return [`Loomrail is ready at ${baseUrl}`, "Opened Loomrail in your default browser."];
  }

  return [
    `Loomrail is ready at ${baseUrl}`,
    "Open this one-time sign-in URL in a browser on this machine within 60 seconds:",
    `  ${bootstrapUrl}`,
    "The link signs in a single browser and then stops working. Restart Loomrail to get a new one.",
  ];
};
