import { describe, expect, it } from "vitest";

import {
  launchBrowserMeasurementSchema,
  interruptLaunchMeasurementRunCommandSchema,
  launchMeasurementPlanConfigurationSchema,
  launchMeasurementRunSchema,
  verificationPlanSchema,
  verificationRecipeSchema,
} from "../src/index.js";

const hash = "a".repeat(64);
const tree = "b".repeat(40);

const configuration = {
  verificationPlanId: "verification-plan-1",
  verificationPlanRevision: 2,
  verificationPlanContentHash: hash,
  startupRecipeId: "serve-app",
  dependencyAuditRecipeId: "audit-dependencies",
  targetOrigin: "http://127.0.0.1:4317",
  healthPath: "/health/ready",
  probePath: "/",
  privateRoutes: ["/app", "/settings/профиль"],
  samples: 3,
  thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 1_048_576 },
  requiredHeaders: ["content-security-policy", "x-content-type-options"],
} as const;

describe("launch measurement contracts", () => {
  it("accepts a bounded loopback plan with Unicode paths", () => {
    expect(launchMeasurementPlanConfigurationSchema.parse(configuration)).toEqual(configuration);
  });

  it.each([
    { ...configuration, targetOrigin: "https://example.com" },
    { ...configuration, targetOrigin: "http://user:pass@127.0.0.1:4317" },
    { ...configuration, healthPath: "../ready" },
    { ...configuration, probePath: "//other.test" },
    { ...configuration, privateRoutes: ["/app", "/app"] },
    { ...configuration, samples: 2 },
    { ...configuration, samples: 6 },
    { ...configuration, requiredHeaders: ["x-content-type-options", "x-content-type-options"] },
    { ...configuration, dependencyAuditRecipeId: "serve-app" },
    { ...configuration, thresholds: { ...configuration.thresholds, scriptBytes: 33_554_433 } },
  ])("rejects an authority-expanding or unbounded plan", (candidate) => {
    expect(launchMeasurementPlanConfigurationSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts only a bounded typed browser projection", () => {
    const measurement = {
      samples: [
        { lcpMs: 800, inpMs: 40, cls: 0.01, scriptBytes: 10_000 },
        { lcpMs: 900, inpMs: 50, cls: 0.02, scriptBytes: 11_000 },
        { lcpMs: 1_000, inpMs: 60, cls: 0.03, scriptBytes: 12_000 },
      ],
      headers: [
        { name: "content-security-policy", present: true },
        { name: "x-content-type-options", present: true },
      ],
      privateRoutes: [
        { path: "/app", statusCode: 401 },
        { path: "/settings/профиль", statusCode: 403 },
      ],
      secrets: [],
      scannedScriptBytes: 33_000,
      browserName: "CHROMIUM",
      browserVersion: "140.0.0",
    } as const;

    expect(launchBrowserMeasurementSchema.parse(measurement)).toEqual(measurement);
    expect(launchBrowserMeasurementSchema.safeParse({ ...measurement, rawBody: "secret" }).success).toBe(
      false,
    );
  });

  it("requires all six unique gate results for a measured terminal run", () => {
    const common = {
      schemaVersion: 1,
      id: "launch-run-1",
      projectId: "project-1",
      planId: "launch-plan-1",
      planRevision: 1,
      planContentHash: hash,
      verificationPlanId: "verification-plan-1",
      verificationPlanRevision: 2,
      verificationPlanContentHash: hash,
      testedTree: tree,
      startedAt: "2026-09-10T10:00:00.000Z",
      completedAt: "2026-09-10T10:01:00.000Z",
      version: 2,
    } as const;
    const base = { status: "PASSED" as const, summary: "Passed." };
    const results = [
      {
        key: "PERF_WEB_VITALS" as const,
        ...base,
        evidence: {
          lcpSamplesMs: [800, 900, 1_000],
          inpSamplesMs: [40, 50, 60],
          clsSamples: [0.01, 0.02, 0.03],
          medianLcpMs: 900,
          medianInpMs: 50,
          medianCls: 0.02,
          thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1 },
        },
      },
      {
        key: "PERF_BUNDLE_BUDGET" as const,
        ...base,
        evidence: {
          scriptByteSamples: [10_000, 11_000, 12_000],
          medianScriptBytes: 11_000,
          budgetBytes: 99_000,
        },
      },
      {
        key: "SEC_RESPONSE_HEADERS" as const,
        ...base,
        evidence: configuration.requiredHeaders.map((name) => ({ name, present: true })),
      },
      { key: "SEC_UNAUTHENTICATED_ROUTES" as const, ...base, evidence: [{ path: "/app", statusCode: 401 }] },
      {
        key: "SEC_CLIENT_BUNDLE_SECRETS" as const,
        ...base,
        evidence: { scannedScriptBytes: 33_000, findings: [] },
      },
      {
        key: "DEPS_AUDIT" as const,
        ...base,
        evidence: {
          verificationRunId: "verification-run-1",
          verificationCheckId: "verification-check-1",
          recipeId: "audit-dependencies",
          testedTree: tree,
          status: "PASSED" as const,
        },
      },
    ];
    expect(
      launchMeasurementRunSchema.parse({ ...common, status: "PASSED", results, errorCode: null }).results,
    ).toHaveLength(6);
    expect(
      launchMeasurementRunSchema.safeParse({
        ...common,
        status: "PASSED",
        results: results.slice(0, 5),
        errorCode: null,
      }).success,
    ).toBe(false);
  });

  it("represents an unproved service stop as an active typed BLOCKED Run", () => {
    const blocked = {
      schemaVersion: 1,
      id: "launch-run-blocked",
      projectId: "project-1",
      planId: "launch-plan-1",
      planRevision: 1,
      planContentHash: hash,
      verificationPlanId: "verification-plan-1",
      verificationPlanRevision: 2,
      verificationPlanContentHash: hash,
      testedTree: tree,
      status: "BLOCKED",
      results: [],
      errorCode: "SERVICE_TERMINATION_FAILED",
      startedAt: "2026-09-10T10:00:00.000Z",
      completedAt: null,
      version: 2,
    } as const;
    expect(launchMeasurementRunSchema.parse(blocked)).toEqual(blocked);
    expect(
      interruptLaunchMeasurementRunCommandSchema.parse({
        schemaVersion: 1,
        commandId: "command-blocked",
        correlationId: "correlation-blocked",
        actor: { type: "SYSTEM", id: "launch-measurement-runner" },
        type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
        payload: {
          runId: blocked.id,
          expectedVersion: 1,
          errorCode: "SERVICE_TERMINATION_FAILED",
          processStopped: false,
        },
      }).payload.processStopped,
    ).toBe(false);
  });
});

