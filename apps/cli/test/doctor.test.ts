import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAvailabilitySnapshot } from "@loomrail/daemon";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectDoctorReport,
  formatCliHelp,
  formatDoctorReport,
  inspectDataDirectory,
  serializeDoctorReport,
} from "../src/doctor.js";

const providerSnapshot = (
  liveReady: boolean,
  environmentOverride: ProviderAvailabilitySnapshot["environmentOverride"] = "NONE",
): ProviderAvailabilitySnapshot => ({
  environmentOverride,
  providers: [
    {
      provider: "MOCK",
      installed: true,
      authentication: "AUTHENTICATED",
      ready: true,
      stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
      checkpointOnRequest: true,
      contextWindowReporting: true,
      costReporting: true,
    },
    {
      provider: "CODEX",
      installed: liveReady,
      authentication: liveReady ? "AUTHENTICATED" : "UNKNOWN",
      ready: liveReady,
      stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "ACCEPTANCE"],
      checkpointOnRequest: true,
      contextWindowReporting: true,
      costReporting: false,
    },
    {
      provider: "CLAUDE_CODE",
      installed: false,
      authentication: "UNKNOWN",
      ready: false,
      stages: ["DISCOVERY", "PLAN", "REVIEW"],
      checkpointOnRequest: true,
      contextWindowReporting: true,
      costReporting: true,
    },
  ],
});

describe("Loomrail doctor", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("derives PASS from supported runtime, Git, storage, state, and a live provider", async () => {
    const report = await collectDoctorReport({
      nodeVersion: "24.19.1",
      platform: "darwin",
      dataLocation: { directory: "/owner/private/loomrail", source: "DEFAULT" },
      inspectGit: () => Promise.resolve("AVAILABLE"),
      inspectDataDirectory: () => Promise.resolve("READY"),
      inspectStateDatabase: () =>
        Promise.resolve({ status: "READY", appliedMigrations: 29, expectedMigrations: 29 }),
      inspectProviders: () => Promise.resolve(providerSnapshot(true)),
    });

    expect(report.status).toBe("PASS");
    expect(report.checks.providers.code).toBe("LIVE_PROVIDER_READY");
  });

  it("treats an uncreated installation and mock-only providers as safe warnings", async () => {
    const secretPath = "/Users/local owner/private loomrail";
    const report = await collectDoctorReport({
      nodeVersion: "24.19.0",
      platform: "linux",
      environment: {
        LOOMRAIL_PROVIDER: "provider-secret-canary",
        LOOMRAIL_DATA_DIR: secretPath,
      },
      dataLocation: { directory: secretPath, source: "ENVIRONMENT_OVERRIDE" },
      inspectGit: () => Promise.resolve("AVAILABLE"),
      inspectDataDirectory: () => Promise.resolve("NOT_CREATED"),
      inspectStateDatabase: () =>
        Promise.resolve({ status: "MISSING", appliedMigrations: 0, expectedMigrations: 0 }),
      inspectProviders: () => Promise.resolve(providerSnapshot(false, "INVALID")),
    });

    expect(report.status).toBe("WARN");
    const rendered = `${serializeDoctorReport(report)}\n${formatDoctorReport(report).join("\n")}`;
    expect(rendered).not.toContain(secretPath);
    expect(rendered).not.toContain("provider-secret-canary");
    expect(rendered).toContain("INVALID_ENVIRONMENT_OVERRIDE");
  });

  it("fails for unsupported runtime and unavailable durable state", async () => {
    const report = await collectDoctorReport({
      nodeVersion: "23.11.0",
      inspectGit: () => Promise.resolve("MISSING"),
      inspectDataDirectory: () => Promise.resolve("UNAVAILABLE"),
      inspectStateDatabase: () =>
        Promise.resolve({ status: "CORRUPT", appliedMigrations: 0, expectedMigrations: 29 }),
      inspectProviders: () => Promise.reject(new Error("/private/path/error-canary")),
    });

    expect(report.status).toBe("FAIL");
    expect(report.checks.providers.code).toBe("PROVIDER_PROBE_UNAVAILABLE");
    expect(serializeDoctorReport(report)).not.toContain("error-canary");
  });

  it("checks a missing nested data path without creating it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "loomrail doctor "));
    directories.push(parent);
    const missing = join(parent, "not", "created");

    await expect(inspectDataDirectory(missing)).resolves.toBe("NOT_CREATED");
    await expect(import("node:fs/promises").then(({ stat }) => stat(missing))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps help bounded and points exact-path disclosure to its explicit command", () => {
    expect(formatCliHelp().join("\n")).toContain("doctor [--json]");
    expect(formatCliHelp().join("\n")).toContain("data-path");
  });
});
