import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderActivityEntry, WorkflowTemplate } from "@loomrail/contracts";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

const timestamp = "2026-09-03T10:00:00.000Z";
const contextPack = {
  schemaVersion: 1 as const,
  sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
};

const activityTemplate: WorkflowTemplate = {
  schemaVersion: 1,
  id: "agent-run-activity-template",
  version: 1,
  name: "Agent run activity",
  stages: [{ stage: "IMPLEMENT", ordinal: 0, contextPack }],
};

type ActivityFixture = {
  agentRunId: string;
  providerSessionId: string;
  provider: "CODEX" | "CLAUDE_CODE";
};

describe("agent run activity", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let clockOffsetMs = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail agent run activity тест "));
    databasePath = join(temporaryDirectory, "state.sqlite");
    clockOffsetMs = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  // Ticks forward on every command so `observed_at` -- and therefore the LIST query's sort key --
  // strictly increases with insertion order, even across the thousand-plus commands the eviction
  // tests issue. A frozen clock would leave every row's timestamp identical and fall back on `id`
  // string comparison for ordering, which does not sort numerically once ids cross a digit boundary
  // (e.g. "activity-100" < "activity-99").
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
        name: "Agent run activity fixture",
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
    };
  };

  // Mirrors the payload apps/daemon's session-loop recorder builds in Task 7: same commandId shape
  // (so a start and its terminal report are distinct commands, merged by the handler's own upsert
  // rather than by the generic commandId replay guard), same actor.
  const recordActivity = (
    fixture: ActivityFixture,
    overrides: {
      actionKey: string;
      terminal: boolean;
      status: string | null;
      kind?: ProviderActivityEntry["kind"];
      label?: string | null;
      detail?: string | null;
      truncated?: boolean;
    },
  ) => ({
    schemaVersion: 1 as const,
    commandId: `activity-${fixture.providerSessionId}-${overrides.actionKey}-${overrides.terminal ? "end" : "start"}`,
    correlationId: "correlation-agent-run-activity",
    actor: { type: "SYSTEM" as const, id: "session-loop" },
    type: "RECORD_AGENT_RUN_ACTIVITY" as const,
    payload: {
      agentRunId: fixture.agentRunId,
      providerSessionId: fixture.providerSessionId,
      provider: fixture.provider,
      entry: {
        actionKey: overrides.actionKey,
        kind: overrides.kind ?? "TOOL_CALL",
        // `??` would treat an explicit `null` the same as "omitted" and silently replace it with
        // the default, which is exactly the distinction the non-erasure test below needs to make.
        label: overrides.label === undefined ? "Ran a tool" : overrides.label,
        detail: overrides.detail === undefined ? null : overrides.detail,
        status: overrides.status,
        terminal: overrides.terminal,
        truncated: overrides.truncated ?? false,
      },
    },
  });

  it("updates the row a start created instead of appending a second", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    localState.execute(recordActivity(fixture, { actionKey: "c1", terminal: false, status: null }));
    localState.execute(recordActivity(fixture, { actionKey: "c1", terminal: true, status: "exit 0" }));

    const page = localState.query({
      type: "LIST_AGENT_RUN_ACTIVITY",
      agentRunId: fixture.agentRunId,
      limit: 50,
    });
    if (page.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an agent run activity page");
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.status).toBe("exit 0");
  });

  // The property that makes this upsert correct rather than merely present: a terminal report adds
  // its outcome, it does not erase the observation its start recorded. The start below carries a
  // real label, detail, and truncated:true; the terminal report that follows for the same
  // actionKey carries label:null, detail:null, truncated:false -- an erasing ON CONFLICT clause
  // would let the terminal report's nulls win, and this test exists to catch exactly that.
  it("keeps the start's label, detail, and truncated flag when a terminal report carries none", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    localState.execute(
      recordActivity(fixture, {
        actionKey: "c1",
        terminal: false,
        status: null,
        label: "Listed the repository root",
        detail: "ls -la /workspace",
        truncated: true,
      }),
    );
    localState.execute(
      recordActivity(fixture, {
        actionKey: "c1",
        terminal: true,
        status: "exit 0",
        label: null,
        detail: null,
        truncated: false,
      }),
    );

    const page = localState.query({
      type: "LIST_AGENT_RUN_ACTIVITY",
      agentRunId: fixture.agentRunId,
      limit: 50,
    });
    if (page.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an agent run activity page");
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      label: "Listed the repository root",
      detail: "ls -la /workspace",
      truncated: true,
      status: "exit 0",
    });
  });

  it("evicts the oldest entries past the bound and counts what it dropped", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    for (let index = 0; index < 1_005; index += 1) {
      localState.execute(
        recordActivity(fixture, { actionKey: `c${index.toString()}`, terminal: true, status: "ok" }),
      );
    }

    const page = localState.query({
      type: "LIST_AGENT_RUN_ACTIVITY",
      agentRunId: fixture.agentRunId,
      limit: 2_000,
    });
    if (page.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an agent run activity page");
    expect(page.entries.length).toBe(1_000);
    expect(page.omittedCount).toBe(5);
  });

  it("keeps seq monotonic across eviction", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    for (let index = 0; index < 1_005; index += 1) {
      localState.execute(
        recordActivity(fixture, { actionKey: `c${index.toString()}`, terminal: true, status: "ok" }),
      );
    }

    const page = localState.query({
      type: "LIST_AGENT_RUN_ACTIVITY",
      agentRunId: fixture.agentRunId,
      limit: 2_000,
    });
    if (page.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an agent run activity page");
    const seqs = page.entries.map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  // Not in the brief's three cases, but this handler adds a SYSTEM/session-loop actor guard
  // (mirroring RECORD_PROVIDER_USAGE's own) that has no other coverage in this plan; a diagnostic
  // buffer with no authority still should not be forgeable by an arbitrary caller.
  it("rejects an actor other than the session loop", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "forbidden-agent-run-activity",
        correlationId: "correlation-forbidden-agent-run-activity",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "RECORD_AGENT_RUN_ACTIVITY",
        payload: {
          agentRunId: fixture.agentRunId,
          providerSessionId: fixture.providerSessionId,
          provider: fixture.provider,
          entry: {
            actionKey: "forbidden",
            kind: "TOOL_CALL",
            label: "Ran a tool",
            detail: null,
            status: null,
            terminal: false,
            truncated: false,
          },
        },
      }),
    ).toThrow(StateStoreError);
    const page = localState.query({
      type: "LIST_AGENT_RUN_ACTIVITY",
      agentRunId: fixture.agentRunId,
      limit: 50,
    });
    if (page.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an agent run activity page");
    expect(page.entries).toHaveLength(0);
  });
});

