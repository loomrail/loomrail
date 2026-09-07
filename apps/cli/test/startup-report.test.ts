import { describe, expect, it } from "vitest";

import { formatStartupReport, type StartupProvider } from "../src/startup-report.js";

const baseUrl = "http://127.0.0.1:4176";
const bootstrapUrl = `${baseUrl}/#bootstrap=Rk9SLVRFU1QtT05MWS1UT0tFTi1WQUxVRS1IRVJF`;
const codex: StartupProvider = {
  provider: "CODEX",
  providerReady: true,
  tokenBudgetEnforcement: "POST_SESSION",
  recognised: true,
  stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
  worksInRepository: true,
};

describe("real-provider startup report", () => {
  it("keeps the bootstrap URL out of the terminal when the launcher opens the browser", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: true, provider: codex });
    expect(lines.join("\n")).toContain("Codex CLI");
    expect(lines.join("\n")).toContain("reconciled after each local CLI session");
    expect(lines.some((line) => line.includes("bootstrap="))).toBe(false);
  });

  it("prints the one-time sign-in URL when no browser is opened", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: false, provider: codex });
    expect(lines.some((line) => line.includes(bootstrapUrl))).toBe(true);
  });

  it("fails transparently when the selected local CLI is not ready", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { ...codex, providerReady: false },
    }).join("\n");
    expect(report).toContain("local CLI is not ready");
    expect(report).toContain("managed dispatches are refused");
  });

  it("names the Claude Code CLI and the stages it actually serves", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { ...codex, provider: "CLAUDE_CODE", stages: ["DISCOVERY", "PLAN", "REVIEW"] },
    }).join("\n");
    expect(report).toContain("Claude Code CLI");
    expect(report).toContain("DISCOVERY, PLAN, REVIEW");
    expect(report).toContain("task-specific Git worktree");
  });

  it("blocks an unknown environment override instead of selecting synthetic work", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { ...codex, providerReady: false, recognised: false },
    }).join("\n");
    expect(report).toContain("LOOMRAIL_PROVIDER");
    expect(report).toContain("CODEX, CLAUDE_CODE");
    expect(report).toContain("blocked");
  });
});
