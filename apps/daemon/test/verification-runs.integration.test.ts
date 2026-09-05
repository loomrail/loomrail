import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verificationRunSnapshotResponseSchema,
  verificationRunsResponseSchema,
  type VerificationPlanProposal,
  type WorkflowTemplate,
} from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import {
  prepareVerificationProcessIntent,
  verificationProcessRecordPath,
  verificationPlanProposalHash,
  type ExecuteVerificationRecipeInput,
  type VerificationRecipeExecution,
} from "@loomrail/project-readiness";
import { addWorktree, inspectRepository } from "@loomrail/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { createProjectVerificationRunner } from "../src/verification-runner.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";

const timestamp = "2026-09-05T12:00:00.000Z";
const template: WorkflowTemplate = {
  schemaVersion: 1,
  id: "verification-api-fixture",
  version: 1,
  name: "Verification API fixture",
  stages: [
    {
      stage: "DISCOVERY",
      ordinal: 0,
      contextPack: {
        schemaVersion: 1,
        sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
      },
    },
  ],
};

type SeededVerification = {
  databasePath: string;
  artifactsDirectory: string;
  workItemId: string;
  workItemVersion: number;
  planRevision: number;
  planContentHash: string;
};

const proposalFor = (projectId: string): VerificationPlanProposal => {
  const content: Omit<VerificationPlanProposal, "proposalHash"> = {
    schemaVersion: 1,
    projectId,
    target: { state: "ABSENT", digest: null },
    recipes: [
      {
        schemaVersion: 1,
        id: "package-test",
        kind: "UNIT",
        label: "Tests",
        required: true,
        executable: "pnpm",
        argv: ["run", "test"],
        cwd: ".",
        timeoutSeconds: 300,
        outputLimitBytes: 65_536,
        environmentProfile: "VERIFICATION_BASELINE",
        networkPolicy: "INHERIT_HOST",
        provenance: {
          source: "PACKAGE_JSON_SCRIPT",
          manifestPath: "package.json",
          manifestContentHash: "a".repeat(64),
          scriptName: "test",
          scriptBodyPreview: "vitest run",
        },
      },
    ],
    warnings: [],
  };
  return { ...content, proposalHash: verificationPlanProposalHash(content) };
};

