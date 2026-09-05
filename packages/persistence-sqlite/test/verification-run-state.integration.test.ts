import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VerificationPlanProposal } from "@loomrail/contracts";
import { VerificationDomainError } from "@loomrail/domain";
import { verificationPlanProposalHash } from "@loomrail/project-readiness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

const timestamp = "2026-09-05T11:00:00.000Z";
const tree = "b".repeat(40);
const proposalContent: Omit<VerificationPlanProposal, "proposalHash"> = {
  schemaVersion: 1,
  projectId: "project-one",
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
const proposal: VerificationPlanProposal = {
  ...proposalContent,
  proposalHash: verificationPlanProposalHash(proposalContent),
};
const template = {
  schemaVersion: 1 as const,
  id: "verification-fixture",
  version: 1,
  name: "Verification fixture",
  stages: [
    {
      stage: "DISCOVERY" as const,
      ordinal: 0,
      contextPack: {
        schemaVersion: 1 as const,
        sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
      },
    },
  ],
};

describe("verification Run local state", () => {
  let directory = "";
  let databasePath = "";
  let workspacePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail verification state "));
    databasePath = join(directory, "state.sqlite");
    workspacePath = join(directory, "worktree with spaces-ёж");
    nextId = 0;
  });

  afterEach(async () => {
    state?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
      listProjectWorktrees: () => [
        { path: workspacePath, branch: "loomrail/work-item-one", prunable: false },
      ],
    });
    return state;
  };

  const prepare = async (): Promise<{
    localState: LocalState;
    workItemId: string;
    workItemVersion: number;
    pipelineRunId: string;
    stageAttemptId: string;
    workspaceId: string;
    planId: string;
    planRevision: number;
    planContentHash: string;
  }> => {
    const localState = await open();
    localState.execute({
      schemaVersion: 1,
      commandId: "register-project",
      correlationId: "correlation-register-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-one",
        fixtureId: null,
        name: "Project one",
        repositoryPath: join(directory, "project-one"),
      },
    });
    const adopted = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-plan",
      correlationId: "correlation-adopt-plan",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ADOPT_VERIFICATION_PLAN",
      payload: { projectId: "project-one", expectedProjectVersion: 1, proposal },
    });
    if (adopted.type !== "VERIFICATION_PLAN_ADOPTED") throw new Error("Expected adopted Plan");
    localState.execute({
      schemaVersion: 1,
      commandId: "publish-plan",
      correlationId: "correlation-publish-plan",
      actor: { type: "SYSTEM", id: "verification-publisher" },
      type: "COMPLETE_VERIFICATION_PLAN_PUBLICATION",
      payload: { publicationId: adopted.publication.id, expectedVersion: adopted.publication.version },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: "create-work-item",
      correlationId: "correlation-create-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-one",
        parentId: null,
        type: "TASK",
        title: "Verify this",
        description: "Synthetic verification fixture",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["Checks are durable"],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem");
    const ready = localState.execute({
      schemaVersion: 1,
      commandId: "ready-work-item",
      correlationId: "correlation-ready-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    if (ready.type !== "WORK_ITEM_MOVED") throw new Error("Expected READY WorkItem");
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: "start-pipeline",
      correlationId: "correlation-start-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: ready.workItem.id,
        expectedVersion: ready.workItem.version,
        template,
        budget: { maxEstimatedTokens: 100_000, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected PipelineRun");
    const workspace = localState.execute({
      schemaVersion: 1,
      commandId: "create-workspace",
      correlationId: "correlation-create-workspace",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "CREATE_WORK_ITEM_WORKSPACE",
      payload: {
        projectId: "project-one",
        workItemId: ready.workItem.id,
        branch: "loomrail/work-item-one",
        worktreePath: workspacePath,
        baseCommit: null,
        snapshotCommit: null,
        carriedPaths: [],
      },
    });
    if (workspace.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace");
    const current = localState.query({ type: "GET_WORK_ITEM", workItemId: ready.workItem.id });
    if (current.type !== "WORK_ITEM" || current.workItem === null) throw new Error("Expected WorkItem");
    return {
      localState,
      workItemId: ready.workItem.id,
      workItemVersion: current.workItem.version,
      pipelineRunId: pipeline.run.id,
      stageAttemptId: pipeline.stageAttempt.id,
      workspaceId: workspace.workspace.id,
      planId: adopted.plan.id,
      planRevision: adopted.plan.revision,
      planContentHash: adopted.plan.contentHash,
    };
  };

  const reserve = (fixture: Awaited<ReturnType<typeof prepare>>, commandId = "start-verification") =>
    fixture.localState.execute({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_VERIFICATION_RUN",
      payload: {
        workItemId: fixture.workItemId,
        expectedWorkItemVersion: fixture.workItemVersion,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
        implementationTree: tree,
        platform: "darwin",
      },
    });

  it("reserves, measures, stores output reference and releases the workspace atomically", async () => {
    const fixture = await prepare();
    const reserved = reserve(fixture);
    if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
    expect(reserved).toMatchObject({
      replayed: false,
      run: {
        pipelineRunId: fixture.pipelineRunId,
        workspaceId: fixture.workspaceId,
        planId: fixture.planId,
        status: "QUEUED",
      },
      checks: [{ recipeId: "package-test", required: true, status: "QUEUED" }],
      event: { type: "VERIFICATION_RUN_RESERVED" },
    });
    expect(reserve(fixture)).toMatchObject({ type: "VERIFICATION_RUN_RESERVED", replayed: true });

    expect(() =>
      fixture.localState.execute({
        schemaVersion: 1,
        commandId: "writer-cannot-overlap",
        correlationId: "correlation-writer-cannot-overlap",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "ACQUIRE_WORKSPACE_LEASE",
        payload: {
          workspaceId: fixture.workspaceId,
          stageAttemptId: fixture.stageAttemptId,
          expectedVersion: 2,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_VERIFICATION_HELD" }));

    const check = reserved.checks[0];
    if (check === undefined) throw new Error("Expected Check");
    const started = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-check",
      correlationId: "correlation-start-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "START_VERIFICATION_CHECK",
      payload: {
        runId: reserved.run.id,
        checkId: check.id,
        expectedRunVersion: reserved.run.version,
        expectedCheckVersion: check.version,
      },
    });
    if (started.type !== "VERIFICATION_CHECK_STARTED") throw new Error("Expected started Check");
    const output = {
      schemaVersion: 1 as const,
      artifactId: "verification-output-one",
      sha256: "c".repeat(64),
      capturedBytes: 4,
      stdoutBytes: 0,
      stderrBytes: 4,
      truncated: false,
      available: true,
    };
    const completeCommand = {
      schemaVersion: 1,
      commandId: "complete-check",
      correlationId: "correlation-complete-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "COMPLETE_VERIFICATION_CHECK",
      payload: {
        runId: started.run.id,
        checkId: started.check.id,
        expectedRunVersion: started.run.version,
        expectedCheckVersion: started.check.version,
        observation: {
          status: "FAILED",
          completedAt: timestamp,
          durationMs: 1,
          exitCode: 7,
          signal: null,
          output,
        },
        outputStorageKey: "verification-output-one.txt",
      },
    } as const;
    const completed = fixture.localState.execute(completeCommand);
    expect(completed).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      run: { status: "FAILED", terminalReason: "REQUIRED_CHECK_FAILED" },
      check: { status: "FAILED", exitCode: 7 },
      next: "TERMINAL",
    });
    if (completed.type !== "VERIFICATION_CHECK_COMPLETED") throw new Error("Expected completed Check");
    expect(
      fixture.localState.query({
        type: "LIST_WORK_ITEM_VERIFICATION_FAILURES",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({
      type: "VERIFICATION_FAILURES",
      failures: [
        {
          verificationRunId: completed.run.id,
          verificationCheckId: completed.check.id,
          reason: "REQUIRED_CHECK_FAILED",
          implementationTree: tree,
        },
      ],
    });
    expect(fixture.localState.execute(completeCommand)).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      replayed: true,
    });
    const failureEvents = fixture.localState.query({
      type: "LIST_EVENTS",
      aggregateId: fixture.workItemId,
      direction: "ASC",
      limit: 100,
    });
    if (failureEvents.type !== "EVENTS") throw new Error("Expected Events");
    expect(failureEvents.events.filter(({ type }) => type === "VERIFICATION_FAILURE_RECORDED")).toHaveLength(
      1,
    );
    expect(
      fixture.localState.query({ type: "GET_VERIFICATION_OUTPUT_ARTIFACT", checkId: check.id }),
    ).toMatchObject({
      type: "VERIFICATION_OUTPUT_ARTIFACT",
      artifact: { artifactId: output.artifactId, storageKey: "verification-output-one.txt" },
    });
    expect(
      fixture.localState.query({
        type: "LIST_EXPIRED_VERIFICATION_OUTPUTS",
        closedBefore: "2026-09-05T11:00:01.000Z",
      }),
    ).toEqual({
      type: "VERIFICATION_OUTPUTS",
      artifacts: [{ artifactId: output.artifactId, storageKey: "verification-output-one.txt" }],
    });
    expect(() =>
      fixture.localState.execute({
        schemaVersion: 1,
        commandId: "forbidden-output-retention",
        correlationId: "correlation-forbidden-output-retention",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "RECORD_VERIFICATION_OUTPUT_RETENTION",
        payload: { artifactId: output.artifactId, outcome: "DELETED" },
      }),
    ).toThrow(expect.objectContaining({ code: "VERIFICATION_RETENTION_ACTOR_FORBIDDEN" }));
    const retentionCommand = {
      schemaVersion: 1,
      commandId: "record-output-retention",
      correlationId: "correlation-record-output-retention",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECORD_VERIFICATION_OUTPUT_RETENTION",
      payload: { artifactId: output.artifactId, outcome: "DELETED" },
    } as const;
    expect(fixture.localState.execute(retentionCommand)).toMatchObject({
      type: "VERIFICATION_OUTPUT_RETENTION_RECORDED",
      replayed: false,
      artifactId: output.artifactId,
      outcome: "DELETED",
    });
    expect(fixture.localState.execute(retentionCommand)).toMatchObject({
      type: "VERIFICATION_OUTPUT_RETENTION_RECORDED",
      replayed: true,
    });
    expect(
      fixture.localState.query({
        type: "LIST_EXPIRED_VERIFICATION_OUTPUTS",
        closedBefore: "2026-09-05T11:00:01.000Z",
      }),
    ).toEqual({ type: "VERIFICATION_OUTPUTS", artifacts: [] });
    const workspace = fixture.localState.query({
      type: "GET_WORKSPACE_BY_WORK_ITEM",
      workItemId: fixture.workItemId,
    });
    if (workspace.type !== "WORKSPACE" || workspace.workspace === null) throw new Error("Expected workspace");
    expect(
      fixture.localState.execute({
        schemaVersion: 1,
        commandId: "writer-after-verification",
        correlationId: "correlation-writer-after-verification",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "ACQUIRE_WORKSPACE_LEASE",
        payload: {
          workspaceId: fixture.workspaceId,
          stageAttemptId: fixture.stageAttemptId,
          expectedVersion: workspace.workspace.version,
        },
      }),
    ).toMatchObject({ type: "WORKSPACE_LEASE_ACQUIRED" });
  });

  it("rolls back a stale completion without output, Event, or state change", async () => {
    const fixture = await prepare();
    const reserved = reserve(fixture);
    if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
    const check = reserved.checks[0];
    if (check === undefined) throw new Error("Expected Check");
    const started = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-check",
      correlationId: "correlation-start-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "START_VERIFICATION_CHECK",
      payload: {
        runId: reserved.run.id,
        checkId: check.id,
        expectedRunVersion: 1,
        expectedCheckVersion: 1,
      },
    });
    if (started.type !== "VERIFICATION_CHECK_STARTED") throw new Error("Expected started Check");

    expect(() =>
      fixture.localState.execute({
        schemaVersion: 1,
        commandId: "stale-completion",
        correlationId: "correlation-stale-completion",
        actor: { type: "SYSTEM", id: "verification-runner" },
        type: "COMPLETE_VERIFICATION_CHECK",
        payload: {
          runId: started.run.id,
          checkId: started.check.id,
          expectedRunVersion: 1,
          expectedCheckVersion: 2,
          observation: {
            status: "ERROR",
            completedAt: timestamp,
            durationMs: 1,
            exitCode: null,
            signal: null,
            errorCode: "TIMED_OUT",
            output: null,
          },
          outputStorageKey: null,
        },
      }),
    ).toThrow(VerificationDomainError);
    expect(fixture.localState.query({ type: "GET_VERIFICATION_RUN", runId: started.run.id })).toMatchObject({
      run: { status: "RUNNING", version: 2 },
      checks: [{ status: "RUNNING", version: 2 }],
    });
    expect(
      fixture.localState.query({ type: "GET_VERIFICATION_OUTPUT_ARTIFACT", checkId: check.id }),
    ).toMatchObject({ artifact: null });
  });

  it("interrupts active verification on restart without replaying unknown work", async () => {
    const fixture = await prepare();
    const reserved = reserve(fixture);
    if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
    const check = reserved.checks[0];
    if (check === undefined) throw new Error("Expected Check");
    const started = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-check",
      correlationId: "correlation-start-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "START_VERIFICATION_CHECK",
      payload: {
        runId: reserved.run.id,
        checkId: check.id,
        expectedRunVersion: 1,
        expectedCheckVersion: 1,
      },
    });
    if (started.type !== "VERIFICATION_CHECK_STARTED") throw new Error("Expected started Check");
    fixture.localState.close();
    state = undefined;

    const reopened = await open();
    const reconciled = reopened.execute({
      schemaVersion: 1,
      commandId: "reconcile-after-restart",
      correlationId: "correlation-reconcile-after-restart",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });
    expect(reconciled).toMatchObject({
      type: "WORKFLOWS_RECONCILED",
      interruptedVerificationRuns: [
        { id: started.run.id, status: "INTERRUPTED", terminalReason: "DAEMON_RESTART" },
      ],
    });
    if (reconciled.type !== "WORKFLOWS_RECONCILED") throw new Error("Expected reconciliation");
    expect(reconciled.events.map((event) => event.type)).toContain("VERIFICATION_RUN_INTERRUPTED");
    expect(reconciled.events.map((event) => event.type)).toContain("VERIFICATION_FAILURE_RECORDED");
    expect(reopened.query({ type: "GET_VERIFICATION_RUN", runId: started.run.id })).toMatchObject({
      run: { status: "INTERRUPTED", terminalReason: "DAEMON_RESTART" },
      checks: [{ status: "INTERRUPTED" }],
    });
    expect(reopened.query({ type: "LIST_ACTIVE_VERIFICATION_RUNS" })).toEqual({
      type: "VERIFICATION_RUNS",
      runs: [],
    });
    expect(
      reopened.query({
        type: "LIST_WORK_ITEM_VERIFICATION_FAILURES",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({
      type: "VERIFICATION_FAILURES",
      failures: [
        {
          verificationRunId: started.run.id,
          verificationCheckId: started.check.id,
          reason: "RUN_INTERRUPTED",
        },
      ],
    });
  });

  it("rejects a second active Run without writing a second reservation", async () => {
    const fixture = await prepare();
    reserve(fixture);
    expect(() => reserve(fixture, "second-verification")).toThrow(
      expect.objectContaining({ code: "VERIFICATION_RUN_ALREADY_ACTIVE" }),
    );
    expect(
      fixture.localState.query({
        type: "LIST_WORK_ITEM_VERIFICATION_RUNS",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({ type: "VERIFICATION_RUNS", runs: [{ ordinal: 1 }] });
  });
});
