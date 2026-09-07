import { describe, expect, it } from "vitest";

import { formatStartupReport, type StartupProvider } from "../src/startup-report.js";

const baseUrl = "http://127.0.0.1:4176";
const bootstrapUrl = `${baseUrl}/#bootstrap=Rk9SLVRFU1QtT05MWS1UT0tFTi1WQUxVRS1IRVJF`;
const openAI: StartupProvider = {
  provider: "CODEX",
  providerReady: true,
  tokenBudgetEnforcement: "HARD",
  recognised: true,
  stages: ["DISCOVERY", "PLAN", "REVIEW", "ACCEPTANCE"],
  worksInRepository: false,
};

describe("real-provider startup report", () => {
  it("keeps the bootstrap URL out of the terminal when the launcher opens the browser", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: true, provider: openAI });
    expect(lines.join("\n")).toContain("OpenAI Responses");
    expect(lines.some((line) => line.includes("bootstrap="))).toBe(false);
  });

  it("prints the one-time sign-in URL when no browser is opened", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: false, provider: openAI });
    expect(lines.some((line) => line.includes(bootstrapUrl))).toBe(true);
  });

  it("fails transparently when the selected API credential is absent", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { ...openAI, providerReady: false },
    }).join("\n");
    expect(report).toContain("API credential missing");
    expect(report).toContain("managed dispatches are refused");
  });

  it("names the Anthropic API and the stages it actually serves", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { ...openAI, provider: "CLAUDE_CODE", stages: ["DISCOVERY", "PLAN", "REVIEW"] },
    }).join("\n");
    expect(report).toContain("Anthropic Messages");
    expect(report).toContain("DISCOVERY, PLAN, REVIEW");
    expect(report).toContain("workspace-writing stages are refused");
  });

  it("blocks an unknown environment override instead of selecting synthetic work", () => {
    const report = formatStartupReport({
      baseUrl,
      bootstrapUrl,
      browserOpened: true,
      provider: { ...openAI, providerReady: false, recognised: false },
    }).join("\n");
    expect(report).toContain("LOOMRAIL_PROVIDER");
    expect(report).toContain("CODEX, CLAUDE_CODE");
    expect(report).toContain("blocked");
  });
});
