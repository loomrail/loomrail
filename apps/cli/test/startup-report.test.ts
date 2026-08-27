import { describe, expect, it } from "vitest";

import { formatStartupReport } from "../src/startup-report.js";

const baseUrl = "http://127.0.0.1:4176";
const bootstrapUrl = `${baseUrl}/#bootstrap=Rk9SLVRFU1QtT05MWS1UT0tFTi1WQUxVRS1IRVJF`;
const mock = { provider: "MOCK", cliAvailable: true, recognised: true } as const;

describe("startup report", () => {
  it("keeps the bootstrap URL out of the terminal when the launcher opens the browser", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: true, provider: mock });

    expect(lines.join("\n")).toContain(baseUrl);
    expect(lines.some((line) => line.includes("bootstrap="))).toBe(false);
  });

  it("prints the one-time sign-in URL when no browser is opened", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: false, provider: mock });

    expect(lines.some((line) => line.includes(bootstrapUrl))).toBe(true);
  });

  // The mock completes every stage successfully. An owner who does not know they are on it can
  // watch a whole delivery run and believe a live agent did the work -- so the launcher says so at
  // the one moment the owner is definitely reading.
  it("says plainly when the daemon is running the deterministic mock", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: mock,
    }).join("\n");

    expect(report).toContain("MOCK");
    expect(report).toContain("no real agent runs");
  });

  // Selected and unable to run are different claims: `capabilities().start` is false when the CLI
  // is not on this machine, and without this line the owner learns it from the first refused
  // dispatch instead of from startup.
  it("warns that a selected live adapter has no CLI on this machine", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { provider: "CODEX", cliAvailable: false, recognised: true },
    }).join("\n");

    expect(report).toContain("CODEX");
    expect(report).toContain("not found on this machine");
  });

  // `LOOMRAIL_PROVIDER=codex` -- lowercase, the way the CLI itself is spelled -- used to start the
  // mock with no warning anywhere.
  it("names the accepted spellings when the environment asked for an unknown provider", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { provider: "MOCK", cliAvailable: true, recognised: false },
    }).join("\n");

    expect(report).toContain("LOOMRAIL_PROVIDER");
    expect(report).toContain("MOCK, CODEX, CLAUDE_CODE");
  });

  it("explains that the printed sign-in URL expires and is single-use", () => {
    const report = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: false, provider: mock }).join(
      "\n",
    );

    expect(report).toMatch(/60 seconds/);
    expect(report).toMatch(/single browser/);
  });
});
