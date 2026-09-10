import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LaunchMeasurementPlanConfiguration, VerificationPlanProposal } from "@loomrail/contracts";
import { LaunchMeasurementDomainError } from "@loomrail/domain";
import { verificationPlanProposalHash } from "@loomrail/project-readiness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

const now = "2026-09-10T12:00:00.000Z";
const tree = "c".repeat(40);

describe("durable launch measurement", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail launch state тест "));
    databasePath = join(directory, "state.sqlite");
    nextId = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(now),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const prepare = async (): Promise<{
    localState: LocalState;
    configuration: LaunchMeasurementPlanConfiguration;
  }> => {
    const localState = await open();
    localState.execute({
      schemaVersion: 1,
      commandId: "register-project",
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
          label: "Start service",
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
          label: "Dependency audit",
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
    const adopted = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-verification",
      correlationId: "correlation-adopt-verification",
      actor: { type: "HUMAN", id: "owner" },
      type: "ADOPT_VERIFICATION_PLAN",
      payload: { projectId: "project-1", expectedProjectVersion: 1, proposal },
    });
    if (adopted.type !== "VERIFICATION_PLAN_ADOPTED") {
      throw new Error("Expected verification Plan adoption");
    }
    return {
      localState,
      configuration: {
        verificationPlanId: adopted.plan.id,
        verificationPlanRevision: adopted.plan.revision,
        verificationPlanContentHash: adopted.plan.contentHash,
        startupRecipeId: "package-start",
        dependencyAuditRecipeId: "package-audit",
        targetOrigin: "http://127.0.0.1:4317",
        healthPath: "/health/ready",
        probePath: "/",
        privateRoutes: ["/app", "/настройки"],
        samples: 3,
        thresholds: { lcpMs: 2_500, inpMs: 200, cls: 0.1, scriptBytes: 1_048_576 },
        requiredHeaders: ["content-security-policy", "x-content-type-options"],
      },
    };
  };

  const adoptAndStart = async () => {
    const { localState, configuration } = await prepare();
    const adopted = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-launch",
      correlationId: "correlation-adopt-launch",
      actor: { type: "HUMAN", id: "owner" },
      type: "ADOPT_LAUNCH_MEASUREMENT_PLAN",
      payload: { projectId: "project-1", expectedProjectVersion: 2, configuration },
    });
    if (adopted.type !== "LAUNCH_MEASUREMENT_PLAN_CHANGED") {
      throw new Error("Expected launch Plan adoption");
    }
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-launch",
      correlationId: "correlation-start-launch",
      actor: { type: "HUMAN", id: "owner" },
      type: "START_LAUNCH_MEASUREMENT_RUN",
      payload: {
        projectId: "project-1",
        expectedPlanRevision: adopted.plan.revision,
        expectedPlanContentHash: adopted.plan.contentHash,
        testedTree: tree,
      },
    });
    if (started.type !== "LAUNCH_MEASUREMENT_RUN_CHANGED") {
      throw new Error("Expected launch Run reservation");
    }
    return { localState, adopted, started };
  };

  it("commits Plan, Run, audit Events and command receipts atomically", async () => {
    const { localState, adopted, started } = await adoptAndStart();
    expect(adopted).toMatchObject({ replayed: false, projectVersion: 3 });
    expect(started.run).toMatchObject({ status: "RUNNING", testedTree: tree, version: 1 });
    expect(
      localState.execute({
        schemaVersion: 1,
        commandId: "start-launch",
        correlationId: "correlation-start-launch",
        actor: { type: "HUMAN", id: "owner" },
        type: "START_LAUNCH_MEASUREMENT_RUN",
        payload: {
          projectId: "project-1",
          expectedPlanRevision: adopted.plan.revision,
          expectedPlanContentHash: adopted.plan.contentHash,
          testedTree: tree,
        },
      }),
    ).toMatchObject({ replayed: true, run: { id: started.run.id } });
    const snapshot = localState.query({ type: "GET_PROJECT_LAUNCH_MEASUREMENT", projectId: "project-1" });
    expect(snapshot).toMatchObject({
      type: "PROJECT_LAUNCH_MEASUREMENT",
      plan: { id: adopted.plan.id },
      latestRun: { id: started.run.id, status: "RUNNING" },
    });
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-1" });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_REGISTERED",
      "VERIFICATION_PLAN_ADOPTED",
      "LAUNCH_MEASUREMENT_PLAN_CHANGED",
      "LAUNCH_MEASUREMENT_RUN_CHANGED",
    ]);
  });

  it("recovers an active Run after restart and records a typed terminal interruption", async () => {
    const { localState, started } = await adoptAndStart();
    localState.close();
    state = undefined;
    const reopened = await open();
    const active = reopened.query({ type: "LIST_ACTIVE_LAUNCH_MEASUREMENT_RUNS" });
    expect(active).toMatchObject({
      type: "LAUNCH_MEASUREMENT_RUNS",
      runs: [{ id: started.run.id, status: "RUNNING" }],
    });
    const interrupted = reopened.execute({
      schemaVersion: 1,
      commandId: "interrupt-after-restart",
      correlationId: "correlation-interrupt-after-restart",
      actor: { type: "SYSTEM", id: "launch-measurement-recovery" },
      type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
      payload: {
        runId: started.run.id,
        expectedVersion: started.run.version,
        errorCode: "DAEMON_RESTART",
        processStopped: true,
      },
    });
    expect(interrupted).toMatchObject({
      type: "LAUNCH_MEASUREMENT_RUN_CHANGED",
      run: { status: "ERROR", errorCode: "DAEMON_RESTART", version: 2 },
    });
    expect(reopened.query({ type: "LIST_ACTIVE_LAUNCH_MEASUREMENT_RUNS" })).toEqual({
      type: "LAUNCH_MEASUREMENT_RUNS",
      runs: [],
    });
  });

  it("persists a blocked stop across restart and keeps it as the only active Run", async () => {
    const { localState, started } = await adoptAndStart();
    const blocked = localState.execute({
      schemaVersion: 1,
      commandId: "block-unproved-stop",
      correlationId: "correlation-block-unproved-stop",
      actor: { type: "SYSTEM", id: "launch-measurement-runner" },
      type: "INTERRUPT_LAUNCH_MEASUREMENT_RUN",
      payload: {
        runId: started.run.id,
        expectedVersion: started.run.version,
        errorCode: "SERVICE_EXITED",
        processStopped: false,
      },
    });
    expect(blocked).toMatchObject({
      type: "LAUNCH_MEASUREMENT_RUN_CHANGED",
      run: {
        status: "BLOCKED",
        errorCode: "SERVICE_TERMINATION_FAILED",
        completedAt: null,
        version: 2,
      },
    });

    localState.close();
    state = undefined;
    const reopened = await open();
    expect(reopened.query({ type: "LIST_ACTIVE_LAUNCH_MEASUREMENT_RUNS" })).toMatchObject({
      type: "LAUNCH_MEASUREMENT_RUNS",
      runs: [{ id: started.run.id, status: "BLOCKED", version: 2 }],
    });
  });

  it("rejects a second active Run without appending an Event", async () => {
    const { localState, adopted } = await adoptAndStart();
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "start-launch-second",
        correlationId: "correlation-start-launch-second",
        actor: { type: "HUMAN", id: "owner" },
        type: "START_LAUNCH_MEASUREMENT_RUN",
        payload: {
          projectId: "project-1",
          expectedPlanRevision: adopted.plan.revision,
          expectedPlanContentHash: adopted.plan.contentHash,
          testedTree: tree,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "ACTIVE_RUN_EXISTS" }));
    expect(() => {
      throw new LaunchMeasurementDomainError("ACTIVE_RUN_EXISTS", "fixture");
    }).toThrow(LaunchMeasurementDomainError);
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-1" });
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(4);
  });
});
