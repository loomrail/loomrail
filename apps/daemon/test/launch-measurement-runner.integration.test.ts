import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaunchMeasurementDriverError, type LaunchMeasurementDriver } from "@loomrail/browser-qa";
import type {
  LaunchBrowserMeasurement,
  LaunchMeasurementPlanConfiguration,
  StateCommandResult,
  VerificationPlanProposal,
} from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { verificationPlanProposalHash, type VerificationServiceStart } from "@loomrail/project-readiness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLaunchMeasurementRunner,
  type LaunchServiceStarter,
} from "../src/launch-measurement-runner.js";

const tree = "c".repeat(40);
const timestamp = "2026-09-10T13:00:00.000Z";

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
  privateRoutes: [{ path: "/private", statusCode: 401 }],
  secrets: [],
  scannedScriptBytes: 33_000,
  browserName: "CHROMIUM",
  browserVersion: "140.0.0",
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

describe("launch measurement runner", () => {
  let directory = "";
  let state: LocalState | undefined;
  let server: Server | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail launch runner тест "));
    nextId = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    if (server?.listening) await closeServer(server);
    server = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const prepare = async (
    healthDelayMs = 0,
  ): Promise<{
    localState: LocalState;
    run: Extract<StateCommandResult, { type: "LAUNCH_MEASUREMENT_RUN_CHANGED" }>["run"];
  }> => {
    server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(204);
        response.end();
      }, healthDelayMs);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Fixture port unavailable");
    const localState = await openLocalState({
      databasePath: join(directory, "state.sqlite"),
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    state = localState;
    localState.execute({
      schemaVersion: 1,
      commandId: "register",
      correlationId: "correlation-register",
      actor: { type: "HUMAN", id: "owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-1",
        fixtureId: null,
        name: "Recurkit",
        repositoryPath: join(directory, "Репозиторий with spaces"),
      },
    });
    const proposalContent: Omit<VerificationPlanProposal, "proposalHash"> = {
      schemaVersion: 1,
      projectId: "project-1",
      target: { state: "ABSENT", digest: null },
      recipes: [
        {
          schemaVersion: 1,
          id: "package-start",
          kind: "SERVE",
          label: "Start",
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
            manifestContentHash: "a".repeat(64),
            scriptName: "start",
            scriptBodyPreview: "node server.mjs",
          },
        },
        {
          schemaVersion: 1,
          id: "package-audit",
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
            manifestContentHash: "a".repeat(64),
            scriptName: "audit",
            scriptBodyPreview: "pnpm audit --audit-level high",
          },
        },
      ],
      warnings: [],
    };
    const proposal: VerificationPlanProposal = {
      ...proposalContent,
      proposalHash: verificationPlanProposalHash(proposalContent),
    };
    const verification = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-verification",
      correlationId: "correlation-adopt-verification",
      actor: { type: "HUMAN", id: "owner" },
      type: "ADOPT_VERIFICATION_PLAN",
      payload: { projectId: "project-1", expectedProjectVersion: 1, proposal },
    });
    if (verification.type !== "VERIFICATION_PLAN_ADOPTED") throw new Error("Plan unavailable");
    const configuration: LaunchMeasurementPlanConfiguration = {
      verificationPlanId: verification.plan.id,
      verificationPlanRevision: verification.plan.revision,
      verificationPlanContentHash: verification.plan.contentHash,
      startupRecipeId: "package-start",
      dependencyAuditRecipeId: "package-audit",
      targetOrigin: `http://127.0.0.1:${address.port.toString()}`,
      healthPath: "/health/ready",
      probePath: "/",
      privateRoutes: ["/private"],
      samples: 3,
      thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 100_000 },
      requiredHeaders: ["content-security-policy", "x-content-type-options"],
    };
    const launchPlan = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-launch",
      correlationId: "correlation-adopt-launch",
      actor: { type: "HUMAN", id: "owner" },
      type: "ADOPT_LAUNCH_MEASUREMENT_PLAN",
      payload: { projectId: "project-1", expectedProjectVersion: 2, configuration },
    });
    if (launchPlan.type !== "LAUNCH_MEASUREMENT_PLAN_CHANGED") throw new Error("Plan unavailable");
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-launch",
      correlationId: "correlation-start-launch",
      actor: { type: "HUMAN", id: "owner" },
      type: "START_LAUNCH_MEASUREMENT_RUN",
      payload: {
        projectId: "project-1",
        expectedPlanRevision: launchPlan.plan.revision,
        expectedPlanContentHash: launchPlan.plan.contentHash,
        testedTree: tree,
      },
    });
    if (started.type !== "LAUNCH_MEASUREMENT_RUN_CHANGED") throw new Error("Run unavailable");
    return { localState, run: started.run };
  };

  const serviceStarter = () => {
    let resolveTerminal: (
      value: Awaited<Extract<VerificationServiceStart, { state: "STARTED" }>["completion"]>,
    ) => void = () => undefined;
    const completion = new Promise<
      Awaited<Extract<VerificationServiceStart, { state: "STARTED" }>["completion"]>
    >((resolve) => {
      resolveTerminal = resolve;
    });
    const startService = vi.fn<LaunchServiceStarter>(() =>
      Promise.resolve({
        state: "STARTED",
        beforeTree: tree,
        stop: () => {
          resolveTerminal({
            state: "STOPPED",
            errorCode: null,
            beforeTree: tree,
            afterTree: tree,
            processStopped: true,
            durationMs: 10,
            capturedOutputBytes: 0,
            outputTruncated: false,
          });
        },
        completion,
      }),
    );
    return { startService, resolveTerminal };
  };

  it("orchestrates an approved service and stores six deterministic gates", async () => {
    const { localState, run } = await prepare();
    const service = serviceStarter();
    const driver: LaunchMeasurementDriver = {
      id: "PLAYWRIGHT",
      measure: vi.fn(() => Promise.resolve(measurement)),
    };
    const stateWithAudit: LocalState = {
      ...localState,
      query: (query) =>
        query.type === "GET_LATEST_PROJECT_AUDIT_EVIDENCE"
          ? {
              type: "LAUNCH_DEPENDENCY_AUDIT_EVIDENCE",
              evidence: {
                verificationRunId: "verification-run-1",
                verificationCheckId: "verification-check-1",
                recipeId: "package-audit",
                testedTree: tree,
                status: "PASSED",
              },
            }
          : localState.query(query),
    };
    const runner = createLaunchMeasurementRunner({
      state: stateWithAudit,
      artifactsDirectory: directory,
      createCommandId: () => `runner-command-${(nextId += 1).toString()}`,
      now: () => new Date(timestamp),
      logger: { error: vi.fn() },
      driver,
      startService: service.startService,
    });
    runner.wake(run.id);
    await runner.whenIdle(run.id);

    const snapshot = localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" });
    expect(snapshot).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      latestRun: { status: "PASSED" },
    });
    if (snapshot.type !== "PROJECT_LAUNCH_MEASUREMENT") throw new Error("Snapshot unavailable");
    expect(snapshot.latestRun?.results).toHaveLength(6);
    expect(service.startService).toHaveBeenCalledOnce();
    const serviceInput = service.startService.mock.calls[0]?.[0];
    if (serviceInput === undefined) throw new Error("Service input unavailable");
    expect(serviceInput.expectedTree).toBe(tree);
    expect(serviceInput.worktreePath).toContain("Репозиторий with spaces");
    expect(serviceInput.recipe).toMatchObject({ id: "package-start", kind: "SERVE" });
  });

  it("stops an in-flight service before recording owner cancellation", async () => {
    const { localState, run } = await prepare();
    const service = serviceStarter();
    const driver: LaunchMeasurementDriver = {
      id: "PLAYWRIGHT",
      measure: (_configuration, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new LaunchMeasurementDriverError("CANCELLED"));
            },
            {
              once: true,
            },
          );
        }),
    };
    const runner = createLaunchMeasurementRunner({
      state: localState,
      artifactsDirectory: directory,
      createCommandId: () => `runner-command-${(nextId += 1).toString()}`,
      now: () => new Date(timestamp),
      logger: { error: vi.fn() },
      driver,
      startService: service.startService,
    });
    runner.wake(run.id);
    await vi.waitFor(() => {
      expect(service.startService).toHaveBeenCalled();
    });
    await runner.cancel({
      runId: run.id,
      expectedVersion: run.version,
      commandId: "cancel-launch",
      correlationId: "correlation-cancel-launch",
    });
    const snapshot = localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" });
    expect(snapshot).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      latestRun: { status: "INTERRUPTED", errorCode: "OWNER_CANCELLED" },
    });
  });

  it("never replays a service after restart and records DAEMON_RESTART", async () => {
    const { localState, run } = await prepare();
    const startService = vi.fn<LaunchServiceStarter>(() => Promise.reject(new Error("must not start")));
    const runner = createLaunchMeasurementRunner({
      state: localState,
      artifactsDirectory: directory,
      createCommandId: () => `runner-command-${(nextId += 1).toString()}`,
      now: () => new Date(timestamp),
      logger: { error: vi.fn() },
      driver: { id: "PLAYWRIGHT", measure: vi.fn(() => Promise.resolve(measurement)) },
      startService,
    });
    await runner.recover();
    expect(startService).not.toHaveBeenCalled();
    const snapshot = localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" });
    expect(snapshot).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      latestRun: { id: run.id, status: "ERROR", errorCode: "DAEMON_RESTART" },
    });
  });

  it("records an early service exit without calling the browser", async () => {
    const { localState, run } = await prepare(500);
    const driver: LaunchMeasurementDriver = {
      id: "PLAYWRIGHT",
      measure: vi.fn(() => Promise.resolve(measurement)),
    };
    const runner = createLaunchMeasurementRunner({
      state: localState,
      artifactsDirectory: directory,
      createCommandId: () => `runner-command-${(nextId += 1).toString()}`,
      now: () => new Date(timestamp),
      logger: { error: vi.fn() },
      driver,
      startService: () =>
        Promise.resolve({
          state: "STARTED",
          beforeTree: tree,
          stop: () => undefined,
          completion: Promise.resolve({
            state: "EXITED",
            errorCode: "SERVICE_EXITED",
            beforeTree: tree,
            afterTree: tree,
            processStopped: true,
            durationMs: 1,
            capturedOutputBytes: 0,
            outputTruncated: false,
          }),
        }),
    });
    runner.wake(run.id);
    await runner.whenIdle(run.id);
    expect(driver.measure).not.toHaveBeenCalled();
    const snapshot = localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" });
    expect(snapshot).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      latestRun: { status: "ERROR", errorCode: "SERVICE_EXITED" },
    });
  });

  it("records a durable block when service-tree termination cannot be proved", async () => {
    const { localState, run } = await prepare(500);
    const driver: LaunchMeasurementDriver = {
      id: "PLAYWRIGHT",
      measure: vi.fn(() => Promise.resolve(measurement)),
    };
    const runner = createLaunchMeasurementRunner({
      state: localState,
      artifactsDirectory: directory,
      createCommandId: () => `runner-command-${(nextId += 1).toString()}`,
      now: () => new Date(timestamp),
      logger: { error: vi.fn() },
      driver,
      startService: () =>
        Promise.resolve({
          state: "STARTED",
          beforeTree: tree,
          stop: () => undefined,
          completion: Promise.resolve({
            state: "ERROR",
            errorCode: "SERVICE_TERMINATION_FAILED",
            beforeTree: tree,
            afterTree: null,
            processStopped: false,
            durationMs: 1,
            capturedOutputBytes: 0,
            outputTruncated: false,
          }),
        }),
    });
    runner.wake(run.id);
    await runner.whenIdle(run.id);
    expect(driver.measure).not.toHaveBeenCalled();
    expect(
      localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" }),
    ).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      latestRun: {
        status: "BLOCKED",
        errorCode: "SERVICE_TERMINATION_FAILED",
        completedAt: null,
        version: 2,
      },
    });
  });

  it("records a typed spawn failure when durable process intent cannot be prepared", async () => {
    const { localState, run } = await prepare();
    const invalidArtifactsPath = join(directory, "not-a-directory");
    await writeFile(invalidArtifactsPath, "fixture", "utf8");
    const startService = vi.fn<LaunchServiceStarter>(() => Promise.reject(new Error("must not start")));
    const runner = createLaunchMeasurementRunner({
      state: localState,
      artifactsDirectory: invalidArtifactsPath,
      createCommandId: () => `runner-command-${(nextId += 1).toString()}`,
      now: () => new Date(timestamp),
      logger: { error: vi.fn() },
      driver: { id: "PLAYWRIGHT", measure: vi.fn(() => Promise.resolve(measurement)) },
      startService,
    });
    runner.wake(run.id);
    await runner.whenIdle(run.id);
    expect(startService).not.toHaveBeenCalled();
    expect(
      localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" }),
    ).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      latestRun: { status: "ERROR", errorCode: "SERVICE_SPAWN_FAILED" },
    });
  });

  it("does not treat a missing process record as stop proof for an already blocked Run", async () => {
    const { localState, run } = await prepare();
    const blocked = localState.execute({
      schemaVersion: 1,
      commandId: "block-launch",
      correlationId: "correlation-block-launch",
      actor: { type: "SYSTEM", id: "launch-measurement-runner" },
      type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
      payload: {
        runId: run.id,
        expectedVersion: run.version,
        errorCode: "SERVICE_TERMINATION_FAILED",
        processStopped: false,
      },
    });
    if (blocked.type !== "LAUNCH_MEASUREMENT_RUN_CHANGED") throw new Error("Blocked Run unavailable");
    const runner = createLaunchMeasurementRunner({
      state: localState,
      artifactsDirectory: directory,
      createCommandId: () => `runner-command-${(nextId += 1).toString()}`,
      now: () => new Date(timestamp),
      logger: { error: vi.fn() },
      driver: { id: "PLAYWRIGHT", measure: vi.fn(() => Promise.resolve(measurement)) },
      startService: vi.fn<LaunchServiceStarter>(() => Promise.reject(new Error("must not start"))),
    });
    await runner.cancel({
      runId: run.id,
      expectedVersion: blocked.run.version,
      commandId: "cancel-blocked-launch",
      correlationId: "correlation-cancel-blocked-launch",
    });
    expect(
      localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" }),
    ).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      latestRun: {
        status: "BLOCKED",
        errorCode: "SERVICE_TERMINATION_FAILED",
        completedAt: null,
        version: 4,
      },
    });
  });
});
