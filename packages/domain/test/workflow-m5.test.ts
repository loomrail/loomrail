import type {
  ApplyProviderOutcomeCommand,
  AgentRun,
  BudgetPolicy,
  PipelineRun,
  ProviderSession,
  StageAttempt,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideApplyProviderOutcome,
  decideApproveBudgetOverride,
  decidePausePipeline,
  decideRecordProviderUsage,
  decideRecoverInterruptedWorkflow,
  decideResumePipeline,
} from "../src/index.js";

const now = "2026-08-24T12:00:00.000Z";
const contextPack: ApplyProviderOutcomeCommand["payload"]["template"]["stages"][number]["contextPack"] = {
  schemaVersion: 1,
  sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
};
const template: ApplyProviderOutcomeCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "DISCOVERY", ordinal: 0, contextPack },
    { stage: "PLAN", ordinal: 1, contextPack },
    { stage: "IMPLEMENT", ordinal: 2, contextPack },
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
  correctionRunId: null,
  stage: "IMPLEMENT",
  attempt: 1,
  status: "RUNNING",
  version: 2,
  startedAt: now,
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  packShareBackoffs: 0,
  resultTree: null,
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
const agentRun: AgentRun = {
  schemaVersion: 1,
  id: "agent-run-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: stageAttempt.id,
  ordinal: 1,
  squadAssignmentId: "squad-1",
  profile: { id: "builtin.developer", revision: 1, role: "DEVELOPER" },
  provider: "CODEX",
  status: "RUNNING",
  policySnapshot: {
    schemaVersion: 1,
    assignment: { id: "squad-1", revision: 1 },
    profile: { id: "builtin.developer", revision: 1, role: "DEVELOPER" },
    provider: "CODEX",
    effectiveCapabilities: ["REPOSITORY_READ", "REPOSITORY_WRITE"],
    modelTier: "STANDARD",
    claimLimits: { global: 3, project: 3, provider: 3 },
    budget: {
      pipelinePolicyId: budgetPolicy.id,
      pipelinePolicyRevision: budgetPolicy.revision,
      maxEstimatedTokens: 70,
      maxProviderSessions: 12,
    },
    workspace: { access: "READ_WRITE", networkAccess: false },
    mcpProfileRevisionIds: [],
  },
  policySnapshotHash: `sha256:${"a".repeat(64)}`,
  startedAt: now,
  finishedAt: null,
  version: 1,
};
const providerSession: ProviderSession = {
  schemaVersion: 1,
  id: "provider-session-1",
  agentRunId: agentRun.id,
  stageAttemptId: stageAttempt.id,
  ordinal: 1,
  status: "RUNNING",
  endReason: null,
  handoffRequestedAt: null,
  startedAt: now,
  endedAt: null,
  version: 1,
  pid: null,
};