const seedVerification = async (directory: string): Promise<SeededVerification> => {
  const databasePath = join(directory, "state.sqlite");
  const artifactsDirectory = join(directory, "verification-output");
  const repositoryPath = await makeThrowawayRepo(join(directory, "repository"));
  const worktreePath = join(directory, "worktrees", "work item ё");
  const repository = await inspectRepository(repositoryPath);
  if (repository?.headCommit === null || repository === null) throw new Error("Expected repository HEAD");
  const added = await addWorktree({
    topLevel: repository.topLevel,
    branch: "loomrail/verification-api-item",
    path: worktreePath,
    startPoint: repository.headCommit,
  });
  if (added.type !== "ADDED") throw new Error("Expected test worktree");

  const state = await openLocalState({
    databasePath,
    now: () => new Date(timestamp),
  });
  try {
    const projectId = "verification-api-project";
    state.execute({
      schemaVersion: 1,
      commandId: "register-verification-project",
      correlationId: "correlation-register-verification-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: projectId,
        fixtureId: null,
        name: "Verification API Project",
        repositoryPath,
      },
    });
    const adopted = state.execute({
      schemaVersion: 1,
      commandId: "adopt-verification-plan",
      correlationId: "correlation-adopt-verification-plan",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ADOPT_VERIFICATION_PLAN",
      payload: { projectId, expectedProjectVersion: 1, proposal: proposalFor(projectId) },
    });
    if (adopted.type !== "VERIFICATION_PLAN_ADOPTED") throw new Error("Expected adopted Plan");
    state.execute({
      schemaVersion: 1,
      commandId: "apply-verification-plan",
      correlationId: "correlation-apply-verification-plan",
      actor: { type: "SYSTEM", id: "verification-publisher" },
      type: "COMPLETE_VERIFICATION_PLAN_PUBLICATION",
      payload: { publicationId: adopted.publication.id, expectedVersion: adopted.publication.version },
    });
    const created = state.execute({
      schemaVersion: 1,
      commandId: "create-verification-item",
      correlationId: "correlation-create-verification-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId,
        parentId: null,
        type: "TASK",
        title: "Verify the implementation",
        description: "A synthetic API fixture",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["The measured check is visible"],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem");
    const ready = state.execute({
      schemaVersion: 1,
      commandId: "ready-verification-item",
      correlationId: "correlation-ready-verification-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    if (ready.type !== "WORK_ITEM_MOVED") throw new Error("Expected READY WorkItem");
    const pipeline = state.execute({
      schemaVersion: 1,
      commandId: "start-verification-pipeline",
      correlationId: "correlation-start-verification-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: ready.workItem.version,
        template,
        budget: { maxEstimatedTokens: 100_000, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected PipelineRun");
    state.execute({
      schemaVersion: 1,
      commandId: "pause-verification-pipeline",
      correlationId: "correlation-pause-verification-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "PAUSE_PIPELINE",
      payload: {
        pipelineRunId: pipeline.run.id,
        expectedVersion: pipeline.run.version,
      },
    });
    state.execute({
      schemaVersion: 1,
      commandId: "create-verification-workspace",
      correlationId: "correlation-create-verification-workspace",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "CREATE_WORK_ITEM_WORKSPACE",
      payload: {
        projectId,
        workItemId: created.workItem.id,
        branch: "loomrail/verification-api-item",
        worktreePath,
        baseCommit: repository.headCommit,
        snapshotCommit: null,
        carriedPaths: [],
      },
    });
    const current = state.query({ type: "GET_WORK_ITEM", workItemId: created.workItem.id });
    if (current.type !== "WORK_ITEM" || current.workItem === null) throw new Error("Expected WorkItem");
    return {
      databasePath,
      artifactsDirectory,
      workItemId: created.workItem.id,
      workItemVersion: current.workItem.version,
      planRevision: adopted.plan.revision,
      planContentHash: adopted.plan.contentHash,
    };
  } finally {
    state.close();
  }
};

const passingExecution = async (
  input: ExecuteVerificationRecipeInput,
): Promise<VerificationRecipeExecution> => {
  const text = "<script>window.mustNotRun = true</script>\npassed\n";
  await mkdir(input.artifactDirectory, { recursive: true });
  const artifactPath = join(input.artifactDirectory, `${input.artifactId}.txt`);
  await writeFile(artifactPath, text, { mode: 0o600 });
  const bytes = Buffer.byteLength(text);
  return {
    observation: {
      status: "PASSED",
      completedAt: timestamp,
      durationMs: 7,
      exitCode: 0,
      signal: null,
      output: {
        schemaVersion: 1,
        artifactId: input.artifactId,
        sha256: createHash("sha256").update(text).digest("hex"),
        capturedBytes: bytes,
        stdoutBytes: bytes,
        stderrBytes: 0,
        truncated: false,
        available: true,
      },
    },
    artifactPath,
    beforeTree: null,
    afterTree: null,
  };
};

describe("project verification HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("notifies the workflow after a manually reserved Run settles successfully", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail verification workflow wake "));
    directories.push(directory);
    const fixture = await seedVerification(directory);
    const state = await openLocalState({
      databasePath: fixture.databasePath,
      now: () => new Date(timestamp),
    });
    try {
      const reserved = state.execute({
        schemaVersion: 1,
        commandId: "reserve-manual-workflow-wake",
        correlationId: "correlation-manual-workflow-wake",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_VERIFICATION_RUN",
        payload: {
          workItemId: fixture.workItemId,
          expectedWorkItemVersion: fixture.workItemVersion,
          expectedPlanRevision: fixture.planRevision,
          expectedPlanContentHash: fixture.planContentHash,
          implementationTree: "b".repeat(40),
          platform: "darwin",
        },
      });
      if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
      const settledRunIds: string[] = [];
      let commandId = 0;
      let artifactId = 0;
      const runner = createProjectVerificationRunner({
        state,
        artifactsDirectory: fixture.artifactsDirectory,
        createCommandId: () => `manual-wake-command-${(commandId++).toString()}`,
        createArtifactId: () => `manual-wake-output-${(artifactId++).toString()}`,
        now: () => new Date(timestamp),
        logger: { error: () => undefined },
        executeRecipe: passingExecution,
        onSettled: (runId) => {
          settledRunIds.push(runId);
        },
      });

      runner.wake(reserved.run.id);
      await runner.whenIdle(reserved.run.id);

      const completed = state.query({ type: "GET_VERIFICATION_RUN", runId: reserved.run.id });
      expect(completed.type === "VERIFICATION_RUN" ? completed.run?.status : null).toBe("PASSED");
      expect(settledRunIds).toEqual([reserved.run.id]);
      await runner.stop();
    } finally {
      state.close();
    }
  });

  it("does not wake the workflow after a non-terminal runner failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail verification failed workflow wake "));
    directories.push(directory);
    const fixture = await seedVerification(directory);
    const state = await openLocalState({
      databasePath: fixture.databasePath,
      now: () => new Date(timestamp),
    });
    try {
      const reserved = state.execute({
        schemaVersion: 1,
        commandId: "reserve-failed-workflow-wake",
        correlationId: "correlation-failed-workflow-wake",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_VERIFICATION_RUN",
        payload: {
          workItemId: fixture.workItemId,
          expectedWorkItemVersion: fixture.workItemVersion,
          expectedPlanRevision: fixture.planRevision,
          expectedPlanContentHash: fixture.planContentHash,
          implementationTree: "b".repeat(40),
          platform: "darwin",
        },
      });
      if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
      const settledRunIds: string[] = [];
      const runner = createProjectVerificationRunner({
        state,
        artifactsDirectory: fixture.artifactsDirectory,
        createCommandId: () => "failed-workflow-wake-command",
        createArtifactId: () => "failed-workflow-wake-output",
        now: () => new Date(timestamp),
        logger: { error: () => undefined },
        executeRecipe: () => Promise.reject(new Error("synthetic runner boundary failure")),
        onSettled: (runId) => {
          settledRunIds.push(runId);
        },
      });

      runner.wake(reserved.run.id);
      await runner.whenIdle(reserved.run.id);

      const incomplete = state.query({ type: "GET_VERIFICATION_RUN", runId: reserved.run.id });
      expect(incomplete.type === "VERIFICATION_RUN" ? incomplete.run?.status : null).toBe("RUNNING");
      expect(settledRunIds).toEqual([]);
      await runner.stop();
    } finally {
      state.close();
    }
  });

  it("removes recovered process proof before notifying workflow of owner cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail recovered verification cancel "));
    directories.push(directory);
    const fixture = await seedVerification(directory);
    const state = await openLocalState({
      databasePath: fixture.databasePath,
      now: () => new Date(timestamp),
    });
    try {
      const reserved = state.execute({
        schemaVersion: 1,
        commandId: "reserve-recovered-cancel",
        correlationId: "correlation-recovered-cancel",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_VERIFICATION_RUN",
        payload: {
          workItemId: fixture.workItemId,
          expectedWorkItemVersion: fixture.workItemVersion,
          expectedPlanRevision: fixture.planRevision,
          expectedPlanContentHash: fixture.planContentHash,
          implementationTree: "b".repeat(40),
          platform: "darwin",
        },
      });
      if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
      const registryDirectory = join(fixture.artifactsDirectory, ".processes");
      const proofPath = await prepareVerificationProcessIntent(registryDirectory, reserved.run.id);
      expect(proofPath).toBe(verificationProcessRecordPath(registryDirectory, reserved.run.id));
      const settledRunIds: string[] = [];
      const runner = createProjectVerificationRunner({
        state,
        artifactsDirectory: fixture.artifactsDirectory,
        createCommandId: () => "recovered-cancel-command",
        createArtifactId: () => "unused-recovered-cancel-output",
        now: () => new Date(timestamp),
        logger: { error: () => undefined },
        onSettled: (runId) => {
          settledRunIds.push(runId);
        },
      });

      await runner.cancel({
        runId: reserved.run.id,
        expectedVersion: reserved.run.version,
        commandId: "owner-recovered-cancel",
        correlationId: "correlation-owner-recovered-cancel",
      });

      const cancelled = state.query({ type: "GET_VERIFICATION_RUN", runId: reserved.run.id });
      expect(cancelled.type === "VERIFICATION_RUN" ? cancelled.run : null).toMatchObject({
        status: "INTERRUPTED",
        terminalReason: "OWNER_CANCELLED",
      });
      await expect(access(proofPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(settledRunIds).toEqual([reserved.run.id]);
      await runner.stop();
    } finally {
      state.close();
    }
  });

  it("starts, measures, lists, retries and serves output as inert text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail verification api "));
    directories.push(directory);
    const fixture = await seedVerification(directory);
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: fixture.databasePath,
      verificationArtifactsDirectory: fixture.artifactsDirectory,
      verificationRecipeExecutor: passingExecution,
    });
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);

    const unauthenticated = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`,
    );
    expect(unauthenticated.status).toBe(401);

    const start = await fetch(`${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "start-measured-verification",
        expectedWorkItemVersion: fixture.workItemVersion,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
      }),
    });
    expect(start.status).toBe(200);
    verificationRunSnapshotResponseSchema.parse(await start.json());
    await daemon.whenIdle();

    const listedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`,
      { headers: { cookie: session.cookie } },
    );
    const listed = verificationRunsResponseSchema.parse(await listedResponse.json());
    expect(listed.runs).toHaveLength(1);
    expect(listed.failures).toEqual([]);
    expect(listed.correctionRuns).toEqual([]);
    expect(listed.runs[0]).toMatchObject({
      run: { ordinal: 1, status: "PASSED", terminalReason: "ALL_REQUIRED_PASSED" },
      checks: [{ status: "PASSED", durationMs: 7 }],
      freshness: "CURRENT",
      staleReasons: [],
    });
    const first = listed.runs[0];
    const firstCheck = first?.checks[0];
    if (first === undefined || firstCheck === undefined) throw new Error("Expected verification evidence");

    const output = await fetch(`${daemon.baseUrl}/api/v1/verification-checks/${firstCheck.id}/output`, {
      headers: { cookie: session.cookie },
    });
    expect(output.status).toBe(200);
    expect(output.headers.get("content-type")).toContain("text/plain");
    expect(output.headers.get("x-content-type-options")).toBe("nosniff");
    expect(output.headers.get("cache-control")).toBe("no-store");
    expect(await output.text()).toContain("<script>window.mustNotRun = true</script>");
    const outputArtifactId = firstCheck.output?.artifactId;
    if (outputArtifactId === undefined) throw new Error("Expected measured output identity");
    await rm(join(fixture.artifactsDirectory, `${outputArtifactId}.txt`));
    const unavailableOutput = await fetch(
      `${daemon.baseUrl}/api/v1/verification-checks/${firstCheck.id}/output`,
      { headers: { cookie: session.cookie } },
    );
    expect(unavailableOutput.status).toBe(404);
    await expect(unavailableOutput.json()).resolves.toMatchObject({
      error: { code: "VERIFICATION_OUTPUT_UNAVAILABLE" },
    });

    const retry = await fetch(`${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "retry-measured-verification",
        expectedWorkItemVersion: fixture.workItemVersion,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
        retryOfRunId: first.run.id,
        expectedRetryOfRunVersion: first.run.version,
      }),
    });
    expect(retry.status).toBe(200);
    await daemon.whenIdle();
    const retried = verificationRunsResponseSchema.parse(
      await (
        await fetch(`${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`, {
          headers: { cookie: session.cookie },
        })
      ).json(),
    );
    expect(retried.runs).toMatchObject([
      { run: { ordinal: 2, retryOfRunId: first.run.id, status: "PASSED" } },
      { run: { ordinal: 1, status: "PASSED" } },
    ]);

    const missingGateUrl =
      `${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}` +
      "/verification/correction-gate/missing-request";
    const missingGateBody = JSON.stringify({
      schemaVersion: 1,
      commandId: "resolve-missing-verification-gate",
      expectedRequestVersion: 1,
      correctionRunId: "missing-correction",
      expectedCorrectionVersion: 1,
      expectedPipelineRunVersion: 1,
      action: "CANCEL",
    });
    const unauthenticatedGate = await fetch(missingGateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: missingGateBody,
    });
    expect(unauthenticatedGate.status).toBe(401);
    const foreignOriginGate = await fetch(missingGateUrl, {
      method: "POST",
      headers: { ...headers, origin: "http://attacker.invalid" },
      body: missingGateBody,
    });
    expect(foreignOriginGate.status).toBe(403);
    const missingGate = await fetch(missingGateUrl, {
      method: "POST",
      headers,
      body: missingGateBody,
    });
    expect(missingGate.status).toBe(404);
    await expect(missingGate.json()).resolves.toMatchObject({ error: { code: "REQUEST_INVALID" } });
  });

  it("lets only the owner cancel a running measured check", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail verification cancel "));
    directories.push(directory);
    const fixture = await seedVerification(directory);
    const token = bootstrapToken();
    let abortCount = 0;
    let stopCompleted = false;
    let observeAbort: () => void = () => undefined;
    let releaseStop: () => void = () => undefined;
    const abortObserved = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: fixture.databasePath,
      verificationArtifactsDirectory: fixture.artifactsDirectory,
      verificationRecipeExecutor: (input) =>
        new Promise((resolve) => {
          const interrupted = (): void => {
            abortCount += 1;
            observeAbort();
            void stopGate.then(() => {
              stopCompleted = true;
              resolve({
                observation: {
                  status: "INTERRUPTED",
                  completedAt: timestamp,
                  durationMs: 1,
                  exitCode: null,
                  signal: null,
                  reason: "OWNER_CANCELLED",
                  output: null,
                },
                artifactPath: null,
                beforeTree: null,
                afterTree: null,
              });
            });
          };
          if (input.signal?.aborted) interrupted();
          else input.signal?.addEventListener("abort", interrupted, { once: true });
        }),
    });
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);
    const start = await fetch(`${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "start-cancellable-verification",
        expectedWorkItemVersion: fixture.workItemVersion,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
      }),
    });
    const started = verificationRunSnapshotResponseSchema.parse(await start.json());

    const forbidden = await fetch(`${daemon.baseUrl}/api/v1/verification-runs/${started.run.id}/cancel`, {
      method: "POST",
      headers: { ...headers, origin: "http://attacker.invalid" },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "forbidden-cancel",
        expectedVersion: 2,
      }),
    });
    expect(forbidden.status).toBe(403);

    const runningResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`,
      { headers: { cookie: session.cookie } },
    );
    const running = verificationRunsResponseSchema.parse(await runningResponse.json()).runs[0];
    expect(running?.run.status).toBe("RUNNING");
    if (running === undefined) throw new Error("Expected running verification");
    const reusedCancel = await fetch(`${daemon.baseUrl}/api/v1/verification-runs/${running.run.id}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "register-verification-project",
        expectedVersion: running.run.version,
      }),
    });
    expect(reusedCancel.status).toBe(409);
    await expect(reusedCancel.json()).resolves.toMatchObject({ error: { code: "COMMAND_ID_REUSED" } });
    expect(abortCount).toBe(0);

    const staleCancel = await fetch(`${daemon.baseUrl}/api/v1/verification-runs/${running.run.id}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "stale-owner-cancel-verification",
        expectedVersion: running.run.version + 1,
      }),
    });
    expect(staleCancel.status).toBe(409);
    expect(abortCount).toBe(0);

    let responseSettled = false;
    const cancellation = fetch(`${daemon.baseUrl}/api/v1/verification-runs/${running.run.id}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "owner-cancel-verification",
        expectedVersion: running.run.version,
      }),
    }).then((response) => {
      responseSettled = true;
      return response;
    });
    await abortObserved;
    expect(responseSettled).toBe(false);
    const cancellingResponse = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${fixture.workItemId}/verification-runs`,
      { headers: { cookie: session.cookie } },
    );
    const cancelling = verificationRunsResponseSchema.parse(await cancellingResponse.json()).runs[0];
    expect(cancelling?.run).toMatchObject({ status: "CANCELLING", terminalReason: null });
    const inFlightReuse = await fetch(`${daemon.baseUrl}/api/v1/verification-runs/${running.run.id}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: "owner-cancel-verification",
        expectedVersion: running.run.version + 1,
      }),
    });
    expect(inFlightReuse.status).toBe(409);
    await expect(inFlightReuse.json()).resolves.toMatchObject({
      error: { code: "COMMAND_ID_REUSED" },
    });
    expect(abortCount).toBe(1);
    releaseStop();
    const cancelledResponse = await cancellation;
    const cancelled = verificationRunSnapshotResponseSchema.parse(await cancelledResponse.json());
    expect(stopCompleted).toBe(true);
    expect(cancelled.run).toMatchObject({ status: "INTERRUPTED", terminalReason: "OWNER_CANCELLED" });
    expect(cancelled.checks).toMatchObject([{ status: "INTERRUPTED" }]);
    await daemon.whenIdle();
  });
});
