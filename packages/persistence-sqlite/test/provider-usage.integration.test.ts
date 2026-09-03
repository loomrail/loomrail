import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

const timestamp = "2026-09-03T10:00:00.000Z";
const contextPack = {
  schemaVersion: 1 as const,
  sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
};

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

  const startExecution = (localState: LocalState, maxEstimatedTokens: number) => {
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
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: "start-pipeline",
      correlationId: "correlation-start-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: {
          schemaVersion: 1,
          id: "provider-usage-template",
          version: 1,
          name: "Provider usage",
          stages: [{ stage: "DISCOVERY", ordinal: 0, contextPack }],
        },
        budget: { maxEstimatedTokens, warningThresholds: [0.5, 0.8, 0.95] },
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
    return { created, pipeline, agent, session };
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

  it("atomically hard-pauses workflow and AgentRun before the session can end", async () => {
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
      runs: [{ status: "HARD_PAUSED" }],
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
  });

  it("rejects an external actor and keeps the report table append-only", async () => {
    const localState = await open();
    const execution = startExecution(localState, 200);
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
