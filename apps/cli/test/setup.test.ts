import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAvailabilitySnapshot } from "@loomrail/daemon";
import { afterEach, describe, expect, it } from "vitest";

import { collectDoctorReport, type DoctorReport } from "../src/doctor.js";
import {
  collectSetupReadiness,
  formatSetupReadiness,
  parseSetupRouteChoice,
  selectSetupRoute,
  serializeSetupReadiness,
  SetupRouteSelectionError,
} from "../src/setup.js";

const providers = (
  liveReady: boolean,
  environmentOverride: ProviderAvailabilitySnapshot["environmentOverride"] = "NONE",
): ProviderAvailabilitySnapshot => ({
  environmentOverride,
  providers: [
    {
      provider: "MOCK",
      installed: true,
      authentication: "AUTHENTICATED",
      version: null,
      compatibility: "BUILT_IN",
      ready: true,
      stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
      checkpointOnRequest: true,
      contextWindowReporting: true,
      costReporting: true,
    },
    {
      provider: "CODEX",
      installed: liveReady,
      authentication: liveReady ? "AUTHENTICATED" : "REQUIRED",
      version: liveReady ? "0.152.1" : null,
      compatibility: liveReady ? "VERIFIED" : "MISSING",
      ready: liveReady,
      stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
      checkpointOnRequest: true,
      contextWindowReporting: true,
      costReporting: false,
    },
  ],
});

const doctor = (
  options: {
    status?: DoctorReport["status"];
    stateCode?: DoctorReport["checks"]["stateDatabase"]["code"];
    liveReady?: boolean;
    environmentOverride?: ProviderAvailabilitySnapshot["environmentOverride"];
  } = {},
): DoctorReport => ({
  schemaVersion: 1,
  status: options.status ?? "WARN",
  platform: "darwin",
  checks: {
    runtime: { status: "PASS", code: "RUNTIME_SUPPORTED", nodeVersion: "24.19.0" },
    git: { status: "PASS", code: "GIT_AVAILABLE" },
    dataDirectory: {
      status: "WARN",
      code: "DATA_DIRECTORY_NOT_CREATED",
      source: "DEFAULT",
    },
    stateDatabase: {
      status: "WARN",
      code: options.stateCode ?? "STATE_MISSING",
      appliedMigrations: 0,
      expectedMigrations: 29,
    },
    providers: {
      status: options.liveReady ? "PASS" : "WARN",
      code: options.liveReady ? "LIVE_PROVIDER_READY" : "MOCK_ONLY",
      environmentOverride: options.environmentOverride ?? "NONE",
      items: providers(options.liveReady ?? false, options.environmentOverride).providers,
    },
  },
});

