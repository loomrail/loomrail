import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowTemplate } from "@loomrail/contracts";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

const timestamp = "2026-09-03T10:00:00.000Z";
const contextPack = {
  schemaVersion: 1 as const,
  sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
};

const providerUsageTemplate = (includePlan = false): WorkflowTemplate => ({
  schemaVersion: 1,
  id: "provider-usage-template",
  version: 1,
  name: "Provider usage",
  stages: [
    { stage: "DISCOVERY", ordinal: 0, contextPack },
    ...(includePlan ? [{ stage: "PLAN" as const, ordinal: 1, contextPack }] : []),
  ],
});

describe("durable provider usage", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail provider usage тест "));
    databasePath = join(temporaryDirectory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const startExecution = (
    localState: LocalState,
    maxEstimatedTokens: number,
    agentRunMaxEstimatedTokensOverride?: number,
    includePlan = false,
  ) => {
    localState.execute({
      schemaVersion: 1,
      commandId: "register-project",
      correlationId: "correlation-register-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-1",
        fixtureId: "web-app-a",
        name: "Provider usage fixture",
        repositoryPath: join(temporaryDirectory, "repo"),
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: "create-work-item",
      correlationId: "correlation-create-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-1",
        parentId: null,
        type: "TASK",
        title: "Measure live provider usage",
        description: "Synthetic fixture",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["Provider usage is durable"],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute({
      schemaVersion: 1,
      commandId: "ready-work-item",
      correlationId: "correlation-ready-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const template = providerUsageTemplate(includePlan);
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: "start-pipeline",
      correlationId: "correlation-start-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template,
        budget: {
          maxEstimatedTokens,
          warningThresholds: [0.5, 0.8, 0.95],
          ...(agentRunMaxEstimatedTokensOverride === undefined ? {} : { agentRunMaxEstimatedTokensOverride }),
        },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    const agent = localState.execute({
      schemaVersion: 1,
      commandId: "start-agent-run",
      correlationId: "correlation-start-agent-run",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: pipeline.dispatch.id,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    if (agent.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun start");
    const session = localState.execute({
      schemaVersion: 1,
      commandId: "start-provider-session",
      correlationId: "correlation-start-provider-session",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId: pipeline.stageAttempt.id,
        recipe: {
          schemaVersion: 1,
          templateId: "provider-usage-template",
          templateVersion: 1,
          specSource: "ROLE_PLAYBOOK",
          roleProfile: { id: agent.run.profile.id, revision: agent.run.profile.revision },
          sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
          omitted: [],
          contentHash: `sha256:${"a".repeat(64)}`,
          estimatedTokens: 10,
          budgetTokens: 100,
          estimateQuality: "LOOMRAIL_ESTIMATE",
        },
      },
    });
    if (session.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected ProviderSession start");
    return { created, pipeline, agent, session, template };
  };

  it("records one cumulative report, projects it into the ledger, and survives restart", async () => {
    const localState = await open();
    const execution = startExecution(localState, 200);
    const command = {
      schemaVersion: 1 as const,
      commandId: "record-provider-usage",
      correlationId: "correlation-record-provider-usage",
      actor: { type: "SYSTEM" as const, id: "session-loop" },
      type: "RECORD_PROVIDER_USAGE" as const,
      payload: {
        providerSessionId: execution.session.session.id,
        usage: {
          inputTokens: 40,
          outputTokens: 20,
          cachedInputTokens: 10,
          reasoningOutputTokens: 5,
          costUsd: 0.04,
          quality: "ACTUAL" as const,
        },
      },
    };
    const recorded = localState.execute(command);
    if (recorded.type !== "PROVIDER_USAGE_RECORDED") throw new Error("Expected ProviderUsage report");
    expect(recorded).toMatchObject({
      type: "PROVIDER_USAGE_RECORDED",
      replayed: false,
      cumulativeAmount: 60,
      hardPaused: false,
      report: { totalTokens: 60, costUsd: 0.04 },
      usageRecord: { amount: 60 },
    });
    expect(localState.execute(command)).toMatchObject({
      type: "PROVIDER_USAGE_RECORDED",
      replayed: true,
    });
    expect(() => localState.execute({ ...command, commandId: "duplicate-provider-usage" })).toThrow(
      expect.objectContaining({ code: "PROVIDER_USAGE_ALREADY_RECORDED" }),
    );

    const beforeRestart = localState.query({
      type: "LIST_PROVIDER_SESSIONS",
      stageAttemptId: execution.pipeline.stageAttempt.id,
    });
    expect(beforeRestart).toMatchObject({
      type: "PROVIDER_SESSIONS",
      usageReports: [{ totalTokens: 60, inputTokens: 40, outputTokens: 20 }],
    });
    const snapshot = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: execution.created.workItem.id,
    });
    expect(snapshot).toMatchObject({ snapshot: { usageRecords: [{ amount: 60 }] } });
    localState.close();
    state = undefined;

    const reopened = await open();
    expect(
      reopened.query({
        type: "LIST_PROVIDER_SESSIONS",
        stageAttemptId: execution.pipeline.stageAttempt.id,
      }),
    ).toMatchObject({ usageReports: [{ totalTokens: 60, usageDigest: recorded.report.usageDigest }] });
  });

  it("records terminal usage from the in-flight turn after Soft Pause withdrew its dispatch", async () => {
    const localState = await open();
    const execution = startExecution(localState, 200);
    localState.execute({
      schemaVersion: 1,
      commandId: "pause-before-provider-usage",
      correlationId: "correlation-pause-before-provider-usage",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "PAUSE_PIPELINE",
      payload: {
        pipelineRunId: execution.pipeline.run.id,
        expectedVersion: execution.pipeline.run.version,
      },
    });

    const recorded = localState.execute({
      schemaVersion: 1,
      commandId: "record-soft-paused-provider-usage",
      correlationId: "correlation-record-soft-paused-provider-usage",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "RECORD_PROVIDER_USAGE",
      payload: {
        providerSessionId: execution.session.session.id,
        usage: { inputTokens: 10, outputTokens: 10, quality: "ACTUAL" },
      },
    });

    expect(recorded).toMatchObject({
      type: "PROVIDER_USAGE_RECORDED",
      hardPaused: false,
      cumulativeAmount: 20,
      stageAttempt: { status: "SOFT_PAUSED" },
    });
    expect(
      localState.query({
        type: "LIST_PROVIDER_SESSIONS",
        stageAttemptId: execution.pipeline.stageAttempt.id,
      }),
    ).toMatchObject({ usageReports: [{ totalTokens: 20 }] });
  });

  it("keeps a zero-token final report without inventing a positive ledger row", async () => {
    const localState = await open();
    const execution = startExecution(localState, 200);
    const recorded = localState.execute({
      schemaVersion: 1,
      commandId: "record-zero-provider-usage",
      correlationId: "correlation-record-zero-provider-usage",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "RECORD_PROVIDER_USAGE",
      payload: {
        providerSessionId: execution.session.session.id,
        usage: { inputTokens: 0, outputTokens: 0, quality: "ACTUAL" },
      },
    });

    expect(recorded).toMatchObject({
      hardPaused: false,
      cumulativeAmount: 0,
      report: { totalTokens: 0, usageRecordId: null },
      usageRecord: null,
    });
    expect(
      localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: execution.created.workItem.id }),
    ).toMatchObject({ snapshot: { usageRecords: [] } });
    expect(
      localState.query({
        type: "LIST_PROVIDER_SESSIONS",
        stageAttemptId: execution.pipeline.stageAttempt.id,
      }),
    ).toMatchObject({ usageReports: [{ totalTokens: 0, usageRecordId: null }] });
  });

  it("hard-pauses workflow but keeps AgentRun authority until the session ends", async () => {
    const localState = await open();
    const execution = startExecution(localState, 100);
    const recorded = localState.execute({
      schemaVersion: 1,
      commandId: "record-exhausting-usage",
      correlationId: "correlation-record-exhausting-usage",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "RECORD_PROVIDER_USAGE",
      payload: {
        providerSessionId: execution.session.session.id,
        usage: { inputTokens: 80, outputTokens: 20, quality: "ACTUAL" },
      },
    });
    expect(recorded).toMatchObject({ hardPaused: true, stageAttempt: { status: "HARD_PAUSED" } });
    expect(
      localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: execution.created.workItem.id }),
    ).toMatchObject({
      snapshot: {
        run: { status: "HARD_PAUSED" },
        stageAttempts: [{ status: "HARD_PAUSED", failureCode: null }],
        humanRequests: [],
        usageRecords: [{ amount: 100 }],
      },
    });
    expect(localState.query({ type: "GET_AGENT_RUN", agentRunId: execution.agent.run.id })).toMatchObject({
      runs: [{ status: "RUNNING" }],
    });
    expect(localState.query({ type: "LIST_PENDING_DISPATCHES" })).toMatchObject({ dispatches: [] });

    const ended = localState.execute({
      schemaVersion: 1,
      commandId: "end-budget-paused-session",
      correlationId: "correlation-end-budget-paused-session",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "END_PROVIDER_SESSION",
      payload: {
        providerSessionId: execution.session.session.id,
        endReason: "INTERRUPTED",
        providerStarted: true,
      },
    });
    expect(ended).toMatchObject({
      type: "PROVIDER_SESSION_ENDED",
      stageAttempt: { status: "HARD_PAUSED" },
      request: null,
      nextSessionOrdinal: null,
    });
    expect(localState.query({ type: "GET_AGENT_RUN", agentRunId: execution.agent.run.id })).toMatchObject({
      runs: [{ status: "HARD_PAUSED" }],
    });
  });

  it("atomically keeps a terminal outcome and parks its next stage when usage reaches a cap", async () => {
    const localState = await open();
    const execution = startExecution(localState, 200_000, undefined, true);
    const command = {
      schemaVersion: 1 as const,
      commandId: "apply-terminal-outcome-with-usage",
      correlationId: "correlation-apply-terminal-outcome-with-usage",
      actor: { type: "SYSTEM" as const, id: "session-loop" },
      type: "APPLY_PROVIDER_OUTCOME" as const,
      payload: {
        dispatchId: execution.pipeline.dispatch.id,
        provider: "CODEX" as const,
        outcome: { type: "COMPLETED" as const, summary: "Discovery completed before usage arrived." },
        template: execution.template,
        resultTree: null,
        sessionCompletion: {
          providerSessionId: execution.session.session.id,
          usage: { inputTokens: 70_000, outputTokens: 10_000, quality: "ACTUAL" as const },
        },
      },
    };

    expect(localState.execute(command)).toMatchObject({
      type: "MOCK_PROVIDER_OUTCOME_APPLIED",
      replayed: false,
      run: { status: "HARD_PAUSED" },
      stageAttempt: { stage: "DISCOVERY", status: "SUCCEEDED" },
      usageRecords: [{ amount: 80_000 }],
    });
    expect(localState.execute(command)).toMatchObject({
      type: "MOCK_PROVIDER_OUTCOME_APPLIED",
      replayed: true,
    });
    expect(
      localState.query({
        type: "LIST_PROVIDER_SESSIONS",
        stageAttemptId: execution.pipeline.stageAttempt.id,
      }),
    ).toMatchObject({
      sessions: [{ status: "ENDED", endReason: "COMPLETED" }],
      usageReports: [{ totalTokens: 80_000, agentRunId: execution.agent.run.id }],
    });
    expect(
      localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: execution.created.workItem.id }),
    ).toMatchObject({
      snapshot: {
        run: { status: "HARD_PAUSED" },
        stageAttempts: [
          { stage: "DISCOVERY", status: "SUCCEEDED" },
          { stage: "PLAN", status: "HARD_PAUSED", startedAt: null },
        ],
        usageRecords: [{ amount: 80_000 }],
      },
    });
    expect(localState.query({ type: "LIST_PENDING_DISPATCHES" })).toMatchObject({ dispatches: [] });
    expect(localState.query({ type: "GET_AGENT_RUN", agentRunId: execution.agent.run.id })).toMatchObject({
      runs: [{ status: "SUCCEEDED" }],
    });

    localState.close();
    state = undefined;
    const reopened = await open();
    expect(
      reopened.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: execution.created.workItem.id }),
    ).toMatchObject({
      snapshot: {
        run: { status: "HARD_PAUSED" },
        stageAttempts: [
          { stage: "DISCOVERY", status: "SUCCEEDED" },
          { stage: "PLAN", status: "HARD_PAUSED" },
        ],
        usageRecords: [{ amount: 80_000 }],
      },
    });
  });

  it("resumes a budget-parked unstarted next stage without inventing a retry", async () => {
    const localState = await open();
    const execution = startExecution(localState, 200_000, undefined, true);
    localState.execute({
      schemaVersion: 1,
      commandId: "park-next-stage-from-terminal-usage",
      correlationId: "correlation-park-next-stage-from-terminal-usage",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: execution.pipeline.dispatch.id,
        provider: "CODEX",
        outcome: { type: "COMPLETED", summary: "Discovery completed before usage arrived." },
        template: execution.template,
        resultTree: null,
        sessionCompletion: {
          providerSessionId: execution.session.session.id,
          usage: { inputTokens: 70_000, outputTokens: 10_000, quality: "ACTUAL" },
        },
      },
    });
    const paused = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: execution.created.workItem.id,
    });
    if (paused.type !== "WORKFLOW_SNAPSHOT" || paused.snapshot.run === null) {
      throw new Error("Expected a hard-paused workflow");
    }
    const parked = paused.snapshot.stageAttempts.at(-1);
    if (parked === undefined) throw new Error("Expected the parked next stage");

    const overridden = localState.execute({
      schemaVersion: 1,
      commandId: "resume-parked-next-stage",
      correlationId: "correlation-resume-parked-next-stage",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "APPROVE_BUDGET_OVERRIDE",
      payload: {
        pipelineRunId: paused.snapshot.run.id,
        expectedVersion: paused.snapshot.run.version,
        maxEstimatedTokens: 200_000,
        agentRunMaxEstimatedTokensOverride: 100_000,
      },
    });

    expect(overridden).toMatchObject({
      type: "BUDGET_OVERRIDE_APPROVED",
      previousStageAttempt: { id: parked.id, stage: "PLAN", attempt: 1, status: "HARD_PAUSED" },
      stageAttempt: { id: parked.id, stage: "PLAN", attempt: 1, status: "QUEUED" },
      dispatch: { stageAttemptId: parked.id, mode: "START", status: "PENDING" },
    });
    expect(
      localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: execution.created.workItem.id }),
    ).toMatchObject({
      snapshot: {
        run: { status: "RUNNING", currentStageAttemptId: parked.id },
        stageAttempts: [
          { stage: "DISCOVERY", status: "SUCCEEDED" },
          { id: parked.id, stage: "PLAN", attempt: 1, status: "QUEUED" },
        ],
      },
    });
  });

  it("raises only an exhausted AgentRun ceiling and binds the revision to the retry", async () => {
    const localState = await open();
    const execution = startExecution(localState, 700_000, 80_000);
    localState.execute({
      schemaVersion: 1,
      commandId: "record-agent-run-exhaustion",
      correlationId: "correlation-record-agent-run-exhaustion",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "RECORD_PROVIDER_USAGE",
      payload: {
        providerSessionId: execution.session.session.id,
        usage: { inputTokens: 132_916, outputTokens: 1_315, quality: "ACTUAL" },
      },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: "end-agent-run-exhaustion",
      correlationId: "correlation-end-agent-run-exhaustion",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "END_PROVIDER_SESSION",
      payload: {
        providerSessionId: execution.session.session.id,
        endReason: "INTERRUPTED",
        providerStarted: true,
      },
    });
    const paused = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: execution.created.workItem.id,
    });
    if (paused.type !== "WORKFLOW_SNAPSHOT" || paused.snapshot.run === null) {
      throw new Error("Expected a hard-paused workflow");
    }

    const overridden = localState.execute({
      schemaVersion: 1,
      commandId: "raise-agent-run-ceiling",
      correlationId: "correlation-raise-agent-run-ceiling",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "APPROVE_BUDGET_OVERRIDE",
      payload: {
        pipelineRunId: paused.snapshot.run.id,
        expectedVersion: paused.snapshot.run.version,
        maxEstimatedTokens: 700_000,
        modelTierOverride: "FAST",
        agentRunMaxEstimatedTokensOverride: 175_000,
      },
    });
    if (overridden.type !== "BUDGET_OVERRIDE_APPROVED") {
      throw new Error("Expected BudgetPolicy override");
    }
    expect(overridden.budgetPolicy).toMatchObject({
      revision: 2,
      maxEstimatedTokens: 700_000,
      agentRunMaxEstimatedTokensOverride: 175_000,
    });

    const retried = localState.execute({
      schemaVersion: 1,
      commandId: "start-agent-run-retry",
      correlationId: "correlation-start-agent-run-retry",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: overridden.dispatch.id,
        provider: "CLAUDE_CODE",
        modelMapping: {
          FAST: "claude-fast-pinned",
          STANDARD: "claude-standard-pinned",
          DEEP: "claude-deep-pinned",
        },
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    expect(retried).toMatchObject({
      type: "AGENT_RUN_STARTED",
      run: {
        policySnapshot: {
          provider: "CLAUDE_CODE",
          modelId: "claude-fast-pinned",
          budget: { pipelinePolicyRevision: 2, maxEstimatedTokens: 175_000 },
        },
      },
    });
  });

  it("parks a re-queued stage whose budget was spent by a question-asking session, so an override can resume it", async () => {
    const localState = await open();
    const execution = startExecution(localState, 100);
    // The session asks the owner a question; its terminal usage spends the whole budget. Nothing
    // is parked here (the owner still has to answer), which is exactly the state that used to
    // leave the run un-startable after the answer.
    localState.execute({
      schemaVersion: 1,
      commandId: "needs-human-at-the-cap",
      correlationId: "correlation-needs-human-at-the-cap",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: execution.pipeline.dispatch.id,
        provider: "CODEX",
        template: execution.template,
        resultTree: null,
        outcome: {
          type: "NEEDS_HUMAN",
          request: {
            kind: "SINGLE_CHOICE",
            blocking: true,
            title: "Choose the discovery depth",
            context: "A decision is required before discovery can continue.",
            recommendation: "Use the focused pass.",
            options: [
              { id: "focused", label: "Focused pass", consequence: "Bounded discovery.", recommended: true },
              { id: "broad", label: "Broad pass", consequence: "Wider discovery.", recommended: false },
            ],
            allowOther: false,
          },
        },
        sessionCompletion: {
          providerSessionId: execution.session.session.id,
          usage: { inputTokens: 80, outputTokens: 20, quality: "ACTUAL" },
        },
      },
    });
    const waiting = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: execution.created.workItem.id,
    });
    if (waiting.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected a workflow snapshot");
    const request = waiting.snapshot.humanRequests[0];
    if (request === undefined) throw new Error("Expected the open HumanRequest");
    const answered = localState.execute({
      schemaVersion: 1,
      commandId: "answer-at-the-cap",
      correlationId: "correlation-answer-at-the-cap",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ANSWER_HUMAN_REQUEST",
      payload: {
        humanRequestId: request.id,
        expectedVersion: request.version,
        answer: { type: "OPTION", optionIds: ["focused"] },
      },
    });
    if (answered.type !== "HUMAN_REQUEST_ANSWERED" || answered.dispatch === null) {
      throw new Error("Expected the answer to queue the stage");
    }

    const parked = localState.execute({
      schemaVersion: 1,
      commandId: "start-agent-run-after-answer",
      correlationId: "correlation-start-agent-run-after-answer",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: answered.dispatch.id,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    expect(parked).toMatchObject({
      type: "AGENT_RUN_BUDGET_PARKED",
      run: { status: "HARD_PAUSED" },
      stageAttempt: { id: execution.pipeline.stageAttempt.id, status: "HARD_PAUSED", failureCode: null },
      dispatch: { id: answered.dispatch.id, status: "FAILED" },
      events: [{ type: "STAGE_ATTEMPT_CHANGED" }, { type: "PIPELINE_PAUSED", data: { kind: "HARD" } }],
    });
    expect(localState.query({ type: "LIST_PENDING_DISPATCHES" })).toMatchObject({ dispatches: [] });
    expect(localState.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" })).toMatchObject({ runs: [] });
    const pausedSnapshot = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: execution.created.workItem.id,
    });
    if (pausedSnapshot.type !== "WORKFLOW_SNAPSHOT" || pausedSnapshot.snapshot.run === null) {
      throw new Error("Expected a hard-paused workflow");
    }
    expect(
      localState.query({ type: "GET_WORK_ITEM", workItemId: execution.created.workItem.id }),
    ).toMatchObject({ workItem: { state: "BLOCKED" } });

    const overridden = localState.execute({
      schemaVersion: 1,
      commandId: "override-after-park",
      correlationId: "correlation-override-after-park",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "APPROVE_BUDGET_OVERRIDE",
      payload: {
        pipelineRunId: pausedSnapshot.snapshot.run.id,
        expectedVersion: pausedSnapshot.snapshot.run.version,
        maxEstimatedTokens: 300,
      },
    });
    if (overridden.type !== "BUDGET_OVERRIDE_APPROVED")
      throw new Error("Expected the override to be approved");
    expect(overridden).toMatchObject({
      stageAttempt: { status: "QUEUED" },
      dispatch: { status: "PENDING" },
    });
    expect(
      localState.execute({
        schemaVersion: 1,
        commandId: "start-agent-run-after-override",
        correlationId: "correlation-start-agent-run-after-override",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: overridden.dispatch.id,
          provider: "CODEX",
          limits: { global: 3, project: 3, provider: 3 },
        },
      }),
    ).toMatchObject({ type: "AGENT_RUN_STARTED" });
  });

  it("rejects an external actor and keeps the report table append-only", async () => {
    const localState = await open();
    const execution = startExecution(localState, 200);
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "forbidden-terminal-provider-usage",
        correlationId: "correlation-forbidden-terminal-provider-usage",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: execution.pipeline.dispatch.id,
          provider: "CODEX",
          outcome: { type: "COMPLETED", summary: "An external actor cannot finalize usage." },
          template: execution.template,
          resultTree: null,
          sessionCompletion: {
            providerSessionId: execution.session.session.id,
            usage: { inputTokens: 1, outputTokens: 1, quality: "ACTUAL" },
          },
        },
      }),
    ).toThrow(StateStoreError);
    expect(
      localState.query({
        type: "LIST_PROVIDER_SESSIONS",
        stageAttemptId: execution.pipeline.stageAttempt.id,
      }),
    ).toMatchObject({ sessions: [{ status: "RUNNING" }], usageReports: [] });
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "forbidden-provider-usage",
        correlationId: "correlation-forbidden-provider-usage",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "RECORD_PROVIDER_USAGE",
        payload: {
          providerSessionId: execution.session.session.id,
          usage: { inputTokens: 1, outputTokens: 1, quality: "ACTUAL" },
        },
      }),
    ).toThrow(StateStoreError);
    expect(
      localState.query({
        type: "LIST_PROVIDER_SESSIONS",
        stageAttemptId: execution.pipeline.stageAttempt.id,
      }),
    ).toMatchObject({ usageReports: [] });

    localState.execute({
      schemaVersion: 1,
      commandId: "allowed-provider-usage",
      correlationId: "correlation-allowed-provider-usage",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "RECORD_PROVIDER_USAGE",
      payload: {
        providerSessionId: execution.session.session.id,
        usage: { inputTokens: 1, outputTokens: 1, quality: "ACTUAL" },
      },
    });
    localState.close();
    state = undefined;
    const raw = new DatabaseSync(databasePath);
    expect(() => raw.prepare("UPDATE provider_usage_reports SET total_tokens = 3").run()).toThrow();
    expect(() => raw.prepare("DELETE FROM provider_usage_reports").run()).toThrow();
    raw.close();
  });
});
