import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  verificationPlanProposalHash,
  type ExecuteVerificationRecipeInput,
  type VerificationRecipeExecution,
} from "@loomrail/project-readiness";
import { addWorktree, inspectRepository } from "@loomrail/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
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
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: fixture.databasePath,
      verificationArtifactsDirectory: fixture.artifactsDirectory,
      verificationRecipeExecutor: (input) =>
        new Promise((resolve) => {
          const interrupted = (): void => {
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
    const cancelledResponse = await fetch(
      `${daemon.baseUrl}/api/v1/verification-runs/${running.run.id}/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "owner-cancel-verification",
          expectedVersion: running.run.version,
        }),
      },
    );
    const cancelled = verificationRunSnapshotResponseSchema.parse(await cancelledResponse.json());
    expect(cancelled.run).toMatchObject({ status: "INTERRUPTED", terminalReason: "OWNER_CANCELLED" });
    expect(cancelled.checks).toMatchObject([{ status: "INTERRUPTED" }]);
    await daemon.whenIdle();
  });
});
