import type {
  Actor,
  PipelineRun,
  Project,
  VerificationCheck,
  VerificationCheckObservation,
  VerificationPlan,
  VerificationPlanPublication,
  VerificationRun,
  WorkItem,
  WorkItemWorkspace,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideVerificationCheckCompletion,
  decideVerificationCheckStart,
  decideVerificationRunReservation,
  decideVerificationRunInterruption,
  projectVerificationAcceptanceGate,
  projectVerificationRunFreshness,
} from "../src/verification.js";

const now = "2026-09-05T10:00:00.000Z";
const system: Actor = { type: "SYSTEM", id: "verification-runner" };
const run: VerificationRun = {
  schemaVersion: 1,
  id: "verification-run-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "pipeline-run-1",
  workspaceId: "workspace-1",
  planId: "verification-plan-1",
  planRevision: 1,
  planContentHash: "a".repeat(64),
  implementationTree: "b".repeat(40),
  ordinal: 1,
  retryOfRunId: null,
  platform: "darwin",
  status: "QUEUED",
  currentCheckId: null,
  terminalReason: null,
  startedAt: null,
  completedAt: null,
  createdAt: now,
  version: 1,
};
const requiredCheck: VerificationCheck = {
  schemaVersion: 1,
  id: "verification-check-required",
  projectId: run.projectId,
  workItemId: run.workItemId,
  runId: run.id,
  recipeId: "package-test",
  ordinal: 1,
  required: true,
  status: "QUEUED",
  startedAt: null,
  completedAt: null,
  durationMs: null,
  exitCode: null,
  signal: null,
  errorCode: null,
  output: null,
  version: 1,
};
const optionalCheck: VerificationCheck = {
  ...requiredCheck,
  id: "verification-check-optional",
  recipeId: "package-lint",
  ordinal: 2,
  required: false,
};
const checks: VerificationCheck[] = [requiredCheck, optionalCheck];
const project: Project = {
  schemaVersion: 1,
  id: run.projectId,
  workspaceId: "workspace-default",
  fixtureId: null,
  name: "Project one",
  repositoryPath: "/tmp/project-one",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const workItem: WorkItem = {
  schemaVersion: 1,
  id: run.workItemId,
  projectId: project.id,
  parentId: null,
  type: "TASK",
  title: "Verify this",
  description: "",
  state: "IN_PROGRESS",
  currentStage: "REVIEW",
  priority: "MEDIUM",
  risk: "LOW",
  acceptanceCriteria: [],
  version: 3,
  createdAt: now,
  updatedAt: now,
};
const pipelineRun: PipelineRun = {
  schemaVersion: 1,
  id: run.pipelineRunId,
  projectId: project.id,
  workItemId: workItem.id,
  workflowTemplateId: "delivery-v1",
  workflowVersion: 1,
  status: "RUNNING",
  currentStageAttemptId: "stage-review-1",
  version: 2,
  createdAt: now,
  updatedAt: now,
  finishedAt: null,
};
const workspace: WorkItemWorkspace = {
  schemaVersion: 1,
  id: run.workspaceId,
  projectId: project.id,
  workItemId: workItem.id,
  branch: "loomrail/work-item-1",
  worktreePath: "/tmp/worktree-one",
  baseCommit: null,
  snapshotCommit: null,
  status: "READY",
  leaseHolder: null,
  createdAt: now,
  version: 1,
};

const output = {
  schemaVersion: 1 as const,
  artifactId: "verification-output-1",
  sha256: "c".repeat(64),
  capturedBytes: 4,
  stdoutBytes: 4,
  stderrBytes: 0,
  truncated: false,
  available: true,
};

const observation = (status: "PASSED" | "FAILED" | "ERROR"): VerificationCheckObservation => {
  if (status === "PASSED") {
    return {
      status,
      completedAt: "2026-09-05T10:00:01.000Z",
      durationMs: 1_000,
      exitCode: 0,
      signal: null,
      output,
    };
  }
  if (status === "FAILED") {
    return {
      status,
      completedAt: "2026-09-05T10:00:01.000Z",
      durationMs: 1_000,
      exitCode: 1,
      signal: null,
      output,
    };
  }
  return {
    status,
    completedAt: "2026-09-05T10:00:01.000Z",
    durationMs: 1_000,
    exitCode: null,
    signal: null,
    errorCode: "TIMED_OUT",
    output,
  };
};

describe("verification Run lifecycle", () => {
  it("reserves one ordered Check per approved recipe and rejects a live writer", () => {
    const plan: VerificationPlan = {
      schemaVersion: 1,
      id: run.planId,
      projectId: project.id,
      revision: 1,
      status: "ACTIVE",
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
            manifestContentHash: "f".repeat(64),
            scriptName: "test",
            scriptBodyPreview: "vitest run",
          },
        },
      ],
      sourceProposalHash: "d".repeat(64),
      contentHash: run.planContentHash,
      createdAt: now,
    };
    const publication: VerificationPlanPublication = {
      schemaVersion: 1,
      id: "verification-publication-1",
      projectId: project.id,
      planId: plan.id,
      targetPath: ".loomrail/verification-plan.json",
      expectedTargetDigest: null,
      contentHash: plan.contentHash,
      status: "APPLIED",
      attempts: 1,
      lastErrorCode: null,
      version: 2,
      createdAt: now,
      updatedAt: now,
      appliedAt: now,
    };
    const command = {
      schemaVersion: 1 as const,
      commandId: "start-verification",
      correlationId: "correlation-start-verification",
      actor: { type: "HUMAN" as const, id: "local-owner" },
      type: "START_VERIFICATION_RUN" as const,
      payload: {
        workItemId: workItem.id,
        expectedWorkItemVersion: workItem.version,
        expectedPlanRevision: plan.revision,
        expectedPlanContentHash: plan.contentHash,
        implementationTree: run.implementationTree,
        platform: "darwin" as const,
      },
    };
    const context = {
      now,
      newRunId: run.id,
      newCheckIds: [requiredCheck.id],
      ordinal: 1,
      project,
      workItem,
      pipelineRun,
      workspace,
      plan,
      publication,
    };

    expect(decideVerificationRunReservation(command, context)).toMatchObject({
      run: { status: "QUEUED", planContentHash: plan.contentHash },
      checks: [{ recipeId: "package-test", status: "QUEUED" }],
      event: { type: "VERIFICATION_RUN_RESERVED" },
    });
    expect(
      decideVerificationRunReservation(
        {
          ...command,
          actor: { type: "SYSTEM", id: "verification-workflow" },
        },
        {
          ...context,
          workItem: { ...workItem, currentStage: "QA" },
        },
      ),
    ).toMatchObject({
      run: { status: "QUEUED", planContentHash: plan.contentHash },
      checks: [{ recipeId: "package-test", status: "QUEUED" }],
    });
    expect(() =>
      decideVerificationRunReservation(
        {
          ...command,
          actor: { type: "SYSTEM", id: "local-daemon" },
        },
        {
          ...context,
          workItem: { ...workItem, currentStage: "QA" },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
    expect(() =>
      decideVerificationRunReservation(
        {
          ...command,
          actor: { type: "SYSTEM", id: "verification-workflow" },
        },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
    expect(() =>
      decideVerificationRunReservation(
        {
          ...command,
          actor: { type: "SYSTEM", id: "verification-workflow" },
          type: "RETRY_VERIFICATION_RUN",
          payload: {
            ...command.payload,
            retryOfRunId: run.id,
            expectedRetryOfRunVersion: run.version,
          },
        },
        {
          ...context,
          workItem: { ...workItem, currentStage: "QA" },
          retryOfRun: { ...run, status: "FAILED" },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
    expect(() =>
      decideVerificationRunReservation(command, {
        ...context,
        workspace: { ...workspace, leaseHolder: "stage-review-1" },
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_UNAVAILABLE" }));
  });

  it("starts only the next queued Check and records one current identity", () => {
    const decision = decideVerificationCheckStart({
      actor: system,
      run,
      check: requiredCheck,
      checks,
      expectedRunVersion: 1,
      expectedCheckVersion: 1,
      now,
    });

    expect(decision.run).toMatchObject({ status: "RUNNING", currentCheckId: requiredCheck.id, version: 2 });
    expect(decision.check).toMatchObject({ status: "RUNNING", startedAt: now, version: 2 });
  });

  it("passes a required Check, then continues to the optional Check", () => {
    const started = decideVerificationCheckStart({
      actor: system,
      run,
      check: requiredCheck,
      checks,
      expectedRunVersion: 1,
      expectedCheckVersion: 1,
      now,
    });
    const decision = decideVerificationCheckCompletion({
      actor: system,
      run: started.run,
      check: started.check,
      checks: [started.check, optionalCheck],
      expectedRunVersion: 2,
      expectedCheckVersion: 2,
      observation: observation("PASSED"),
    });

    expect(decision.check.status).toBe("PASSED");
    expect(decision.run).toMatchObject({ status: "RUNNING", currentCheckId: null, version: 3 });
    expect(decision.next).toBe("START_NEXT_CHECK");
  });

  it.each([
    ["FAILED", "FAILED", "REQUIRED_CHECK_FAILED"],
    ["ERROR", "ERROR", "REQUIRED_CHECK_ERROR"],
  ] as const)("makes a required %s terminal for the Run", (checkStatus, runStatus, terminalReason) => {
    const started = decideVerificationCheckStart({
      actor: system,
      run,
      check: requiredCheck,
      checks,
      expectedRunVersion: 1,
      expectedCheckVersion: 1,
      now,
    });
    const decision = decideVerificationCheckCompletion({
      actor: system,
      run: started.run,
      check: started.check,
      checks: [started.check, optionalCheck],
      expectedRunVersion: 2,
      expectedCheckVersion: 2,
      observation: observation(checkStatus),
    });

    expect(decision.run).toMatchObject({ status: runStatus, terminalReason });
    expect(decision.next).toBe("TERMINAL");
  });

  it("keeps an optional failure advisory and passes after all required Checks passed", () => {
    const requiredPassed: VerificationCheck = {
      ...requiredCheck,
      status: "PASSED",
      startedAt: now,
      completedAt: "2026-09-05T10:00:01.000Z",
      durationMs: 1_000,
      exitCode: 0,
      output,
      version: 3,
    };
    const runningOptional: VerificationCheck = {
      ...optionalCheck,
      status: "RUNNING",
      startedAt: "2026-09-05T10:00:01.000Z",
      version: 2,
    };
    const decision = decideVerificationCheckCompletion({
      actor: system,
      run: {
        ...run,
        status: "RUNNING",
        currentCheckId: runningOptional.id,
        startedAt: now,
        version: 4,
      },
      check: runningOptional,
      checks: [requiredPassed, runningOptional],
      expectedRunVersion: 4,
      expectedCheckVersion: 2,
      observation: observation("FAILED"),
    });

    expect(decision.run).toMatchObject({ status: "PASSED", terminalReason: "ALL_REQUIRED_PASSED" });
    expect(decision.next).toBe("TERMINAL");
  });

  it("rejects a human completion and out-of-order start", () => {
    expect(() =>
      decideVerificationCheckStart({
        actor: system,
        run,
        check: optionalCheck,
        checks,
        expectedRunVersion: 1,
        expectedCheckVersion: 1,
        now,
      }),
    ).toThrow(expect.objectContaining({ code: "CHECK_SEQUENCE_INVALID" }));
    expect(() =>
      decideVerificationCheckCompletion({
        actor: { type: "HUMAN", id: "local-owner" },
        run: { ...run, status: "RUNNING", currentCheckId: requiredCheck.id, startedAt: now, version: 2 },
        check: { ...requiredCheck, status: "RUNNING", startedAt: now, version: 2 },
        checks,
        expectedRunVersion: 2,
        expectedCheckVersion: 2,
        observation: observation("PASSED"),
      }),
    ).toThrow(expect.objectContaining({ code: "SYSTEM_REQUIRED" }));
  });

  it("lets the owner cancel a queued Run without inventing a start time", () => {
    const decision = decideVerificationRunInterruption({
      actor: { type: "HUMAN", id: "local-owner" },
      run,
      checks,
      expectedRunVersion: 1,
      reason: "OWNER_CANCELLED",
      now: "2026-09-05T10:00:02.000Z",
    });

    expect(decision.run).toMatchObject({
      status: "INTERRUPTED",
      terminalReason: "OWNER_CANCELLED",
      startedAt: null,
      completedAt: "2026-09-05T10:00:02.000Z",
      version: 2,
    });
    expect(decision.checks).toEqual(checks);
  });

  it("interrupts only the current Check during daemon restart", () => {
    const started = decideVerificationCheckStart({
      actor: system,
      run,
      check: requiredCheck,
      checks,
      expectedRunVersion: 1,
      expectedCheckVersion: 1,
      now,
    });
    const decision = decideVerificationRunInterruption({
      actor: system,
      run: started.run,
      checks: [started.check, optionalCheck],
      expectedRunVersion: 2,
      reason: "DAEMON_RESTART",
      now: "2026-09-05T10:00:02.000Z",
    });

    expect(decision.run).toMatchObject({
      status: "INTERRUPTED",
      terminalReason: "DAEMON_RESTART",
      currentCheckId: null,
    });
    expect(decision.checks[0]).toMatchObject({
      status: "INTERRUPTED",
      completedAt: "2026-09-05T10:00:02.000Z",
      durationMs: 2_000,
      version: 3,
    });
    expect(decision.checks[1]).toEqual(optionalCheck);
  });
});

describe("verification Run freshness", () => {
  const plan: VerificationPlan = {
    schemaVersion: 1,
    id: run.planId,
    projectId: run.projectId,
    revision: run.planRevision,
    status: "ACTIVE",
    recipes: [
      {
        schemaVersion: 1,
        id: requiredCheck.recipeId,
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
          manifestContentHash: "f".repeat(64),
          scriptName: "test",
          scriptBodyPreview: "vitest run",
        },
      },
    ],
    sourceProposalHash: "d".repeat(64),
    contentHash: run.planContentHash,
    createdAt: now,
  };
  const publication: VerificationPlanPublication = {
    schemaVersion: 1,
    id: "verification-publication-1",
    projectId: run.projectId,
    planId: plan.id,
    targetPath: ".loomrail/verification-plan.json",
    expectedTargetDigest: null,
    contentHash: plan.contentHash,
    status: "APPLIED",
    attempts: 1,
    lastErrorCode: null,
    version: 2,
    createdAt: now,
    updatedAt: now,
    appliedAt: now,
  };

  it("keeps current evidence only for the exact active published Plan and tree", () => {
    expect(
      projectVerificationRunFreshness(run, {
        currentPlan: plan,
        publication,
        currentTree: run.implementationTree,
      }),
    ).toEqual({ freshness: "CURRENT", staleReasons: [] });
  });

  it("reports every independent stale reason without rewriting history", () => {
    expect(
      projectVerificationRunFreshness(run, {
        currentPlan: { ...plan, revision: 2, contentHash: "e".repeat(64) },
        publication: { ...publication, status: "FAILED", appliedAt: null },
        currentTree: "f".repeat(40),
      }),
    ).toEqual({
      freshness: "STALE",
      staleReasons: ["PLAN_REPLACED", "PLAN_UNPUBLISHED", "TREE_CHANGED"],
    });
  });
});

describe("verification Acceptance gate", () => {
  const plan: VerificationPlan = {
    schemaVersion: 1,
    id: run.planId,
    projectId: run.projectId,
    revision: run.planRevision,
    status: "ACTIVE",
    recipes: [
      {
        schemaVersion: 1,
        id: requiredCheck.recipeId,
        kind: "UNIT",
        label: "Unit tests",
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
          manifestContentHash: "f".repeat(64),
          scriptName: "test",
          scriptBodyPreview: "vitest run",
        },
      },
      {
        schemaVersion: 1,
        id: optionalCheck.recipeId,
        kind: "LINT",
        label: "Lint",
        required: false,
        executable: "pnpm",
        argv: ["run", "lint"],
        cwd: ".",
        timeoutSeconds: 300,
        outputLimitBytes: 65_536,
        environmentProfile: "VERIFICATION_BASELINE",
        networkPolicy: "INHERIT_HOST",
        provenance: {
          source: "PACKAGE_JSON_SCRIPT",
          manifestPath: "package.json",
          manifestContentHash: "f".repeat(64),
          scriptName: "lint",
          scriptBodyPreview: "eslint .",
        },
      },
    ],
    sourceProposalHash: "d".repeat(64),
    contentHash: run.planContentHash,
    createdAt: now,
  };
  const publication: VerificationPlanPublication = {
    schemaVersion: 1,
    id: "verification-publication-1",
    projectId: run.projectId,
    planId: plan.id,
    targetPath: ".loomrail/verification-plan.json",
    expectedTargetDigest: null,
    contentHash: plan.contentHash,
    status: "APPLIED",
    attempts: 1,
    lastErrorCode: null,
    version: 2,
    createdAt: now,
    updatedAt: now,
    appliedAt: now,
  };
  const passedRun: VerificationRun = {
    ...run,
    status: "PASSED",
    terminalReason: "ALL_REQUIRED_PASSED",
    startedAt: now,
    completedAt: "2026-09-05T10:00:02.000Z",
    version: 4,
  };
  const passedRequired: VerificationCheck = {
    ...requiredCheck,
    status: "PASSED",
    startedAt: now,
    completedAt: "2026-09-05T10:00:01.000Z",
    durationMs: 1_000,
    exitCode: 0,
    output,
    version: 3,
  };
  const failedOptional: VerificationCheck = {
    ...optionalCheck,
    status: "FAILED",
    startedAt: now,
    completedAt: "2026-09-05T10:00:02.000Z",
    durationMs: 1_000,
    exitCode: 1,
    output,
    version: 3,
  };

  it("allows legacy Projects without an active Plan", () => {
    expect(
      projectVerificationAcceptanceGate({
        projectId: run.projectId,
        workItemId: run.workItemId,
        pipelineRunId: run.pipelineRunId,
        currentPlan: undefined,
        publication: undefined,
        latestRun: undefined,
        checks: [],
        currentTree: run.implementationTree,
      }),
    ).toEqual({ status: "NOT_CONFIGURED", evidence: null, blocker: null });
  });

  it("binds safe current-tree evidence while keeping an optional failure advisory", () => {
    expect(
      projectVerificationAcceptanceGate({
        projectId: run.projectId,
        workItemId: run.workItemId,
        pipelineRunId: run.pipelineRunId,
        currentPlan: plan,
        publication,
        latestRun: passedRun,
        checks: [passedRequired, failedOptional],
        currentTree: run.implementationTree,
      }),
    ).toEqual({
      status: "READY",
      blocker: null,
      evidence: {
        schemaVersion: 1,
        projectId: run.projectId,
        workItemId: run.workItemId,
        pipelineRunId: run.pipelineRunId,
        verificationRunId: run.id,
        planId: plan.id,
        planRevision: plan.revision,
        planContentHash: plan.contentHash,
        implementationTree: run.implementationTree,
        platform: run.platform,
        requiredCheckIds: [requiredCheck.id],
        optionalFailedCheckIds: [optionalCheck.id],
        completedAt: passedRun.completedAt,
      },
    });
  });

  it.each([
    ["missing Run", undefined, [] as VerificationCheck[], "RUN_MISSING"],
    [
      "failed required Check",
      { ...passedRun, status: "FAILED", terminalReason: "REQUIRED_CHECK_FAILED" },
      [{ ...passedRequired, status: "FAILED", exitCode: 1 }, failedOptional],
      "RUN_FAILED",
    ],
    [
      "errored required Check",
      { ...passedRun, status: "ERROR", terminalReason: "REQUIRED_CHECK_ERROR" },
      [
        {
          ...passedRequired,
          status: "ERROR",
          exitCode: null,
          errorCode: "TIMED_OUT",
        },
        failedOptional,
      ],
      "RUN_ERROR",
    ],
    [
      "interrupted Run",
      {
        ...passedRun,
        status: "INTERRUPTED",
        terminalReason: "OWNER_CANCELLED",
      },
      [passedRequired, failedOptional],
      "RUN_INTERRUPTED",
    ],
    [
      "foreign PipelineRun",
      { ...passedRun, pipelineRunId: "pipeline-run-foreign" },
      [passedRequired, failedOptional],
      "LINEAGE_MISMATCH",
    ],
    [
      "stale tree",
      { ...passedRun, implementationTree: "e".repeat(40) },
      [passedRequired, failedOptional],
      "STALE",
    ],
  ] as const)("blocks Acceptance for %s", (_label, latestRun, gateChecks, blocker) => {
    expect(
      projectVerificationAcceptanceGate({
        projectId: run.projectId,
        workItemId: run.workItemId,
        pipelineRunId: run.pipelineRunId,
        currentPlan: plan,
        publication,
        latestRun,
        checks: gateChecks,
        currentTree: run.implementationTree,
      }),
    ).toEqual({ status: "BLOCKED", evidence: null, blocker });
  });
});
