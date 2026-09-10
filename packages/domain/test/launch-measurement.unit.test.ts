import type {
  Actor,
  LaunchBrowserMeasurement,
  LaunchMeasurementPlan,
  LaunchMeasurementRun,
  Project,
  VerificationPlan,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideLaunchMeasurementPlanAdoption,
  decideLaunchMeasurementRunCancellation,
  decideLaunchMeasurementRunCompletion,
  decideLaunchMeasurementRunInterruption,
  decideLaunchMeasurementRunReservation,
  launchMeasurementFreshness,
} from "../src/launch-measurement.js";

const now = "2026-09-10T10:00:00.000Z";
const owner: Actor = { type: "HUMAN", id: "owner" };
const system: Actor = { type: "SYSTEM", id: "launch-measurement-runner" };
const planHash = "a".repeat(64);
const verificationHash = "b".repeat(64);
const tree = "c".repeat(40);

const project: Project = {
  schemaVersion: 1,
  id: "project-1",
  workspaceId: "workspace-default",
  fixtureId: null,
  name: "Приложение with spaces",
  repositoryPath: "C:\\Работа с пробелами\\recurkit",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 4,
  createdAt: now,
  updatedAt: now,
};

const verificationPlan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-1",
  projectId: project.id,
  revision: 2,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "serve-app",
      kind: "SERVE",
      label: "Serve",
      required: false,
      executable: "pnpm",
      argv: ["run", "start"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "d".repeat(64),
        scriptName: "start",
        scriptBodyPreview: "node server.mjs",
      },
    },
    {
      schemaVersion: 1,
      id: "audit-dependencies",
      kind: "AUDIT",
      label: "Audit",
      required: true,
      executable: "pnpm",
      argv: ["run", "audit"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "d".repeat(64),
        scriptName: "audit",
        scriptBodyPreview: "pnpm audit --audit-level high",
      },
    },
  ],
  sourceProposalHash: "e".repeat(64),
  contentHash: verificationHash,
  createdAt: now,
};

const configuration: LaunchMeasurementPlan["configuration"] = {
  verificationPlanId: verificationPlan.id,
  verificationPlanRevision: verificationPlan.revision,
  verificationPlanContentHash: verificationPlan.contentHash,
  startupRecipeId: "serve-app",
  dependencyAuditRecipeId: "audit-dependencies",
  targetOrigin: "http://127.0.0.1:4317",
  healthPath: "/health/ready",
  probePath: "/",
  privateRoutes: ["/app", "/настройки"],
  samples: 3,
  thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 100_000 },
  requiredHeaders: ["content-security-policy", "x-content-type-options"],
};

const plan: LaunchMeasurementPlan = {
  schemaVersion: 1,
  id: "launch-plan-1",
  projectId: project.id,
  revision: 1,
  status: "ACTIVE",
  configuration,
  contentHash: planHash,
  createdAt: now,
};

const running: LaunchMeasurementRun = {
  schemaVersion: 1,
  id: "launch-run-1",
  projectId: project.id,
  planId: plan.id,
  planRevision: plan.revision,
  planContentHash: plan.contentHash,
  verificationPlanId: verificationPlan.id,
  verificationPlanRevision: verificationPlan.revision,
  verificationPlanContentHash: verificationPlan.contentHash,
  testedTree: tree,
  status: "RUNNING",
  results: [],
  errorCode: null,
  startedAt: now,
  completedAt: null,
  version: 1,
};

const measurement: LaunchBrowserMeasurement = {
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
    { path: "/настройки", statusCode: 403 },
  ],
  secrets: [],
  scannedScriptBytes: 33_000,
  browserName: "CHROMIUM",
  browserVersion: "140.0.0",
};

const adoptionCommand = {
  schemaVersion: 1 as const,
  commandId: "command-adopt",
  correlationId: "correlation-adopt",
  actor: owner,
  type: "ADOPT_LAUNCH_MEASUREMENT_PLAN" as const,
  payload: { projectId: project.id, expectedProjectVersion: project.version, configuration },
};

const startCommand = {
  schemaVersion: 1 as const,
  commandId: "command-start",
  correlationId: "correlation-start",
  actor: owner,
  type: "START_LAUNCH_MEASUREMENT_RUN" as const,
  payload: {
    projectId: project.id,
    expectedPlanRevision: plan.revision,
    expectedPlanContentHash: plan.contentHash,
    testedTree: tree,
  },
};

