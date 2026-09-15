import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderActivityEntry, WorkflowTemplate, WorkspaceToolOperation } from "@loomrail/contracts";

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

// Task 10's shared read: the newest Run Activity entry per AgentRun, resolved across BOTH sources
// in one query. What makes this worth its own suite rather than a few more cases in the block
// above is exactly the case a naive implementation gets wrong -- picking the newer of two rows that
// live in different tables, in either order -- which the block above never exercises because it
// only ever touches `agent_run_activity`.
describe("latest agent run activity", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let clockOffsetMs = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail latest agent run activity тест "));
    databasePath = join(temporaryDirectory, "state.sqlite");
    clockOffsetMs = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  // Ticks forward on every command, same reasoning as the describe block above: this suite's whole
  // point is proving which of two sources is NEWER, so the two sources' timestamps must actually
  // differ and increase in the exact order the commands below run in.
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

  // Duplicated from the describe blocks above rather than shared, same reasoning as the second
  // block's own copy: this suite's fixtures should read on their own. `projectSuffix` keeps two
  // fixtures opened against the same LocalState (the "many runs in one query" test needs exactly
  // that) from colliding on `REGISTER_PROJECT`'s project id.
  const startExecution = (localState: LocalState, projectSuffix: string): ActivityFixture => {
    localState.execute({
      schemaVersion: 1,
      commandId: `register-project-${projectSuffix}`,
      correlationId: `correlation-register-project-${projectSuffix}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: `project-${projectSuffix}`,
        // Unlike the describe block above, this suite opens two fixtures against the same
        // LocalState (the "many runs in one query" test needs both at once) -- a shared bundled
        // fixtureId would collide on REGISTER_PROJECT's own uniqueness check the second time.
        fixtureId: null,
        name: "Latest agent run activity fixture",
        repositoryPath: join(temporaryDirectory, `repo-${projectSuffix}`),
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: `create-work-item-${projectSuffix}`,
      correlationId: `correlation-create-work-item-${projectSuffix}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: `project-${projectSuffix}`,
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
      commandId: `ready-work-item-${projectSuffix}`,
      correlationId: `correlation-ready-work-item-${projectSuffix}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: `start-pipeline-${projectSuffix}`,
      correlationId: `correlation-start-pipeline-${projectSuffix}`,
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
      commandId: `start-agent-run-${projectSuffix}`,
      correlationId: `correlation-start-agent-run-${projectSuffix}`,
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
      commandId: `start-provider-session-${projectSuffix}`,
      correlationId: `correlation-start-provider-session-${projectSuffix}`,
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

  const recordActivity = (fixture: ActivityFixture, actionKey: string, label: string) => ({
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
        label,
        detail: null,
        status: "ok",
        terminal: true,
        truncated: false,
      },
    },
  });

  // `START_WORKSPACE_TOOL_CALL` alone is enough: the newest-entry read orders `workspace_tool_calls`
  // by `started_at`, exactly like Task 8's merged feed does (activityEntryFromWorkspaceToolCall's
  // `at: call.startedAt`), so there is no need to also finish the call just to give it a timestamp.
  const startWorkspaceToolCall = (
    fixture: ActivityFixture,
    providerCallKey: string,
    operation: WorkspaceToolOperation,
    target: string,
  ) => ({
    schemaVersion: 1 as const,
    commandId: `workspace-tool-${fixture.providerSessionId}-${providerCallKey}`,
    correlationId: "correlation-workspace-tool-call",
    actor: { type: "SYSTEM" as const, id: "workspace-executor" },
    type: "START_WORKSPACE_TOOL_CALL" as const,
    payload: {
      providerSessionId: fixture.providerSessionId,
      providerCallKey,
      operation,
      target,
      policyDigest: "b".repeat(64),
      inputDigest: "c".repeat(64),
    },
  });

  const readLatest = (localState: LocalState, agentRunIds: readonly string[]) => {
    const result = localState.query({ type: "LIST_LATEST_AGENT_RUN_ACTIVITY", agentRunIds });
    if (result.type !== "LATEST_AGENT_RUN_ACTIVITY") {
      throw new Error("Expected a latest agent run activity read");
    }
    return result.entries;
  };

  it("returns nothing for an AgentRun with no activity in either source", async () => {
    const localState = await open();
    const fixture = startExecution(localState, "p1");

    expect(readLatest(localState, [fixture.agentRunId])).toEqual([]);
  });

  it("picks the provider-reported entry when it is the newer of the two sources", async () => {
    const localState = await open();
    const fixture = startExecution(localState, "p1");
    // Audited first, so it gets the earlier `started_at`.
    localState.execute(startWorkspaceToolCall(fixture, "a".repeat(64), "READ_FILE", "src/a.ts"));
    localState.execute(recordActivity(fixture, "c1", "pnpm test"));

    const entries = readLatest(localState, [fixture.agentRunId]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agentRunId: fixture.agentRunId,
      origin: "PROVIDER_REPORTED",
      label: "pnpm test",
    });
  });

  it("picks the audited entry when it is the newer of the two sources", async () => {
    const localState = await open();
    const fixture = startExecution(localState, "p1");
    // Reported first this time -- the naive mistake this suite exists to catch is an implementation
    // that always prefers one source over the other instead of actually comparing timestamps.
    localState.execute(recordActivity(fixture, "c1", "pnpm test"));
    localState.execute(startWorkspaceToolCall(fixture, "a".repeat(64), "READ_FILE", "src/a.ts"));

    const entries = readLatest(localState, [fixture.agentRunId]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agentRunId: fixture.agentRunId,
      origin: "DAEMON_AUDITED",
      label: "READ_FILE",
      detail: "src/a.ts",
    });
  });

  it("reads many AgentRuns' latest entries in one query, each matched to its own run", async () => {
    const localState = await open();
    const first = startExecution(localState, "p1");
    const second = startExecution(localState, "p2");
    localState.execute(recordActivity(first, "c1", "pnpm test"));
    localState.execute(startWorkspaceToolCall(second, "a".repeat(64), "WRITE_FILE", "src/b.ts"));

    const entries = readLatest(localState, [first.agentRunId, second.agentRunId]);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.agentRunId === first.agentRunId)).toMatchObject({
      origin: "PROVIDER_REPORTED",
      label: "pnpm test",
    });
    expect(entries.find((entry) => entry.agentRunId === second.agentRunId)).toMatchObject({
      origin: "DAEMON_AUDITED",
      label: "WRITE_FILE",
    });
  });
});

// Task 1 of the follow-up plan (docs/plans/129): the feed's unit moves from AgentRun to WorkItem.
// A WorkItem's Run Activity now has to span every run the pipeline made against it, not just the
// current stage attempt's -- otherwise an audited action a finished stage made becomes visible on
// no screen at all (spec 128's whole reason for existing). This suite proves the two work-item-
// scoped reads that make that possible: `agent_run_activity` and `workspace_tool_calls` both
// already carry `work_item_id` as their own column, so both reads filter on it directly -- no join
// through `agent_runs` -- and this is what pins that down against a real command surface.
describe("work item activity", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let clockOffsetMs = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail work item activity тест "));
    databasePath = join(temporaryDirectory, "state.sqlite");
    clockOffsetMs = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  // Same reasoning as the "agent run activity" describe block's own clock: `observed_at` (and
  // `started_at` for the audited side) must strictly increase with insertion order, including
  // across the thousand-plus commands the aggregation test below issues.
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

  // Two stages, not one: this suite's whole point is a feed spanning more than one AgentRun, and a
  // WorkItem only ever gets a second one by finishing the first stage and starting the next.
  // Neither stage is IMPLEMENT, so completing one never has to satisfy the audited-mutation gate
  // that stage alone carries -- irrelevant to what this suite is testing.
  const workItemActivityTemplate: WorkflowTemplate = {
    schemaVersion: 1,
    id: "work-item-activity-template",
    version: 1,
    name: "Work item activity",
    stages: [
      { stage: "DISCOVERY", ordinal: 0, contextPack },
      { stage: "PLAN", ordinal: 1, contextPack },
    ],
  };

  // `projectSuffix` keeps two fixtures opened against the same LocalState (the "excludes another
  // task's entries" tests need exactly that) from colliding on REGISTER_PROJECT's own uniqueness
  // check, the same reasoning the "latest agent run activity" suite above states for its own copy.
  const startWorkItemExecution = (
    localState: LocalState,
    projectSuffix: string,
  ): { workItemId: string; dispatchId: string; stageAttemptId: string; run: ActivityFixture } => {
    localState.execute({
      schemaVersion: 1,
      commandId: `register-project-${projectSuffix}`,
      correlationId: `correlation-register-project-${projectSuffix}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: `project-${projectSuffix}`,
        fixtureId: null,
        name: "Work item activity fixture",
        repositoryPath: join(temporaryDirectory, `repo-${projectSuffix}`),
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: `create-work-item-${projectSuffix}`,
      correlationId: `correlation-create-work-item-${projectSuffix}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: `project-${projectSuffix}`,
        parentId: null,
        type: "TASK",
        title: "Record work item activity",
        description: "Synthetic fixture",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["Work item activity is durable"],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute({
      schemaVersion: 1,
      commandId: `ready-work-item-${projectSuffix}`,
      correlationId: `correlation-ready-work-item-${projectSuffix}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: `start-pipeline-${projectSuffix}`,
      correlationId: `correlation-start-pipeline-${projectSuffix}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: workItemActivityTemplate,
        budget: { maxEstimatedTokens: 200_000, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    const run = startAgentRunAndSession(
      localState,
      projectSuffix,
      "discovery",
      pipeline.dispatch.id,
      pipeline.stageAttempt.id,
    );
    return {
      workItemId: created.workItem.id,
      dispatchId: pipeline.dispatch.id,
      stageAttemptId: pipeline.stageAttempt.id,
      run,
    };
  };

  const startAgentRunAndSession = (
    localState: LocalState,
    projectSuffix: string,
    stageLabel: string,
    dispatchId: string,
    stageAttemptId: string,
  ): ActivityFixture => {
    const agent = localState.execute({
      schemaVersion: 1,
      commandId: `start-agent-run-${projectSuffix}-${stageLabel}`,
      correlationId: `correlation-start-agent-run-${projectSuffix}-${stageLabel}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    if (agent.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun start");
    const session = localState.execute({
      schemaVersion: 1,
      commandId: `start-provider-session-${projectSuffix}-${stageLabel}`,
      correlationId: `correlation-start-provider-session-${projectSuffix}-${stageLabel}`,
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId,
        recipe: {
          schemaVersion: 1,
          templateId: workItemActivityTemplate.id,
          templateVersion: workItemActivityTemplate.version,
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
    return { agentRunId: agent.run.id, providerSessionId: session.session.id, provider: "CODEX" };
  };

  // Completes the DISCOVERY dispatch this run holds (ending its session and finishing its
  // AgentRun, which frees the WorkItem's "one active AgentRun" slot) and hands back the PLAN
  // dispatch the pipeline advances to -- the second AgentRun's own starting point.
  const advanceToNextStage = (
    localState: LocalState,
    projectSuffix: string,
    dispatchId: string,
    run: ActivityFixture,
    workItemId: string,
  ): { dispatchId: string; stageAttemptId: string } => {
    localState.execute({
      schemaVersion: 1,
      commandId: `complete-discovery-${projectSuffix}`,
      correlationId: `correlation-complete-discovery-${projectSuffix}`,
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId,
        provider: "CODEX",
        outcome: { type: "COMPLETED", summary: "Discovery is complete." },
        template: workItemActivityTemplate,
        resultTree: null,
        sessionCompletion: { providerSessionId: run.providerSessionId, usage: null },
      },
    });
    const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
    if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
    // Filtered by WorkItem, not just "the first pending dispatch": this suite opens two fixtures
    // against the same LocalState, so a stray dispatch from the other one would otherwise be
    // picked up silently instead of this one failing loudly.
    const dispatch = pending.dispatches.find((candidate) => candidate.workItemId === workItemId);
    if (!dispatch) throw new Error("Expected the PLAN dispatch");
    return { dispatchId: dispatch.id, stageAttemptId: dispatch.stageAttemptId };
  };

  const recordActivity = (fixture: ActivityFixture, actionKey: string, label: string) => ({
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
        label,
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

  const startWorkspaceToolCall = (
    fixture: ActivityFixture,
    providerCallKey: string,
    operation: WorkspaceToolOperation,
    target: string,
  ) => ({
    schemaVersion: 1 as const,
    commandId: `workspace-tool-${fixture.providerSessionId}-${providerCallKey}`,
    correlationId: "correlation-workspace-tool-call",
    actor: { type: "SYSTEM" as const, id: "workspace-executor" },
    type: "START_WORKSPACE_TOOL_CALL" as const,
    payload: {
      providerSessionId: fixture.providerSessionId,
      providerCallKey,
      operation,
      target,
      policyDigest: "b".repeat(64),
      inputDigest: "c".repeat(64),
    },
  });

  const readWorkItemActivity = (localState: LocalState, workItemId: string, limit = 200) => {
    const page = localState.query({ type: "LIST_WORK_ITEM_ACTIVITY", workItemId, limit });
    if (page.type !== "WORK_ITEM_ACTIVITY") throw new Error("Expected a work item activity page");
    return page;
  };

  it("collects entries from two different runs of one task in a single, ordered read", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    localState.execute(recordActivity(execution.run, "c1", "Explored the repository"));
    localState.execute(recordActivity(execution.run, "c2", "Read package.json"));

    const nextStage = advanceToNextStage(
      localState,
      "p1",
      execution.dispatchId,
      execution.run,
      execution.workItemId,
    );
    const secondRun = startAgentRunAndSession(
      localState,
      "p1",
      "plan",
      nextStage.dispatchId,
      nextStage.stageAttemptId,
    );
    localState.execute(recordActivity(secondRun, "c3", "Drafted the plan"));

    const page = readWorkItemActivity(localState, execution.workItemId);
    expect(page.entries.map((entry) => entry.agentRunId)).toEqual([
      execution.run.agentRunId,
      execution.run.agentRunId,
      secondRun.agentRunId,
    ]);
    expect(page.entries.map((entry) => entry.label)).toEqual([
      "Explored the repository",
      "Read package.json",
      "Drafted the plan",
    ]);
    // `(observed_at, id)` order across the run boundary, not merely "grouped by run": the second
    // run's entry must sort after both of the first run's, not just appear after them by luck of
    // insertion order.
    const observedTimes = page.entries.map((entry) => entry.observedAt);
    expect([...observedTimes].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(
      observedTimes,
    );
    // Neither run ever evicted or degraded: the healthy-path aggregation must read 0/false, not
    // leave the field undefined or throw over the "no counters row past SQL's own NULL" case (see
    // the dedicated empty-WorkItem test below for that case in isolation).
    expect(page.omittedCount).toBe(0);
    expect(page.degraded).toBe(false);
  });

  it("reads omittedCount 0 and degraded false for a task with no recorded activity yet", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");

    // No RECORD_AGENT_RUN_ACTIVITY and no MARK_AGENT_RUN_ACTIVITY_DEGRADED for this run: its
    // `agent_run_activity_state` row does not exist yet, so the aggregation query's join finds
    // nothing to aggregate. SQL's own SUM/MAX over zero grouped rows is NULL, not 0 -- this pins
    // the COALESCE that turns that NULL into the honest "not omitted, not degraded" reading rather
    // than a schema-parse crash or an undefined field.
    const page = readWorkItemActivity(localState, execution.workItemId);
    expect(page.entries).toEqual([]);
    expect(page.omittedCount).toBe(0);
    expect(page.degraded).toBe(false);
  });

  it("excludes another task's entries", async () => {
    const localState = await open();
    const first = startWorkItemExecution(localState, "p1");
    const second = startWorkItemExecution(localState, "p2");
    localState.execute(recordActivity(first.run, "c1", "First task action"));
    localState.execute(recordActivity(second.run, "c1", "Second task action"));

    const page = readWorkItemActivity(localState, first.workItemId);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      agentRunId: first.run.agentRunId,
      label: "First task action",
    });
  });

  it("honours the limit", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    localState.execute(recordActivity(execution.run, "c1", "First"));
    localState.execute(recordActivity(execution.run, "c2", "Second"));
    localState.execute(recordActivity(execution.run, "c3", "Third"));

    const page = readWorkItemActivity(localState, execution.workItemId, 2);
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((entry) => entry.label)).toEqual(["First", "Second"]);
  });

  // The aggregation this task's brief asked for a documented decision on: one SQL query, summing
  // `omitted_count` and OR-ing `degraded` across every run the WorkItem has, rather than one read
  // per run. The two runs below are pushed past their own 1_000-row eviction bound by different
  // amounts (1 and 2) specifically so their sum (3) cannot be produced by a wrong aggregation that
  // picks one run's count, or takes the larger of the two (`MAX`) instead of summing -- either of
  // those bugs would read back 1 or 2, never 3.
  //
  // The *later* (PLAN) run, not the temporally-first one, is the one marked degraded. That is
  // deliberate, not arbitrary: a fix-round review found that marking the first-created run left
  // this test unable to tell `COALESCE(MAX(state.degraded), 0)` apart from the un-aggregated
  // `COALESCE(state.degraded, 0)` -- a bug that drops the OR-across-runs semantics and just reads
  // one arbitrary row's column. SQLite's query plan for that bug happened to surface the
  // first-created run's value here, so a fixture that only ever degrades the first run cannot
  // distinguish the two implementations. Degrading the later run instead means a "some arbitrary
  // row" implementation reads back `false` (or the wrong run's status) rather than `true`. See the
  // dedicated "regardless of which run degraded" test below for the same property proven cheaply,
  // in both directions, without the 1_000+ row eviction cost this test pays for the sum.
  it("aggregates omittedCount and degraded across the task's runs", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    for (let index = 0; index < 1_001; index += 1) {
      localState.execute(recordActivity(execution.run, `c${index.toString()}`, "Repeated discovery action"));
    }
    const nextStage = advanceToNextStage(
      localState,
      "p1",
      execution.dispatchId,
      execution.run,
      execution.workItemId,
    );
    const secondRun = startAgentRunAndSession(
      localState,
      "p1",
      "plan",
      nextStage.dispatchId,
      nextStage.stageAttemptId,
    );
    for (let index = 0; index < 1_002; index += 1) {
      localState.execute(recordActivity(secondRun, `d${index.toString()}`, "Repeated plan action"));
    }
    localState.execute(markDegraded(secondRun.agentRunId, "mark-degraded-plan-run"));

    const page = readWorkItemActivity(localState, execution.workItemId, 2_000);
    expect(page.omittedCount).toBe(3);
    expect(page.degraded).toBe(true);
  });

  // Cheap complement to the omittedCount-summing test above: proves `degraded` is a true
  // disjunction across every run of the task -- not a read of one arbitrary run's column -- in
  // BOTH directions, so neither "always reads the first-created run" nor "always reads the
  // last-created run" can pass.
  //
  // Both runs of each WorkItem below are given their own `recordActivity` call before either is
  // marked, specifically so BOTH carry an `agent_run_activity_state` row and the aggregation's join
  // genuinely has two contending rows to pick from. Skipping that step (as an earlier version of
  // this test did) leaves the non-degraded run with no counters row at all -- the join then has
  // only one row per WorkItem, which a "reads one arbitrary row" implementation satisfies exactly
  // as well as a real `MAX`, so the test cannot tell them apart. Confirmed against the reviewer's
  // exact `COALESCE(MAX(state.degraded), 0)` -> `COALESCE(state.degraded, 0)` mutation: without
  // this fix that mutation passed every test in the file; with it, this test fails.
  it("flags the task degraded regardless of which run degraded", async () => {
    const localState = await open();

    const earlierDegraded = startWorkItemExecution(localState, "p1");
    const earlierNextStage = advanceToNextStage(
      localState,
      "p1",
      earlierDegraded.dispatchId,
      earlierDegraded.run,
      earlierDegraded.workItemId,
    );
    const earlierSecondRun = startAgentRunAndSession(
      localState,
      "p1",
      "plan",
      earlierNextStage.dispatchId,
      earlierNextStage.stageAttemptId,
    );
    localState.execute(recordActivity(earlierDegraded.run, "c1", "Discovery action"));
    localState.execute(recordActivity(earlierSecondRun, "d1", "Plan action"));
    localState.execute(markDegraded(earlierDegraded.run.agentRunId, "mark-degraded-earlier-p1"));
    expect(readWorkItemActivity(localState, earlierDegraded.workItemId).degraded).toBe(true);

    const laterDegraded = startWorkItemExecution(localState, "p2");
    const laterNextStage = advanceToNextStage(
      localState,
      "p2",
      laterDegraded.dispatchId,
      laterDegraded.run,
      laterDegraded.workItemId,
    );
    const laterSecondRun = startAgentRunAndSession(
      localState,
      "p2",
      "plan",
      laterNextStage.dispatchId,
      laterNextStage.stageAttemptId,
    );
    localState.execute(recordActivity(laterDegraded.run, "c1", "Discovery action"));
    localState.execute(recordActivity(laterSecondRun, "d1", "Plan action"));
    localState.execute(markDegraded(laterSecondRun.agentRunId, "mark-degraded-later-p2"));
    expect(readWorkItemActivity(localState, laterDegraded.workItemId).degraded).toBe(true);
  });

  // Fix round 1: the aggregation query's own `WHERE agent_runs.work_item_id = ?` had zero
  // coverage -- every prior test in this suite that checks `omittedCount`/`degraded` only ever
  // opens ONE WorkItem whose runs have those values, so a mutation that folds every WorkItem's
  // runs into the aggregate (`... OR 1 = 1`) produced the exact same result and every test still
  // passed. This test opens two WorkItems and gives the noisy one nonzero contributions on both
  // axes specifically so a leaked aggregation is visible on the quiet one.
  it("does not leak another task's aggregation into this task's omittedCount and degraded", async () => {
    const localState = await open();
    const quiet = startWorkItemExecution(localState, "p1");
    localState.execute(recordActivity(quiet.run, "c1", "Quiet task action"));

    const noisy = startWorkItemExecution(localState, "p2");
    for (let index = 0; index < 1_001; index += 1) {
      localState.execute(recordActivity(noisy.run, `n${index.toString()}`, "Noisy repeated action"));
    }
    localState.execute(markDegraded(noisy.run.agentRunId, "mark-degraded-noisy-p2"));

    const quietPage = readWorkItemActivity(localState, quiet.workItemId);
    expect(quietPage.omittedCount).toBe(0);
    expect(quietPage.degraded).toBe(false);

    const noisyPage = readWorkItemActivity(localState, noisy.workItemId, 2_000);
    expect(noisyPage.omittedCount).toBe(1);
    expect(noisyPage.degraded).toBe(true);
  });

  it("collects the work item's audited workspace tool calls across runs, ordered", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    localState.execute(startWorkspaceToolCall(execution.run, "a".repeat(64), "READ_FILE", "src/a.ts"));

    const nextStage = advanceToNextStage(
      localState,
      "p1",
      execution.dispatchId,
      execution.run,
      execution.workItemId,
    );
    const secondRun = startAgentRunAndSession(
      localState,
      "p1",
      "plan",
      nextStage.dispatchId,
      nextStage.stageAttemptId,
    );
    localState.execute(startWorkspaceToolCall(secondRun, "b".repeat(64), "WRITE_FILE", "src/b.ts"));

    const result = localState.query({
      type: "LIST_WORKSPACE_TOOL_CALLS_FOR_WORK_ITEM",
      workItemId: execution.workItemId,
    });
    if (result.type !== "WORKSPACE_TOOL_CALLS") throw new Error("Expected workspace tool calls");
    expect(result.calls.map((call) => call.agentRunId)).toEqual([
      execution.run.agentRunId,
      secondRun.agentRunId,
    ]);
    expect(result.calls.map((call) => call.operation)).toEqual(["READ_FILE", "WRITE_FILE"]);
  });

  it("excludes another task's audited workspace tool calls", async () => {
    const localState = await open();
    const first = startWorkItemExecution(localState, "p1");
    const second = startWorkItemExecution(localState, "p2");
    localState.execute(startWorkspaceToolCall(first.run, "a".repeat(64), "READ_FILE", "src/a.ts"));
    localState.execute(startWorkspaceToolCall(second.run, "b".repeat(64), "WRITE_FILE", "src/b.ts"));

    const result = localState.query({
      type: "LIST_WORKSPACE_TOOL_CALLS_FOR_WORK_ITEM",
      workItemId: first.workItemId,
    });
    if (result.type !== "WORKSPACE_TOOL_CALLS") throw new Error("Expected workspace tool calls");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ agentRunId: first.run.agentRunId, operation: "READ_FILE" });
  });

  // Fix round 1 (Task 2): both work-item-scoped reads gained `after`/`limit` so the daemon route can
  // fetch roughly one page at a time instead of the WorkItem's entire history -- a flat 2_000-row
  // constant no longer bounds a WorkItem with several runs. `after` filters `observed_at >= ?`
  // (deliberately inclusive of the boundary row, not `>`) because the daemon's own cursor logic
  // needs to see the boundary row again to confirm it was not pruned -- see the query's own comment.
  it("LIST_WORK_ITEM_ACTIVITY's `after` returns only rows observed at or after that timestamp, boundary included", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    localState.execute(recordActivity(execution.run, "c1", "First"));
    localState.execute(recordActivity(execution.run, "c2", "Second"));
    localState.execute(recordActivity(execution.run, "c3", "Third"));

    const full = readWorkItemActivity(localState, execution.workItemId);
    const boundary = full.entries[1];
    if (!boundary) throw new Error("Expected a second entry to anchor the cursor on");

    const page = localState.query({
      type: "LIST_WORK_ITEM_ACTIVITY",
      workItemId: execution.workItemId,
      after: boundary.observedAt,
      limit: 200,
    });
    if (page.type !== "WORK_ITEM_ACTIVITY") throw new Error("Expected a work item activity page");
    // Inclusive: the boundary row ("Second") itself is still present, alongside everything after it.
    expect(page.entries.map((entry) => entry.label)).toEqual(["Second", "Third"]);
  });

  it("LIST_WORKSPACE_TOOL_CALLS_FOR_WORK_ITEM's `after` returns only rows started at or after that timestamp, boundary included", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    localState.execute(startWorkspaceToolCall(execution.run, "a".repeat(64), "READ_FILE", "src/a.ts"));
    localState.execute(startWorkspaceToolCall(execution.run, "b".repeat(64), "WRITE_FILE", "src/b.ts"));
    localState.execute(startWorkspaceToolCall(execution.run, "c".repeat(64), "DELETE_FILE", "src/c.ts"));

    const full = localState.query({
      type: "LIST_WORKSPACE_TOOL_CALLS_FOR_WORK_ITEM",
      workItemId: execution.workItemId,
    });
    if (full.type !== "WORKSPACE_TOOL_CALLS") throw new Error("Expected workspace tool calls");
    const boundary = full.calls[1];
    if (!boundary) throw new Error("Expected a second call to anchor the cursor on");

    const page = localState.query({
      type: "LIST_WORKSPACE_TOOL_CALLS_FOR_WORK_ITEM",
      workItemId: execution.workItemId,
      after: boundary.startedAt,
      limit: 200,
    });
    if (page.type !== "WORKSPACE_TOOL_CALLS") throw new Error("Expected workspace tool calls");
    expect(page.calls.map((call) => call.operation)).toEqual(["WRITE_FILE", "DELETE_FILE"]);
  });

  it("bounds LIST_WORK_ITEM_ACTIVITY's read by `limit` even when `after` is given", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    for (let index = 0; index < 5; index += 1) {
      localState.execute(recordActivity(execution.run, `c${index.toString()}`, `Entry ${index.toString()}`));
    }
    const full = readWorkItemActivity(localState, execution.workItemId);
    // Anchored on the THIRD entry, not the first: if `after` were silently ignored, this would read
    // back the WorkItem's first two entries instead -- a different, wrong answer the test can catch.
    // Anchoring on the first entry cannot tell "after honoured" apart from "after ignored", because
    // both start the read at the very beginning.
    const boundary = full.entries[2];
    if (!boundary) throw new Error("Expected a third entry to anchor the cursor on");

    const page = localState.query({
      type: "LIST_WORK_ITEM_ACTIVITY",
      workItemId: execution.workItemId,
      after: boundary.observedAt,
      limit: 2,
    });
    if (page.type !== "WORK_ITEM_ACTIVITY") throw new Error("Expected a work item activity page");
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((entry) => entry.label)).toEqual(["Entry 2", "Entry 3"]);
  });

  // Fix round 1 (Task 2): GET_STAGE_ATTEMPT resolves one StageAttempt directly by id -- unlike
  // GET_WORKFLOW_SNAPSHOT's `stageAttempts`, which only ever covers a WorkItem's *latest* pipeline
  // run, this is what the daemon route now uses so an AgentRun from an earlier, already-finished
  // pipeline run still resolves. Deliberately not exercised through `startWorkItemExecution`'s
  // two-pipeline-run machinery here -- that scenario belongs to the daemon-level HTTP test
  // (work-item-activity-http.integration.test.ts), which proves the route's own use of this query
  // survives it end to end. This is the query's own minimal, direct proof.
  it("GET_STAGE_ATTEMPT resolves a StageAttempt directly by id", async () => {
    const localState = await open();
    const execution = startWorkItemExecution(localState, "p1");
    const result = localState.query({ type: "GET_STAGE_ATTEMPT", stageAttemptId: execution.stageAttemptId });
    if (result.type !== "STAGE_ATTEMPT") throw new Error("Expected a StageAttempt result");
    expect(result.stageAttempt?.id).toBe(execution.stageAttemptId);
    expect(result.stageAttempt?.stage).toBe("DISCOVERY");
  });

  it("GET_STAGE_ATTEMPT reads back null for a StageAttempt id nothing seeded", async () => {
    const localState = await open();
    const result = localState.query({
      type: "GET_STAGE_ATTEMPT",
      stageAttemptId: "stage-attempt-does-not-exist",
    });
    if (result.type !== "STAGE_ATTEMPT") throw new Error("Expected a StageAttempt result");
    expect(result.stageAttempt).toBeNull();
  });
});
