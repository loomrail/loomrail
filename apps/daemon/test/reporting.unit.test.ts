import { describe, expect, it } from "vitest";

import { describeReportingRuntime } from "../src/reporting.js";

describe("reporting runtime categories", () => {
  it("maps supported release platforms without exposing raw host data", () => {
    expect(
      describeReportingRuntime({
        productVersion: "0.1.0-alpha.5",
        platform: "darwin",
        architecture: "arm64",
        nodeVersion: "24.19.0",
      }),
    ).toEqual({
      productVersion: "0.1.0-alpha.5",
      operatingSystem: "MACOS",
      architecture: "ARM64",
      nodeMajor: 24,
    });
    expect(
      describeReportingRuntime({
        productVersion: "0.1.0-alpha.5",
        platform: "win32",
        architecture: "x64",
        nodeVersion: "24.19.0",
      }),
    ).toMatchObject({ operatingSystem: "WINDOWS", architecture: "X64" });
  });

  it("collapses unreviewed platform values to closed categories", () => {
    expect(
      describeReportingRuntime({
        productVersion: "0.1.0-alpha.5",
        platform: "freebsd-owner-host",
        architecture: "riscv64-private",
        nodeVersion: "24.19.0",
      }),
    ).toMatchObject({ operatingSystem: "OTHER", architecture: "OTHER" });
  });
});