describe("launch measurement Plan and Run", () => {
  it("adopts only an exact active Q17 SERVE/AUDIT pair", () => {
    const decision = decideLaunchMeasurementPlanAdoption(adoptionCommand, {
      now,
      newPlanId: "launch-plan-1",
      contentHash: planHash,
      project,
      currentPlan: undefined,
      verificationPlan,
    });
    expect(decision.plan).toMatchObject({ revision: 1, status: "ACTIVE", configuration });
    expect(decision.project.version).toBe(project.version + 1);

    expect(() =>
      decideLaunchMeasurementPlanAdoption(adoptionCommand, {
        now,
        newPlanId: "launch-plan-bad",
        contentHash: planHash,
        project,
        currentPlan: undefined,
        verificationPlan: {
          ...verificationPlan,
          recipes: verificationPlan.recipes.map((recipe) =>
            recipe.id === "serve-app" ? { ...recipe, kind: "CUSTOM" } : recipe,
          ),
        },
      }),
    ).toThrow(expect.objectContaining({ code: "STARTUP_RECIPE_INVALID" }));
  });

  it("reserves one Run and rejects concurrent or non-owner starts", () => {
    expect(
      decideLaunchMeasurementRunReservation(startCommand, {
        now,
        newRunId: running.id,
        project,
        plan,
        verificationPlan,
        activeRun: undefined,
      }).run,
    ).toEqual(running);
    expect(() =>
      decideLaunchMeasurementRunReservation(startCommand, {
        now,
        newRunId: "launch-run-2",
        project,
        plan,
        verificationPlan,
        activeRun: running,
      }),
    ).toThrow(expect.objectContaining({ code: "ACTIVE_RUN_EXISTS" }));
    expect(() =>
      decideLaunchMeasurementRunReservation(
        { ...startCommand, actor: system },
        { now, newRunId: "launch-run-2", project, plan, verificationPlan, activeRun: undefined },
      ),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
  });

  it("computes all six gates from typed evidence and preserves no raw payload", () => {
    const decision = decideLaunchMeasurementRunCompletion(
      {
        schemaVersion: 1,
        commandId: "command-complete",
        correlationId: "correlation-complete",
        actor: system,
        type: "COMPLETE_LAUNCH_MEASUREMENT_RUN",
        payload: {
          runId: running.id,
          expectedVersion: running.version,
          currentTree: tree,
          browserMeasurement: measurement,
          dependencyAudit: {
            verificationRunId: "verification-run-1",
            verificationCheckId: "verification-check-1",
            recipeId: "audit-dependencies",
            testedTree: tree,
            status: "PASSED",
          },
          processStopped: true,
        },
      },
      { now: "2026-09-10T10:01:00.000Z", run: running, plan },
    );
    expect(decision.run.status).toBe("PASSED");
    expect(decision.run.results.map(({ key }) => key)).toEqual([
      "PERF_WEB_VITALS",
      "PERF_BUNDLE_BUDGET",
      "SEC_RESPONSE_HEADERS",
      "SEC_UNAUTHENTICATED_ROUTES",
      "SEC_CLIENT_BUNDLE_SECRETS",
      "DEPS_AUDIT",
    ]);
    expect(JSON.stringify(decision.run)).not.toContain("rawBody");
  });

  it("fails closed for missing vitals, unsafe routes, secret findings and stale audit", () => {
    const decision = decideLaunchMeasurementRunCompletion(
      {
        schemaVersion: 1,
        commandId: "command-complete-failed",
        correlationId: "correlation-complete-failed",
        actor: system,
        type: "COMPLETE_LAUNCH_MEASUREMENT_RUN",
        payload: {
          runId: running.id,
          expectedVersion: running.version,
          currentTree: tree,
          browserMeasurement: {
            ...measurement,
            samples: measurement.samples.map((sample) => ({ ...sample, inpMs: null })),
            privateRoutes: [
              { path: "/app", statusCode: 200 },
              { path: "/настройки", statusCode: 403 },
            ],
            secrets: [{ category: "API_KEY", count: 1 }],
          },
          dependencyAudit: null,
          processStopped: true,
        },
      },
      { now, run: running, plan },
    );
    expect(decision.run.status).toBe("FAILED");
    expect(decision.run.results.map(({ status }) => status)).toEqual([
      "ACTION_REQUIRED",
      "PASSED",
      "PASSED",
      "FAILED",
      "FAILED",
      "ACTION_REQUIRED",
    ]);
  });

  it("rejects mismatched evidence and a tree mutation", () => {
    const command = {
      schemaVersion: 1 as const,
      commandId: "command-complete-invalid",
      correlationId: "correlation-complete-invalid",
      actor: system,
      type: "COMPLETE_LAUNCH_MEASUREMENT_RUN" as const,
      payload: {
        runId: running.id,
        expectedVersion: running.version,
        currentTree: tree,
        browserMeasurement: { ...measurement, privateRoutes: measurement.privateRoutes.slice(0, 1) },
        dependencyAudit: null,
        processStopped: true as const,
      },
    };
    expect(() => decideLaunchMeasurementRunCompletion(command, { now, run: running, plan })).toThrow(
      expect.objectContaining({ code: "EVIDENCE_INVALID" }),
    );
    expect(() =>
      decideLaunchMeasurementRunCompletion(
        { ...command, payload: { ...command.payload, currentTree: "f".repeat(40) } },
        { now, run: running, plan },
      ),
    ).toThrow(expect.objectContaining({ code: "TREE_MUTATED" }));
  });

  it("exposes explicit cancelling and typed interruption states", () => {
    const cancelled = decideLaunchMeasurementRunCancellation(
      {
        schemaVersion: 1,
        commandId: "command-cancel",
        correlationId: "correlation-cancel",
        actor: owner,
        type: "CANCEL_LAUNCH_MEASUREMENT_RUN",
        payload: { runId: running.id, expectedVersion: running.version },
      },
      { run: running },
    ).run;
    expect(cancelled.status).toBe("CANCELLING");
    const interrupted = decideLaunchMeasurementRunInterruption(
      {
        schemaVersion: 1,
        commandId: "command-interrupt",
        correlationId: "correlation-interrupt",
        actor: system,
        type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
        payload: {
          runId: running.id,
          expectedVersion: cancelled.version,
          errorCode: "OWNER_CANCELLED",
          processStopped: true,
        },
      },
      { now, run: cancelled },
    ).run;
    expect(interrupted).toMatchObject({ status: "INTERRUPTED", errorCode: "OWNER_CANCELLED" });
  });

  it("keeps authority blocked until a later cancellation proves the service stopped", () => {
    const blocked = decideLaunchMeasurementRunInterruption(
      {
        schemaVersion: 1,
        commandId: "command-blocked",
        correlationId: "correlation-blocked",
        actor: system,
        type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
        payload: {
          runId: running.id,
          expectedVersion: running.version,
          errorCode: "SERVICE_EXITED",
          processStopped: false,
        },
      },
      { now, run: running },
    ).run;
    expect(blocked).toMatchObject({
      status: "BLOCKED",
      errorCode: "SERVICE_TERMINATION_FAILED",
      completedAt: null,
      version: 2,
    });

    const cancelling = decideLaunchMeasurementRunCancellation(
      {
        schemaVersion: 1,
        commandId: "command-cancel-blocked",
        correlationId: "correlation-cancel-blocked",
        actor: owner,
        type: "CANCEL_LAUNCH_MEASUREMENT_RUN",
        payload: { runId: running.id, expectedVersion: blocked.version },
      },
      { run: blocked },
    ).run;
    expect(cancelling).toMatchObject({ status: "CANCELLING", errorCode: null, version: 3 });

    const interrupted = decideLaunchMeasurementRunInterruption(
      {
        schemaVersion: 1,
        commandId: "command-stop-blocked",
        correlationId: "correlation-stop-blocked",
        actor: system,
        type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
        payload: {
          runId: running.id,
          expectedVersion: cancelling.version,
          errorCode: "OWNER_CANCELLED",
          processStopped: true,
        },
      },
      { now, run: cancelling },
    ).run;
    expect(interrupted).toMatchObject({
      status: "INTERRUPTED",
      errorCode: "OWNER_CANCELLED",
      completedAt: now,
      version: 4,
    });
  });

  it("derives freshness from the tree and both approved Plans", () => {
    expect(
      launchMeasurementFreshness({
        run: running,
        currentTree: tree,
        currentPlan: plan,
        currentVerificationPlan: verificationPlan,
      }),
    ).toEqual({ status: "CURRENT", reasons: [] });
    expect(
      launchMeasurementFreshness({
        run: running,
        currentTree: "f".repeat(40),
        currentPlan: { ...plan, revision: 2 },
        currentVerificationPlan: { ...verificationPlan, contentHash: "e".repeat(64) },
      }),
    ).toEqual({
      status: "STALE",
      reasons: ["TREE_CHANGED", "PLAN_CHANGED", "VERIFICATION_PLAN_CHANGED"],
    });
  });
});
