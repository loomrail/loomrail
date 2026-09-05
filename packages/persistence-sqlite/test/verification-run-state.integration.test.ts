import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { StartMockPipelineCommand, VerificationPlanProposal } from "@loomrail/contracts";
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
      stage: "QA" as const,
      ordinal: 0,
      contextPack: {
        schemaVersion: 1 as const,
        sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
      },
    },
  ],
};
const correctionWorkflowTemplate: StartMockPipelineCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "verification-correction-workflow",
  version: 1,
  name: "Verification correction workflow",
  stages: [
    {
      stage: "IMPLEMENT",
      ordinal: 0,
      contextPack: {
        schemaVersion: 1,
        sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
      },
    },
    {
      stage: "REVIEW",
      ordinal: 1,
      contextPack: {
        schemaVersion: 1,
        sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
      },
    },
    {
      stage: "QA",
      ordinal: 2,
      contextPack: {
        schemaVersion: 1,
        sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
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

  const prepare = async (
    workflowTemplate: StartMockPipelineCommand["payload"]["template"] = template,
  ): Promise<{
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
        template: workflowTemplate,
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

  it("atomically returns a failed QA verification gate to a distinct correction IMPLEMENT", async () => {
    const fixture = await prepare();
    const reserved = reserve(fixture, "reserve-correction-source");
    if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
    const check = reserved.checks[0];
    if (check === undefined) throw new Error("Expected Check");
    const started = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-correction-source-check",
      correlationId: "correlation-start-correction-source-check",
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
    const completeCommand = {
      schemaVersion: 1,
      commandId: "fail-correction-source-check",
      correlationId: "correlation-fail-correction-source-check",
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
          exitCode: 1,
          signal: null,
          output: {
            schemaVersion: 1,
            artifactId: "correction-source-output",
            sha256: "d".repeat(64),
            capturedBytes: 1,
            stdoutBytes: 0,
            stderrBytes: 1,
            truncated: false,
            available: true,
          },
        },
        outputStorageKey: "correction-source-output.txt",
      },
    } as const;
    expect(fixture.localState.execute(completeCommand)).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      replayed: false,
      run: { status: "FAILED" },
    });
    expect(fixture.localState.execute(completeCommand)).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      replayed: true,
    });
    const failures = fixture.localState.query({
      type: "LIST_WORK_ITEM_VERIFICATION_FAILURES",
      workItemId: fixture.workItemId,
    });
    if (failures.type !== "VERIFICATION_FAILURES") throw new Error("Expected failures");
    const failure = failures.failures[0];
    if (failure === undefined) throw new Error("Expected source failure");

    const corrections = fixture.localState.query({
      type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
      workItemId: fixture.workItemId,
    });
    if (corrections.type !== "VERIFICATION_CORRECTIONS") throw new Error("Expected corrections");
    const correction = corrections.correctionRuns[0];
    if (correction === undefined) throw new Error("Expected correction");

    const workflow = fixture.localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (workflow.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
    const correctionAttempt = workflow.snapshot.stageAttempts.find(
      ({ verificationCorrectionRunId }) => verificationCorrectionRunId === correction.id,
    );
    expect(correctionAttempt).toMatchObject({
      correctionRunId: null,
      verificationCorrectionRunId: correction.id,
      stage: "IMPLEMENT",
      attempt: 1,
      status: "QUEUED",
    });
    if (correctionAttempt === undefined) throw new Error("Expected correction IMPLEMENT attempt");
    expect(correction).toMatchObject({
      projectId: "project-one",
      workItemId: fixture.workItemId,
      pipelineRunId: fixture.pipelineRunId,
      budgetPosition: 1,
      automatic: true,
      sourceFailureId: failure.id,
      sourceVerificationRunId: failure.verificationRunId,
      sourceImplementationTree: tree,
      status: "ACTIVE",
      completedAt: null,
      version: 1,
    });
    expect(workflow.snapshot.run).toMatchObject({
      id: fixture.pipelineRunId,
      currentStageAttemptId: correctionAttempt.id,
      status: "RUNNING",
    });
    expect(fixture.localState.query({ type: "GET_WORK_ITEM", workItemId: fixture.workItemId })).toMatchObject(
      { workItem: { state: "IN_PROGRESS", currentStage: "IMPLEMENT" } },
    );
    const events = fixture.localState.query({
      type: "LIST_EVENTS",
      aggregateId: fixture.workItemId,
      direction: "ASC",
      limit: 100,
    });
    if (events.type !== "EVENTS") throw new Error("Expected Events");
    expect(events.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "VERIFICATION_CHECK_COMPLETED",
        "VERIFICATION_FAILURE_RECORDED",
        "VERIFICATION_CORRECTION_STARTED",
      ]),
    );
    expect(events.events.filter(({ type }) => type === "VERIFICATION_CORRECTION_STARTED")).toHaveLength(1);

    fixture.localState.close();
    state = undefined;
    const beforeLedger = new DatabaseSync(databasePath);
    beforeLedger.exec(`
      DROP TRIGGER qa_correction_runs_budget_entry_insert;
      DROP TRIGGER verification_correction_runs_budget_entry_insert;
      DROP TRIGGER correction_budget_entries_append_only_update;
      DROP TRIGGER correction_budget_entries_append_only_delete;
      DROP TABLE correction_budget_entries;
      DELETE FROM schema_migrations WHERE version = 46;
    `);
    beforeLedger.close();
    const reopened = await open();
    expect(reopened.startup.appliedMigrations).toEqual([46]);
    expect(
      reopened.query({
        type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({
      type: "VERIFICATION_CORRECTIONS",
      correctionRuns: [{ id: correction.id, status: "ACTIVE", version: 1 }],
    });
    const reopenedWorkflow = reopened.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (reopenedWorkflow.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected reopened workflow");
    expect(reopenedWorkflow.snapshot.run).toMatchObject({
      currentStageAttemptId: correctionAttempt.id,
      status: "RUNNING",
    });
    expect(
      reopenedWorkflow.snapshot.stageAttempts.find(({ id }) => id === correctionAttempt.id),
    ).toMatchObject({
      verificationCorrectionRunId: correction.id,
      stage: "IMPLEMENT",
      status: "QUEUED",
    });
    const durableLedger = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      durableLedger
        .prepare(
          `SELECT position, automatic, evaluator, correction_run_id
           FROM correction_budget_entries
           WHERE pipeline_run_id = ?`,
        )
        .all(fixture.pipelineRunId),
    ).toEqual([
      {
        position: 1,
        automatic: 1,
        evaluator: "PROJECT_VERIFICATION",
        correction_run_id: correction.id,
      },
    ]);
    durableLedger.close();
  });

  it("materializes stale passing evidence without rewriting it and survives restart", async () => {
    const fixture = await prepare();
    const reserved = reserve(fixture, "reserve-stale-source");
    if (reserved.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected reserved Run");
    const check = reserved.checks[0];
    if (check === undefined) throw new Error("Expected Check");
    const started = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-stale-source-check",
      correlationId: "correlation-start-stale-source-check",
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
    const completed = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "pass-stale-source-check",
      correlationId: "correlation-pass-stale-source-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "COMPLETE_VERIFICATION_CHECK",
      payload: {
        runId: started.run.id,
        checkId: started.check.id,
        expectedRunVersion: started.run.version,
        expectedCheckVersion: started.check.version,
        observation: {
          status: "PASSED",
          completedAt: timestamp,
          durationMs: 1,
          exitCode: 0,
          signal: null,
          output: {
            schemaVersion: 1,
            artifactId: "stale-source-output",
            sha256: "e".repeat(64),
            capturedBytes: 1,
            stdoutBytes: 1,
            stderrBytes: 0,
            truncated: false,
            available: true,
          },
        },
        outputStorageKey: "stale-source-output.txt",
      },
    });
    if (completed.type !== "VERIFICATION_CHECK_COMPLETED") throw new Error("Expected completed Check");
    expect(completed.run).toMatchObject({ status: "PASSED", terminalReason: "ALL_REQUIRED_PASSED" });

    const currentWorkItem = fixture.localState.query({
      type: "GET_WORK_ITEM",
      workItemId: fixture.workItemId,
    });
    const workflow = fixture.localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (currentWorkItem.type !== "WORK_ITEM" || currentWorkItem.workItem === null) {
      throw new Error("Expected current WorkItem");
    }
    if (workflow.type !== "WORKFLOW_SNAPSHOT" || workflow.snapshot.run === null) {
      throw new Error("Expected workflow snapshot");
    }
    const currentStage = workflow.snapshot.stageAttempts.find(
      ({ id }) => id === workflow.snapshot.run?.currentStageAttemptId,
    );
    if (currentStage === undefined) throw new Error("Expected current StageAttempt");
    const changedTree = "c".repeat(40);
    const materializeCommand = {
      schemaVersion: 1,
      commandId: "materialize-stale-source",
      correlationId: "correlation-materialize-stale-source",
      actor: { type: "SYSTEM", id: "verification-workflow" },
      type: "MATERIALIZE_STALE_VERIFICATION_FAILURE",
      payload: {
        workItemId: fixture.workItemId,
        verificationRunId: completed.run.id,
        expectedWorkItemVersion: currentWorkItem.workItem.version,
        expectedPipelineRunVersion: workflow.snapshot.run.version,
        expectedStageAttemptVersion: currentStage.version,
        expectedVerificationRunVersion: completed.run.version,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
        currentTree: changedTree,
      },
    } as const;
    expect(() =>
      fixture.localState.execute({
        ...materializeCommand,
        commandId: "materialize-stale-source-version-conflict",
        payload: {
          ...materializeCommand.payload,
          expectedStageAttemptVersion: materializeCommand.payload.expectedStageAttemptVersion + 1,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(
      fixture.localState.query({
        type: "LIST_WORK_ITEM_VERIFICATION_FAILURES",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({ failures: [] });

    const materialized = fixture.localState.execute(materializeCommand);
    if (materialized.type !== "VERIFICATION_STALE_FAILURE_MATERIALIZED") {
      throw new Error("Expected stale materialization");
    }
    expect(materialized).toMatchObject({
      replayed: false,
      action: "START_CORRECTION",
      failure: {
        verificationRunId: completed.run.id,
        verificationCheckId: null,
        implementationTree: tree,
        reason: "STALE",
        staleReasons: ["TREE_CHANGED"],
      },
      correctionRun: {
        budgetPosition: 1,
        automatic: true,
        sourceVerificationRunId: completed.run.id,
        sourceImplementationTree: tree,
        status: "ACTIVE",
      },
      run: { currentStageAttemptId: materialized.dispatch?.stageAttemptId, status: "RUNNING" },
      stageAttempt: { id: currentStage.id, status: "SUCCEEDED", resultTree: tree },
      dispatch: { status: "PENDING" },
    });
    expect(materialized.events.map(({ type }) => type)).toEqual([
      "VERIFICATION_FAILURE_RECORDED",
      "STAGE_ATTEMPT_CHANGED",
      "VERIFICATION_CORRECTION_STARTED",
    ]);
    expect(fixture.localState.execute(materializeCommand)).toMatchObject({
      type: "VERIFICATION_STALE_FAILURE_MATERIALIZED",
      replayed: true,
      failure: { id: materialized.failure.id },
      correctionRun: { id: materialized.correctionRun?.id },
    });

    const sourceAfterMaterialization = fixture.localState.query({
      type: "GET_VERIFICATION_RUN",
      runId: completed.run.id,
    });
    expect(sourceAfterMaterialization).toMatchObject({
      run: {
        id: completed.run.id,
        status: "PASSED",
        terminalReason: "ALL_REQUIRED_PASSED",
        implementationTree: tree,
        version: completed.run.version,
      },
    });
    expect(
      fixture.localState.query({
        type: "LIST_WORK_ITEM_VERIFICATION_FAILURES",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({
      failures: [{ id: materialized.failure.id, reason: "STALE", staleReasons: ["TREE_CHANGED"] }],
    });

    fixture.localState.close();
    state = undefined;
    const reopened = await open();
    expect(
      reopened.query({
        type: "GET_VERIFICATION_RUN",
        runId: completed.run.id,
      }),
    ).toMatchObject({ run: { status: "PASSED", version: completed.run.version } });
    expect(
      reopened.query({
        type: "LIST_WORK_ITEM_VERIFICATION_FAILURES",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({ failures: [{ id: materialized.failure.id, reason: "STALE" }] });
    expect(
      reopened.query({
        type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({
      correctionRuns: [
        {
          id: materialized.correctionRun?.id,
          sourceFailureId: materialized.failure.id,
          status: "ACTIVE",
        },
      ],
    });
    const reopenedWorkflow = reopened.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (reopenedWorkflow.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected reopened workflow");
    expect(reopenedWorkflow.snapshot.run).toMatchObject({
      currentStageAttemptId: materialized.dispatch?.stageAttemptId,
      status: "RUNNING",
    });
    expect(
      reopenedWorkflow.snapshot.stageAttempts.find(({ id }) => id === materialized.dispatch?.stageAttemptId),
    ).toMatchObject({
      stage: "IMPLEMENT",
      verificationCorrectionRunId: materialized.correctionRun?.id,
      status: "QUEUED",
    });
  });

  it("closes the active correction only after a fresh reviewed passing rerun", async () => {
    const fixture = await prepare(correctionWorkflowTemplate);
    const nextDispatch = () => {
      const pending = fixture.localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
      const dispatch = pending.dispatches.find(({ workItemId }) => workItemId === fixture.workItemId);
      if (dispatch === undefined) throw new Error("Expected pending workflow dispatch");
      return dispatch;
    };
    const startAgent = (suffix: string, provider: "CODEX" | "CLAUDE_CODE") => {
      const dispatch = nextDispatch();
      const started = fixture.localState.execute({
        schemaVersion: 1,
        commandId: `start-${suffix}`,
        correlationId: `correlation-start-${suffix}`,
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: dispatch.id,
          provider,
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (started.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun");
      return dispatch;
    };
    const completeImplementation = (suffix: string, implementationTree: string): void => {
      const dispatch = startAgent(`${suffix}-implement`, "CODEX");
      expect(
        fixture.localState.execute({
          schemaVersion: 1,
          commandId: `complete-${suffix}-implement`,
          correlationId: `correlation-complete-${suffix}-implement`,
          actor: { type: "SYSTEM", id: "codex-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            dispatchId: dispatch.id,
            provider: "CODEX",
            template: correctionWorkflowTemplate,
            outcome: { type: "COMPLETED", summary: "Implementation completed." },
            resultTree: implementationTree,
          },
        }),
      ).toMatchObject({ type: "MOCK_PROVIDER_OUTCOME_APPLIED", stageAttempt: { status: "SUCCEEDED" } });
    };
    const completeReview = (suffix: string, reviewedTree: string): void => {
      const dispatch = startAgent(`${suffix}-review`, "CLAUDE_CODE");
      expect(
        fixture.localState.execute({
          schemaVersion: 1,
          commandId: `complete-${suffix}-review`,
          correlationId: `correlation-complete-${suffix}-review`,
          actor: { type: "SYSTEM", id: "claude-code-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            dispatchId: dispatch.id,
            provider: "CLAUDE_CODE",
            template: correctionWorkflowTemplate,
            outcome: {
              type: "COMPLETED",
              summary: "Independent review passed.",
              artifacts: [
                {
                  kind: "REVIEW_REPORT",
                  title: "Independent review",
                  summary: "The implementation is ready for measured checks.",
                  checks: ["Reviewed the exact implementation tree."],
                },
              ],
              reviewReport: {
                kind: "REVIEW_REPORT",
                title: "Independent review",
                summary: "The implementation is ready for measured checks.",
                checks: ["Reviewed the exact implementation tree."],
                verdict: "PASSED",
                findings: [],
              },
            },
            resultTree: reviewedTree,
          },
        }),
      ).toMatchObject({ type: "MOCK_PROVIDER_OUTCOME_APPLIED", stageAttempt: { status: "SUCCEEDED" } });
    };
    const currentWorkItem = () => {
      const result = fixture.localState.query({ type: "GET_WORK_ITEM", workItemId: fixture.workItemId });
      if (result.type !== "WORK_ITEM" || result.workItem === null) throw new Error("Expected WorkItem");
      return result.workItem;
    };

    completeImplementation("initial", tree);
    completeReview("initial", tree);
    const initialQA = nextDispatch();
    const beforeFailure = currentWorkItem();
    expect(beforeFailure.currentStage).toBe("QA");
    const reservedSource = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "reserve-reviewed-source-run",
      correlationId: "correlation-reserve-reviewed-source-run",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_VERIFICATION_RUN",
      payload: {
        workItemId: fixture.workItemId,
        expectedWorkItemVersion: beforeFailure.version,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
        implementationTree: tree,
        platform: "darwin",
      },
    });
    if (reservedSource.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected source Run");
    expect(reservedSource.run.verificationCorrectionRunId).toBeNull();
    const sourceCheck = reservedSource.checks[0];
    if (sourceCheck === undefined) throw new Error("Expected source Check");
    const startedSource = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-reviewed-source-check",
      correlationId: "correlation-start-reviewed-source-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "START_VERIFICATION_CHECK",
      payload: {
        runId: reservedSource.run.id,
        checkId: sourceCheck.id,
        expectedRunVersion: reservedSource.run.version,
        expectedCheckVersion: sourceCheck.version,
      },
    });
    if (startedSource.type !== "VERIFICATION_CHECK_STARTED") throw new Error("Expected source Check start");
    const failedSource = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "fail-reviewed-source-check",
      correlationId: "correlation-fail-reviewed-source-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "COMPLETE_VERIFICATION_CHECK",
      payload: {
        runId: startedSource.run.id,
        checkId: startedSource.check.id,
        expectedRunVersion: startedSource.run.version,
        expectedCheckVersion: startedSource.check.version,
        observation: {
          status: "FAILED",
          completedAt: timestamp,
          durationMs: 1,
          exitCode: 1,
          signal: null,
          output: {
            schemaVersion: 1,
            artifactId: "reviewed-source-output",
            sha256: "e".repeat(64),
            capturedBytes: 1,
            stdoutBytes: 0,
            stderrBytes: 1,
            truncated: false,
            available: true,
          },
        },
        outputStorageKey: "reviewed-source-output.txt",
      },
    });
    if (failedSource.type !== "VERIFICATION_CHECK_COMPLETED") throw new Error("Expected source failure");
    expect(initialQA.status).toBe("PENDING");
    const activeCorrections = fixture.localState.query({
      type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
      workItemId: fixture.workItemId,
    });
    if (activeCorrections.type !== "VERIFICATION_CORRECTIONS") throw new Error("Expected corrections");
    const activeCorrection = activeCorrections.correctionRuns[0];
    if (activeCorrection === undefined) throw new Error("Expected active correction");

    const fixedTree = "f".repeat(40);
    completeImplementation("correction", fixedTree);
    completeReview("correction", fixedTree);
    const correctionQA = nextDispatch();
    const correctionSnapshot = fixture.localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (correctionSnapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
    expect(
      correctionSnapshot.snapshot.stageAttempts.find(({ id }) => id === correctionQA.stageAttemptId),
    ).toMatchObject({ stage: "QA", verificationCorrectionRunId: activeCorrection.id, status: "QUEUED" });
    const beforeFirstRerun = currentWorkItem();
    const reservedFirstRerun = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "reserve-first-correction-rerun",
      correlationId: "correlation-reserve-first-correction-rerun",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RETRY_VERIFICATION_RUN",
      payload: {
        workItemId: fixture.workItemId,
        expectedWorkItemVersion: beforeFirstRerun.version,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
        implementationTree: fixedTree,
        platform: "darwin",
        retryOfRunId: failedSource.run.id,
        expectedRetryOfRunVersion: failedSource.run.version,
      },
    });
    if (reservedFirstRerun.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected first rerun");
    expect(reservedFirstRerun.run).toMatchObject({
      retryOfRunId: failedSource.run.id,
      verificationCorrectionRunId: activeCorrection.id,
      implementationTree: fixedTree,
    });
    const firstRerunCheck = reservedFirstRerun.checks[0];
    if (firstRerunCheck === undefined) throw new Error("Expected first rerun Check");
    const startedFirstRerun = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-first-correction-rerun",
      correlationId: "correlation-start-first-correction-rerun",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "START_VERIFICATION_CHECK",
      payload: {
        runId: reservedFirstRerun.run.id,
        checkId: firstRerunCheck.id,
        expectedRunVersion: reservedFirstRerun.run.version,
        expectedCheckVersion: firstRerunCheck.version,
      },
    });
    if (startedFirstRerun.type !== "VERIFICATION_CHECK_STARTED") {
      throw new Error("Expected first rerun Check start");
    }
    const failFirstRerunCommand = {
      schemaVersion: 1,
      commandId: "fail-first-correction-rerun",
      correlationId: "correlation-fail-first-correction-rerun",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "COMPLETE_VERIFICATION_CHECK",
      payload: {
        runId: startedFirstRerun.run.id,
        checkId: startedFirstRerun.check.id,
        expectedRunVersion: startedFirstRerun.run.version,
        expectedCheckVersion: startedFirstRerun.check.version,
        observation: {
          status: "FAILED",
          completedAt: timestamp,
          durationMs: 1,
          exitCode: 1,
          signal: null,
          output: {
            schemaVersion: 1,
            artifactId: "failed-first-correction-output",
            sha256: "1".repeat(64),
            capturedBytes: 1,
            stdoutBytes: 0,
            stderrBytes: 1,
            truncated: false,
            available: true,
          },
        },
        outputStorageKey: "failed-first-correction-output.txt",
      },
    } as const;
    const failedFirstRerun = fixture.localState.execute(failFirstRerunCommand);
    if (failedFirstRerun.type !== "VERIFICATION_CHECK_COMPLETED") {
      throw new Error("Expected failed first correction rerun");
    }
    expect(fixture.localState.execute(failFirstRerunCommand)).toMatchObject({ replayed: true });
    const repeatedCorrections = fixture.localState.query({
      type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
      workItemId: fixture.workItemId,
    });
    if (repeatedCorrections.type !== "VERIFICATION_CORRECTIONS") throw new Error("Expected corrections");
    const secondCorrection = repeatedCorrections.correctionRuns[0];
    if (secondCorrection === undefined) throw new Error("Expected second correction");
    expect(repeatedCorrections.correctionRuns).toMatchObject([
      { id: secondCorrection.id, budgetPosition: 2, automatic: true, status: "ACTIVE", version: 1 },
      { id: activeCorrection.id, budgetPosition: 1, status: "SUPERSEDED", version: 2 },
    ]);

    const secondTree = "9".repeat(40);
    completeImplementation("second-correction", secondTree);
    completeReview("second-correction", secondTree);
    const secondCorrectionQA = nextDispatch();
    const secondCorrectionSnapshot = fixture.localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (secondCorrectionSnapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
    expect(
      secondCorrectionSnapshot.snapshot.stageAttempts.find(
        ({ id }) => id === secondCorrectionQA.stageAttemptId,
      ),
    ).toMatchObject({
      stage: "QA",
      verificationCorrectionRunId: secondCorrection.id,
      status: "QUEUED",
    });
    const beforeSecondRerun = currentWorkItem();
    const reservedSecondRerun = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "reserve-second-correction-rerun",
      correlationId: "correlation-reserve-second-correction-rerun",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RETRY_VERIFICATION_RUN",
      payload: {
        workItemId: fixture.workItemId,
        expectedWorkItemVersion: beforeSecondRerun.version,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
        implementationTree: secondTree,
        platform: "darwin",
        retryOfRunId: failedFirstRerun.run.id,
        expectedRetryOfRunVersion: failedFirstRerun.run.version,
      },
    });
    if (reservedSecondRerun.type !== "VERIFICATION_RUN_RESERVED") {
      throw new Error("Expected second correction rerun");
    }
    expect(reservedSecondRerun.run).toMatchObject({
      retryOfRunId: failedFirstRerun.run.id,
      verificationCorrectionRunId: secondCorrection.id,
      implementationTree: secondTree,
    });
    const secondRerunCheck = reservedSecondRerun.checks[0];
    if (secondRerunCheck === undefined) throw new Error("Expected second rerun Check");
    const startedSecondRerun = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-second-correction-check",
      correlationId: "correlation-start-second-correction-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "START_VERIFICATION_CHECK",
      payload: {
        runId: reservedSecondRerun.run.id,
        checkId: secondRerunCheck.id,
        expectedRunVersion: reservedSecondRerun.run.version,
        expectedCheckVersion: secondRerunCheck.version,
      },
    });
    if (startedSecondRerun.type !== "VERIFICATION_CHECK_STARTED") {
      throw new Error("Expected second rerun Check start");
    }
    const failSecondRerunCommand = {
      schemaVersion: 1,
      commandId: "fail-second-correction-check",
      correlationId: "correlation-fail-second-correction-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "COMPLETE_VERIFICATION_CHECK",
      payload: {
        runId: startedSecondRerun.run.id,
        checkId: startedSecondRerun.check.id,
        expectedRunVersion: startedSecondRerun.run.version,
        expectedCheckVersion: startedSecondRerun.check.version,
        observation: {
          status: "FAILED",
          completedAt: timestamp,
          durationMs: 1,
          exitCode: 1,
          signal: null,
          output: {
            schemaVersion: 1,
            artifactId: "failed-second-correction-output",
            sha256: "2".repeat(64),
            capturedBytes: 1,
            stdoutBytes: 0,
            stderrBytes: 1,
            truncated: false,
            available: true,
          },
        },
        outputStorageKey: "failed-second-correction-output.txt",
      },
    } as const;
    const failedSecondRerun = fixture.localState.execute(failSecondRerunCommand);
    expect(failedSecondRerun).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      replayed: false,
      run: { status: "FAILED", verificationCorrectionRunId: secondCorrection.id },
    });
    if (failedSecondRerun.type !== "VERIFICATION_CHECK_COMPLETED") {
      throw new Error("Expected failed second correction rerun");
    }
    expect(fixture.localState.execute(failSecondRerunCommand)).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      replayed: true,
    });
    const exhaustedWorkflow = fixture.localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (exhaustedWorkflow.type !== "WORKFLOW_SNAPSHOT" || exhaustedWorkflow.snapshot.run === null) {
      throw new Error("Expected exhausted correction workflow");
    }
    const ownerRequest = exhaustedWorkflow.snapshot.humanRequests.find(({ status }) => status === "OPEN");
    if (ownerRequest === undefined) throw new Error("Expected Project verification owner request");
    expect(exhaustedWorkflow.snapshot.run).toMatchObject({ status: "WAITING_HUMAN" });
    expect(currentWorkItem()).toMatchObject({ state: "BLOCKED", currentStage: "QA" });
    const exhaustedCorrections = fixture.localState.query({
      type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
      workItemId: fixture.workItemId,
    });
    if (exhaustedCorrections.type !== "VERIFICATION_CORRECTIONS") throw new Error("Expected corrections");
    const exhaustedSecondCorrection = exhaustedCorrections.correctionRuns[0];
    if (exhaustedSecondCorrection === undefined) throw new Error("Expected exhausted correction");
    expect(exhaustedSecondCorrection).toMatchObject({
      id: secondCorrection.id,
      budgetPosition: 2,
      status: "EXHAUSTED",
      version: 2,
    });
    const authorizeFinalCommand = {
      schemaVersion: 1,
      commandId: "authorize-final-verification-correction",
      correlationId: "correlation-authorize-final-verification-correction",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RESOLVE_VERIFICATION_CORRECTION_GATE",
      payload: {
        humanRequestId: ownerRequest.id,
        expectedRequestVersion: ownerRequest.version,
        correctionRunId: exhaustedSecondCorrection.id,
        expectedCorrectionVersion: exhaustedSecondCorrection.version,
        expectedPipelineRunVersion: exhaustedWorkflow.snapshot.run.version,
        action: "AUTHORIZE_FINAL",
      },
    } as const;
    const authorized = fixture.localState.execute(authorizeFinalCommand);
    if (authorized.type !== "VERIFICATION_CORRECTION_GATE_RESOLVED" || authorized.correctionRun === null) {
      throw new Error("Expected final correction authorization");
    }
    const finalCorrection = authorized.correctionRun;
    expect(authorized).toMatchObject({
      replayed: false,
      action: "AUTHORIZE_FINAL",
      request: { status: "RESOLVED" },
      previousCorrection: { id: secondCorrection.id, status: "SUPERSEDED", version: 3 },
      correctionRun: { budgetPosition: 3, automatic: false, status: "ACTIVE" },
      run: { status: "RUNNING" },
      stageAttempt: { status: "SUCCEEDED", failureCode: null },
      dispatch: { status: "PENDING" },
    });
    expect(fixture.localState.execute(authorizeFinalCommand)).toMatchObject({ replayed: true });

    const finalTree = "8".repeat(40);
    completeImplementation("final-correction", finalTree);
    completeReview("final-correction", finalTree);
    const finalCorrectionQA = nextDispatch();
    const finalCorrectionSnapshot = fixture.localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: fixture.workItemId,
    });
    if (finalCorrectionSnapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
    expect(
      finalCorrectionSnapshot.snapshot.stageAttempts.find(
        ({ id }) => id === finalCorrectionQA.stageAttemptId,
      ),
    ).toMatchObject({
      stage: "QA",
      verificationCorrectionRunId: finalCorrection.id,
      status: "QUEUED",
    });
    const beforePassingRerun = currentWorkItem();
    const reservedPassing = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "reserve-passing-final-correction-run",
      correlationId: "correlation-reserve-passing-final-correction-run",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RETRY_VERIFICATION_RUN",
      payload: {
        workItemId: fixture.workItemId,
        expectedWorkItemVersion: beforePassingRerun.version,
        expectedPlanRevision: fixture.planRevision,
        expectedPlanContentHash: fixture.planContentHash,
        implementationTree: finalTree,
        platform: "darwin",
        retryOfRunId: failedSecondRerun.run.id,
        expectedRetryOfRunVersion: failedSecondRerun.run.version,
      },
    });
    if (reservedPassing.type !== "VERIFICATION_RUN_RESERVED") throw new Error("Expected passing Run");
    expect(reservedPassing.run).toMatchObject({
      retryOfRunId: failedSecondRerun.run.id,
      verificationCorrectionRunId: finalCorrection.id,
      implementationTree: finalTree,
    });
    const passingCheck = reservedPassing.checks[0];
    if (passingCheck === undefined) throw new Error("Expected passing Check");
    const startedPassing = fixture.localState.execute({
      schemaVersion: 1,
      commandId: "start-passing-final-correction-check",
      correlationId: "correlation-start-passing-final-correction-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "START_VERIFICATION_CHECK",
      payload: {
        runId: reservedPassing.run.id,
        checkId: passingCheck.id,
        expectedRunVersion: reservedPassing.run.version,
        expectedCheckVersion: passingCheck.version,
      },
    });
    if (startedPassing.type !== "VERIFICATION_CHECK_STARTED") throw new Error("Expected passing Check start");
    const passingCommand = {
      schemaVersion: 1,
      commandId: "pass-final-correction-check",
      correlationId: "correlation-pass-final-correction-check",
      actor: { type: "SYSTEM", id: "verification-runner" },
      type: "COMPLETE_VERIFICATION_CHECK",
      payload: {
        runId: startedPassing.run.id,
        checkId: startedPassing.check.id,
        expectedRunVersion: startedPassing.run.version,
        expectedCheckVersion: startedPassing.check.version,
        observation: {
          status: "PASSED",
          completedAt: timestamp,
          durationMs: 1,
          exitCode: 0,
          signal: null,
          output: {
            schemaVersion: 1,
            artifactId: "passing-final-correction-output",
            sha256: "f".repeat(64),
            capturedBytes: 1,
            stdoutBytes: 1,
            stderrBytes: 0,
            truncated: false,
            available: true,
          },
        },
        outputStorageKey: "passing-final-correction-output.txt",
      },
    } as const;
    expect(fixture.localState.execute(passingCommand)).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      replayed: false,
      run: { status: "PASSED", verificationCorrectionRunId: finalCorrection.id },
    });
    expect(fixture.localState.execute(passingCommand)).toMatchObject({
      type: "VERIFICATION_CHECK_COMPLETED",
      replayed: true,
    });
    expect(
      fixture.localState.query({
        type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({
      correctionRuns: [
        { id: finalCorrection.id, budgetPosition: 3, status: "PASSED", completedAt: timestamp, version: 2 },
        { id: secondCorrection.id, status: "SUPERSEDED", completedAt: timestamp, version: 3 },
        { id: activeCorrection.id, status: "SUPERSEDED", completedAt: timestamp, version: 2 },
      ],
    });
    const events = fixture.localState.query({
      type: "LIST_EVENTS",
      aggregateId: fixture.workItemId,
      direction: "ASC",
      limit: 200,
    });
    if (events.type !== "EVENTS") throw new Error("Expected Events");
    expect(events.events.filter(({ type }) => type === "VERIFICATION_CORRECTION_PASSED")).toHaveLength(1);
    expect(events.events.filter(({ type }) => type === "VERIFICATION_CORRECTION_SUPERSEDED")).toHaveLength(2);
    expect(events.events.filter(({ type }) => type === "VERIFICATION_CORRECTION_STARTED")).toHaveLength(3);
    expect(events.events.filter(({ type }) => type === "VERIFICATION_CORRECTION_EXHAUSTED")).toHaveLength(1);
    expect(events.events.filter(({ type }) => type === "HUMAN_REQUEST_RESOLVED")).toHaveLength(1);

    fixture.localState.close();
    state = undefined;
    const reopened = await open();
    expect(
      reopened.query({
        type: "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS",
        workItemId: fixture.workItemId,
      }),
    ).toMatchObject({
      correctionRuns: [
        { id: finalCorrection.id, budgetPosition: 3, status: "PASSED", completedAt: timestamp, version: 2 },
        { id: secondCorrection.id, status: "SUPERSEDED", completedAt: timestamp, version: 3 },
        { id: activeCorrection.id, status: "SUPERSEDED", completedAt: timestamp, version: 2 },
      ],
    });
    const reopenedEvents = reopened.query({
      type: "LIST_EVENTS",
      aggregateId: fixture.workItemId,
      direction: "ASC",
      limit: 200,
    });
    if (reopenedEvents.type !== "EVENTS") throw new Error("Expected reopened Events");
    expect(
      reopenedEvents.events.filter(({ type }) => type === "VERIFICATION_CORRECTION_PASSED"),
    ).toHaveLength(1);
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
