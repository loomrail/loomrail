import { describe, expect, it } from "vitest";

import { serializeAnonymousReport } from "./reportDownload";

describe("anonymous report download", () => {
  it("serializes the exact parsed preview object with stable readable bytes", () => {
    const report = {
      schemaVersion: 1,
      kind: "CRASH",
      runtime: {
        productVersion: "0.1.0-alpha.5",
        operatingSystem: "MACOS",
        architecture: "ARM64",
        nodeMajor: 24,
      },
      incident: {
        reason: "DAEMON_RESTART",
        recoveredStatus: "INTERRUPTED",
        affectedWorkflowCount: 1,
      },
    } as const;
    expect(serializeAnonymousReport(report)).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });

  it("refuses extra sensitive fields instead of silently stripping them", () => {
    expect(() =>
      serializeAnonymousReport({
        schemaVersion: 1,
        kind: "CRASH",
        runtime: {
          productVersion: "0.1.0-alpha.5",
          operatingSystem: "MACOS",
          architecture: "ARM64",
          nodeMajor: 24,
        },
        incident: {
          reason: "DAEMON_RESTART",
          recoveredStatus: "INTERRUPTED",
          affectedWorkflowCount: 1,
          stack: "/private/repository/index.ts:1",
        },
      } as never),
    ).toThrow();
  });
});
