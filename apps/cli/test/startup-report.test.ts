import { describe, expect, it } from "vitest";

import { formatStartupReport } from "../src/startup-report.js";

const baseUrl = "http://127.0.0.1:4176";
const bootstrapUrl = `${baseUrl}/#bootstrap=Rk9SLVRFU1QtT05MWS1UT0tFTi1WQUxVRS1IRVJF`;
const mock = {
  provider: "MOCK",
  cliAvailable: true,
  recognised: true,
  stages: ["DISCOVERY", "PLAN", "REVIEW", "IMPLEMENT", "VERIFY", "DELIVER"],
} as const;

// What `capabilities().stages` really says for both A2 live adapters.
const liveStages = ["DISCOVERY", "PLAN", "REVIEW"] as const;

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
      provider: { provider: "CODEX", cliAvailable: false, recognised: true, stages: liveStages },
    }).join("\n");

    expect(report).toContain("CODEX");
    expect(report).toContain("not found on this machine");
  });

  // A live provider used to get strictly less than the mock: one bare line, "Provider: CODEX.",
  // while MOCK got a whole explanatory sentence. The stage list existed only in the JSON log, so an
  // owner running a live adapter learned that it serves three of a run's six stages when a dispatch
  // was refused mid-run -- after the money for the earlier stages had been spent.
  it("tells a live provider's owner which stages that adapter actually serves", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { provider: "CODEX", cliAvailable: true, recognised: true, stages: liveStages },
    }).join("\n");

    expect(report).toContain("DISCOVERY, PLAN, REVIEW");
    expect(report).toContain("refused");
  });

  // The other limit of an A2 live run, and the one an owner is most likely to assume away: the
  // adapter is not looking at their repository at all. It works in an empty temporary directory
  // until E1 wires a workspace up.
  it("says plainly that a live adapter cannot see the repository yet", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { provider: "CLAUDE_CODE", cliAvailable: true, recognised: true, stages: liveStages },
    }).join("\n");

    expect(report).toContain("no access to your repository");
    expect(report).toContain("E1");
  });

  // The mock is the one provider these two lines would be wrong about: it serves every stage and
  // touches nothing, so saying "no access to your repository until E1" about it would read as a
  // limitation of the run rather than of the adapter.
  it("does not tell the mock's owner about a repository the mock never wanted", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: mock,
    }).join("\n");

    expect(report).not.toContain("no access to your repository");
  });

  // `LOOMRAIL_PROVIDER=codex` -- lowercase, the way the CLI itself is spelled -- used to start the
  // mock with no warning anywhere.
  it("names the accepted spellings when the environment asked for an unknown provider", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { provider: "MOCK", cliAvailable: true, recognised: false, stages: mock.stages },
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