describe("M5 workflow decisions", () => {
  it("records final provider usage and crosses each pipeline threshold once", () => {
    const decision = decideRecordProviderUsage({
      now,
      workItem,
      run,
      stageAttempt,
      dispatch,
      providerSession,
      agentRun,
      budgetPolicy,
      existingUsageRecords: [],
      existingAgentUsageTotal: 0,
      usage: {
        inputTokens: 40,
        outputTokens: 20,
        cachedInputTokens: 10,
        reasoningOutputTokens: 5,
        quality: "ACTUAL",
      },
      reportId: "provider-usage-1",
      usageRecordId: "usage-live-1",
      usageDigest: `sha256:${"b".repeat(64)}`,
    });

    expect(decision).toMatchObject({
      cumulativeAmount: 60,
      hardPaused: false,
      report: { totalTokens: 60, cachedInputTokens: 10, reasoningOutputTokens: 5 },
      usageRecord: { amount: 60 },
      stageAttempt: { status: "RUNNING" },
    });
    expect(
      decision.events
        .filter(({ type }) => type === "BUDGET_THRESHOLD_REACHED")
        .map((event) => (event.type === "BUDGET_THRESHOLD_REACHED" ? event.data.threshold : null)),
    ).toEqual([0.5]);
  });

  it("hard-pauses before another session when the immutable AgentRun cap is reached", () => {
    const decision = decideRecordProviderUsage({
      now,
      workItem,
      run,
      stageAttempt,
      dispatch,
      providerSession,
      agentRun,
      budgetPolicy,
      existingUsageRecords: [],
      existingAgentUsageTotal: 20,
      usage: { inputTokens: 40, outputTokens: 10, quality: "PROVIDER_ESTIMATE" },
      reportId: "provider-usage-2",
      usageRecordId: "usage-live-2",
      usageDigest: `sha256:${"c".repeat(64)}`,
    });

    expect(decision).toMatchObject({
      hardPaused: true,
      workItem: { state: "BLOCKED" },
      run: { status: "HARD_PAUSED" },
      stageAttempt: { status: "HARD_PAUSED", failureCode: null },
      dispatch: { status: "COMPLETED" },
    });
    expect(decision.events.map(({ type }) => type)).toContain("PIPELINE_PAUSED");
  });

  it("records terminal usage from the current turn after Soft Pause", () => {
    const paused = decidePausePipeline(
      {
        schemaVersion: 1,
        commandId: "pause-before-terminal-usage",
        correlationId: "correlation-pause-before-terminal-usage",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "PAUSE_PIPELINE",
        payload: { pipelineRunId: run.id, expectedVersion: run.version },
      },
      { now, workItem, run, stageAttempt, pendingDispatch: dispatch },
    );
    if (paused.previousDispatch === null) throw new Error("Expected the withdrawn dispatch");

    const decision = decideRecordProviderUsage({
      now,
      workItem: paused.workItem,
      run: paused.run,
      stageAttempt: paused.stageAttempt,
      dispatch: paused.previousDispatch,
      providerSession,
      agentRun,
      budgetPolicy,
      existingUsageRecords: [],
      existingAgentUsageTotal: 0,
      usage: { inputTokens: 10, outputTokens: 10, quality: "ACTUAL" },
      reportId: "provider-usage-soft-pause",
      usageRecordId: "usage-soft-pause",
      usageDigest: `sha256:${"e".repeat(64)}`,
    });

    expect(decision).toMatchObject({
      hardPaused: false,
      run: { status: "SOFT_PAUSED" },
      stageAttempt: { status: "SOFT_PAUSED" },
      dispatch: { status: "FAILED" },
      report: { totalTokens: 20 },
    });
  });

  it("refuses usage whose session is not owned by the active AgentRun", () => {
    expect(() =>
      decideRecordProviderUsage({
        now,
        workItem,
        run,
        stageAttempt,
        dispatch,
        providerSession: { ...providerSession, agentRunId: "agent-run-other" },
        agentRun,
        budgetPolicy,
        existingUsageRecords: [],
        existingAgentUsageTotal: 0,
        usage: { inputTokens: 1, outputTokens: 1, quality: "ACTUAL" },
        reportId: "provider-usage-mismatch",
        usageRecordId: "usage-live-mismatch",
        usageDigest: `sha256:${"d".repeat(64)}`,
      }),
    ).toThrow(expect.objectContaining({ code: "PROVIDER_SESSION_MISMATCH" }));
  });

  it("records deterministic usage thresholds once and enters a hard pause", () => {
    const command: ApplyProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: "apply-budget",
      correlationId: "correlation-budget",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        resultTree: null,
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

  it("rejects a session-level outcome as a stage result", () => {
    // HANDED_OFF and CONTEXT_EXHAUSTED (spec \u00a75.2) are session-level: the session loop
    // (spec \u00a76.3) handles them, not this stage-level decision. Built by breaking exactly
    // the outcome's `type` off an otherwise-identical, accepted COMPLETED command, so the
    // rejection can only be attributed to that field.
    const command: ApplyProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: "apply-completed",
      correlationId: "correlation-apply-completed",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        resultTree: null,
        dispatchId: dispatch.id,
        template,
        outcome: { type: "COMPLETED", summary: "Implementation complete." },
      },
    };
    const context = {
      now,
      workItem,
      run,
      stageAttempt,
      dispatch,
      budgetPolicy,
      existingUsageRecords: [],
      usageRecordIds: [],
    };
    expect(() => decideApplyProviderOutcome(command, context)).not.toThrow();

    const handedOff: ApplyProviderOutcomeCommand = {
      ...command,
      payload: {
        ...command.payload,
        outcome: {
          type: "HANDED_OFF",
          checkpoint: {
            summary: "Wired the mock adapter's checkpoint.",
            completed: [],
            remaining: [],
            deadEnds: [],
            openQuestions: [],
          },
        },
      },
    };
    expect(() => decideApplyProviderOutcome(handedOff, context)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_STAGE_MISMATCH" }),
    );
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
