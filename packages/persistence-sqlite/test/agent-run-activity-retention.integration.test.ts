import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowTemplate } from "@loomrail/contracts";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

// Task 13: SD-004's 30-day sweep for `agent_run_activity`. The 30-day arithmetic itself lives in
// apps/daemon's orchestrator (mirroring cleanupExpiredBrowserQAArtifacts) -- this suite only proves
// what packages/persistence-sqlite owns: the query and the delete, both keyed off a raw
// `closedBefore` timestamp the caller supplies.
const timestamp = "2026-01-01T00:00:00.000Z";
const contextPack = {
  schemaVersion: 1 as const,
  sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
};

const activityTemplate: WorkflowTemplate = {
  schemaVersion: 1,
  id: "agent-run-activity-retention-template",
  version: 1,
  name: "Agent run activity retention",
  stages: [{ stage: "IMPLEMENT", ordinal: 0, contextPack }],
};

type ActivityFixture = {
  agentRunId: string;
  providerSessionId: string;
  provider: "CODEX" | "CLAUDE_CODE";
  workItemId: string;
  pipelineRunId: string;
  pipelineVersion: number;
  dispatchId: string;
};

describe("agent run activity retention", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let clockOffsetMs = 0;
  let nextCommandId = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail agent run activity retention тест "));
    databasePath = join(temporaryDirectory, "state.sqlite");
    clockOffsetMs = 0;
    nextCommandId = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  // Same reasoning as agent-run-activity.integration.test.ts's own `tick`: `observed_at` and event
  // `occurred_at` must strictly increase with insertion order for the ORDER BY in this sweep's
  // query/delete to behave deterministically.
  const tick = (): Date => {
    clockOffsetMs += 1;
    return new Date(new Date(timestamp).getTime() + clockOffsetMs);
  };

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: tick,
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const freshCommandId = (label: string): string => `${label}-${(nextCommandId += 1).toString()}`;

  const startExecution = (localState: LocalState): ActivityFixture => {
    localState.execute({
      schemaVersion: 1,
      commandId: "register-project",
      correlationId: "correlation-register-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-1",
        fixtureId: "web-app-a",
        name: "Agent run activity retention fixture",
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
        title: "Record live agent run activity",
        description: "Synthetic fixture",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["Agent run activity is durable"],
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
        template: activityTemplate,
        budget: { maxEstimatedTokens: 200_000, warningThresholds: [0.5, 0.8, 0.95] },
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
          templateId: activityTemplate.id,
          templateVersion: activityTemplate.version,
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
    return {
      agentRunId: agent.run.id,
      providerSessionId: session.session.id,
      provider: "CODEX",
      workItemId: created.workItem.id,
      pipelineRunId: pipeline.run.id,
      pipelineVersion: pipeline.run.version,
      dispatchId: pipeline.dispatch.id,
    };
  };

  const recordActivity = (localState: LocalState, fixture: ActivityFixture, actionKey: string): void => {
    localState.execute({
      schemaVersion: 1,
      commandId: `activity-${fixture.providerSessionId}-${actionKey}`,
      correlationId: "correlation-agent-run-activity",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "RECORD_AGENT_RUN_ACTIVITY",
      payload: {
        agentRunId: fixture.agentRunId,
        providerSessionId: fixture.providerSessionId,
        provider: fixture.provider,
        entry: {
          actionKey,
          kind: "TOOL_CALL",
          label: "Ran a tool",
          detail: null,
          status: "ok",
          terminal: true,
          truncated: false,
        },
      },
    });
  };

  const markDegraded = (localState: LocalState, fixture: ActivityFixture): void => {
    localState.execute({
      schemaVersion: 1,
      commandId: freshCommandId("mark-degraded"),
      correlationId: "correlation-mark-agent-run-activity-degraded",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "MARK_AGENT_RUN_ACTIVITY_DEGRADED",
      payload: { agentRunId: fixture.agentRunId },
    });
  };

  // Cancelling a freshly-started (still-RUNNING) pipeline is the same closure path
  // local-state.integration.test.ts already exercises for LIST_EXPIRED_QA_ATTACHMENTS: it moves the
  // WorkItem to CANCELLED and appends a PIPELINE_CANCELLED event, the exact closure signal this
  // sweep's join looks for. Returns that event's `occurredAt` so tests can place `closedBefore`
  // precisely on either side of it.
  const closeWorkItem = (localState: LocalState, fixture: ActivityFixture): string => {
    const result = localState.execute({
      schemaVersion: 1,
      commandId: freshCommandId("cancel-pipeline"),
      correlationId: "correlation-cancel-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CANCEL_PIPELINE",
      payload: { pipelineRunId: fixture.pipelineRunId, expectedVersion: fixture.pipelineVersion },
    });
    if (result.type !== "PIPELINE_CONTROL_APPLIED") throw new Error("Expected pipeline cancellation");
    const closureEvent = result.events.find((event) => event.type === "PIPELINE_CANCELLED");
    if (!closureEvent) throw new Error("Expected a PIPELINE_CANCELLED event");
    return closureEvent.occurredAt;
  };

  // Drives the fixture's single-IMPLEMENT-stage pipeline to completion WITHOUT ending it in
  // ACCEPTANCE, the exact gap fix-round-1 flagged: `decideApplyProviderOutcome`
  // (packages/domain/src/workflow.ts) returns `workItem: context.workItem` unchanged when a
  // template's last stage succeeds -- only the terminal `PIPELINE_COMPLETED` event moves, not the
  // WorkItem's own `state` column. `workflowTemplateSchema` never requires a template to end with
  // ACCEPTANCE, and `activityTemplate` above is exactly such a template, so this is a reachable
  // shape in production, not a fixture artifact. START_AGENT_RUN already performs the
  // MARK_WORKFLOW_DISPATCH_STARTED transition internally (see its handler in
  // packages/persistence-sqlite/src/index.ts), so this goes straight to APPLY_PROVIDER_OUTCOME.
  // `sessionCompletion` is omitted, same as the mock-pipeline precedent in
  // local-state.integration.test.ts, so IMPLEMENT's "observed a real mutation" check never applies.
  const completeStageWithoutClosingWorkItem = (localState: LocalState, fixture: ActivityFixture): string => {
    const result = localState.execute({
      schemaVersion: 1,
      commandId: freshCommandId("apply-provider-outcome"),
      correlationId: "correlation-apply-provider-outcome",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: fixture.dispatchId,
        provider: fixture.provider,
        template: activityTemplate,
        outcome: { type: "COMPLETED", summary: "Implementation completed." },
        resultTree: "c".repeat(40),
      },
    });
    if (result.type !== "PROVIDER_OUTCOME_APPLIED") throw new Error("Expected the provider outcome to apply");
    const closureEvent = result.events.find((event) => event.type === "PIPELINE_COMPLETED");
    if (!closureEvent) throw new Error("Expected a PIPELINE_COMPLETED event");
    return closureEvent.occurredAt;
  };

  const listExpired = (localState: LocalState, closedBefore: string, limit?: number): string[] => {
    const result = localState.query({
      type: "LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES",
      closedBefore,
      ...(limit === undefined ? {} : { limit }),
    });
    if (result.type !== "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES") {
      throw new Error("Expected retention candidates");
    }
    return result.entryIds;
  };

  const sweep = (
    localState: LocalState,
    closedBefore: string,
    limit = 200,
  ): { entriesDeleted: number; stateRowsDeleted: number } => {
    const result = localState.execute({
      schemaVersion: 1,
      commandId: freshCommandId("sweep"),
      correlationId: "correlation-sweep-agent-run-activity",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "DELETE_EXPIRED_AGENT_RUN_ACTIVITY",
      payload: { closedBefore, limit },
    });
    if (result.type !== "AGENT_RUN_ACTIVITY_RETENTION_APPLIED") {
      throw new Error("Expected retention applied result");
    }
    return { entriesDeleted: result.entriesDeleted, stateRowsDeleted: result.stateRowsDeleted };
  };

  const readState = (
    localState: LocalState,
    agentRunId: string,
  ): { entries: number; omittedCount: number; degraded: boolean } => {
    const page = localState.query({ type: "LIST_AGENT_RUN_ACTIVITY", agentRunId, limit: 2_000 });
    if (page.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an agent run activity page");
    return { entries: page.entries.length, omittedCount: page.omittedCount, degraded: page.degraded };
  };

  const farFuture = "2030-01-01T00:00:00.000Z";

  it("does not select or delete activity for a still-open work item, regardless of age", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    recordActivity(localState, fixture, "c1");
    recordActivity(localState, fixture, "c2");

    expect(listExpired(localState, farFuture)).toEqual([]);
    expect(sweep(localState, farFuture)).toEqual({ entriesDeleted: 0, stateRowsDeleted: 0 });
    expect(readState(localState, fixture.agentRunId)).toMatchObject({ entries: 2 });
  });

  // fix-round-1, finding 1: the Case-1 mutation defeated the closure-Event join AND the
  // `work_items.state IN ('DONE','CANCELLED')` clause together, so it proved only the pair, not
  // this clause on its own. A WorkItem carrying an old closure-class Event while its own `state`
  // never moved past IN_PROGRESS is reachable (see `completeStageWithoutClosingWorkItem` above),
  // and this is the only test that isolates the `work_items.state` guard against it.
  it("does not select or delete activity for a completed-but-unaccepted, still-open work item, however old", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    recordActivity(localState, fixture, "c1");
    const completedAt = completeStageWithoutClosingWorkItem(localState, fixture);

    const workItem = localState.query({ type: "GET_WORK_ITEM", workItemId: fixture.workItemId });
    if (workItem.type !== "WORK_ITEM" || workItem.workItem === null) throw new Error("Expected the WorkItem");
    // The gap this test exists to close: PIPELINE_COMPLETED fired on the WorkItem's own aggregate,
    // but the WorkItem's `state` never left IN_PROGRESS -- there is no ACCEPTANCE stage in
    // `activityTemplate` to move it to DONE.
    expect(workItem.workItem.state).toBe("IN_PROGRESS");

    const afterCompletion = new Date(new Date(completedAt).getTime() + 1).toISOString();
    expect(listExpired(localState, afterCompletion)).toEqual([]);
    expect(sweep(localState, afterCompletion)).toEqual({ entriesDeleted: 0, stateRowsDeleted: 0 });
    expect(readState(localState, fixture.agentRunId)).toMatchObject({ entries: 1 });
  });

  it("does not select activity for a work item closed within the retention window", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    recordActivity(localState, fixture, "c1");
    const closedAt = closeWorkItem(localState, fixture);

    // The threshold sits strictly before the closure itself -- "closed 29 days ago" reads the same
    // as "closed a moment ago" to this query, since neither is <= a cutoff that predates the closure.
    const beforeClosure = new Date(new Date(closedAt).getTime() - 1).toISOString();
    expect(listExpired(localState, beforeClosure)).toEqual([]);
    expect(sweep(localState, beforeClosure)).toEqual({ entriesDeleted: 0, stateRowsDeleted: 0 });
    expect(readState(localState, fixture.agentRunId)).toMatchObject({ entries: 1 });
  });

  it("selects and deletes activity for a work item closed long ago, and removes its emptied state row", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    recordActivity(localState, fixture, "c1");
    recordActivity(localState, fixture, "c2");
    const closedAt = closeWorkItem(localState, fixture);

    const afterClosure = new Date(new Date(closedAt).getTime() + 1).toISOString();
    const candidates = listExpired(localState, afterClosure);
    expect(candidates).toHaveLength(2);
    expect(sweep(localState, afterClosure)).toEqual({ entriesDeleted: 2, stateRowsDeleted: 1 });
    expect(readState(localState, fixture.agentRunId)).toEqual({
      entries: 0,
      omittedCount: 0,
      degraded: false,
    });
    // A read after the state row itself is gone must not read as "degraded" or carry a stale
    // omittedCount -- exactly the silent-lie failure mode RECORD_AGENT_RUN_ACTIVITY's own comments
    // warn against for the *degraded* flag specifically.
    expect(listExpired(localState, afterClosure)).toEqual([]);
  });

  it("bounds both the query and the delete to `limit` rows per call", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    for (let index = 0; index < 5; index += 1) {
      recordActivity(localState, fixture, `c${index.toString()}`);
    }
    const closedAt = closeWorkItem(localState, fixture);
    const afterClosure = new Date(new Date(closedAt).getTime() + 1).toISOString();

    expect(listExpired(localState, afterClosure, 2)).toHaveLength(2);
    expect(sweep(localState, afterClosure, 2)).toEqual({ entriesDeleted: 2, stateRowsDeleted: 0 });
    expect(readState(localState, fixture.agentRunId)).toMatchObject({ entries: 3 });

    expect(sweep(localState, afterClosure, 2)).toEqual({ entriesDeleted: 2, stateRowsDeleted: 0 });
    expect(readState(localState, fixture.agentRunId)).toMatchObject({ entries: 1 });

    expect(sweep(localState, afterClosure, 2)).toEqual({ entriesDeleted: 1, stateRowsDeleted: 1 });
    expect(readState(localState, fixture.agentRunId)).toMatchObject({ entries: 0 });
  });

  it("is safe to run twice: the second call over the same window deletes nothing more", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    recordActivity(localState, fixture, "c1");
    const closedAt = closeWorkItem(localState, fixture);
    const afterClosure = new Date(new Date(closedAt).getTime() + 1).toISOString();

    expect(sweep(localState, afterClosure)).toEqual({ entriesDeleted: 1, stateRowsDeleted: 1 });
    // A distinct commandId each call, like every other retry in this suite -- proving the DELETE
    // statement's own predicate is what makes the second pass a no-op, not the generic
    // commandId-replay cache standing in for it.
    expect(sweep(localState, afterClosure)).toEqual({ entriesDeleted: 0, stateRowsDeleted: 0 });
  });

  it("sweeps an orphaned state row for a closed, expired run that never recorded any entries", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    markDegraded(localState, fixture);
    expect(readState(localState, fixture.agentRunId)).toEqual({
      entries: 0,
      omittedCount: 0,
      degraded: true,
    });
    const closedAt = closeWorkItem(localState, fixture);
    const afterClosure = new Date(new Date(closedAt).getTime() + 1).toISOString();

    // Nothing in `agent_run_activity` for this run, so the entries query finds no candidates --
    // this run's only trace of expired diagnostic data is its counters row.
    expect(listExpired(localState, afterClosure)).toEqual([]);
    expect(sweep(localState, afterClosure)).toEqual({ entriesDeleted: 0, stateRowsDeleted: 1 });
    expect(readState(localState, fixture.agentRunId)).toEqual({
      entries: 0,
      omittedCount: 0,
      degraded: false,
    });
  });

  it("rejects an actor other than the local daemon, deleting nothing", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    recordActivity(localState, fixture, "c1");
    const closedAt = closeWorkItem(localState, fixture);
    const afterClosure = new Date(new Date(closedAt).getTime() + 1).toISOString();

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: freshCommandId("sweep-forbidden"),
        correlationId: "correlation-sweep-forbidden",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "DELETE_EXPIRED_AGENT_RUN_ACTIVITY",
        payload: { closedBefore: afterClosure, limit: 200 },
      }),
    ).toThrow(expect.objectContaining({ code: "AGENT_RUN_ACTIVITY_RETENTION_ACTOR_FORBIDDEN" }));
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: freshCommandId("sweep-forbidden-session-loop"),
        correlationId: "correlation-sweep-forbidden-session-loop",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "DELETE_EXPIRED_AGENT_RUN_ACTIVITY",
        payload: { closedBefore: afterClosure, limit: 200 },
      }),
    ).toThrow(StateStoreError);
    expect(readState(localState, fixture.agentRunId)).toMatchObject({ entries: 1 });
  });
});
