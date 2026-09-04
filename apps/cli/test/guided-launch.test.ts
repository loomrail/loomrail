import { describe, expect, it } from "vitest";

import { formatGuidedLaunchReadiness, guidedBootstrapUrl } from "../src/guided-launch.js";
import type { SetupReadinessReport } from "../src/setup.js";

const report = (status: "READY" | "BLOCKED"): SetupReadinessReport => ({
  schemaVersion: 1,
  status,
  route: "MOCK",
  checks: {
    system: {
      status: status === "READY" ? "PASS" : "FAIL",
      code: status === "READY" ? "SYSTEM_READY" : "SYSTEM_BLOCKED",
    },
    browser: { status: "PASS", code: "BROWSER_READY" },
    route: { status: "PASS", code: "MOCK_ROUTE_READY" },
  },
  nextActions:
    status === "READY" ? ["RUN_START", "INITIALIZE_DEMO_WORKSPACE", "SELECT_MOCK"] : ["RUN_DOCTOR"],
});

describe("guided launch", () => {
  it("keeps the one-time token in the fragment while selecting /try", () => {
    expect(guidedBootstrapUrl("http://127.0.0.1:4176/#bootstrap=secret")).toBe(
      "http://127.0.0.1:4176/try#bootstrap=secret",
    );
  });

  it("states launch side effects and the zero-quota Mock boundary before startup", () => {
    const output = formatGuidedLaunchReadiness(report("READY")).join("\n");
    expect(output).toContain("state and operational log files");
    expect(output).toContain("no provider quota");
  });

  it("states that a blocked preflight wrote and launched nothing", () => {
    expect(formatGuidedLaunchReadiness(report("BLOCKED")).join("\n")).toContain(
      "Nothing was started or written",
    );
  });
});
