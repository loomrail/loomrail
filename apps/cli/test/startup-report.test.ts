import { describe, expect, it } from "vitest";

import { formatStartupReport } from "../src/startup-report.js";

const baseUrl = "http://127.0.0.1:4176";
const bootstrapUrl = `${baseUrl}/#bootstrap=Rk9SLVRFU1QtT05MWS1UT0tFTi1WQUxVRS1IRVJF`;
const mock = {
  provider: "MOCK",
  cliAvailable: true,
  recognised: true,
  stages: ["DISCOVERY", "PLAN", "REVIEW", "IMPLEMENT", "VERIFY", "DELIVER"],
  worksInRepository: false,
} as const;

// What `capabilities().stages` really says for the Claude Code adapter, which spec D11 keeps off
// the write path until the owner runs the reconnaissance against an authorised CLI.
const liveStages = ["DISCOVERY", "PLAN", "REVIEW"] as const;

// And for Codex since E1: all six stages, IMPLEMENT and QA among them, so `worksInRepository` is
// the daemon's answer for it. The two adapters differ on exactly this, which is why the launcher
// can no longer say one thing about "a live provider".
const codexStages = ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"] as const;

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
      provider: {
        provider: "CODEX",
        cliAvailable: false,
        recognised: true,
        stages: codexStages,
        worksInRepository: true,
      },
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
      provider: {
        provider: "CLAUDE_CODE",
        cliAvailable: true,
        recognised: true,
        stages: liveStages,
        worksInRepository: false,
      },
    }).join("\n");

    expect(report).toContain("DISCOVERY, PLAN, REVIEW");
    expect(report).toContain("refused");
  });

  // The other limit an owner is most likely to assume away, for the adapter it still applies to:
  // Claude Code is not looking at their repository at all (spec D11). This is the case E1 did NOT
  // change, and it is asserted separately from the Codex case below precisely so that a future
  // change collapsing the two back into one sentence fails here.
  it("says plainly that an adapter without the write path cannot see the repository", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: {
        provider: "CLAUDE_CODE",
        cliAvailable: true,
        recognised: true,
        stages: liveStages,
        worksInRepository: false,
      },
    }).join("\n");

    expect(report).toContain("does not see your repository");
    expect(report).not.toContain("worktree");
  });

  // The defect this replaces was live on main and printed to every Codex owner: "no access to your
  // repository until milestone E1", after E1 had shipped and while the adapter was cutting a
  // worktree from that very repository and writing in it. A false reassurance about the one thing
  // an owner most needs to know is worse than silence, so the launcher now says what is true --
  // where the agent writes, and what it leaves alone.
  it("tells a Codex owner where the agent writes, and never that it cannot reach their repository", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: {
        provider: "CODEX",
        cliAvailable: true,
        recognised: true,
        stages: codexStages,
        worksInRepository: true,
      },
    }).join("\n");

    expect(report).toContain("worktree");
    expect(report).toContain("outside your repository");
    expect(report).toContain("pushes nothing");
    expect(report).not.toContain("does not see your repository");
    // The sentence that was false. Pinned by its own words so that restoring it -- or any
    // paraphrase claiming the repository is out of reach -- fails here rather than reaching an
    // owner's terminal again.
    expect(report).not.toContain("no access to your repository");
  });

  // The mock is the one provider both of those lines would be wrong about: it serves every stage
  // and touches nothing, so either sentence -- "it does not see your repository" or "it writes in a
  // worktree" -- would read as a fact about the run rather than about the adapter.
  it("does not tell the mock's owner about a repository the mock never wanted", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: mock,
    }).join("\n");

    expect(report).not.toContain("does not see your repository");
    expect(report).not.toContain("worktree");
  });

  // `LOOMRAIL_PROVIDER=codex` -- lowercase, the way the CLI itself is spelled -- used to start the
  // mock with no warning anywhere.
  it("names the accepted spellings when the environment asked for an unknown provider", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: {
        provider: "MOCK",
        cliAvailable: true,
        recognised: false,
        stages: mock.stages,
        worksInRepository: false,
      },
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