describe("launch-specific verification recipes", () => {
  const recipeBase = {
    schemaVersion: 1,
    label: "Fixture",
    executable: "pnpm",
    cwd: ".",
    timeoutSeconds: 300,
    outputLimitBytes: 65_536,
    environmentProfile: "VERIFICATION_BASELINE",
    networkPolicy: "INHERIT_HOST",
    provenance: {
      source: "PACKAGE_JSON_SCRIPT",
      manifestPath: "package.json",
      manifestContentHash: hash,
      scriptBodyPreview: "node server.mjs",
    },
  } as const;

  it("allows an optional SERVE recipe and an AUDIT recipe", () => {
    const serve = {
      ...recipeBase,
      id: "serve-app",
      kind: "SERVE",
      required: false,
      argv: ["run", "start"],
      provenance: { ...recipeBase.provenance, scriptName: "start" },
    } as const;
    const audit = {
      ...recipeBase,
      id: "audit-dependencies",
      kind: "AUDIT",
      required: true,
      argv: ["run", "audit"],
      provenance: { ...recipeBase.provenance, scriptName: "audit" },
    } as const;
    expect(verificationRecipeSchema.parse(serve).kind).toBe("SERVE");
    expect(verificationRecipeSchema.parse(audit).kind).toBe("AUDIT");
    expect(
      verificationPlanSchema.safeParse({
        schemaVersion: 1,
        id: "verification-plan-1",
        projectId: "project-1",
        revision: 1,
        status: "ACTIVE",
        recipes: [{ ...serve, required: true }, audit],
        sourceProposalHash: hash,
        contentHash: hash,
        createdAt: "2026-09-10T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