describe("mark agent run activity degraded", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let clockOffsetMs = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail mark agent run activity degraded тест "));
    databasePath = join(temporaryDirectory, "state.sqlite");
    clockOffsetMs = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

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

  // Duplicated from the describe block above rather than shared, so this block's fixtures stay
  // readable on their own -- MARK_AGENT_RUN_ACTIVITY_DEGRADED cares about none of RECORD's
  // provider-session plumbing beyond the AgentRun it hangs off of.
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
        name: "Mark agent run activity degraded fixture",
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
        title: "Mark agent run activity degraded",
        description: "Synthetic fixture",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["Agent run activity degradation is durable"],
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
    };
  };

  const recordActivity = (fixture: ActivityFixture, actionKey: string) => ({
    schemaVersion: 1 as const,
    commandId: `activity-${fixture.providerSessionId}-${actionKey}`,
    correlationId: "correlation-agent-run-activity",
    actor: { type: "SYSTEM" as const, id: "session-loop" },
    type: "RECORD_AGENT_RUN_ACTIVITY" as const,
    payload: {
      agentRunId: fixture.agentRunId,
      providerSessionId: fixture.providerSessionId,
      provider: fixture.provider,
      entry: {
        actionKey,
        kind: "TOOL_CALL" as const,
        label: "Ran a tool",
        detail: null,
        status: "ok",
        terminal: true,
        truncated: false,
      },
    },
  });

  const markDegraded = (agentRunId: string, commandId: string) => ({
    schemaVersion: 1 as const,
    commandId,
    correlationId: "correlation-mark-agent-run-activity-degraded",
    actor: { type: "SYSTEM" as const, id: "session-loop" },
    type: "MARK_AGENT_RUN_ACTIVITY_DEGRADED" as const,
    payload: { agentRunId },
  });

  const readPage = (localState: LocalState, agentRunId: string) => {
    const page = localState.query({ type: "LIST_AGENT_RUN_ACTIVITY", agentRunId, limit: 50 });
    if (page.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an agent run activity page");
    return page;
  };

  it("marks an existing run's activity feed degraded without disturbing its entries", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    localState.execute(recordActivity(fixture, "c1"));

    const result = localState.execute(markDegraded(fixture.agentRunId, "mark-degraded-1"));
    expect(result).toMatchObject({
      type: "AGENT_RUN_ACTIVITY_DEGRADED_MARKED",
      agentRunId: fixture.agentRunId,
    });

    const page = readPage(localState, fixture.agentRunId);
    expect(page.degraded).toBe(true);
    expect(page.entries).toHaveLength(1);
    expect(page.omittedCount).toBe(0);
  });

  // The caller marks on first failure and again at session end (spec above the command), so a
  // second mark is the ordinary path, not an error -- issued as a genuinely separate command
  // (distinct commandId) rather than a retried one, so this exercises the handler's own
  // idempotence rather than the generic commandId replay cache.
  it("marking an already-degraded run again succeeds and changes nothing", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    localState.execute(recordActivity(fixture, "c1"));
    localState.execute(markDegraded(fixture.agentRunId, "mark-degraded-first"));
    const before = readPage(localState, fixture.agentRunId);

    const second = localState.execute(markDegraded(fixture.agentRunId, "mark-degraded-second"));
    expect(second).toMatchObject({ type: "AGENT_RUN_ACTIVITY_DEGRADED_MARKED" });

    const after = readPage(localState, fixture.agentRunId);
    expect(after.degraded).toBe(true);
    expect(after.omittedCount).toBe(before.omittedCount);
    expect(after.entries).toEqual(before.entries);
  });

  // The recorder can fail on its very first entry for a run, before RECORD_AGENT_RUN_ACTIVITY has
  // ever created a counters row. Honest degradation reporting cannot depend on having already
  // succeeded once, so this must create the row rather than throw for lack of one to update --
  // proven here against the same LIST_AGENT_RUN_ACTIVITY read a real caller would use.
  it("marks a run degraded even when no activity was ever recorded for it", async () => {
    const localState = await open();
    const fixture = startExecution(localState);

    const result = localState.execute(markDegraded(fixture.agentRunId, "mark-degraded-first-failure"));
    expect(result).toMatchObject({
      type: "AGENT_RUN_ACTIVITY_DEGRADED_MARKED",
      agentRunId: fixture.agentRunId,
    });

    const page = readPage(localState, fixture.agentRunId);
    expect(page.degraded).toBe(true);
    expect(page.entries).toHaveLength(0);
    expect(page.omittedCount).toBe(0);
  });

  it("rejects an actor other than the session loop, writing nothing", async () => {
    const localState = await open();
    const fixture = startExecution(localState);

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "forbidden-mark-agent-run-activity-degraded",
        correlationId: "correlation-forbidden-mark-agent-run-activity-degraded",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MARK_AGENT_RUN_ACTIVITY_DEGRADED",
        payload: { agentRunId: fixture.agentRunId },
      }),
    ).toThrow(StateStoreError);

    const page = readPage(localState, fixture.agentRunId);
    expect(page.degraded).toBe(false);
  });

  it("rejects an AgentRun that does not exist", async () => {
    const localState = await open();

    expect(() =>
      localState.execute(markDegraded("agent-run-missing", "mark-degraded-missing-run")),
    ).toThrow();
  });

  // Recovery, not the recorder. The buffer the recorder was filling lived in the process that died,
  // so whatever it still held when the daemon stopped was never written and never will be. A feed
  // that is missing its tail must say so; left unmarked it reports `degraded = false`, which is the
  // silent lie this flag exists to prevent -- and the one case no in-process code path can cover,
  // because the process that would have marked it is gone.
  it("marks every AgentRun that startup reconciliation interrupts as having a degraded feed", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    localState.execute(recordActivity(fixture, "c1"));
    expect(readPage(localState, fixture.agentRunId).degraded).toBe(false);
    localState.close();
    state = undefined;

    const reopened = await open();
    const reconciled = reopened.execute({
      schemaVersion: 1,
      commandId: "reconcile-after-crash",
      correlationId: "correlation-reconcile-after-crash",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });
    expect(reconciled.type).toBe("WORKFLOWS_RECONCILED");

    const run = reopened.query({ type: "GET_AGENT_RUN", agentRunId: fixture.agentRunId });
    if (run.type !== "AGENT_RUNS") throw new Error("Expected the interrupted AgentRun");
    expect(run.runs[0]?.status).toBe("INTERRUPTED");
    const page = readPage(reopened, fixture.agentRunId);
    expect(page.degraded).toBe(true);
    // What survived the crash is still there and still readable: the mark says the feed is
    // incomplete, it does not throw the feed away.
    expect(page.entries).toHaveLength(1);
  });

  // The counters row is created by whichever of the two writers gets there first. A run interrupted
  // before its recorder ever wrote has no row at all, and the mark must create one rather than
  // affect zero rows -- the same requirement the first-failure case has, reached from recovery.
  it("marks an interrupted AgentRun that never recorded any activity", async () => {
    const localState = await open();
    const fixture = startExecution(localState);
    localState.close();
    state = undefined;

    const reopened = await open();
    reopened.execute({
      schemaVersion: 1,
      commandId: "reconcile-after-crash-with-empty-buffer",
      correlationId: "correlation-reconcile-after-crash-with-empty-buffer",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });

    const page = readPage(reopened, fixture.agentRunId);
    expect(page.degraded).toBe(true);
    expect(page.entries).toHaveLength(0);
    expect(page.omittedCount).toBe(0);
  });
});
