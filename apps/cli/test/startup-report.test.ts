import { describe, expect, it } from "vitest";

import { formatStartupReport } from "../src/startup-report.js";

const baseUrl = "http://127.0.0.1:4176";
const bootstrapUrl = `${baseUrl}/#bootstrap=Rk9SLVRFU1QtT05MWS1UT0tFTi1WQUxVRS1IRVJF`;

describe("startup report", () => {
  it("keeps the bootstrap URL out of the terminal when the launcher opens the browser", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: true });

    expect(lines.join("\n")).toContain(baseUrl);
    expect(lines.some((line) => line.includes("bootstrap="))).toBe(false);
  });

  it("prints the one-time sign-in URL when no browser is opened", () => {
    const lines = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: false });

    expect(lines.some((line) => line.includes(bootstrapUrl))).toBe(true);
  });

  it("explains that the printed sign-in URL expires and is single-use", () => {
    const report = formatStartupReport({ baseUrl, bootstrapUrl, browserOpened: false }).join("\n");

    expect(report).toMatch(/60 seconds/);
    expect(report).toMatch(/single browser/);
  });
});