describe("Loomrail guided setup", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("defaults the exact interactive choice to Mock and rejects free text without echoing it", async () => {
    expect(parseSetupRouteChoice("")).toBe("MOCK");
    expect(parseSetupRouteChoice("1")).toBe("MOCK");
    expect(parseSetupRouteChoice("mock")).toBe("MOCK");
    expect(parseSetupRouteChoice("2")).toBe("LIVE");
    expect(parseSetupRouteChoice("live")).toBe("LIVE");
    await expect(selectSetupRoute(() => Promise.resolve(""))).resolves.toBe("MOCK");

    const secretCanary = "owner-secret-free-text";
    expect(() => parseSetupRouteChoice(secretCanary)).toThrow("Setup choice must be");
    try {
      parseSetupRouteChoice(secretCanary);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secretCanary);
    }
    expect(() => parseSetupRouteChoice("unknown")).toThrow(SetupRouteSelectionError);
    await expect(selectSetupRoute(() => Promise.reject(new Error(secretCanary)))).rejects.toEqual(
      expect.objectContaining({
        name: "SetupRouteSelectionError",
        code: "QUESTION_FAILED",
        message: "The setup route question could not be completed safely",
      }),
    );
    await expect(selectSetupRoute(() => Promise.reject(new Error(secretCanary)))).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining(secretCanary),
    );
  });

  it("keeps a new mock installation ready without provider login or state creation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "loomrail setup "));
    directories.push(parent);
    const missing = join(parent, "not-created");
    const report = await collectDoctorReport({
      nodeVersion: "24.19.0",
      platform: "darwin",
      dataLocation: { directory: missing, source: "ENVIRONMENT_OVERRIDE" },
      inspectGit: () => Promise.resolve("AVAILABLE"),
      inspectDataDirectory: () => Promise.resolve("NOT_CREATED"),
      inspectStateDatabase: () =>
        Promise.resolve({ status: "MISSING", appliedMigrations: 0, expectedMigrations: 29 }),
      inspectProviders: () => Promise.resolve(providers(false)),
    });
    const setup = await collectSetupReadiness("MOCK", {
      collectDoctor: () => Promise.resolve(report),
      inspectBrowser: () => Promise.resolve("AVAILABLE"),
    });

    expect(setup).toMatchObject({
      status: "READY",
      route: "MOCK",
      checks: {
        system: { status: "WARN", code: "SYSTEM_READY_WITH_WARNINGS" },
        browser: { status: "PASS", code: "BROWSER_READY" },
        route: { status: "PASS", code: "MOCK_ROUTE_READY" },
      },
      nextActions: ["RUN_START", "INITIALIZE_DEMO_WORKSPACE", "SELECT_MOCK"],
    });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an observed ready provider for the live route", async () => {
    const blocked = await collectSetupReadiness("LIVE", {
      collectDoctor: () => Promise.resolve(doctor()),
      inspectBrowser: () => Promise.resolve("AVAILABLE"),
    });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.checks.route.code).toBe("LIVE_PROVIDER_NOT_READY");
    expect(blocked.nextActions).toEqual(["REVIEW_PROVIDER_COMPATIBILITY"]);

    const verifiedButSignedOut = doctor();
    verifiedButSignedOut.checks.providers.items = verifiedButSignedOut.checks.providers.items.map((item) =>
      item.provider === "CODEX"
        ? {
            ...item,
            installed: true,
            version: "0.152.1",
            compatibility: "VERIFIED",
            authentication: "REQUIRED",
          }
        : item,
    );
    const signInRequired = await collectSetupReadiness("LIVE", {
      collectDoctor: () => Promise.resolve(verifiedButSignedOut),
      inspectBrowser: () => Promise.resolve("AVAILABLE"),
    });
    expect(signInRequired.nextActions).toEqual(["SIGN_IN_PROVIDER"]);

    const ready = await collectSetupReadiness("LIVE", {
      collectDoctor: () => Promise.resolve(doctor({ liveReady: true, status: "PASS" })),
      inspectBrowser: () => Promise.resolve("AVAILABLE"),
    });
    expect(ready.status).toBe("READY");
    expect(ready.checks.route.code).toBe("LIVE_ROUTE_READY");
    expect(ready.nextActions).toEqual(["RUN_START", "INITIALIZE_DEMO_WORKSPACE", "SELECT_LIVE_PROVIDER"]);
  });

  it("blocks pending migration, missing Chromium, and every provider override in stable order", async () => {
    const report = await collectSetupReadiness("MOCK", {
      collectDoctor: () =>
        Promise.resolve(doctor({ stateCode: "STATE_UPGRADE_REQUIRED", environmentOverride: "VALID" })),
      inspectBrowser: () => Promise.resolve("MISSING"),
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.checks).toEqual({
      system: { status: "FAIL", code: "DATA_BACKUP_REQUIRED" },
      browser: { status: "FAIL", code: "BROWSER_MISSING" },
      route: { status: "FAIL", code: "PROVIDER_OVERRIDE_ACTIVE" },
    });
    expect(report.nextActions).toEqual(["BACK_UP_DATA", "INSTALL_CHROMIUM", "CLEAR_PROVIDER_OVERRIDE"]);
  });

  it("turns probe failures into closed codes without leaking paths or error text", async () => {
    const canary = "/private/owner/setup-secret-canary";
    const report = await collectSetupReadiness("LIVE", {
      collectDoctor: () => Promise.reject(new Error(canary)),
      inspectBrowser: () => Promise.reject(new Error(canary)),
    });
    const output = `${serializeSetupReadiness(report)}\n${formatSetupReadiness(report).join("\n")}`;

    expect(report.status).toBe("BLOCKED");
    expect(report.checks.system.code).toBe("SYSTEM_INSPECTION_UNAVAILABLE");
    expect(report.checks.browser.code).toBe("BROWSER_UNAVAILABLE");
    expect(report.checks.route.code).toBe("ROUTE_INSPECTION_UNAVAILABLE");
    expect(report.nextActions).toEqual(["RUN_DOCTOR", "INSTALL_CHROMIUM"]);
    expect(output).not.toContain(canary);
  });
});
