import type {
  ApplyProviderOutcomeCommand,
  BudgetPolicy,
  PipelineRun,
  StageAttempt,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideApplyProviderOutcome,
  decideApproveBudgetOverride,
  decidePausePipeline,
  decideRecoverInterruptedWorkflow,
  decideResumePipeline,
} from "../src/index.js";

const now = "2026-08-24T12:00:00.000Z";
const template: ApplyProviderOutcomeCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "DISCOVERY", ordinal: 0 },
    { stage: "PLAN", ordinal: 1 },
    { stage: "IMPLEMENT", ordinal: 2 },
  ],
};
const workItem: WorkItem = {
  schemaVersion: 1,
  id: "work-item-1",
  projectId: "project-1",
  parentId: null,
  type: "TASK",
  title: "Exercise M5 controls",
  description: "Synthetic fixture",
  state: "IN_PROGRESS",
  currentStage: "IMPLEMENT",
  priority: "MEDIUM",
  risk: "LOW",
  acceptanceCriteria: [],
  version: 5,
  createdAt: now,
  updatedAt: now,
};
const run: PipelineRun = {
  schemaVersion: 1,
  id: "run-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  workflowTemplateId: template.id,
  workflowVersion: template.version,
  status: "RUNNING",
  currentStageAttemptId: "attempt-1",
  version: 4,
  createdAt: now,
  updatedAt: now,
  finishedAt: null,
};
const stageAttempt: StageAttempt = {
  schemaVersion: 1,
  id: "attempt-1",
  pipelineRunId: run.id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  stage: "IMPLEMENT",
  attempt: 1,
  status: "RUNNING",
  version: 2,
  startedAt: now,
  finishedAt: null,
  failureCode: null,
};
const dispatch: WorkflowDispatch = {
  schemaVersion: 1,
  id: "dispatch-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: stageAttempt.id,
  mode: "START",
  status: "PENDING",
  createdAt: now,
  completedAt: null,
};
const budgetPolicy: BudgetPolicy = {
  schemaVersion: 1,
  id: "budget-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  revision: 1,
  maxEstimatedTokens: 100,
  warningThresholds: [0.5, 0.8, 0.95],
  createdBy: { type: "HUMAN", id: "local-owner" },
  createdAt: now,
};

describe("M5 workflow decisions", () => {
  it("records deterministic usage thresholds once and enters a hard pause", () => {
    const command: ApplyProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: "apply-budget",
      correlationId: "correlation-budget",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: dispatch.id,
        template,
        outcome: {
          type: "BUDGET_LIMIT_REACHED",
          usageIncrements: [50, 30, 15, 5],
          quality: "LOOMRAIL_ESTIMATE",
        },
      },
    };
    const decision = decideApplyProviderOutcome(command, {
      now,
      workItem,
      run,
      stageAttempt,
      dispatch,
      budgetPolicy,
      existingUsageRecords: [],
      usageRecordIds: ["usage-1", "usage-2", "usage-3", "usage-4"],
    });

    expect(decision.run.status).toBe("HARD_PAUSED");
    expect(decision.stageAttempt.status).toBe("HARD_PAUSED");
    expect(decision.usageRecords.map(({ amount }) => amount)).toEqual([50, 30, 15, 5]);
    expect(
      decision.events
        .filter(({ type }) => type === "BUDGET_THRESHOLD_REACHED")
        .map((event) => (event.type === "BUDGET_THRESHOLD_REACHED" ? event.data.threshold : null)),
    ).toEqual([0.5, 0.8, 0.95, 1]);
  });

  it("requires an immutable budget override before a hard-paused run can continue", () => {
    const hardRun = { ...run, status: "HARD_PAUSED" as const };
    const hardAttempt = { ...stageAttempt, status: "HARD_PAUSED" as const };
    expect(() =>
      decideResumePipeline(
        {
          schemaVersion: 1,
          commandId: "resume-hard",
          correlationId: "correlation-resume-hard",
          actor: { type: "HUMAN", id: "local-owner" },
          type: "RESUME_PIPELINE",
          payload: { pipelineRunId: hardRun.id, expectedVersion: hardRun.version },
        },
        {
          now,
          workItem: { ...workItem, state: "BLOCKED" },
          run: hardRun,
          stageAttempt: hardAttempt,
          dispatchId: "dispatch-2",
        },
      ),
    ).toThrow(expect.objectContaining({ code: "BUDGET_OVERRIDE_REQUIRED" }));

    const overridden = decideApproveBudgetOverride(
      {
        schemaVersion: 1,
        commandId: "override-budget",
        correlationId: "correlation-override-budget",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "APPROVE_BUDGET_OVERRIDE",
        payload: { pipelineRunId: hardRun.id, expectedVersion: hardRun.version, maxEstimatedTokens: 200 },
      },
      {
        now,
        workItem: { ...workItem, state: "BLOCKED" },
        run: hardRun,
        stageAttempt: hardAttempt,
        currentBudgetPolicy: budgetPolicy,
        cumulativeUsage: 100,
        ids: { budgetPolicyId: "budget-2", stageAttemptId: "attempt-2", dispatchId: "dispatch-2" },
      },
    );
    expect(overridden).toMatchObject({
      run: { status: "RUNNING", currentStageAttemptId: "attempt-2" },
      stageAttempt: { attempt: 2, status: "QUEUED" },
      budgetPolicy: { revision: 2, maxEstimatedTokens: 200 },
    });
  });

  it("supports soft pause and explicit recovery without auto-resuming", () => {
    const paused = decidePausePipeline(
      {
        schemaVersion: 1,
        commandId: "pause-run",
        correlationId: "correlation-pause-run",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "PAUSE_PIPELINE",
        payload: { pipelineRunId: run.id, expectedVersion: run.version },
      },
      { now, workItem, run, stageAttempt, pendingDispatch: dispatch },
    );
    expect(paused).toMatchObject({
      run: { status: "SOFT_PAUSED" },
      stageAttempt: { status: "SOFT_PAUSED" },
      previousDispatch: { status: "FAILED" },
    });

    const recovered = decideRecoverInterruptedWorkflow({
      now,
      workItem,
      run,
      stageAttempt,
      dispatch,
      recoveryReportId: "recovery-1",
    });
    expect(recovered).toMatchObject({
      run: { status: "INTERRUPTED" },
      stageAttempt: { status: "INTERRUPTED", failureCode: "DAEMON_RESTART" },
      dispatch: { status: "FAILED" },
      report: { reason: "DAEMON_RESTART" },
    });
  });
});
