import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AcquireWorkspaceLeaseCommand,
  AnswerHumanRequestCommand,
  ApplyProviderOutcomeCommand,
  ContextPackRecipeInput,
  CreateWorkItemCommand,
  CreateWorkItemWorkspaceCommand,
  EndProviderSessionCommand,
  LegacyApplyMockProviderOutcomeCommand,
  MarkWorkspaceOrphanedCommand,
  MoveWorkItemCommand,
  PublishCheckpointCommand,
  ReconcileWorkflowsCommand,
  RegisterProjectCommand,
  ReleaseWorkspaceLeaseCommand,
  RequestContextHandoffCommand,
  StartMockPipelineCommand,
  StartAgentRunCommand,
  StartProviderSessionCommand,
  UpdateWorkItemCommand,
} from "@loomrail/contracts";
import {
  contextPackRecipeSectionSchema,
  maxAttentionItems,
  maxContextPackRecipeSources,
} from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { applyMigrations } from "../src/migrations.js";
import {
  openLocalState,
  StateStoreError,
  type LocalState,
  type OpenLocalStateOptions,
  type OrphanProcessEvent,
  type OrphanWorkspaceEvent,
} from "../src/index.js";

const timestamp = "2026-08-22T18:00:00.000Z";

// Removes the named A1 fields from every embedded StageAttempt, wherever one appears in a stored
// payload -- i.e. turns a payload this branch wrote into the shape an older database actually
// holds. Both fields together is the pre-A1 shape; `packShareBackoffs` alone is what a build
// between migration 0006 and 0007 wrote.
const mapStageAttempts = (
  value: unknown,
  map: (attempt: Record<string, unknown>) => Record<string, unknown>,
): unknown => {
  if (Array.isArray(value)) return value.map((nested) => mapStageAttempts(nested, map));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "stageAttempt" || key === "previousStageAttempt") &&
      nested !== null &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      result[key] = mapStageAttempts(map({ ...(nested as Record<string, unknown>) }), map);
      continue;
    }
    result[key] = mapStageAttempts(nested, map);
  }
  return result;
};

const withoutSessionCounters = (value: unknown): unknown =>
  mapStageAttempts(value, (attempt) => {
    delete attempt["unproductiveSessions"];
    delete attempt["packShareBackoffs"];
    return attempt;
  });

// The shape a build between migration 0006 and 0007 wrote: `unproductiveSessions` present -- and
// deliberately non-zero, so a backfill that overwrites the field instead of filling it in shows up
// as a changed count -- and `packShareBackoffs` absent.
const halfLegacySessionCounters = (value: unknown): unknown =>
  mapStageAttempts(value, (attempt) => {
    attempt["unproductiveSessions"] = 2;
    delete attempt["packShareBackoffs"];
    return attempt;
  });

// The same two shapes for the stage-end tree label of migration 0013: what a database written
// before that milestone holds, and how many such payloads are left. `resultTree` is required by
// `stageAttemptSchema` exactly as the two counters are, so an unbackfilled payload fails to parse
// exactly as hard.
const withoutResultTree = (value: unknown): unknown =>
  mapStageAttempts(value, (attempt) => {
    delete attempt["resultTree"];
    return attempt;
  });

// `json_type` answers the string 'null' for a key that is present and null, and SQL NULL only for a
// key that is absent -- so this counts payloads the backfill has not reached, and not the ones it
// filled in with null.
const countLegacyResultTrees = (raw: DatabaseSync): { events: number; commands: number } => {
  const count = (table: "events" | "commands", column: "data_json" | "result_json"): number =>
    (
      raw
        .prepare(
          `SELECT COUNT(*) AS count FROM ${table}, json_tree(${table}.${column}) AS tree
           WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
             AND tree.type = 'object'
             AND json_type(tree.value, '$.resultTree') IS NULL`,
        )
        .get() as { count: number }
    ).count;
  return { events: count("events", "data_json"), commands: count("commands", "result_json") };
};

const withoutQ2Lineage = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutQ2Lineage);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, withoutQ2Lineage(nested)]),
  );
  if (
    ("stage" in result && "attempt" in result && "pipelineRunId" in result) ||
    ("providerRelation" in result && "reviewerAgentRunId" in result && "reviewedTree" in result) ||
    ("reviewArtifactId" in result && "severity" in result && "reviewedTree" in result) ||
    ("pipelineRunId" in result &&
      "stage" in result &&
      "kind" in result &&
      "provider" in result &&
      "checks" in result)
  ) {
    delete result["correctionRunId"];
  }
  if ("driverId" in result && "targetOrigin" in result && "plan" in result) {
    delete result["scope"];
  }
  return result;
};

const countLegacyQ2Lineage = (raw: DatabaseSync): { events: number; commands: number } => {
  const count = (table: "events" | "commands", column: "data_json" | "result_json"): number =>
    (
      raw
        .prepare(
          `SELECT COUNT(*) AS count FROM ${table}, json_tree(${table}.${column}) AS tree
           WHERE tree.type = 'object' AND (
             (
               json_type(tree.value, '$.correctionRunId') IS NULL
               AND (
                 (json_type(tree.value, '$.stage') IS NOT NULL
                   AND json_type(tree.value, '$.attempt') IS NOT NULL
                   AND json_type(tree.value, '$.pipelineRunId') IS NOT NULL)
                 OR (json_type(tree.value, '$.providerRelation') IS NOT NULL
                   AND json_type(tree.value, '$.reviewerAgentRunId') IS NOT NULL
                   AND json_type(tree.value, '$.reviewedTree') IS NOT NULL)
                 OR (json_type(tree.value, '$.reviewArtifactId') IS NOT NULL
                   AND json_type(tree.value, '$.severity') IS NOT NULL
                   AND json_type(tree.value, '$.reviewedTree') IS NOT NULL)
                 OR (json_type(tree.value, '$.pipelineRunId') IS NOT NULL
                   AND json_extract(tree.value, '$.stage') IN ('REVIEW', 'QA')
                   AND json_extract(tree.value, '$.kind') IN ('REVIEW_REPORT', 'QA_REPORT')
                   AND json_extract(tree.value, '$.status') = 'PASSED'
                   AND json_type(tree.value, '$.provider') IS NOT NULL
                   AND json_type(tree.value, '$.checks') = 'array')
               )
             )
             OR (
               json_type(tree.value, '$.scope') IS NULL
               AND json_type(tree.value, '$.driverId') IS NOT NULL
               AND json_type(tree.value, '$.targetOrigin') IS NOT NULL
               AND json_type(tree.value, '$.plan') = 'object'
             )
           )`,
        )
        .get() as { count: number }
    ).count;
  return { events: count("events", "data_json"), commands: count("commands", "result_json") };
};

// How many embedded StageAttempts anywhere in the stored payloads still lack *either* counter.
// Asserted non-zero before the migration runs and zero after it, so the test cannot pass by finding
// nothing. Either, not just the first: a payload carrying `unproductiveSessions` and not
// `packShareBackoffs` fails `stageAttemptSchema` exactly as hard as one missing both.
const countLegacyStageAttempts = (raw: DatabaseSync): { events: number; commands: number } => {
  const count = (table: "events" | "commands", column: "data_json" | "result_json"): number =>
    (
      raw
        .prepare(
          `SELECT COUNT(*) AS count FROM ${table}, json_tree(${table}.${column}) AS tree
           WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
             AND tree.type = 'object'
             AND (json_type(tree.value, '$.unproductiveSessions') IS NULL
                  OR json_type(tree.value, '$.packShareBackoffs') IS NULL)`,
        )
        .get() as { count: number }
    ).count;
  return { events: count("events", "data_json"), commands: count("commands", "result_json") };
};

const contextPack: StartMockPipelineCommand["payload"]["template"]["stages"][number]["contextPack"] = {
  schemaVersion: 1,
  sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
};

const mockTemplate: StartMockPipelineCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "DISCOVERY", ordinal: 0, contextPack },
    { stage: "PLAN", ordinal: 1, contextPack },
  ],
};

describe("SQLite local state", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail state тест "));
    databasePath = join(temporaryDirectory, "local state.sqlite");
    nextId = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const open = async (overrides: Partial<OpenLocalStateOptions> = {}): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
      ...overrides,
    });
    return state;
  };

  const registerProject = (id = "project-web", commandId = "register-project"): RegisterProjectCommand => ({
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "REGISTER_PROJECT",
    payload: {
      id,
      fixtureId: id === "project-api" ? "api-service-b" : "web-app-a",
      name: id === "project-api" ? "API fixture" : "Web fixture",
      repositoryPath: join(temporaryDirectory, id),
    },
  });

  const createWorkItem = (
    commandId = "create-work-item",
    projectId = "project-web",
    parentId: string | null = null,
  ): CreateWorkItemCommand => ({
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "CREATE_WORK_ITEM",
    payload: {
      projectId,
      parentId,
      type: parentId === null ? "TASK" : "SUBTASK",
      title: `Work for ${commandId}`,
      description: "Synthetic fixture work",
      priority: "MEDIUM",
      risk: "LOW",
      acceptanceCriteria: ["State is durable"],
    },
  });

  const moveWorkItem = (
    commandId: string,
    workItemId: string,
    expectedVersion: number,
    targetState: MoveWorkItemCommand["payload"]["targetState"],
  ): MoveWorkItemCommand => ({
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "MOVE_WORK_ITEM",
    payload: { workItemId, expectedVersion, targetState },
  });

  const completeMeasuredQA = (localState: LocalState, suffix: string, testedTree: string): void => {
    const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
    if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
    const dispatch = pending.dispatches[0];
    if (!dispatch) throw new Error("Expected a pending QA dispatch");
    const started = localState.execute({
      schemaVersion: 1,
      commandId: `start-${suffix}-qa-agent`,
      correlationId: `correlation-start-${suffix}-qa-agent`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: dispatch.id,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    if (started.type !== "AGENT_RUN_STARTED") throw new Error("Expected Browser QA AgentRun");
    const plan = {
      schemaVersion: 1 as const,
      revision: 1,
      contentHash: `sha256:${"e".repeat(64)}`,
      targets: [
        {
          id: "desktop-light-en",
          viewport: { width: 1_280, height: 800 },
          locale: "en-US",
          theme: "LIGHT" as const,
        },
      ],
      scenarios: [
        {
          id: "task-cockpit",
          title: "Task Cockpit shows the current state",
          steps: [
            {
              id: "open",
              title: "Open the Task Cockpit",
              action: { type: "NAVIGATE" as const, path: "/" },
            },
          ],
          assertions: [
            {
              id: "state-visible",
              title: "The current state is visible",
              rule: {
                type: "VISIBLE" as const,
                locator: { by: "TEXT" as const, value: "Current work" },
              },
            },
          ],
        },
      ],
    };
    const reserved = localState.execute({
      schemaVersion: 1,
      commandId: `reserve-${suffix}-qa`,
      correlationId: `correlation-reserve-${suffix}-qa`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RESERVE_QA_RUN",
      payload: {
        stageAttemptId: dispatch.stageAttemptId,
        agentRunId: started.run.id,
        testedTree,
        targetOrigin: "http://127.0.0.1:4173",
        plan,
        scope: { type: "FULL" },
      },
    });
    if (reserved.type !== "QA_RUN_RESERVED") throw new Error("Expected durable QA reservation");
    const completed = localState.execute({
      schemaVersion: 1,
      commandId: `complete-${suffix}-qa`,
      correlationId: `correlation-complete-${suffix}-qa`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "COMPLETE_QA_RUN",
      payload: {
        qaRunId: reserved.qaRun.id,
        expectedVersion: reserved.qaRun.version,
        currentTree: testedTree,
        result: {
          outcome: "MEASURED",
          environment: {
            osFamily: "MACOS",
            runtimeName: "NODE",
            runtimeVersion: "24.7.0",
            browserName: "CHROMIUM",
            browserVersion: "140.0",
          },
          executions: [
            {
              targetId: "desktop-light-en",
              scenarioId: "task-cockpit",
              durationMs: 80,
              steps: [{ id: "open", status: "PASSED", durationMs: 50 }],
              assertions: [{ id: "state-visible", status: "PASSED", details: null }],
            },
          ],
          observations: [],
          attachments: [],
          defects: [],
        },
        finalizedAttachments: [],
      },
    });
    if (completed.type !== "QA_RUN_COMPLETED" || completed.qaRun.status !== "PASSED") {
      throw new Error("Expected measured browser QA to pass");
    }
  };

  it("reads privacy-safe reporting facts from one aggregate snapshot", async () => {
    const localState = await open();
    expect(localState.query({ type: "GET_REPORTING_FACTS" })).toEqual({
      type: "REPORTING_FACTS",
      facts: {
        workItems: { total: 0, accepted: 0, cancelled: 0, active: 0 },
        pipelineRuns: { total: 0, succeeded: 0, failed: 0, interrupted: 0, cancelled: 0 },
        agentRuns: { total: 0, succeeded: 0, failed: 0, interrupted: 0 },
        reviews: { total: 0, firstRound: 0, firstRoundPassed: 0 },
        qa: {
          total: 0,
          passed: 0,
          failed: 0,
          errored: 0,
          defectsOpen: 0,
          defectsResolved: 0,
          defectsWaived: 0,
        },
        humanRequests: { total: 0, resolved: 0 },
        usage: { estimatedTokens: 0 },
        reliability: { daemonRestartRecoveries: 0 },
      },
    });

    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-reporting-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-reporting-item", created.workItem.id, 1, "READY"));
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-reporting-workflow",
      correlationId: "correlation-start-reporting-workflow",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    localState.execute({
      schemaVersion: 1,
      commandId: "dispatch-reporting-workflow",
      correlationId: "correlation-dispatch-reporting-workflow",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: started.dispatch.id },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: "reconcile-reporting-workflow",
      correlationId: "correlation-reconcile-reporting-workflow",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });

    expect(localState.query({ type: "GET_REPORTING_FACTS" })).toMatchObject({
      type: "REPORTING_FACTS",
      facts: {
        workItems: { total: 1, accepted: 0, cancelled: 0, active: 1 },
        pipelineRuns: { total: 1, succeeded: 0, failed: 0, interrupted: 1, cancelled: 0 },
        reliability: { daemonRestartRecoveries: 1 },
      },
    });
  });

  it("replays a duplicate command without duplicating state or Events", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const command = createWorkItem();
    const created = localState.execute(command);
    const replayed = localState.execute(command);
    const events = localState.query({ type: "LIST_EVENTS" });

    expect(created.type).toBe("WORK_ITEM_CREATED");
    expect(replayed).toMatchObject({ replayed: true });
    expect(
      replayed.type === "WORK_ITEM_CREATED" && created.type === "WORK_ITEM_CREATED"
        ? replayed.workItem.id
        : undefined,
    ).toBe(created.type === "WORK_ITEM_CREATED" ? created.workItem.id : undefined);
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(2);
  });

  it("pages an aggregate's Events newest-first without dropping any across page boundaries", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem());
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("The WorkItem was not created");
    const workItemId = created.workItem.id;

    // Toggle the state so the aggregate accumulates more Events than a single page can hold.
    let version = created.workItem.version;
    for (let move = 0; move < 12; move += 1) {
      const targetState = move % 2 === 0 ? "READY" : "BACKLOG";
      const moved = localState.execute(
        moveWorkItem(`move-${move.toString()}`, workItemId, version, targetState),
      );
      if (moved.type !== "WORK_ITEM_MOVED") throw new Error("The WorkItem was not moved");
      version = moved.workItem.version;
    }

    const listAscending = localState.query({ type: "LIST_EVENTS", aggregateId: workItemId });
    if (listAscending.type !== "EVENTS") throw new Error("The Events were not listed");
    expect(listAscending.events).toHaveLength(13);
    expect(listAscending.hasMore).toBe(false);
    // The ascending default is unchanged: oldest first, cursor at the newest sequence read.
    expect(listAscending.events.at(0)?.type).toBe("WORK_ITEM_CREATED");
    expect(listAscending.nextSequence).toBe(listAscending.events.at(-1)?.sequence);

    const pages = [];
    let beforeSequence: number | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = localState.query({
        type: "LIST_EVENTS",
        aggregateId: workItemId,
        direction: "DESC",
        limit: 5,
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
      });
      if (result.type !== "EVENTS") throw new Error("The Events were not listed");
      pages.push(result);
      beforeSequence = result.nextSequence;
    }

    expect(pages.map((page) => page.events.length)).toEqual([5, 5, 3]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    // Every Event appears exactly once and in strict newest-first order - a shifting cursor would
    // either skip the Events straddling a boundary or repeat them.
    expect(pages.flatMap((page) => page.events.map((event) => event.sequence))).toEqual(
      listAscending.events.map((event) => event.sequence).reverse(),
    );
  });

  it("rejects command ID reuse with different input", async () => {
    const localState = await open();
    localState.execute(registerProject());
    localState.execute(createWorkItem());
    const changed = createWorkItem();
    changed.payload.title = "Different input";

    expect(() => localState.execute(changed)).toThrow(expect.objectContaining({ code: "COMMAND_ID_REUSED" }));
  });

  it("rolls back stale updates and preserves the accepted version", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem());
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    const update: UpdateWorkItemCommand = {
      schemaVersion: 1,
      commandId: "update-work-item",
      correlationId: "correlation-update-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "UPDATE_WORK_ITEM",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        patch: { title: "Stale update" },
      },
    };

    expect(() => localState.execute(update)).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    const loaded = localState.query({ type: "GET_WORK_ITEM", workItemId: created.workItem.id });
    const events = localState.query({ type: "LIST_EVENTS" });
    expect(loaded.type === "WORK_ITEM" ? loaded.workItem?.version : undefined).toBe(1);
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(2);
  });

  it("keeps a parent WorkItem out of execution", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const parent = localState.execute(createWorkItem("create-parent"));
    if (parent.type !== "WORK_ITEM_CREATED") throw new Error("Expected parent creation");
    localState.execute(moveWorkItem("ready-parent", parent.workItem.id, 1, "READY"));
    localState.execute(createWorkItem("create-child", "project-web", parent.workItem.id));

    expect(() =>
      localState.execute(moveWorkItem("start-parent", parent.workItem.id, 2, "IN_PROGRESS")),
    ).toThrow(expect.objectContaining({ code: "WORK_ITEM_HAS_CHILDREN" }));
  });

  it("rejects creating a child below an in-progress WorkItem", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const parent = localState.execute(createWorkItem("create-active-parent"));
    if (parent.type !== "WORK_ITEM_CREATED") throw new Error("Expected parent creation");
    localState.execute(moveWorkItem("ready-active-parent", parent.workItem.id, 1, "READY"));
    localState.execute(moveWorkItem("start-active-parent", parent.workItem.id, 2, "IN_PROGRESS"));

    expect(() =>
      localState.execute(createWorkItem("create-late-child", "project-web", parent.workItem.id)),
    ).toThrow(expect.objectContaining({ code: "PARENT_IN_PROGRESS" }));
    const events = localState.query({ type: "LIST_EVENTS" });
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(4);
  });

  it("reopens accepted state and ordered Events after restart", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem());
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-work-item", created.workItem.id, 1, "READY"));
    localState.close();
    state = undefined;

    const reopened = await open();
    const loaded = reopened.query({ type: "GET_WORK_ITEM", workItemId: created.workItem.id });
    const events = reopened.query({ type: "LIST_EVENTS" });

    expect(loaded.type === "WORK_ITEM" ? loaded.workItem : null).toMatchObject({
      state: "READY",
      version: 2,
    });
    expect(events.type === "EVENTS" ? events.events.map((event) => event.sequence) : []).toEqual([1, 2, 3]);
  });

  it("keeps fixture Projects isolated in WorkItem queries", async () => {
    const localState = await open();
    localState.execute(registerProject());
    localState.execute(registerProject("project-api", "register-api"));
    localState.execute(createWorkItem("create-web", "project-web"));
    localState.execute(createWorkItem("create-api", "project-api"));

    const webItems = localState.query({ type: "LIST_WORK_ITEMS", projectId: "project-web" });
    const apiItems = localState.query({ type: "LIST_WORK_ITEMS", projectId: "project-api" });
    expect(webItems.type === "WORK_ITEMS" ? webItems.workItems : []).toHaveLength(1);
    expect(apiItems.type === "WORK_ITEMS" ? apiItems.workItems : []).toHaveLength(1);
  });

  it("persists Review and QA evidence and gates Done on owner acceptance", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-acceptance-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-acceptance-item", created.workItem.id, 1, "READY"));
    const acceptanceTemplate: StartMockPipelineCommand["payload"]["template"] = {
      schemaVersion: 1,
      id: "acceptance-fixture-v1",
      version: 1,
      name: "Acceptance fixture",
      stages: [
        { stage: "IMPLEMENT", ordinal: 0, contextPack },
        { stage: "REVIEW", ordinal: 1, contextPack },
        { stage: "QA", ordinal: 2, contextPack },
        { stage: "ACCEPTANCE", ordinal: 3, contextPack },
      ],
    };
    localState.execute({
      schemaVersion: 1,
      commandId: "start-acceptance-workflow",
      correlationId: "correlation-start-acceptance-workflow",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: acceptanceTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });

    const applyNext = (
      outcome: ApplyProviderOutcomeCommand["payload"]["outcome"],
      resultTree: string | null = null,
    ): void => {
      const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
      const dispatch = pending.dispatches[0];
      if (!dispatch) throw new Error("Expected a pending dispatch");
      localState.execute({
        schemaVersion: 1,
        commandId: `mark-${dispatch.id}`,
        correlationId: `correlation-mark-${dispatch.id}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: dispatch.id },
      });
      localState.execute({
        schemaVersion: 1,
        commandId: `apply-${dispatch.id}`,
        correlationId: `correlation-apply-${dispatch.id}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: dispatch.id,
          provider: "CODEX",
          template: acceptanceTemplate,
          outcome,
          resultTree,
        },
      });
    };

    const acceptedTree = "a".repeat(40);
    applyNext(
      {
        type: "COMPLETED",
        summary: "Implementation completed.",
      },
      acceptedTree,
    );
    applyNext({
      type: "COMPLETED",
      summary: "Review passed.",
      artifacts: [
        {
          kind: "REVIEW_REPORT",
          title: "Review report",
          summary: "Review passed.",
          checks: ["Contract review passed."],
        },
      ],
    });
    completeMeasuredQA(localState, "acceptance", acceptedTree);
    const pendingAcceptance = localState.query({ type: "LIST_PENDING_DISPATCHES" });
    if (pendingAcceptance.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
    const acceptanceDispatch = pendingAcceptance.dispatches[0];
    if (!acceptanceDispatch) throw new Error("Expected an Acceptance dispatch");
    localState.execute({
      schemaVersion: 1,
      commandId: `mark-${acceptanceDispatch.id}`,
      correlationId: `correlation-mark-${acceptanceDispatch.id}`,
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: acceptanceDispatch.id },
    });
    const beforeInvalid = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    const beforeInvalidEvents = localState.query({
      type: "LIST_EVENTS",
      aggregateId: created.workItem.id,
    });
    const acceptanceOutcome: ApplyProviderOutcomeCommand["payload"]["outcome"] = {
      type: "READY_FOR_ACCEPTANCE",
      releaseNote: "The bounded fixture is ready for owner acceptance.",
      verifyInstructions: ["Run pnpm verify."],
      criteria: [
        {
          criterion: "State is durable",
          implementation: "The durable acceptance flow was implemented.",
          reviewCheck: "Contract review passed.",
          qaCheck: "1 required assertions passed.",
          ownerVerification: "Run pnpm verify.",
          knownRisk: null,
        },
      ],
    };
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-invalid-acceptance-mapping",
        correlationId: "correlation-apply-invalid-acceptance-mapping",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: acceptanceDispatch.id,
          provider: "CODEX",
          template: acceptanceTemplate,
          outcome: {
            ...acceptanceOutcome,
            criteria: acceptanceOutcome.criteria?.map((criterion) => ({
              ...criterion,
              qaCheck: "A stale QA check from another run.",
            })),
          },
          resultTree: null,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "ACCEPTANCE_NOT_READY" }));
    expect(localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: created.workItem.id })).toEqual(
      beforeInvalid,
    );
    expect(localState.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id })).toEqual(
      beforeInvalidEvents,
    );
    const applyAcceptanceCommand: ApplyProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: `apply-${acceptanceDispatch.id}`,
      correlationId: `correlation-apply-${acceptanceDispatch.id}`,
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: acceptanceDispatch.id,
        provider: "CODEX",
        template: acceptanceTemplate,
        outcome: acceptanceOutcome,
        resultTree: null,
      },
    };
    localState.execute(applyAcceptanceCommand);

    const pendingSnapshot = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    if (
      pendingSnapshot.type !== "WORKFLOW_SNAPSHOT" ||
      !pendingSnapshot.snapshot.run ||
      !pendingSnapshot.snapshot.acceptancePackage
    ) {
      throw new Error("Expected a pending acceptance snapshot");
    }
    expect(pendingSnapshot.snapshot).toMatchObject({
      run: { status: "WAITING_HUMAN" },
      artifacts: [
        { kind: "REVIEW_REPORT", provider: "CODEX" },
        {
          kind: "QA_REPORT",
          provider: "CODEX",
          testedTree: acceptedTree,
        },
      ],
      acceptancePackage: { status: "PENDING" },
    });
    const measuredQAArtifact = pendingSnapshot.snapshot.artifacts.find(({ kind }) => kind === "QA_REPORT");
    expect(typeof measuredQAArtifact?.qaRunId).toBe("string");
    expect(typeof measuredQAArtifact?.qaEvidenceBundleId).toBe("string");
    const pendingAttention = localState.query({ type: "GET_ATTENTION_INBOX" });
    expect(pendingAttention.type === "ATTENTION_INBOX" ? pendingAttention.inbox : null).toMatchObject({
      items: [
        {
          project: { id: "project-web" },
          workItem: { id: created.workItem.id },
          stage: { name: "ACCEPTANCE" },
          section: "BLOCKING_NOW",
          category: "APPROVAL",
          action: "REVIEW_ACCEPTANCE",
          acceptancePackageId: pendingSnapshot.snapshot.acceptancePackage.id,
        },
      ],
      hasMore: false,
    });
    localState.close();
    state = undefined;
    const acceptanceState = await open();
    const restored = acceptanceState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    if (
      restored.type !== "WORKFLOW_SNAPSHOT" ||
      !restored.snapshot.run ||
      !restored.snapshot.acceptancePackage
    ) {
      throw new Error("Expected the acceptance snapshot after restart");
    }
    expect(restored.snapshot.artifacts).toHaveLength(2);
    expect(restored.snapshot.acceptancePackage.criteria).toEqual([
      expect.objectContaining({
        criterion: "State is durable",
        reviewCheck: "Contract review passed.",
        qaCheck: "1 required assertions passed.",
      }),
    ]);
    expect(acceptanceState.query({ type: "GET_ATTENTION_INBOX" })).toMatchObject({
      type: "ATTENTION_INBOX",
      inbox: {
        items: [{ acceptancePackageId: restored.snapshot.acceptancePackage.id }],
        hasMore: false,
      },
    });
    const acceptancePackage = restored.snapshot.acceptancePackage;
    const acceptanceCommand = {
      schemaVersion: 1,
      commandId: "accept-persisted-package",
      correlationId: "correlation-accept-persisted-package",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RESOLVE_ACCEPTANCE",
      payload: {
        acceptancePackageId: acceptancePackage.id,
        expectedVersion: acceptancePackage.version,
        expectedRunVersion: restored.snapshot.run.version,
        action: "ACCEPT",
        reason: "Evidence accepted.",
      },
    } as const;
    const accepted = acceptanceState.execute(acceptanceCommand);
    expect(accepted).toMatchObject({
      type: "ACCEPTANCE_RESOLVED",
      acceptancePackage: { status: "ACCEPTED" },
      run: { status: "SUCCEEDED" },
    });
    expect(acceptanceState.query({ type: "GET_ATTENTION_INBOX" })).toMatchObject({
      type: "ATTENTION_INBOX",
      inbox: { items: [], hasMore: false },
    });
    expect(acceptanceState.query({ type: "GET_WORK_ITEM", workItemId: created.workItem.id })).toMatchObject({
      workItem: { state: "DONE" },
    });
    const eventCount = acceptanceState.query({
      type: "LIST_EVENTS",
      aggregateId: created.workItem.id,
    });
    expect(acceptanceState.execute(acceptanceCommand)).toMatchObject({
      type: "ACCEPTANCE_RESOLVED",
      replayed: true,
    });
    const replayedEventCount = acceptanceState.query({
      type: "LIST_EVENTS",
      aggregateId: created.workItem.id,
    });
    expect(replayedEventCount.type === "EVENTS" ? replayedEventCount.events.length : -1).toBe(
      eventCount.type === "EVENTS" ? eventCount.events.length : -2,
    );
    acceptanceState.close();
    state = undefined;
    const raw = new DatabaseSync(databasePath);
    const evidenceTable = raw
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'evidence_artifacts'")
      .get() as { sql: string };
    expect(evidenceTable.sql).toContain("provider IN ('MOCK', 'CODEX', 'CLAUDE_CODE')");
    expect(() =>
      raw
        .prepare(
          `INSERT INTO evidence_artifacts (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            stage, kind, status, provider, title, summary, checks_json, created_at
          )
          SELECT 'artifact-unknown-provider', schema_version, project_id, work_item_id,
            pipeline_run_id, stage_attempt_id, stage, kind, status, 'GPT', title, summary,
            checks_json, created_at
          FROM evidence_artifacts LIMIT 1`,
        )
        .run(),
    ).toThrow(/provider/);
    expect(() => raw.prepare("UPDATE evidence_artifacts SET title = ?").run("Tampered")).toThrow();
    raw.close();

    const historical = new DatabaseSync(databasePath);
    historical.exec("DROP TRIGGER events_are_append_only_update");
    historical.exec("DROP TRIGGER commands_are_append_only_update");
    historical
      .prepare(
        `UPDATE acceptance_packages
         SET criteria_json = json_remove(
           criteria_json,
           '$[0].reviewCheck',
           '$[0].qaCheck'
         )
         WHERE id = ?`,
      )
      .run(acceptancePackage.id);
    historical.exec(`
      UPDATE events
      SET data_json = json_remove(
        data_json,
        '$.acceptancePackage.criteria[0].reviewCheck',
        '$.acceptancePackage.criteria[0].qaCheck'
      )
      WHERE type = 'ACCEPTANCE_REQUESTED'
    `);
    historical
      .prepare(
        `UPDATE commands
         SET result_json = json_remove(
           result_json,
           '$.acceptancePackage.criteria[0].reviewCheck',
           '$.acceptancePackage.criteria[0].qaCheck'
         )
         WHERE command_id = ?`,
      )
      .run(applyAcceptanceCommand.commandId);
    historical.exec(`
      CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands
      BEGIN
        SELECT RAISE(ABORT, 'command receipts are append-only');
      END;
    `);
    historical.close();

    const legacyState = await open();
    const legacySnapshot = legacyState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    if (legacySnapshot.type !== "WORKFLOW_SNAPSHOT" || !legacySnapshot.snapshot.acceptancePackage) {
      throw new Error("Expected a legacy AcceptancePackage after restart");
    }
    expect(legacySnapshot.snapshot.acceptancePackage.criteria).toHaveLength(1);
    expect(
      legacySnapshot.snapshot.acceptancePackage.criteria.every(
        ({ reviewCheck, qaCheck }) => reviewCheck === undefined && qaCheck === undefined,
      ),
    ).toBe(true);
    const legacyEvents = legacyState.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    if (legacyEvents.type !== "EVENTS") throw new Error("Expected legacy acceptance Events");
    const requestedEvent = legacyEvents.events.find(({ type }) => type === "ACCEPTANCE_REQUESTED");
    if (requestedEvent?.type !== "ACCEPTANCE_REQUESTED") {
      throw new Error("Expected a historical acceptance request Event");
    }
    expect(requestedEvent.data.acceptancePackage.criteria).toHaveLength(1);
    expect(
      requestedEvent.data.acceptancePackage.criteria.every(
        ({ reviewCheck, qaCheck }) => reviewCheck === undefined && qaCheck === undefined,
      ),
    ).toBe(true);
    const legacyReceipt = legacyState.execute(applyAcceptanceCommand);
    if (legacyReceipt.type !== "MOCK_PROVIDER_OUTCOME_APPLIED" || !legacyReceipt.acceptancePackage) {
      throw new Error("Expected the historical Acceptance command receipt");
    }
    expect(legacyReceipt.replayed).toBe(true);
    expect(legacyReceipt.acceptancePackage.criteria).toHaveLength(1);
    expect(
      legacyReceipt.acceptancePackage.criteria.every(
        ({ reviewCheck, qaCheck }) => reviewCheck === undefined && qaCheck === undefined,
      ),
    ).toBe(true);
  });

  it("widens the evidence provider without changing rows written before migration 0014", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-pre-0014-evidence-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-pre-0014-evidence", created.workItem.id, 1, "READY"));
    const reviewOnlyTemplate: StartMockPipelineCommand["payload"]["template"] = {
      schemaVersion: 1,
      id: "pre-0014-review-v1",
      version: 1,
      name: "Pre-0014 review fixture",
      stages: [{ stage: "REVIEW", ordinal: 0, contextPack }],
    };
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-pre-0014-review",
      correlationId: "correlation-start-pre-0014-review",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: reviewOnlyTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    localState.execute({
      schemaVersion: 1,
      commandId: "mark-pre-0014-review",
      correlationId: "correlation-mark-pre-0014-review",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: started.dispatch.id },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: "apply-pre-0014-review",
      correlationId: "correlation-apply-pre-0014-review",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: started.dispatch.id,
        template: reviewOnlyTemplate,
        resultTree: null,
        outcome: {
          type: "COMPLETED",
          summary: "Historical mock review completed.",
          artifacts: [
            {
              kind: "REVIEW_REPORT",
              title: "Historical mock review",
              summary: "The row predates live evidence attribution.",
              checks: ["Historical row present"],
            },
          ],
        },
      },
    });
    localState.close();
    state = undefined;

    // Rebuild the one table to its v13 CHECK while preserving the real row above. This is an
    // independent inverse of 0014, not the migration SQL copied backwards: the test would still
    // fail if 0014 forgot the INSERT ... SELECT that carries old data forward.
    const pre14 = new DatabaseSync(databasePath);
    pre14.exec(`
      DROP TRIGGER evidence_artifacts_are_append_only_update;
      DROP TRIGGER evidence_artifacts_are_append_only_delete;
      DROP INDEX evidence_artifacts_run_created_idx;
      ALTER TABLE evidence_artifacts RENAME TO evidence_artifacts_current;
      CREATE TABLE evidence_artifacts (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
        pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
        stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
        stage TEXT NOT NULL CHECK (stage IN ('REVIEW', 'QA')),
        kind TEXT NOT NULL CHECK (kind IN ('REVIEW_REPORT', 'QA_REPORT')),
        status TEXT NOT NULL CHECK (status = 'PASSED'),
        provider TEXT NOT NULL CHECK (provider = 'MOCK'),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
        checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
        created_at TEXT NOT NULL,
        UNIQUE (pipeline_run_id, kind)
      ) STRICT;
      INSERT INTO evidence_artifacts (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        stage, kind, status, provider, title, summary, checks_json, created_at
      )
      SELECT
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        stage, kind, status, provider, title, summary, checks_json, created_at
      FROM evidence_artifacts_current;
      DROP TABLE evidence_artifacts_current;
      CREATE INDEX evidence_artifacts_run_created_idx
        ON evidence_artifacts(pipeline_run_id, created_at, id);
      CREATE TRIGGER evidence_artifacts_are_append_only_update
      BEFORE UPDATE ON evidence_artifacts BEGIN
        SELECT RAISE(ABORT, 'evidence artifacts are append-only');
      END;
      CREATE TRIGGER evidence_artifacts_are_append_only_delete
      BEFORE DELETE ON evidence_artifacts BEGIN
        SELECT RAISE(ABORT, 'evidence artifacts are append-only');
      END;
      DELETE FROM schema_migrations WHERE version IN (14, 23, 26);
    `);
    expect(
      (pre14.prepare("SELECT provider FROM evidence_artifacts").get() as { provider: string }).provider,
    ).toBe("MOCK");
    pre14.close();

    const migrated = await open();
    expect(migrated.startup.appliedMigrations).toEqual([14, 23, 26]);
    const snapshot = migrated.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    expect(snapshot).toMatchObject({
      snapshot: { artifacts: [{ kind: "REVIEW_REPORT", provider: "MOCK" }] },
    });
  });

  it("creates a backup before migrating an existing non-empty database", async () => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL) STRICT");
    legacy.prepare("INSERT INTO legacy_marker (value) VALUES (?)").run("preserve-me");
    legacy.close();

    const localState = await open();
    expect(localState.startup.appliedMigrations).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
      29, 30, 31, 32,
    ]);
    expect(localState.startup.backupPath).toBeDefined();
    if (!localState.startup.backupPath) throw new Error("Expected a migration backup");
    await access(localState.startup.backupPath);
    const backup = new DatabaseSync(localState.startup.backupPath, { readOnly: true });
    expect(backup.prepare("SELECT value FROM legacy_marker").get()).toEqual({ value: "preserve-me" });
    backup.close();
  });

  it("persists bounded QA correction lineage and local cycle numbering", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-q2-lineage"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-q2-lineage", created.workItem.id, 1, "READY"));
    const qaOnlyTemplate: StartMockPipelineCommand["payload"]["template"] = {
      schemaVersion: 1,
      id: "q2-lineage-v1",
      version: 1,
      name: "Q2 lineage fixture",
      stages: [{ stage: "QA", ordinal: 0, contextPack }],
    };
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: "pipeline-q2-lineage",
      correlationId: "correlation-pipeline-q2-lineage",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: qaOnlyTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    localState.close();
    state = undefined;

    const testedTree = "c".repeat(40);
    const planHash = `sha256:${"d".repeat(64)}`;
    const plan = {
      schemaVersion: 1,
      revision: 1,
      contentHash: planHash,
      targets: [
        {
          id: "mobile-dark-ru",
          viewport: { width: 320, height: 720 },
          locale: "ru-RU",
          theme: "DARK",
        },
      ],
      scenarios: [
        {
          id: "task-cockpit",
          title: "Task Cockpit remains usable on mobile",
          steps: [
            {
              id: "open",
              title: "Open the Task Cockpit",
              action: { type: "NAVIGATE", path: "/" },
            },
          ],
          assertions: [
            {
              id: "no-overflow",
              title: "The page does not overflow horizontally",
              rule: { type: "NO_HORIZONTAL_OVERFLOW" },
            },
          ],
        },
      ],
    };
    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA foreign_keys = ON");
    const assignment = raw
      .prepare("SELECT id FROM squad_assignments WHERE pipeline_run_id = ?")
      .get(pipeline.run.id) as { id: string };
    const insertAgentRun = raw.prepare(
      `INSERT INTO agent_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id, ordinal,
        squad_assignment_id, profile_id, profile_revision, profile_role, provider, status,
        policy_snapshot_hash, started_at, finished_at, version
      ) VALUES (?, 1, ?, ?, ?, ?, 1, ?, 'builtin.browser-qa', 1, 'BROWSER_QA', 'CODEX', ?, ?, ?, ?, ?)`,
    );
    insertAgentRun.run(
      "q2-baseline-agent",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      pipeline.stageAttempt.id,
      assignment.id,
      "SUCCEEDED",
      `sha256:${"a".repeat(64)}`,
      timestamp,
      timestamp,
      2,
    );
    raw
      .prepare(
        `INSERT INTO qa_runs (
          id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
          agent_run_id, driver_id, tested_tree, target_origin, plan_json, correction_run_id,
          retest_plan_id, status, error_code, error_summary, started_at, completed_at, version
        ) VALUES (?, 1, ?, ?, ?, ?, ?, 'PLAYWRIGHT', ?, ?, ?, NULL, NULL,
          'FAILED', NULL, NULL, ?, ?, 2)`,
      )
      .run(
        "q2-baseline-qa-run",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        pipeline.stageAttempt.id,
        "q2-baseline-agent",
        testedTree,
        "http://127.0.0.1:4173",
        JSON.stringify(plan),
        timestamp,
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO qa_defects (
          id, schema_version, qa_run_id, project_id, work_item_id, tested_tree, ordinal,
          severity, status, title, description, reproduction_json, target_id, scenario_id,
          resolution_reason, created_at, resolved_at, version
        ) VALUES (?, 1, ?, ?, ?, ?, 1, 'HIGH', 'OPEN', ?, ?, ?, ?, ?, NULL, ?, NULL, 1)`,
      )
      .run(
        "q2-source-defect",
        "q2-baseline-qa-run",
        created.workItem.projectId,
        created.workItem.id,
        testedTree,
        "Task Cockpit overflows on mobile",
        "The page width exceeds the viewport.",
        JSON.stringify(["Open the Task Cockpit at 320x720."]),
        "mobile-dark-ru",
        "task-cockpit",
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO qa_evidence_bundles (
          id, schema_version, qa_run_id, project_id, work_item_id, pipeline_run_id,
          stage_attempt_id, tested_tree, verdict, environment_json, executions_json,
          observations_json, attachment_ids_json, defect_ids_json, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'FAILED', ?, ?, '[]', '[]', ?, ?)`,
      )
      .run(
        "q2-source-evidence",
        "q2-baseline-qa-run",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        pipeline.stageAttempt.id,
        testedTree,
        JSON.stringify({
          osFamily: "MACOS",
          runtimeName: "NODE",
          runtimeVersion: "24.7.0",
          browserName: "CHROMIUM",
          browserVersion: "140.0",
        }),
        JSON.stringify([
          {
            targetId: "mobile-dark-ru",
            scenarioId: "task-cockpit",
            durationMs: 90,
            steps: [{ id: "open", status: "PASSED", durationMs: 40 }],
            assertions: [{ id: "no-overflow", status: "FAILED", details: "24px overflow" }],
          },
        ]),
        JSON.stringify(["q2-source-defect"]),
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO qa_correction_runs (
          id, schema_version, project_id, work_item_id, pipeline_run_id, ordinal,
          source_qa_run_id, baseline_qa_run_id, source_evidence_bundle_id, source_tested_tree,
          defect_ids_json, status, created_at, completed_at, version
        ) VALUES (?, 1, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, 1)`,
      )
      .run(
        "q2-correction-1",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        "q2-baseline-qa-run",
        "q2-baseline-qa-run",
        "q2-source-evidence",
        testedTree,
        JSON.stringify(["q2-source-defect"]),
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO qa_retest_plans (
          id, schema_version, project_id, work_item_id, pipeline_run_id, correction_run_id,
          baseline_qa_run_id, source_qa_run_id, source_evidence_bundle_id,
          baseline_plan_revision, baseline_plan_content_hash, cells_json, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        "q2-retest-plan-1",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        "q2-correction-1",
        "q2-baseline-qa-run",
        "q2-baseline-qa-run",
        "q2-source-evidence",
        planHash,
        JSON.stringify([
          {
            targetId: "mobile-dark-ru",
            scenarioId: "task-cockpit",
            reasons: ["FAILED_CHECK", "OPEN_DEFECT"],
          },
        ]),
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO stage_attempts (
          id, pipeline_run_id, project_id, work_item_id, correction_run_id, stage, attempt,
          status, version, started_at, finished_at, failure_code, unproductive_sessions,
          pack_share_backoffs, result_tree
        ) VALUES (?, ?, ?, ?, ?, 'QA', 1, 'RUNNING', 1, ?, NULL, NULL, 0, 0, NULL)`,
      )
      .run(
        "q2-correction-qa-attempt",
        pipeline.run.id,
        created.workItem.projectId,
        created.workItem.id,
        "q2-correction-1",
        timestamp,
      );
    const insertReviewAttempt = raw.prepare(
      `INSERT INTO stage_attempts (
        id, pipeline_run_id, project_id, work_item_id, correction_run_id, stage, attempt,
        status, version, started_at, finished_at, failure_code, unproductive_sessions,
        pack_share_backoffs, result_tree
      ) VALUES (?, ?, ?, ?, ?, 'REVIEW', 1, 'SUCCEEDED', 2, ?, ?, NULL, 0, 0, ?)`,
    );
    insertReviewAttempt.run(
      "q2-initial-review-attempt",
      pipeline.run.id,
      created.workItem.projectId,
      created.workItem.id,
      null,
      timestamp,
      timestamp,
      testedTree,
    );
    insertReviewAttempt.run(
      "q2-correction-review-attempt",
      pipeline.run.id,
      created.workItem.projectId,
      created.workItem.id,
      "q2-correction-1",
      timestamp,
      timestamp,
      testedTree,
    );
    const insertReviewAgentRun = raw.prepare(
      `INSERT INTO agent_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id, ordinal,
        squad_assignment_id, profile_id, profile_revision, profile_role, provider, status,
        policy_snapshot_hash, started_at, finished_at, version
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'SUCCEEDED', ?, ?, ?, 2)`,
    );
    const reviewAgents = [
      ["q2-initial-review-author", "q2-initial-review-attempt", 1, "builtin.developer", "DEVELOPER", "CODEX"],
      [
        "q2-initial-reviewer",
        "q2-initial-review-attempt",
        2,
        "builtin.code-reviewer",
        "CODE_REVIEWER",
        "CLAUDE_CODE",
      ],
      [
        "q2-correction-review-author",
        "q2-correction-review-attempt",
        1,
        "builtin.developer",
        "DEVELOPER",
        "CODEX",
      ],
      [
        "q2-correction-reviewer",
        "q2-correction-review-attempt",
        2,
        "builtin.code-reviewer",
        "CODE_REVIEWER",
        "CLAUDE_CODE",
      ],
    ] as const;
    for (const [id, stageAttemptId, ordinal, profileId, profileRole, provider] of reviewAgents) {
      insertReviewAgentRun.run(
        id,
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        stageAttemptId,
        ordinal,
        assignment.id,
        profileId,
        profileRole,
        provider,
        `sha256:${"e".repeat(64)}`,
        timestamp,
        timestamp,
      );
    }
    const insertReviewReport = raw.prepare(
      `INSERT INTO review_reports (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        correction_run_id, author_agent_run_id, reviewer_agent_run_id, provider_relation,
        reviewed_tree, round, title, summary, checks_json, verdict, finding_ids_json, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'CROSS_PROVIDER', ?, 1, ?, ?, ?, 'PASSED', '[]', ?)`,
    );
    insertReviewReport.run(
      "q2-initial-review-report",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      "q2-initial-review-attempt",
      null,
      "q2-initial-review-author",
      "q2-initial-reviewer",
      testedTree,
      "Initial review",
      "The initial review passed.",
      JSON.stringify(["Reviewed the initial delivery tree."]),
      timestamp,
    );
    insertReviewReport.run(
      "q2-correction-review-report",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      "q2-correction-review-attempt",
      "q2-correction-1",
      "q2-correction-review-author",
      "q2-correction-reviewer",
      testedTree,
      "Correction review",
      "The correction review passed.",
      JSON.stringify(["Reviewed the correction tree independently."]),
      timestamp,
    );
    const insertReviewArtifact = raw.prepare(
      `INSERT INTO evidence_artifacts (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        correction_run_id, stage, kind, status, provider, title, summary, checks_json,
        review_report_id, qa_run_id, qa_evidence_bundle_id, tested_tree, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, 'REVIEW', 'REVIEW_REPORT', 'PASSED', 'CLAUDE_CODE',
        ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    );
    insertReviewArtifact.run(
      "q2-initial-review-artifact",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      "q2-initial-review-attempt",
      null,
      "Initial review evidence",
      "The initial review passed.",
      JSON.stringify(["Reviewed the initial delivery tree."]),
      "q2-initial-review-report",
      testedTree,
      timestamp,
    );
    insertReviewArtifact.run(
      "q2-correction-review-artifact",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      "q2-correction-review-attempt",
      "q2-correction-1",
      "Correction review evidence",
      "The correction review passed.",
      JSON.stringify(["Reviewed the correction tree independently."]),
      "q2-correction-review-report",
      testedTree,
      timestamp,
    );
    insertAgentRun.run(
      "q2-retest-agent",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      "q2-correction-qa-attempt",
      assignment.id,
      "RUNNING",
      `sha256:${"b".repeat(64)}`,
      timestamp,
      null,
      1,
    );
    raw
      .prepare(
        `INSERT INTO qa_runs (
          id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
          agent_run_id, driver_id, tested_tree, target_origin, plan_json, correction_run_id,
          retest_plan_id, status, error_code, error_summary, started_at, completed_at, version
        ) VALUES (?, 1, ?, ?, ?, ?, ?, 'PLAYWRIGHT', ?, ?, ?, ?, ?,
          'RUNNING', NULL, NULL, ?, NULL, 1)`,
      )
      .run(
        "q2-retest-qa-run",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        "q2-correction-qa-attempt",
        "q2-retest-agent",
        testedTree,
        "http://127.0.0.1:4173",
        JSON.stringify(plan),
        "q2-correction-1",
        "q2-retest-plan-1",
        timestamp,
      );

    expect(() => {
      raw.exec(`UPDATE qa_retest_plans SET cells_json = '[]' WHERE id = 'q2-retest-plan-1'`);
    }).toThrow(/append-only/);
    expect(() => {
      raw.exec(`
        INSERT INTO stage_attempts (
          id, pipeline_run_id, project_id, work_item_id, correction_run_id, stage, attempt,
          status, version, started_at, finished_at, failure_code, unproductive_sessions,
          pack_share_backoffs, result_tree
        ) SELECT
          'q2-duplicate-cycle-attempt', pipeline_run_id, project_id, work_item_id,
          correction_run_id, stage, attempt, status, version, started_at, finished_at,
          failure_code, unproductive_sessions, pack_share_backoffs, result_tree
        FROM stage_attempts WHERE id = 'q2-correction-qa-attempt'
      `);
    }).toThrow(/UNIQUE constraint failed/);
    expect(() => {
      raw.exec(`
        INSERT INTO qa_correction_runs (
          id, schema_version, project_id, work_item_id, pipeline_run_id, ordinal,
          source_qa_run_id, baseline_qa_run_id, source_evidence_bundle_id, source_tested_tree,
          defect_ids_json, status, created_at, completed_at, version
        ) SELECT
          'q2-correction-2', schema_version, project_id, work_item_id, pipeline_run_id, 2,
          source_qa_run_id, baseline_qa_run_id, source_evidence_bundle_id, source_tested_tree,
          defect_ids_json, status, created_at, completed_at, version
        FROM qa_correction_runs WHERE id = 'q2-correction-1'
      `);
    }).toThrow(/UNIQUE constraint failed/);
    expect(() => {
      raw
        .prepare(
          `INSERT INTO qa_runs (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            agent_run_id, driver_id, tested_tree, target_origin, plan_json, correction_run_id,
            retest_plan_id, status, error_code, error_summary, started_at, completed_at, version
          ) VALUES ('q2-half-scoped-run', 1, ?, ?, ?, ?, 'missing-agent', 'PLAYWRIGHT', ?, ?, ?, ?,
            NULL, 'RUNNING', NULL, NULL, ?, NULL, 1)`,
        )
        .run(
          created.workItem.projectId,
          created.workItem.id,
          pipeline.run.id,
          "q2-correction-qa-attempt",
          testedTree,
          "http://127.0.0.1:4173",
          JSON.stringify(plan),
          "q2-correction-1",
          timestamp,
        );
    }).toThrow(/correction scope is invalid/);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();

    const reopened = await open();
    expect(reopened.query({ type: "GET_QA_RUN", qaRunId: "q2-retest-qa-run" })).toMatchObject({
      type: "QA_RUN",
      qaRun: {
        scope: {
          type: "RETEST",
          correctionRunId: "q2-correction-1",
          retestPlanId: "q2-retest-plan-1",
        },
      },
    });
    const reviewReports = reopened.query({
      type: "LIST_REVIEW_REPORTS",
      pipelineRunId: pipeline.run.id,
    });
    if (reviewReports.type !== "REVIEW_REPORTS") throw new Error("Expected review reports");
    expect(reviewReports.reports).toHaveLength(2);
    expect(reviewReports.reports.find(({ id }) => id === "q2-initial-review-report")).toMatchObject({
      correctionRunId: null,
      round: 1,
    });
    expect(reviewReports.reports.find(({ id }) => id === "q2-correction-review-report")).toMatchObject({
      correctionRunId: "q2-correction-1",
      round: 1,
    });
    const snapshot = reopened.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    if (snapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
    expect(
      snapshot.snapshot.stageAttempts.filter(({ stage, attempt }) => stage === "QA" && attempt === 1),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pipeline.stageAttempt.id, correctionRunId: null }),
        expect.objectContaining({
          id: "q2-correction-qa-attempt",
          correctionRunId: "q2-correction-1",
        }),
      ]),
    );
    expect(snapshot.snapshot.artifacts).toHaveLength(2);
    expect(
      snapshot.snapshot.artifacts.find(({ id }) => id === "q2-correction-review-artifact"),
    ).toMatchObject({
      correctionRunId: "q2-correction-1",
      reviewReportId: "q2-correction-review-report",
      testedTree,
    });

    const waiverCommand = {
      schemaVersion: 1 as const,
      commandId: "waive-q2-source-defect",
      correlationId: "correlation-waive-q2-source-defect",
      actor: { type: "HUMAN" as const, id: "local-owner" },
      type: "WAIVE_QA_DEFECT" as const,
      payload: {
        defectId: "q2-source-defect",
        expectedVersion: 1,
        reason: "The owner accepts the documented responsive-layout risk for this bounded delivery.",
      },
    };
    expect(() =>
      reopened.execute({
        ...waiverCommand,
        commandId: "provider-waive-q2-source-defect",
        actor: { type: "SYSTEM", id: "provider" },
      }),
    ).toThrow(expect.objectContaining({ code: "QA_DEFECT_ACTOR_FORBIDDEN" }));
    expect(() =>
      reopened.execute({
        ...waiverCommand,
        commandId: "stale-waive-q2-source-defect",
        payload: { ...waiverCommand.payload, expectedVersion: 2 },
      }),
    ).toThrow(expect.objectContaining({ code: "QA_DEFECT_VERSION_CONFLICT" }));
    expect(reopened.execute(waiverCommand)).toMatchObject({
      type: "QA_DEFECT_WAIVED",
      replayed: false,
      defect: {
        id: "q2-source-defect",
        status: "WAIVED",
        resolutionReason:
          "The owner accepts the documented responsive-layout risk for this bounded delivery.",
        version: 2,
      },
      event: {
        type: "QA_DEFECT_WAIVED",
        actor: { type: "HUMAN", id: "local-owner" },
      },
    });
    expect(reopened.execute(waiverCommand)).toMatchObject({
      type: "QA_DEFECT_WAIVED",
      replayed: true,
      defect: { status: "WAIVED", version: 2 },
    });
    expect(reopened.query({ type: "GET_QA_STATE", pipelineRunId: pipeline.run.id })).toMatchObject({
      type: "QA_STATE",
      runs: [
        { id: "q2-baseline-qa-run", status: "FAILED" },
        { id: "q2-retest-qa-run", status: "RUNNING" },
      ],
      defects: [{ id: "q2-source-defect", status: "WAIVED", version: 2 }],
    });
    const afterWaiver = reopened.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    expect(afterWaiver).toMatchObject({
      type: "WORKFLOW_SNAPSHOT",
      snapshot: { artifacts: [{}, {}], acceptancePackage: null },
    });
    reopened.close();
    state = undefined;

    const waiverRestart = await open();
    expect(waiverRestart.query({ type: "GET_QA_STATE", pipelineRunId: pipeline.run.id })).toMatchObject({
      type: "QA_STATE",
      defects: [{ id: "q2-source-defect", status: "WAIVED", version: 2 }],
    });
    expect(() =>
      waiverRestart.execute({
        ...waiverCommand,
        commandId: "waive-q2-source-defect-again",
        payload: { ...waiverCommand.payload, expectedVersion: 2 },
      }),
    ).toThrow(expect.objectContaining({ code: "QA_DEFECT_ALREADY_CLOSED" }));
    waiverRestart.close();
    state = undefined;

    const durable = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      durable.prepare("SELECT status FROM qa_correction_runs WHERE id = ?").get("q2-correction-1"),
    ).toEqual({ status: "ACTIVE" });
    durable.close();
  });

  it("resolves an exhausted QA gate atomically and preserves the final correction across restart", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-q2-owner-gate"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-q2-owner-gate", created.workItem.id, 1, "READY"));
    const template: StartMockPipelineCommand["payload"]["template"] = {
      schemaVersion: 1,
      id: "q2-owner-gate-v1",
      version: 1,
      name: "Q2 exhausted correction gate",
      stages: [{ stage: "QA", ordinal: 0, contextPack }],
    };
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: "pipeline-q2-owner-gate",
      correlationId: "correlation-pipeline-q2-owner-gate",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    const baselineAgent = localState.execute({
      schemaVersion: 1,
      commandId: "q2-owner-gate-baseline-agent",
      correlationId: "correlation-q2-owner-gate-baseline-agent",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: pipeline.dispatch.id,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    if (baselineAgent.type !== "AGENT_RUN_STARTED") throw new Error("Expected baseline QA AgentRun");
    localState.close();
    state = undefined;

    const testedTree = "f".repeat(40);
    const plan = {
      schemaVersion: 1,
      revision: 1,
      contentHash: `sha256:${"c".repeat(64)}`,
      targets: [
        {
          id: "mobile-dark-ru",
          viewport: { width: 320, height: 720 },
          locale: "ru-RU",
          theme: "DARK",
        },
      ],
      scenarios: [
        {
          id: "task-cockpit",
          title: "Task Cockpit remains usable on mobile",
          steps: [{ id: "open", title: "Open the Task Cockpit", action: { type: "NAVIGATE", path: "/" } }],
          assertions: [
            {
              id: "no-overflow",
              title: "The page does not overflow horizontally",
              rule: { type: "NO_HORIZONTAL_OVERFLOW" },
            },
          ],
        },
      ],
    };
    const environment = {
      osFamily: "MACOS",
      runtimeName: "NODE",
      runtimeVersion: "24.7.0",
      browserName: "CHROMIUM",
      browserVersion: "140.0",
    };
    const executions = [
      {
        targetId: "mobile-dark-ru",
        scenarioId: "task-cockpit",
        durationMs: 90,
        steps: [{ id: "open", status: "PASSED", durationMs: 40 }],
        assertions: [{ id: "no-overflow", status: "FAILED", details: "24px overflow" }],
      },
    ];
    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA foreign_keys = ON");
    const assignment = raw
      .prepare("SELECT id FROM squad_assignments WHERE pipeline_run_id = ?")
      .get(pipeline.run.id) as { id: string };
    raw
      .prepare(
        `UPDATE agent_runs SET status = 'SUCCEEDED', finished_at = ?, version = 2
         WHERE id = ? AND status = 'RUNNING' AND version = 1`,
      )
      .run(timestamp, baselineAgent.run.id);
    raw
      .prepare(
        `UPDATE stage_attempts SET status = 'SUCCEEDED', finished_at = ?, result_tree = ?, version = 2
         WHERE id = ? AND version = 1`,
      )
      .run(timestamp, testedTree, pipeline.stageAttempt.id);
    const insertQARun = raw.prepare(
      `INSERT INTO qa_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        agent_run_id, driver_id, tested_tree, target_origin, plan_json, correction_run_id,
        retest_plan_id, status, error_code, error_summary, started_at, completed_at, version
      ) VALUES (?, 1, ?, ?, ?, ?, ?, 'PLAYWRIGHT', ?, ?, ?, ?, ?,
        'FAILED', NULL, NULL, ?, ?, 2)`,
    );
    insertQARun.run(
      "q2-owner-gate-baseline-run",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      pipeline.stageAttempt.id,
      baselineAgent.run.id,
      testedTree,
      "http://127.0.0.1:4173",
      JSON.stringify(plan),
      null,
      null,
      timestamp,
      timestamp,
    );
    raw
      .prepare(
        `INSERT INTO qa_defects (
          id, schema_version, qa_run_id, project_id, work_item_id, tested_tree, ordinal,
          severity, status, title, description, reproduction_json, target_id, scenario_id,
          resolution_reason, resolved_by_qa_run_id, created_at, resolved_at, version
        ) VALUES (?, 1, ?, ?, ?, ?, 1, 'HIGH', 'OPEN', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 1)`,
      )
      .run(
        "q2-owner-gate-defect",
        "q2-owner-gate-baseline-run",
        created.workItem.projectId,
        created.workItem.id,
        testedTree,
        "Task Cockpit overflows on mobile",
        "The page width exceeds the viewport.",
        JSON.stringify(["Open the Task Cockpit at 320x720."]),
        "mobile-dark-ru",
        "task-cockpit",
        timestamp,
      );
    const insertEvidence = raw.prepare(
      `INSERT INTO qa_evidence_bundles (
        id, schema_version, qa_run_id, project_id, work_item_id, pipeline_run_id,
        stage_attempt_id, tested_tree, verdict, environment_json, executions_json,
        observations_json, attachment_ids_json, defect_ids_json, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'FAILED', ?, ?, '[]', '[]', ?, ?)`,
    );
    insertEvidence.run(
      "q2-owner-gate-baseline-evidence",
      "q2-owner-gate-baseline-run",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      pipeline.stageAttempt.id,
      testedTree,
      JSON.stringify(environment),
      JSON.stringify(executions),
      JSON.stringify(["q2-owner-gate-defect"]),
      timestamp,
    );
    raw
      .prepare(
        `INSERT INTO qa_correction_runs (
          id, schema_version, project_id, work_item_id, pipeline_run_id, ordinal,
          source_qa_run_id, baseline_qa_run_id, source_evidence_bundle_id, source_tested_tree,
          defect_ids_json, status, created_at, completed_at, version
        ) VALUES (?, 1, ?, ?, ?, 2, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, 1)`,
      )
      .run(
        "q2-owner-gate-correction-2",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        "q2-owner-gate-baseline-run",
        "q2-owner-gate-baseline-run",
        "q2-owner-gate-baseline-evidence",
        testedTree,
        JSON.stringify(["q2-owner-gate-defect"]),
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO qa_retest_plans (
          id, schema_version, project_id, work_item_id, pipeline_run_id, correction_run_id,
          baseline_qa_run_id, source_qa_run_id, source_evidence_bundle_id,
          baseline_plan_revision, baseline_plan_content_hash, cells_json, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        "q2-owner-gate-retest-2",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        "q2-owner-gate-correction-2",
        "q2-owner-gate-baseline-run",
        "q2-owner-gate-baseline-run",
        "q2-owner-gate-baseline-evidence",
        plan.contentHash,
        JSON.stringify([
          {
            targetId: "mobile-dark-ru",
            scenarioId: "task-cockpit",
            reasons: ["FAILED_CHECK", "OPEN_DEFECT"],
          },
        ]),
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO stage_attempts (
          id, pipeline_run_id, project_id, work_item_id, correction_run_id, stage, attempt,
          status, version, started_at, finished_at, failure_code, unproductive_sessions,
          pack_share_backoffs, result_tree
        ) VALUES (?, ?, ?, ?, ?, 'QA', 1, 'WAITING_HUMAN', 1, ?, NULL,
          'QA_CORRECTION_EXHAUSTED', 0, 0, NULL)`,
      )
      .run(
        "q2-owner-gate-qa-attempt",
        pipeline.run.id,
        created.workItem.projectId,
        created.workItem.id,
        "q2-owner-gate-correction-2",
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO agent_runs (
          id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id, ordinal,
          squad_assignment_id, profile_id, profile_revision, profile_role, provider, status,
          policy_snapshot_hash, started_at, finished_at, version
        ) VALUES (?, 1, ?, ?, ?, ?, 1, ?, 'builtin.browser-qa', 1, 'BROWSER_QA', 'CODEX',
          'SUCCEEDED', ?, ?, ?, 2)`,
      )
      .run(
        "q2-owner-gate-retest-agent",
        created.workItem.projectId,
        created.workItem.id,
        pipeline.run.id,
        "q2-owner-gate-qa-attempt",
        assignment.id,
        `sha256:${"e".repeat(64)}`,
        timestamp,
        timestamp,
      );
    insertQARun.run(
      "q2-owner-gate-retest-run",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      "q2-owner-gate-qa-attempt",
      "q2-owner-gate-retest-agent",
      testedTree,
      "http://127.0.0.1:4173",
      JSON.stringify(plan),
      "q2-owner-gate-correction-2",
      "q2-owner-gate-retest-2",
      timestamp,
      timestamp,
    );
    insertEvidence.run(
      "q2-owner-gate-retest-evidence",
      "q2-owner-gate-retest-run",
      created.workItem.projectId,
      created.workItem.id,
      pipeline.run.id,
      "q2-owner-gate-qa-attempt",
      testedTree,
      JSON.stringify(environment),
      JSON.stringify(executions),
      JSON.stringify(["q2-owner-gate-defect"]),
      timestamp,
    );
    raw
      .prepare(
        `UPDATE qa_correction_runs SET status = 'EXHAUSTED', version = 2
         WHERE id = 'q2-owner-gate-correction-2' AND status = 'ACTIVE' AND version = 1`,
      )
      .run();
    raw
      .prepare(
        `UPDATE pipeline_runs SET status = 'WAITING_HUMAN', orchestration_status = 'WAITING_HUMAN',
          current_stage_attempt_id = 'q2-owner-gate-qa-attempt', version = 2, updated_at = ?
         WHERE id = ? AND version = 1`,
      )
      .run(timestamp, pipeline.run.id);
    raw
      .prepare(
        `UPDATE work_items SET state = 'BLOCKED', current_stage = 'QA', version = version + 1,
          updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, created.workItem.id);
    raw
      .prepare(
        `INSERT INTO human_requests (
          id, project_id, work_item_id, stage_attempt_id, kind, blocking, title, context,
          recommendation, allow_other, status, version, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, 'SINGLE_CHOICE', 1, ?, ?, ?, 0, 'OPEN', 1, ?, NULL)`,
      )
      .run(
        "q2-owner-gate-request",
        created.workItem.projectId,
        created.workItem.id,
        "q2-owner-gate-qa-attempt",
        "QA correction loop needs a decision",
        "Two automatic QA correction runs still ended in measured defects.",
        "Inspect the complete defect and evidence history.",
        timestamp,
      );
    const insertOption = raw.prepare(
      `INSERT INTO human_request_options
       (human_request_id, ordinal, id, label, consequence, recommended)
       VALUES ('q2-owner-gate-request', ?, ?, ?, ?, ?)`,
    );
    insertOption.run(
      0,
      "q2-owner-gate-authorize",
      "Authorize one final QA correction",
      "Creates CorrectionRun 3 with a locked retest plan.",
      1,
    );
    insertOption.run(
      1,
      "q2-owner-gate-cancel",
      "Cancel the delivery",
      "Stops this PipelineRun without acceptance.",
      0,
    );
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();

    const reopened = await open();
    expect(() =>
      reopened.execute({
        schemaVersion: 1,
        commandId: "generic-answer-q2-owner-gate",
        correlationId: "correlation-generic-answer-q2-owner-gate",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ANSWER_HUMAN_REQUEST",
        payload: {
          humanRequestId: "q2-owner-gate-request",
          expectedVersion: 1,
          answer: { type: "OPTION", optionIds: ["q2-owner-gate-authorize"] },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }));
    const command = {
      schemaVersion: 1 as const,
      commandId: "resolve-q2-owner-gate",
      correlationId: "correlation-resolve-q2-owner-gate",
      actor: { type: "HUMAN" as const, id: "local-owner" },
      type: "RESOLVE_QA_CORRECTION_GATE" as const,
      payload: {
        humanRequestId: "q2-owner-gate-request",
        expectedRequestVersion: 1,
        correctionRunId: "q2-owner-gate-correction-2",
        expectedCorrectionVersion: 2,
        expectedPipelineRunVersion: 2,
        action: "AUTHORIZE_FINAL" as const,
      },
    };
    const resolved = reopened.execute(command);
    if (resolved.type !== "QA_CORRECTION_GATE_RESOLVED" || resolved.correctionRun === null) {
      throw new Error("Expected the final QA correction to start");
    }
    const finalCorrectionId = resolved.correctionRun.id;
    expect(resolved).toMatchObject({
      type: "QA_CORRECTION_GATE_RESOLVED",
      replayed: false,
      action: "AUTHORIZE_FINAL",
      request: { status: "RESOLVED", version: 2 },
      decision: { answer: { type: "OPTION", optionIds: ["q2-owner-gate-authorize"] } },
      previousCorrection: { id: "q2-owner-gate-correction-2", status: "SUPERSEDED", version: 3 },
      correctionRun: { ordinal: 3, status: "ACTIVE", version: 1 },
      retestPlan: { sourceQARunId: "q2-owner-gate-retest-run" },
      run: { status: "RUNNING", version: 3 },
      stageAttempt: { id: "q2-owner-gate-qa-attempt", status: "SUCCEEDED", version: 2 },
      dispatch: { status: "PENDING" },
    });
    expect(resolved.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["HUMAN_REQUEST_RESOLVED", "QA_CORRECTION_STARTED", "STAGE_ATTEMPT_CHANGED"]),
    );
    expect(reopened.execute(command)).toMatchObject({
      type: "QA_CORRECTION_GATE_RESOLVED",
      replayed: true,
    });
    reopened.close();
    state = undefined;

    const restarted = await open();
    const restartedQA = restarted.query({ type: "GET_QA_STATE", pipelineRunId: pipeline.run.id });
    expect(restartedQA).toMatchObject({
      type: "QA_STATE",
      correctionRuns: [
        { ordinal: 2, status: "SUPERSEDED", version: 3 },
        { ordinal: 3, status: "ACTIVE", version: 1 },
      ],
    });
    if (restartedQA.type !== "QA_STATE") throw new Error("Expected restarted QA state");
    expect(
      restartedQA.retestPlans.some(({ correctionRunId }) => correctionRunId === "q2-owner-gate-correction-2"),
    ).toBe(true);
    expect(
      restartedQA.retestPlans.some(({ sourceQARunId }) => sourceQARunId === "q2-owner-gate-retest-run"),
    ).toBe(true);
    const restartedWorkflow = restarted.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    expect(restartedWorkflow).toMatchObject({
      type: "WORKFLOW_SNAPSHOT",
      snapshot: {
        run: { status: "RUNNING" },
        humanRequests: [{ id: "q2-owner-gate-request", status: "RESOLVED" }],
      },
    });
    if (restartedWorkflow.type !== "WORKFLOW_SNAPSHOT" || restartedWorkflow.snapshot.run === null) {
      throw new Error("Expected the restarted final correction workflow");
    }
    expect(
      restartedWorkflow.snapshot.stageAttempts.some(
        ({ correctionRunId, stage }) => correctionRunId === finalCorrectionId && stage === "IMPLEMENT",
      ),
    ).toBe(true);
    const cancelled = restarted.execute({
      schemaVersion: 1,
      commandId: "cancel-q2-owner-gate-final-correction",
      correlationId: "correlation-cancel-q2-owner-gate-final-correction",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CANCEL_PIPELINE",
      payload: {
        pipelineRunId: restartedWorkflow.snapshot.run.id,
        expectedVersion: restartedWorkflow.snapshot.run.version,
      },
    });
    expect(cancelled).toMatchObject({
      type: "PIPELINE_CONTROL_APPLIED",
      action: "CANCEL",
      run: { status: "CANCELLED" },
    });
    if (cancelled.type !== "PIPELINE_CONTROL_APPLIED") throw new Error("Expected cancelled pipeline");
    expect(cancelled.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["PIPELINE_CANCELLED", "QA_CORRECTION_CANCELLED"]),
    );
    expect(restarted.query({ type: "GET_QA_STATE", pipelineRunId: pipeline.run.id })).toMatchObject({
      type: "QA_STATE",
      correctionRuns: [
        { ordinal: 2, status: "SUPERSEDED" },
        { ordinal: 3, status: "CANCELLED", version: 2 },
      ],
    });
  });

  it("backfills Q2 lineage in strict Events and command receipts", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-pre-q2-history"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-pre-q2-history", created.workItem.id, 1, "READY"));
    const startCommand: StartMockPipelineCommand = {
      schemaVersion: 1,
      commandId: "pipeline-pre-q2-history",
      correlationId: "correlation-pipeline-pre-q2-history",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    };
    const started = localState.execute(startCommand);
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    const qaRun = {
      schemaVersion: 1,
      id: "pre-q2-qa-run",
      projectId: created.workItem.projectId,
      workItemId: created.workItem.id,
      pipelineRunId: started.run.id,
      stageAttemptId: started.stageAttempt.id,
      agentRunId: "pre-q2-agent-run",
      driverId: "PLAYWRIGHT",
      testedTree: "a".repeat(40),
      targetOrigin: "http://127.0.0.1:4173",
      plan: {
        schemaVersion: 1,
        revision: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        targets: [
          {
            id: "desktop-light-en",
            viewport: { width: 1280, height: 800 },
            locale: "en-US",
            theme: "LIGHT",
          },
        ],
        scenarios: [
          {
            id: "task-cockpit",
            title: "Task Cockpit opens",
            steps: [
              {
                id: "open",
                title: "Open Task Cockpit",
                action: { type: "NAVIGATE", path: "/" },
              },
            ],
            assertions: [
              {
                id: "visible",
                title: "Task Cockpit is visible",
                rule: { type: "VISIBLE", locator: { by: "TEXT", value: "Current work" } },
              },
            ],
          },
        ],
      },
      scope: { type: "FULL" },
      status: "RUNNING",
      error: null,
      startedAt: timestamp,
      completedAt: null,
      version: 1,
    };
    const evidenceArtifact = {
      schemaVersion: 1,
      id: "pre-q2-review-artifact",
      projectId: created.workItem.projectId,
      workItemId: created.workItem.id,
      pipelineRunId: started.run.id,
      stageAttemptId: started.stageAttempt.id,
      correctionRunId: null,
      stage: "REVIEW",
      kind: "REVIEW_REPORT",
      status: "PASSED",
      provider: "MOCK",
      title: "Historical review evidence",
      summary: "The historical compact review artifact predates authority lineage.",
      checks: ["Historical review completed."],
      createdAt: timestamp,
    };
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER events_are_append_only_update");
    raw.exec("DROP TRIGGER commands_are_append_only_update");
    raw
      .prepare(
        `INSERT INTO events (
          id, schema_version, type, aggregate_type, aggregate_id, project_id,
          actor_type, actor_id, occurred_at, correlation_id, data_json
        ) VALUES (?, 1, 'QA_RUN_RESERVED', 'WORK_ITEM', ?, ?, 'SYSTEM', 'local-daemon', ?, ?, ?)`,
      )
      .run(
        "event-pre-q2-qa-run",
        created.workItem.id,
        created.workItem.projectId,
        timestamp,
        "correlation-pre-q2-qa-run",
        JSON.stringify({ qaRun }),
      );
    raw
      .prepare(
        `INSERT INTO commands (command_id, command_type, input_hash, result_json, created_at)
         VALUES (?, 'LEGACY_QA_FIXTURE', ?, ?, ?)`,
      )
      .run("receipt-pre-q2-qa-run", "c".repeat(64), JSON.stringify({ qaRun }), timestamp);
    raw
      .prepare(
        `INSERT INTO events (
          id, schema_version, type, aggregate_type, aggregate_id, project_id,
          actor_type, actor_id, occurred_at, correlation_id, data_json
        ) VALUES (?, 1, 'EVIDENCE_ARTIFACT_RECORDED', 'WORK_ITEM', ?, ?, 'SYSTEM',
          'mock-provider', ?, ?, ?)`,
      )
      .run(
        "event-pre-q2-review-artifact",
        created.workItem.id,
        created.workItem.projectId,
        timestamp,
        "correlation-pre-q2-review-artifact",
        JSON.stringify({ artifact: evidenceArtifact }),
      );
    raw
      .prepare(
        `INSERT INTO commands (command_id, command_type, input_hash, result_json, created_at)
         VALUES (?, 'LEGACY_EVIDENCE_FIXTURE', ?, ?, ?)`,
      )
      .run(
        "receipt-pre-q2-review-artifact",
        "d".repeat(64),
        JSON.stringify({ artifact: evidenceArtifact }),
        timestamp,
      );
    for (const row of raw.prepare("SELECT sequence, data_json FROM events").all() as {
      sequence: number;
      data_json: string;
    }[]) {
      const legacy = JSON.stringify(withoutQ2Lineage(JSON.parse(row.data_json)));
      raw.prepare("UPDATE events SET data_json = ? WHERE sequence = ?").run(legacy, row.sequence);
    }
    for (const row of raw.prepare("SELECT command_id, result_json FROM commands").all() as {
      command_id: string;
      result_json: string;
    }[]) {
      const legacy = JSON.stringify(withoutQ2Lineage(JSON.parse(row.result_json)));
      raw.prepare("UPDATE commands SET result_json = ? WHERE command_id = ?").run(legacy, row.command_id);
    }
    const before = countLegacyQ2Lineage(raw);
    expect(before.events).toBeGreaterThan(1);
    expect(before.commands).toBeGreaterThan(1);
    raw.exec(`
      CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON events BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands BEGIN
        SELECT RAISE(ABORT, 'command receipts are append-only');
      END;
    `);
    raw.close();

    const skipped = await open();
    expect(skipped.startup.appliedMigrations).toEqual([]);
    expect(() => skipped.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id })).toThrow(
      StateStoreError,
    );
    expect(() => skipped.execute(startCommand)).toThrow();
    skipped.close();
    state = undefined;

    const migration = await readFile(
      new URL("../migrations/0025_qa_correction_lineage.sql", import.meta.url),
      "utf8",
    );
    const historyMarker = "-- Required fields were added to strict JSON contracts";
    const historyOffset = migration.indexOf(historyMarker);
    expect(historyOffset).toBeGreaterThan(0);
    const repair = new DatabaseSync(databasePath);
    repair.exec(migration.slice(historyOffset));
    expect(countLegacyQ2Lineage(repair)).toEqual({ events: 1, commands: 1 });
    const evidenceMigration = await readFile(
      new URL("../migrations/0026_evidence_authority_lineage.sql", import.meta.url),
      "utf8",
    );
    const evidenceHistoryMarker = "-- EvidenceArtifact is embedded in Events";
    const evidenceHistoryOffset = evidenceMigration.indexOf(evidenceHistoryMarker);
    expect(evidenceHistoryOffset).toBeGreaterThan(0);
    repair.exec(evidenceMigration.slice(evidenceHistoryOffset));
    expect(countLegacyQ2Lineage(repair)).toEqual({ events: 0, commands: 0 });
    repair.close();

    const migrated = await open();
    const events = migrated.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    if (events.type !== "EVENTS") throw new Error("Expected repaired events");
    expect(events.events.find(({ id }) => id === "event-pre-q2-qa-run")).toMatchObject({
      type: "QA_RUN_RESERVED",
      data: { qaRun: { scope: { type: "FULL" } } },
    });
    expect(events.events.find(({ id }) => id === "event-pre-q2-review-artifact")).toMatchObject({
      type: "EVIDENCE_ARTIFACT_RECORDED",
      data: { artifact: { correctionRunId: null } },
    });
    expect(migrated.execute(startCommand)).toMatchObject({
      type: "PIPELINE_STARTED",
      replayed: true,
      stageAttempt: { correctionRunId: null },
    });
  });

  it("migrates and reads bounded independent review reports and findings", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem());
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-review-state", created.workItem.id, 1, "READY"));
    const reviewOnlyTemplate: StartMockPipelineCommand["payload"]["template"] = {
      schemaVersion: 1,
      id: "review-state-v1",
      version: 1,
      name: "Review state fixture",
      stages: [{ stage: "REVIEW", ordinal: 0, contextPack }],
    };
    localState.execute({
      schemaVersion: 1,
      commandId: "start-review-state",
      correlationId: "correlation-start-review-state",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: reviewOnlyTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    const snapshotResult = localState.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    if (snapshotResult.type !== "WORKFLOW_SNAPSHOT" || snapshotResult.snapshot.run === null) {
      throw new Error("Expected workflow state");
    }
    const run = snapshotResult.snapshot.run;
    const attempt = snapshotResult.snapshot.stageAttempts[0];
    if (attempt === undefined) throw new Error("Expected StageAttempt");
    const assignmentResult = localState.query({ type: "GET_SQUAD_ASSIGNMENT", pipelineRunId: run.id });
    if (assignmentResult.type !== "SQUAD_ASSIGNMENT" || assignmentResult.assignment === null) {
      throw new Error("Expected SquadAssignment");
    }
    const assignment = assignmentResult.assignment;
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    const insertRun = raw.prepare(
      `INSERT INTO agent_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id, ordinal,
        squad_assignment_id, profile_id, profile_revision, profile_role, provider, status,
        policy_snapshot_hash, started_at, finished_at, version
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'SUCCEEDED', ?, ?, ?, 2)`,
    );
    const policyHash = `sha256:${"a".repeat(64)}`;
    insertRun.run(
      "agent-author",
      created.workItem.projectId,
      created.workItem.id,
      run.id,
      attempt.id,
      1,
      assignment.id,
      "builtin.developer",
      "DEVELOPER",
      "CODEX",
      policyHash,
      timestamp,
      timestamp,
    );
    insertRun.run(
      "agent-reviewer",
      created.workItem.projectId,
      created.workItem.id,
      run.id,
      attempt.id,
      2,
      assignment.id,
      "builtin.code-reviewer",
      "CODE_REVIEWER",
      "CLAUDE_CODE",
      policyHash,
      timestamp,
      timestamp,
    );
    raw
      .prepare(
        `INSERT INTO review_reports (
          id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
          author_agent_run_id, reviewer_agent_run_id, provider_relation, reviewed_tree, round,
          title, summary, checks_json, verdict, finding_ids_json, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'CROSS_PROVIDER', ?, 1, ?, ?, ?,
          'CHANGES_REQUESTED', ?, ?)`,
      )
      .run(
        "review-report-1",
        created.workItem.projectId,
        created.workItem.id,
        run.id,
        attempt.id,
        "agent-author",
        "agent-reviewer",
        "b".repeat(40),
        "Independent review",
        "One blocking finding remains.",
        JSON.stringify(["Compared the diff with the criterion."]),
        JSON.stringify(["review-finding-1"]),
        timestamp,
      );
    raw
      .prepare(
        `INSERT INTO review_findings (
          id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
          review_artifact_id, reviewed_tree, ordinal, severity, status, title, description,
          path, start_line, end_line, reproduction, criterion, suggested_fix, resolution_reason,
          resolved_by_type, resolved_by_id, created_at, resolved_at, version
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, 'HIGH', 'OPEN', ?, ?, ?, 10, 12, ?, ?, ?,
          NULL, NULL, NULL, ?, NULL, 1)`,
      )
      .run(
        "review-finding-1",
        created.workItem.projectId,
        created.workItem.id,
        run.id,
        attempt.id,
        "review-report-1",
        "b".repeat(40),
        "Expected-version is ignored",
        "The guarded mutation accepts a stale version.",
        "packages/domain/src/review.ts",
        "Submit the previous aggregate version.",
        "Concurrent writes fail closed.",
        "Add the version to the update predicate.",
        timestamp,
      );
    raw.close();

    const reopened = await open();
    expect(reopened.query({ type: "LIST_REVIEW_REPORTS", pipelineRunId: run.id })).toMatchObject({
      type: "REVIEW_REPORTS",
      reports: [
        {
          id: "review-report-1",
          verdict: "CHANGES_REQUESTED",
          providerRelation: "CROSS_PROVIDER",
          findingIds: ["review-finding-1"],
        },
      ],
    });
    expect(
      reopened.query({ type: "LIST_REVIEW_FINDINGS", pipelineRunId: run.id, status: "OPEN" }),
    ).toMatchObject({
      type: "REVIEW_FINDINGS",
      findings: [
        {
          id: "review-finding-1",
          status: "OPEN",
          severity: "HIGH",
          path: "packages/domain/src/review.ts",
        },
      ],
    });
    expect(() =>
      reopened.execute({
        schemaVersion: 1,
        commandId: "provider-dispose-review-finding",
        correlationId: "correlation-provider-dispose-review-finding",
        actor: { type: "SYSTEM", id: "provider" },
        type: "DISPOSE_REVIEW_FINDING",
        payload: {
          findingId: "review-finding-1",
          expectedVersion: 1,
          disposition: "WAIVED",
          reason: "Provider output must not own this disposition.",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "REVIEW_FINDING_ACTOR_FORBIDDEN" }));
    expect(() =>
      reopened.execute({
        schemaVersion: 1,
        commandId: "stale-dispose-review-finding",
        correlationId: "correlation-stale-dispose-review-finding",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "DISPOSE_REVIEW_FINDING",
        payload: {
          findingId: "review-finding-1",
          expectedVersion: 2,
          disposition: "WAIVED",
          reason: "The expected version is deliberately stale.",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "REVIEW_FINDING_VERSION_CONFLICT" }));
    const dispositionCommand = {
      schemaVersion: 1 as const,
      commandId: "dispose-review-finding",
      correlationId: "correlation-dispose-review-finding",
      actor: { type: "HUMAN" as const, id: "local-owner" },
      type: "DISPOSE_REVIEW_FINDING" as const,
      payload: {
        findingId: "review-finding-1",
        expectedVersion: 1,
        disposition: "FALSE_POSITIVE" as const,
        reason: "The reported path is unreachable under the validated command schema.",
      },
    };
    const disposed = reopened.execute(dispositionCommand);
    expect(disposed).toMatchObject({
      type: "REVIEW_FINDING_DISPOSED",
      replayed: false,
      finding: {
        id: "review-finding-1",
        status: "FALSE_POSITIVE",
        resolvedBy: { type: "HUMAN", id: "local-owner" },
        version: 2,
      },
      events: [{ type: "REVIEW_FINDING_RESOLVED" }],
    });
    expect(reopened.execute(dispositionCommand)).toMatchObject({
      type: "REVIEW_FINDING_DISPOSED",
      replayed: true,
      finding: { status: "FALSE_POSITIVE", version: 2 },
    });
    expect(() =>
      reopened.execute({
        ...dispositionCommand,
        commandId: "dispose-review-finding-again",
        correlationId: "correlation-dispose-review-finding-again",
        payload: { ...dispositionCommand.payload, expectedVersion: 2, disposition: "WAIVED" },
      }),
    ).toThrow(expect.objectContaining({ code: "REVIEW_FINDING_ALREADY_CLOSED" }));
    reopened.close();
    state = undefined;

    const dispositionRestart = await open();
    expect(dispositionRestart.query({ type: "LIST_REVIEW_FINDINGS", pipelineRunId: run.id })).toMatchObject({
      type: "REVIEW_FINDINGS",
      findings: [{ id: "review-finding-1", status: "FALSE_POSITIVE", version: 2 }],
    });
    dispositionRestart.close();
    state = undefined;

    const immutable = new DatabaseSync(databasePath);
    expect(() => {
      immutable.exec("UPDATE review_reports SET title = 'changed' WHERE id = 'review-report-1'");
    }).toThrow(/append-only/);
    expect(() => {
      immutable.exec("DELETE FROM review_findings WHERE id = 'review-finding-1'");
    }).toThrow(/cannot be deleted/);
    immutable.close();
  });

  describe("A3 AgentRun reservation (migration 0020)", () => {
    const startReadyWorkflow = (localState: LocalState, suffix: string, projectId = "project-web") => {
      const created = localState.execute(createWorkItem(`create-${suffix}`, projectId));
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute(moveWorkItem(`ready-${suffix}`, created.workItem.id, 1, "READY"));
      localState.execute({
        schemaVersion: 1,
        commandId: `pipeline-${suffix}`,
        correlationId: `correlation-pipeline-${suffix}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: mockTemplate,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
      const dispatch = pending.dispatches.find(({ workItemId }) => workItemId === created.workItem.id);
      if (!dispatch) throw new Error("Expected a pending dispatch");
      return { workItemId: created.workItem.id, dispatch };
    };

    const startAgentRun = (
      suffix: string,
      dispatchId: string,
      limits: StartAgentRunCommand["payload"]["limits"] = {
        global: 3,
        project: 3,
        provider: 3,
      },
    ): StartAgentRunCommand => ({
      schemaVersion: 1,
      commandId: `agent-run-${suffix}`,
      correlationId: `correlation-agent-run-${suffix}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId,
        provider: "CODEX",
        limits,
      },
    });

    it("claims one run atomically, audits it and replays idempotently", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, dispatch } = startReadyWorkflow(localState, "a3-idempotent");

      expect(() =>
        localState.execute({
          ...startAgentRun("human-refused", dispatch.id),
          actor: { type: "HUMAN", id: "local-owner" },
        }),
      ).toThrow(expect.objectContaining({ code: "AGENT_RUN_ACTOR_FORBIDDEN" }));
      expect(() =>
        localState.execute({
          ...startAgentRun("system-refused", dispatch.id),
          actor: { type: "SYSTEM", id: "browser-proxy" },
        }),
      ).toThrow(expect.objectContaining({ code: "AGENT_RUN_ACTOR_FORBIDDEN" }));
      expect(() =>
        localState.execute(startAgentRun("paused", dispatch.id, { global: 0, project: 3, provider: 3 })),
      ).toThrow(expect.objectContaining({ code: "AGENT_RUN_CAPACITY_EXHAUSTED" }));

      const command = startAgentRun("accepted", dispatch.id);
      const started = localState.execute(command);
      const replayed = localState.execute(command);
      if (started.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun start");
      expect(started).toMatchObject({
        type: "AGENT_RUN_STARTED",
        replayed: false,
        workItemId,
        assignment: { revision: 1 },
        run: {
          stageAttemptId: dispatch.stageAttemptId,
          ordinal: 1,
          status: "RUNNING",
          provider: "CODEX",
          profile: { role: "PRODUCT_ANALYST" },
          policySnapshot: {
            assignment: { revision: 1 },
            profile: { role: "PRODUCT_ANALYST" },
            provider: "CODEX",
            effectiveCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ"],
            modelTier: "STANDARD",
            claimLimits: { global: 3, project: 3, provider: 3 },
            budget: { maxEstimatedTokens: 100, maxProviderSessions: 6 },
            workspace: { access: "READ_ONLY", networkAccess: false },
            mcpProfileRevisionIds: [],
          },
        },
        events: [{ type: "STAGE_ATTEMPT_CHANGED" }, { type: "AGENT_RUN_STARTED" }],
      });
      expect(started.run.policySnapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(replayed).toMatchObject({ type: "AGENT_RUN_STARTED", replayed: true });
      expect(localState.query({ type: "LIST_AGENT_RUNS", status: "RUNNING", limit: 1 })).toMatchObject({
        type: "AGENT_RUNS",
        runs: [{ id: started.run.id }],
      });
      expect(() => localState.query({ type: "LIST_AGENT_RUNS", limit: 201 })).toThrow(ZodError);

      const session = localState.execute({
        schemaVersion: 1,
        commandId: "start-a3-provider-session",
        correlationId: "correlation-start-a3-provider-session",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "START_PROVIDER_SESSION",
        payload: {
          stageAttemptId: dispatch.stageAttemptId,
          recipe: {
            schemaVersion: 1,
            templateId: mockTemplate.id,
            templateVersion: mockTemplate.version,
            specSource: "WORKFLOW_TEMPLATE",
            roleProfile: null,
            sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
            omitted: [],
            contentHash: `sha256:${"0".repeat(64)}`,
            estimatedTokens: 10,
            budgetTokens: 100,
            estimateQuality: "LOOMRAIL_ESTIMATE",
          },
        },
      });
      expect(session).toMatchObject({
        type: "PROVIDER_SESSION_STARTED",
        session: { agentRunId: started.run.id },
      });
      expect(() => localState.execute(startAgentRun("duplicate", dispatch.id))).toThrow(
        expect.objectContaining({ code: "AGENT_RUN_ALREADY_ACTIVE" }),
      );

      const reconciled = localState.execute({
        schemaVersion: 1,
        commandId: "reconcile-a3-agent-run",
        correlationId: "correlation-reconcile-a3-agent-run",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "RECONCILE_WORKFLOWS",
        payload: {},
      });
      expect(reconciled).toMatchObject({
        type: "WORKFLOWS_RECONCILED",
        recoveryReports: [{ stageAttemptId: dispatch.stageAttemptId, recoveredStatus: "INTERRUPTED" }],
        interruptedSessions: [{ agentRunId: started.run.id, endReason: "INTERRUPTED" }],
      });
      expect(localState.query({ type: "LIST_AGENT_RUNS", status: "INTERRUPTED" })).toMatchObject({
        type: "AGENT_RUNS",
        runs: [{ id: started.run.id, finishedAt: timestamp }],
      });

      const raw = new DatabaseSync(databasePath, { readOnly: true });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM squad_assignments").get()).toEqual({ count: 1 });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM agent_runs").get()).toEqual({ count: 1 });
      expect(raw.prepare("SELECT status, finished_at FROM agent_runs").get()).toEqual({
        status: "INTERRUPTED",
        finished_at: timestamp,
      });
      raw.close();

      const events = localState.query({ type: "LIST_EVENTS", aggregateId: workItemId });
      expect(
        events.type === "EVENTS" ? events.events.filter(({ type }) => type === "AGENT_RUN_FINISHED") : [],
      ).toHaveLength(1);
    });

    it("rejects a policy snapshot whose stored bytes no longer match its hash", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { dispatch } = startReadyWorkflow(localState, "a3-policy-tamper");
      const started = localState.execute(startAgentRun("policy-tamper", dispatch.id));
      if (started.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun start");
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      raw.exec("DROP TRIGGER agent_runs_immutable_identity");
      raw
        .prepare(
          "UPDATE agent_runs SET policy_snapshot_json = json_set(policy_snapshot_json, '$.modelTier', 'DEEP') WHERE id = ?",
        )
        .run(started.run.id);
      raw.close();

      const reopened = await open();
      expect(() => reopened.query({ type: "GET_AGENT_RUN", agentRunId: started.run.id })).toThrow(
        expect.objectContaining({
          code: "PERSISTENCE_FAILURE",
          message: "The AgentRun policy snapshot does not match its immutable hash",
        }),
      );
    });

    it("binds every new AgentRun to the Constitution content active when the run starts", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const seed = new DatabaseSync(databasePath);
      const insertConstitution = (
        suffix: string,
        ordinal: number,
        digestCharacter: string,
        body: string,
      ): void => {
        seed
          .prepare(
            `INSERT INTO constitution_proposals (
              id, schema_version, project_id, project_version, status, preset_id, preset_version,
              recommended_preset_id, scan_json, sections_json, rendered_markdown, content_digest,
              version, created_at, adopted_at
            ) VALUES (?, 1, 'project-web', 1, 'ADOPTED', 'repository-baseline', 1,
              'repository-baseline', '{}', '[]', ?, ?, 3, ?, ?)`,
          )
          .run(`proposal-${suffix}`, body, digestCharacter.repeat(64), timestamp, timestamp);
        seed
          .prepare(
            `INSERT INTO project_constitution_versions (
              id, schema_version, project_id, proposal_id, ordinal, preset_id, preset_version,
              source_digest, content_digest, rendered_markdown, status, version, created_at, activated_at
            ) VALUES (?, 1, 'project-web', ?, ?, 'repository-baseline', 1, ?, ?, ?, 'ACTIVE', 2, ?, ?)`,
          )
          .run(
            `constitution-${suffix}`,
            `proposal-${suffix}`,
            ordinal,
            "f".repeat(64),
            digestCharacter.repeat(64),
            body,
            timestamp,
            timestamp,
          );
      };
      insertConstitution("run-start", 1, "a", "# Constitution A\n\n- Review the exact accepted rules.");
      seed.close();

      const { dispatch } = startReadyWorkflow(localState, "a3-constitution");
      const started = localState.execute(startAgentRun("constitution", dispatch.id));
      if (started.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun start");
      expect(started.run.policySnapshot?.projectConstitution).toEqual({
        id: "constitution-run-start",
        version: 2,
        contentDigest: "a".repeat(64),
      });

      const switched = new DatabaseSync(databasePath);
      switched
        .prepare("UPDATE project_constitution_versions SET status = 'SUPERSEDED', version = 3 WHERE id = ?")
        .run("constitution-run-start");
      const insertReplacement = (
        suffix: string,
        ordinal: number,
        digestCharacter: string,
        body: string,
      ): void => {
        switched
          .prepare(
            `INSERT INTO constitution_proposals (
              id, schema_version, project_id, project_version, status, preset_id, preset_version,
              recommended_preset_id, scan_json, sections_json, rendered_markdown, content_digest,
              version, created_at, adopted_at
            ) VALUES (?, 1, 'project-web', 1, 'ADOPTED', 'repository-baseline', 1,
              'repository-baseline', '{}', '[]', ?, ?, 3, ?, ?)`,
          )
          .run(`proposal-${suffix}`, body, digestCharacter.repeat(64), timestamp, timestamp);
        switched
          .prepare(
            `INSERT INTO project_constitution_versions (
              id, schema_version, project_id, proposal_id, ordinal, preset_id, preset_version,
              source_digest, content_digest, rendered_markdown, status, version, created_at, activated_at
            ) VALUES (?, 1, 'project-web', ?, ?, 'repository-baseline', 1, ?, ?, ?, 'ACTIVE', 2, ?, ?)`,
          )
          .run(
            `constitution-${suffix}`,
            `proposal-${suffix}`,
            ordinal,
            "e".repeat(64),
            digestCharacter.repeat(64),
            body,
            timestamp,
            timestamp,
          );
      };
      insertReplacement("replacement", 2, "b", "# Constitution B\n\n- Rules activated later.");
      switched.close();

      const result = localState.query({
        type: "READ_CONTEXT_SOURCES",
        stageAttemptId: dispatch.stageAttemptId,
        sessionOrdinal: 1,
      });
      expect(result.type === "CONTEXT_SOURCES" ? result.sources.projectConstitution : null).toEqual({
        id: "constitution-run-start",
        version: 2,
        ordinal: 1,
        contentDigest: "a".repeat(64),
        renderedMarkdown: "# Constitution A\n\n- Review the exact accepted rules.",
      });
    });

    it("enforces the default 3+1 boundary from durable active runs", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const workflows = ["one", "two", "three", "four"].map((suffix) =>
        startReadyWorkflow(localState, `a3-${suffix}`),
      );

      for (const [index, workflow] of workflows.slice(0, 3).entries()) {
        expect(
          localState.execute(startAgentRun(`slot-${index.toString()}`, workflow.dispatch.id)),
        ).toMatchObject({
          type: "AGENT_RUN_STARTED",
        });
      }
      const fourth = workflows[3];
      if (!fourth) throw new Error("Expected a fourth workflow");
      expect(() => localState.execute(startAgentRun("slot-four", fourth.dispatch.id))).toThrow(
        expect.objectContaining({
          code: "AGENT_RUN_CAPACITY_EXHAUSTED",
          details: { scope: "GLOBAL", active: 3, limit: 3 },
        }),
      );

      const raw = new DatabaseSync(databasePath, { readOnly: true });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'RUNNING'").get()).toEqual({
        count: 3,
      });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM squad_assignments").get()).toEqual({ count: 4 });
      raw.close();
    });

    it("claims an existing WorkItem workspace in the same transaction", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, dispatch } = startReadyWorkflow(localState, "a3-workspace");
      localState.execute({
        schemaVersion: 1,
        commandId: "provision-a3-workspace",
        correlationId: "correlation-provision-a3-workspace",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "CREATE_WORK_ITEM_WORKSPACE",
        payload: {
          projectId: "project-web",
          workItemId,
          branch: `loomrail/${workItemId}`,
          worktreePath: join(temporaryDirectory, "worktrees", workItemId),
          baseCommit: null,
          snapshotCommit: null,
          carriedPaths: [],
        },
      });

      localState.execute(startAgentRun("workspace", dispatch.id));
      const workspace = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(workspace.type === "WORKSPACE" ? workspace.workspace : null).toMatchObject({
        leaseHolder: dispatch.stageAttemptId,
        version: 2,
      });

      localState.execute({
        schemaVersion: 1,
        commandId: "finish-a3-workspace-run",
        correlationId: "correlation-finish-a3-workspace-run",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: dispatch.id,
          provider: "CODEX",
          template: mockTemplate,
          outcome: { type: "COMPLETED", summary: "Discovery finished." },
          resultTree: null,
        },
      });
      const released = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(released.type === "WORKSPACE" ? released.workspace : null).toMatchObject({
        leaseHolder: null,
        version: 3,
      });
      const raw = new DatabaseSync(databasePath, { readOnly: true });
      expect(raw.prepare("SELECT status, finished_at FROM agent_runs").get()).toEqual({
        status: "SUCCEEDED",
        finished_at: timestamp,
      });
      raw.close();
    });

    it("records an independent review and queues a bounded fix round atomically", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const created = localState.execute(createWorkItem("create-r1-review-loop"));
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute(moveWorkItem("ready-r1-review-loop", created.workItem.id, 1, "READY"));
      const reviewLoopTemplate: StartMockPipelineCommand["payload"]["template"] = {
        schemaVersion: 1,
        id: "review-loop-v1",
        version: 1,
        name: "Independent review loop",
        stages: [
          { stage: "IMPLEMENT", ordinal: 0, contextPack },
          { stage: "REVIEW", ordinal: 1, contextPack },
          { stage: "QA", ordinal: 2, contextPack },
          { stage: "ACCEPTANCE", ordinal: 3, contextPack },
        ],
      };
      localState.execute({
        schemaVersion: 1,
        commandId: "pipeline-r1-review-loop",
        correlationId: "correlation-pipeline-r1-review-loop",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: reviewLoopTemplate,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });

      const nextDispatch = () => {
        const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
        if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
        const dispatch = pending.dispatches.find(({ workItemId }) => workItemId === created.workItem.id);
        if (!dispatch) throw new Error("Expected a pending dispatch");
        return dispatch;
      };

      const implementationDispatch = nextDispatch();
      const author = localState.execute(startAgentRun("r1-author", implementationDispatch.id));
      if (author.type !== "AGENT_RUN_STARTED") throw new Error("Expected author AgentRun");
      const reviewedTree = "a".repeat(40);
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-r1-implementation",
        correlationId: "correlation-apply-r1-implementation",
        actor: { type: "SYSTEM", id: "codex-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: implementationDispatch.id,
          provider: "CODEX",
          template: reviewLoopTemplate,
          outcome: { type: "COMPLETED", summary: "Implementation is ready for independent review." },
          resultTree: reviewedTree,
        },
      });

      const reviewDispatch = nextDispatch();
      const firstReviewSources = localState.query({
        type: "READ_CONTEXT_SOURCES",
        stageAttemptId: reviewDispatch.stageAttemptId,
        sessionOrdinal: 1,
      });
      expect(firstReviewSources).toMatchObject({
        type: "CONTEXT_SOURCES",
        sources: {
          latestCheckpoint: null,
          reviewInput: {
            implementationAttempt: { attempt: 1, resultTree: reviewedTree },
            authorAgentRun: { id: author.run.id, provider: "CODEX" },
            openFindings: [],
          },
        },
      });
      const reviewerCommand = startAgentRun("r1-reviewer", reviewDispatch.id);
      const reviewer = localState.execute({
        ...reviewerCommand,
        payload: { ...reviewerCommand.payload, provider: "CLAUDE_CODE" },
      });
      if (reviewer.type !== "AGENT_RUN_STARTED") throw new Error("Expected reviewer AgentRun");
      const applied = localState.execute({
        schemaVersion: 1,
        commandId: "apply-r1-review",
        correlationId: "correlation-apply-r1-review",
        actor: { type: "SYSTEM", id: "claude-code-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: reviewDispatch.id,
          provider: "CLAUDE_CODE",
          template: reviewLoopTemplate,
          outcome: {
            type: "COMPLETED",
            summary: "One blocking finding requires another implementation round.",
            artifacts: [
              {
                kind: "REVIEW_REPORT",
                title: "Independent review",
                summary: "Changes requested.",
                checks: ["Checked the guarded update against the acceptance criterion."],
              },
            ],
            reviewReport: {
              kind: "REVIEW_REPORT",
              title: "Independent review",
              summary: "The guarded update accepts a stale aggregate version.",
              checks: ["Checked the guarded update against the acceptance criterion."],
              verdict: "CHANGES_REQUESTED",
              findings: [
                {
                  severity: "HIGH",
                  title: "Expected version is ignored",
                  description: "The mutation can overwrite a concurrent update.",
                  path: "packages/domain/src/review.ts",
                  startLine: 40,
                  endLine: 44,
                  reproduction: "Submit the command with the previous aggregate version.",
                  criterion: "Concurrent updates fail closed.",
                  suggestedFix: "Include expectedVersion in the guarded update predicate.",
                },
              ],
            },
          },
          resultTree: reviewedTree,
        },
      });

      expect(applied).toMatchObject({
        type: "MOCK_PROVIDER_OUTCOME_APPLIED",
        run: { status: "RUNNING" },
        stageAttempt: { id: reviewDispatch.stageAttemptId, stage: "REVIEW", status: "SUCCEEDED" },
        events: [
          { type: "REVIEW_REPORT_RECORDED" },
          { type: "REVIEW_FINDING_RECORDED" },
          { type: "STAGE_ATTEMPT_CHANGED" },
        ],
      });
      const fixDispatch = nextDispatch();
      expect(fixDispatch).toMatchObject({ status: "PENDING" });

      const snapshot = localState.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      if (snapshot.type !== "WORKFLOW_SNAPSHOT" || !snapshot.snapshot.run) {
        throw new Error("Expected review-loop workflow snapshot");
      }
      expect(
        snapshot.snapshot.stageAttempts.find(({ id }) => id === fixDispatch.stageAttemptId),
      ).toMatchObject({ stage: "IMPLEMENT", attempt: 2, status: "QUEUED" });
      expect(
        localState.query({ type: "LIST_REVIEW_REPORTS", pipelineRunId: snapshot.snapshot.run.id }),
      ).toMatchObject({
        type: "REVIEW_REPORTS",
        reports: [
          {
            authorAgentRunId: author.run.id,
            reviewerAgentRunId: reviewer.run.id,
            providerRelation: "CROSS_PROVIDER",
            reviewedTree,
            round: 1,
            verdict: "CHANGES_REQUESTED",
          },
        ],
      });
      expect(
        localState.query({
          type: "LIST_REVIEW_FINDINGS",
          pipelineRunId: snapshot.snapshot.run.id,
          status: "OPEN",
        }),
      ).toMatchObject({
        type: "REVIEW_FINDINGS",
        findings: [{ status: "OPEN", reviewedTree, severity: "HIGH" }],
      });
      const audit = localState.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
      expect(audit.type === "EVENTS" ? audit.events.map(({ type }) => type) : []).toEqual(
        expect.arrayContaining(["REVIEW_REPORT_RECORDED", "REVIEW_FINDING_RECORDED", "AGENT_RUN_FINISHED"]),
      );

      localState.close();
      state = undefined;
      const reopened = await open();
      expect(reopened.query({ type: "LIST_PENDING_DISPATCHES" })).toMatchObject({
        type: "WORKFLOW_DISPATCHES",
        dispatches: [{ id: fixDispatch.id, stageAttemptId: fixDispatch.stageAttemptId, status: "PENDING" }],
      });
      expect(
        reopened.query({
          type: "LIST_REVIEW_FINDINGS",
          pipelineRunId: snapshot.snapshot.run.id,
          status: "OPEN",
        }),
      ).toMatchObject({ type: "REVIEW_FINDINGS", findings: [{ severity: "HIGH", status: "OPEN" }] });

      const secondAuthor = reopened.execute(startAgentRun("r1-second-author", fixDispatch.id));
      if (secondAuthor.type !== "AGENT_RUN_STARTED") throw new Error("Expected second author AgentRun");
      const fixedTree = "b".repeat(40);
      reopened.execute({
        schemaVersion: 1,
        commandId: "apply-r1-second-implementation",
        correlationId: "correlation-apply-r1-second-implementation",
        actor: { type: "SYSTEM", id: "codex-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: fixDispatch.id,
          provider: "CODEX",
          template: reviewLoopTemplate,
          outcome: { type: "COMPLETED", summary: "The guarded update now rejects stale versions." },
          resultTree: fixedTree,
        },
      });
      const pendingReview = reopened.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pendingReview.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
      const secondReviewDispatch = pendingReview.dispatches.find(
        ({ workItemId }) => workItemId === created.workItem.id,
      );
      if (!secondReviewDispatch) throw new Error("Expected second review dispatch");
      const secondReviewSnapshot = reopened.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      if (secondReviewSnapshot.type !== "WORKFLOW_SNAPSHOT") {
        throw new Error("Expected second review snapshot");
      }
      expect(
        secondReviewSnapshot.snapshot.stageAttempts.find(
          ({ id }) => id === secondReviewDispatch.stageAttemptId,
        ),
      ).toMatchObject({ stage: "REVIEW", attempt: 2, status: "QUEUED" });
      expect(
        reopened.query({
          type: "READ_CONTEXT_SOURCES",
          stageAttemptId: secondReviewDispatch.stageAttemptId,
          sessionOrdinal: 1,
        }),
      ).toMatchObject({
        type: "CONTEXT_SOURCES",
        sources: {
          latestCheckpoint: null,
          reviewInput: {
            implementationAttempt: { attempt: 2, resultTree: fixedTree },
            authorAgentRun: { id: secondAuthor.run.id, provider: "CODEX" },
            openFindings: [{ severity: "HIGH" }],
          },
        },
      });
      const secondReviewerCommand = startAgentRun("r1-second-reviewer", secondReviewDispatch.id);
      const secondReviewer = reopened.execute({
        ...secondReviewerCommand,
        payload: { ...secondReviewerCommand.payload, provider: "CLAUDE_CODE" },
      });
      if (secondReviewer.type !== "AGENT_RUN_STARTED") throw new Error("Expected second reviewer AgentRun");
      const passed = reopened.execute({
        schemaVersion: 1,
        commandId: "apply-r1-passed-review",
        correlationId: "correlation-apply-r1-passed-review",
        actor: { type: "SYSTEM", id: "claude-code-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: secondReviewDispatch.id,
          provider: "CLAUDE_CODE",
          template: reviewLoopTemplate,
          outcome: {
            type: "COMPLETED",
            summary: "The independent re-review passed.",
            artifacts: [
              {
                kind: "REVIEW_REPORT",
                title: "Independent re-review",
                summary: "The previous finding is resolved.",
                checks: ["Reproduced the stale-version scenario and observed a guarded failure."],
              },
            ],
            reviewReport: {
              kind: "REVIEW_REPORT",
              title: "Independent re-review",
              summary: "The previous finding is resolved.",
              checks: ["Reproduced the stale-version scenario and observed a guarded failure."],
              verdict: "PASSED",
              findings: [],
            },
          },
          resultTree: fixedTree,
        },
      });
      if (passed.type !== "MOCK_PROVIDER_OUTCOME_APPLIED") {
        throw new Error("Expected passed review outcome");
      }
      expect(passed.events.map(({ type }) => type)).toEqual([
        "REVIEW_REPORT_RECORDED",
        "REVIEW_FINDING_RESOLVED",
        "EVIDENCE_ARTIFACT_RECORDED",
        "STAGE_ATTEMPT_CHANGED",
      ]);
      expect(
        reopened.query({ type: "LIST_REVIEW_REPORTS", pipelineRunId: snapshot.snapshot.run.id }),
      ).toMatchObject({
        type: "REVIEW_REPORTS",
        reports: [
          {
            authorAgentRunId: secondAuthor.run.id,
            reviewerAgentRunId: secondReviewer.run.id,
            round: 2,
            verdict: "PASSED",
          },
          { round: 1, verdict: "CHANGES_REQUESTED" },
        ],
      });
      expect(
        reopened.query({ type: "LIST_REVIEW_FINDINGS", pipelineRunId: snapshot.snapshot.run.id }),
      ).toMatchObject({
        type: "REVIEW_FINDINGS",
        findings: [
          {
            status: "RESOLVED",
            resolutionReason: "A later independent review passed the current implementation tree.",
            resolvedBy: { type: "SYSTEM", id: "local-daemon" },
          },
        ],
      });
      const qaDispatches = reopened.query({ type: "LIST_PENDING_DISPATCHES" });
      if (qaDispatches.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected QA dispatch queue");
      const qaDispatch = qaDispatches.dispatches.find(({ workItemId }) => workItemId === created.workItem.id);
      if (!qaDispatch) throw new Error("Expected QA dispatch");
      const qaSnapshot = reopened.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      if (qaSnapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected QA workflow snapshot");
      expect(
        qaSnapshot.snapshot.stageAttempts.find(({ id }) => id === qaDispatch.stageAttemptId),
      ).toMatchObject({
        stage: "QA",
        attempt: 1,
        status: "QUEUED",
      });

      const qaAgent = reopened.execute(startAgentRun("q1-browser-qa", qaDispatch.id));
      if (qaAgent.type !== "AGENT_RUN_STARTED") throw new Error("Expected Browser QA AgentRun");
      expect(qaAgent.run.profile.role).toBe("BROWSER_QA");
      expect(qaAgent.run.policySnapshot).toMatchObject({
        effectiveCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "BROWSER_READ"],
        workspace: { access: "READ_ONLY", networkAccess: false },
        mcpProfileRevisionIds: [],
      });
      expect(() =>
        reopened.execute({
          schemaVersion: 1,
          commandId: "provider-cannot-complete-q1-browser-qa",
          correlationId: "correlation-provider-cannot-complete-q1-browser-qa",
          actor: { type: "SYSTEM", id: "codex-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            dispatchId: qaDispatch.id,
            provider: "CODEX",
            template: reviewLoopTemplate,
            outcome: {
              type: "COMPLETED",
              summary: "Provider claims that QA passed.",
              artifacts: [
                {
                  kind: "QA_REPORT",
                  title: "Provider QA",
                  summary: "This report has no measured browser provenance.",
                  checks: ["Provider says the page looks correct."],
                },
              ],
            },
            resultTree: fixedTree,
          },
        }),
      ).toThrow(expect.objectContaining({ code: "QA_MEASUREMENT_REQUIRED" }));
      const qaPlan = {
        schemaVersion: 1 as const,
        revision: 1,
        contentHash: `sha256:${"e".repeat(64)}`,
        targets: [
          {
            id: "desktop-light-en",
            viewport: { width: 1_280, height: 800 },
            locale: "en-US",
            theme: "LIGHT" as const,
          },
        ],
        scenarios: [
          {
            id: "task-cockpit",
            title: "Task Cockpit shows the current state",
            steps: [
              {
                id: "open",
                title: "Open the Task Cockpit",
                action: { type: "NAVIGATE" as const, path: "/" },
              },
            ],
            assertions: [
              {
                id: "state-visible",
                title: "Current state is visible",
                rule: {
                  type: "VISIBLE" as const,
                  locator: { by: "TEXT" as const, value: "Current work" },
                },
              },
            ],
          },
        ],
      };
      const reserveCommand = {
        schemaVersion: 1 as const,
        commandId: "reserve-q1-browser-qa",
        correlationId: "correlation-reserve-q1-browser-qa",
        actor: { type: "SYSTEM" as const, id: "local-daemon" },
        type: "RESERVE_QA_RUN" as const,
        payload: {
          stageAttemptId: qaDispatch.stageAttemptId,
          agentRunId: qaAgent.run.id,
          testedTree: fixedTree,
          targetOrigin: "http://127.0.0.1:4173",
          plan: qaPlan,
          scope: { type: "FULL" as const },
        },
      };
      expect(() =>
        reopened.execute({ ...reserveCommand, actor: { type: "HUMAN", id: "local-owner" } }),
      ).toThrow(expect.objectContaining({ code: "QA_RUN_ACTOR_FORBIDDEN" }));
      const reserved = reopened.execute(reserveCommand);
      if (reserved.type !== "QA_RUN_RESERVED") throw new Error("Expected durable QA reservation");
      expect(reserved).toMatchObject({
        replayed: false,
        qaRun: {
          agentRunId: qaAgent.run.id,
          testedTree: fixedTree,
          status: "RUNNING",
          version: 1,
        },
        event: { type: "QA_RUN_RESERVED" },
      });
      expect(reopened.execute(reserveCommand)).toMatchObject({
        type: "QA_RUN_RESERVED",
        replayed: true,
      });

      const completionCommand = {
        schemaVersion: 1 as const,
        commandId: "complete-q1-browser-qa",
        correlationId: "correlation-complete-q1-browser-qa",
        actor: { type: "SYSTEM" as const, id: "local-daemon" },
        type: "COMPLETE_QA_RUN" as const,
        payload: {
          qaRunId: reserved.qaRun.id,
          expectedVersion: 1,
          currentTree: fixedTree,
          result: {
            outcome: "MEASURED" as const,
            environment: {
              osFamily: "MACOS" as const,
              runtimeName: "NODE" as const,
              runtimeVersion: "24.7.0",
              browserName: "CHROMIUM" as const,
              browserVersion: "140.0",
            },
            executions: [
              {
                targetId: "desktop-light-en",
                scenarioId: "task-cockpit",
                durationMs: 80,
                steps: [{ id: "open", status: "PASSED" as const, durationMs: 50 }],
                assertions: [{ id: "state-visible", status: "PASSED" as const, details: null }],
              },
            ],
            observations: [],
            attachments: [
              {
                handle: "quarantine-screenshot-1",
                kind: "SCREENSHOT" as const,
                contentHash: `sha256:${"f".repeat(64)}`,
                byteSize: 4_096,
                targetId: "desktop-light-en",
                scenarioId: "task-cockpit",
                capturedAt: timestamp,
              },
            ],
            defects: [],
          },
          finalizedAttachments: [
            {
              handle: "quarantine-screenshot-1",
              ref: {
                schemaVersion: 1 as const,
                id: "qa-attachment-screenshot-1",
                qaRunId: reserved.qaRun.id,
                kind: "SCREENSHOT" as const,
                contentHash: `sha256:${"f".repeat(64)}`,
                byteSize: 4_096,
                targetId: "desktop-light-en",
                scenarioId: "task-cockpit",
                capturedAt: timestamp,
                retentionClass: "STANDARD_30_DAYS" as const,
                storageKey: `${reserved.qaRun.id}/desktop-light-en/task-cockpit.png`,
              },
            },
          ],
        },
      };
      const measuredExecution = completionCommand.payload.result.executions[0];
      if (!measuredExecution) throw new Error("Expected measured browser execution fixture");
      expect(() =>
        reopened.execute({
          ...completionCommand,
          commandId: "complete-q1-browser-qa-stale-version",
          correlationId: "correlation-complete-q1-browser-qa-stale-version",
          payload: { ...completionCommand.payload, expectedVersion: 2 },
        }),
      ).toThrow(expect.objectContaining({ code: "QA_RUN_VERSION_CONFLICT" }));
      expect(() =>
        reopened.execute({
          ...completionCommand,
          commandId: "complete-q1-browser-qa-inconsistent",
          correlationId: "correlation-complete-q1-browser-qa-inconsistent",
          payload: {
            ...completionCommand.payload,
            result: {
              ...completionCommand.payload.result,
              executions: [
                {
                  ...measuredExecution,
                  assertions: [
                    {
                      id: "state-visible",
                      status: "FAILED" as const,
                      details: "The current state was absent.",
                    },
                  ],
                },
              ],
              defects: [],
            },
          },
        }),
      ).toThrow(expect.objectContaining({ code: "QA_EVIDENCE_INCONSISTENT" }));
      const completed = reopened.execute(completionCommand);
      if (completed.type !== "QA_RUN_COMPLETED") throw new Error("Expected completed QA run");
      expect(completed).toMatchObject({
        type: "QA_RUN_COMPLETED",
        replayed: false,
        qaRun: { status: "PASSED", version: 2 },
        evidence: { verdict: "PASSED", testedTree: fixedTree, defectIds: [] },
        attachments: [
          {
            id: "qa-attachment-screenshot-1",
            storageKey: `${reserved.qaRun.id}/desktop-light-en/task-cockpit.png`,
          },
        ],
        defects: [],
        event: { type: "QA_RUN_COMPLETED" },
      });
      expect(reopened.execute(completionCommand)).toMatchObject({
        type: "QA_RUN_COMPLETED",
        replayed: true,
      });
      expect(reopened.query({ type: "GET_QA_STATE", pipelineRunId: snapshot.snapshot.run.id })).toMatchObject(
        {
          type: "QA_STATE",
          runs: [{ id: reserved.qaRun.id, status: "PASSED" }],
          evidence: [{ verdict: "PASSED" }],
          attachments: [{ id: "qa-attachment-screenshot-1" }],
          defects: [],
        },
      );
      const workflowAfterQA = reopened.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      if (workflowAfterQA.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
      expect(workflowAfterQA.snapshot.run).toMatchObject({ status: "RUNNING" });
      expect(
        workflowAfterQA.snapshot.stageAttempts.find(({ id }) => id === qaDispatch.stageAttemptId),
      ).toMatchObject({ stage: "QA", status: "SUCCEEDED" });
      expect(
        workflowAfterQA.snapshot.stageAttempts.find(({ stage }) => stage === "ACCEPTANCE"),
      ).toMatchObject({ status: "QUEUED" });
      expect(workflowAfterQA.snapshot.artifacts.find(({ kind }) => kind === "QA_REPORT")).toMatchObject({
        qaRunId: reserved.qaRun.id,
        qaEvidenceBundleId: completed.evidence?.id,
        testedTree: fixedTree,
      });
      const completedAgent = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        completedAgent.prepare("SELECT status FROM agent_runs WHERE id = ?").get(qaAgent.run.id),
      ).toEqual({
        status: "SUCCEEDED",
      });
      completedAgent.close();
      reopened.close();
      state = undefined;
      const qaRestart = await open();
      expect(qaRestart.query({ type: "GET_QA_RUN", qaRunId: reserved.qaRun.id })).toMatchObject({
        type: "QA_RUN",
        qaRun: { status: "PASSED", version: 2 },
      });
      qaRestart.close();
      state = undefined;
      const immutableQA = new DatabaseSync(databasePath);
      expect(() => {
        immutableQA.exec(
          `UPDATE qa_runs SET tested_tree = '${"0".repeat(40)}' WHERE id = '${reserved.qaRun.id}'`,
        );
      }).toThrow(/only complete once/);
      expect(() => {
        immutableQA.exec("UPDATE qa_evidence_bundles SET verdict = 'FAILED'");
      }).toThrow(/append-only/);
      expect(() => {
        immutableQA.exec("DELETE FROM qa_attachment_refs");
      }).toThrow(/append-only/);
      immutableQA.close();
    });

    it("starts the first bounded correction atomically when measured browser QA fails", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const created = localState.execute(createWorkItem("create-q1-failed-qa"));
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute(moveWorkItem("ready-q1-failed-qa", created.workItem.id, 1, "READY"));
      const template: StartMockPipelineCommand["payload"]["template"] = {
        schemaVersion: 1,
        id: "q1-failed-qa-v1",
        version: 1,
        name: "Measured QA failure",
        stages: [
          { stage: "IMPLEMENT", ordinal: 0, contextPack },
          { stage: "REVIEW", ordinal: 1, contextPack },
          { stage: "QA", ordinal: 2, contextPack },
          { stage: "ACCEPTANCE", ordinal: 3, contextPack },
        ],
      };
      const pipeline = localState.execute({
        schemaVersion: 1,
        commandId: "pipeline-q1-failed-qa",
        correlationId: "correlation-pipeline-q1-failed-qa",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      const initialAuthor = localState.execute(
        startAgentRun("q1-failed-initial-author", pipeline.dispatch.id),
      );
      if (initialAuthor.type !== "AGENT_RUN_STARTED") throw new Error("Expected initial author AgentRun");
      const testedTree = "c".repeat(40);
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-q1-failed-implementation",
        correlationId: "correlation-apply-q1-failed-implementation",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: pipeline.dispatch.id,
          provider: "CODEX",
          template,
          outcome: { type: "COMPLETED", summary: "Implementation is ready for browser QA." },
          resultTree: testedTree,
        },
      });
      const pendingReview = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pendingReview.type !== "WORKFLOW_DISPATCHES" || pendingReview.dispatches[0] === undefined) {
        throw new Error("Expected initial REVIEW dispatch");
      }
      const initialReviewDispatch = pendingReview.dispatches[0];
      const initialReviewerCommand = startAgentRun("q1-failed-initial-reviewer", initialReviewDispatch.id);
      const initialReviewer = localState.execute({
        ...initialReviewerCommand,
        payload: { ...initialReviewerCommand.payload, provider: "CLAUDE_CODE" },
      });
      if (initialReviewer.type !== "AGENT_RUN_STARTED") throw new Error("Expected initial reviewer AgentRun");
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-q1-failed-initial-review",
        correlationId: "correlation-apply-q1-failed-initial-review",
        actor: { type: "SYSTEM", id: "claude-code-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: initialReviewDispatch.id,
          provider: "CLAUDE_CODE",
          template,
          outcome: {
            type: "COMPLETED",
            summary: "The initial tree passed independent review.",
            artifacts: [
              {
                kind: "REVIEW_REPORT",
                title: "Initial independent review",
                summary: "The initial implementation is internally consistent.",
                checks: ["Inspected the initial implementation tree."],
              },
            ],
            reviewReport: {
              kind: "REVIEW_REPORT",
              title: "Initial independent review",
              summary: "The initial implementation is internally consistent.",
              checks: ["Inspected the initial implementation tree."],
              verdict: "PASSED",
              findings: [],
            },
          },
          resultTree: testedTree,
        },
      });
      const pendingQA = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pendingQA.type !== "WORKFLOW_DISPATCHES" || !pendingQA.dispatches[0]) {
        throw new Error("Expected QA dispatch");
      }
      const qaDispatch = pendingQA.dispatches[0];
      const qaAgent = localState.execute(startAgentRun("q1-failed-browser-qa", qaDispatch.id));
      if (qaAgent.type !== "AGENT_RUN_STARTED") throw new Error("Expected Browser QA AgentRun");
      const plan = {
        schemaVersion: 1 as const,
        revision: 1,
        contentHash: `sha256:${"d".repeat(64)}`,
        targets: [
          {
            id: "mobile-dark-ru",
            viewport: { width: 320, height: 720 },
            locale: "ru-RU",
            theme: "DARK" as const,
          },
        ],
        scenarios: [
          {
            id: "task-cockpit",
            title: "Task Cockpit remains usable on mobile",
            steps: [
              {
                id: "open",
                title: "Open the Task Cockpit",
                action: { type: "NAVIGATE" as const, path: "/" },
              },
            ],
            assertions: [
              {
                id: "no-overflow",
                title: "The page does not overflow horizontally",
                rule: { type: "NO_HORIZONTAL_OVERFLOW" as const },
              },
            ],
          },
        ],
      };
      const reserved = localState.execute({
        schemaVersion: 1,
        commandId: "reserve-q1-failed-browser-qa",
        correlationId: "correlation-reserve-q1-failed-browser-qa",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "RESERVE_QA_RUN",
        payload: {
          stageAttemptId: qaDispatch.stageAttemptId,
          agentRunId: qaAgent.run.id,
          testedTree,
          targetOrigin: "http://127.0.0.1:4173",
          plan,
          scope: { type: "FULL" },
        },
      });
      if (reserved.type !== "QA_RUN_RESERVED") throw new Error("Expected QA reservation");
      const completionCommand = {
        schemaVersion: 1 as const,
        commandId: "complete-q1-failed-browser-qa",
        correlationId: "correlation-complete-q1-failed-browser-qa",
        actor: { type: "SYSTEM" as const, id: "local-daemon" },
        type: "COMPLETE_QA_RUN" as const,
        payload: {
          qaRunId: reserved.qaRun.id,
          expectedVersion: 1,
          currentTree: testedTree,
          result: {
            outcome: "MEASURED" as const,
            environment: {
              osFamily: "MACOS" as const,
              runtimeName: "NODE" as const,
              runtimeVersion: "24.7.0",
              browserName: "CHROMIUM" as const,
              browserVersion: "140.0",
            },
            executions: [
              {
                targetId: "mobile-dark-ru",
                scenarioId: "task-cockpit",
                durationMs: 90,
                steps: [{ id: "open", status: "PASSED" as const, durationMs: 40 }],
                assertions: [
                  { id: "no-overflow", status: "FAILED" as const, details: "The page is 24px too wide." },
                ],
              },
            ],
            observations: [],
            attachments: [
              {
                handle: "failed-qa-screenshot",
                kind: "SCREENSHOT" as const,
                contentHash: `sha256:${"a".repeat(64)}`,
                byteSize: 8,
                targetId: "mobile-dark-ru",
                scenarioId: "task-cockpit",
                capturedAt: timestamp,
              },
            ],
            defects: [
              {
                severity: "HIGH" as const,
                title: "Task Cockpit overflows on mobile",
                description: "The measured page width exceeds the 320px viewport.",
                reproduction: ["Open the Task Cockpit at 320x720.", "Compare scrollWidth and clientWidth."],
                targetId: "mobile-dark-ru",
                scenarioId: "task-cockpit",
              },
            ],
          },
          finalizedAttachments: [
            {
              handle: "failed-qa-screenshot",
              ref: {
                schemaVersion: 1 as const,
                id: "failed-qa-attachment",
                qaRunId: reserved.qaRun.id,
                kind: "SCREENSHOT" as const,
                contentHash: `sha256:${"a".repeat(64)}`,
                byteSize: 8,
                targetId: "mobile-dark-ru",
                scenarioId: "task-cockpit",
                capturedAt: timestamp,
                retentionClass: "STANDARD_30_DAYS" as const,
                storageKey: `run-${"a".repeat(32)}/screenshot.png`,
              },
            },
          ],
        },
      };
      const completed = localState.execute(completionCommand);
      expect(completed).toMatchObject({
        type: "QA_RUN_COMPLETED",
        qaRun: { status: "FAILED" },
        evidence: { verdict: "FAILED" },
        defects: [{ severity: "HIGH", status: "OPEN" }],
      });
      const failedSnapshot = localState.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      if (failedSnapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected failed QA snapshot");
      expect(failedSnapshot.snapshot).toMatchObject({
        run: { status: "RUNNING" },
        artifacts: [{ kind: "REVIEW_REPORT", correctionRunId: null, testedTree }],
        acceptancePackage: null,
        humanRequests: [],
      });
      expect(localState.query({ type: "GET_WORK_ITEM", workItemId: created.workItem.id })).toMatchObject({
        type: "WORK_ITEM",
        workItem: { state: "IN_PROGRESS", currentStage: "IMPLEMENT" },
      });
      expect(
        failedSnapshot.snapshot.stageAttempts.find(({ id }) => id === qaDispatch.stageAttemptId),
      ).toMatchObject({ stage: "QA", status: "SUCCEEDED", resultTree: testedTree });
      const correctionImplementation = failedSnapshot.snapshot.stageAttempts.at(-1);
      expect(correctionImplementation).toMatchObject({
        stage: "IMPLEMENT",
        attempt: 1,
        status: "QUEUED",
      });
      if (correctionImplementation?.correctionRunId === null || correctionImplementation === undefined) {
        throw new Error("Expected a correction-bound IMPLEMENT attempt");
      }
      const correctionDispatches = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      expect(correctionDispatches).toMatchObject({
        type: "WORKFLOW_DISPATCHES",
        dispatches: [{ stageAttemptId: correctionImplementation.id, status: "PENDING" }],
      });
      if (
        correctionDispatches.type !== "WORKFLOW_DISPATCHES" ||
        correctionDispatches.dispatches[0] === undefined
      ) {
        throw new Error("Expected the correction IMPLEMENT dispatch");
      }
      const correctionDispatch = correctionDispatches.dispatches[0];
      const correctionQAState = localState.query({
        type: "GET_QA_STATE",
        pipelineRunId: pipeline.run.id,
      });
      expect(correctionQAState).toMatchObject({
        type: "QA_STATE",
        runs: [{ id: reserved.qaRun.id, status: "FAILED" }],
        defects: [{ severity: "HIGH", status: "OPEN" }],
        correctionRuns: [
          {
            id: correctionImplementation.correctionRunId,
            ordinal: 1,
            sourceQARunId: reserved.qaRun.id,
            baselineQARunId: reserved.qaRun.id,
            status: "ACTIVE",
          },
        ],
        retestPlans: [
          {
            correctionRunId: correctionImplementation.correctionRunId,
            baselineQARunId: reserved.qaRun.id,
            sourceQARunId: reserved.qaRun.id,
            cells: [
              {
                targetId: "mobile-dark-ru",
                scenarioId: "task-cockpit",
                reasons: ["FAILED_CHECK", "OPEN_DEFECT"],
              },
            ],
          },
        ],
      });
      if (correctionQAState.type !== "QA_STATE") throw new Error("Expected correction QA state");
      const activeCorrection = correctionQAState.correctionRuns[0];
      const activeRetestPlan = correctionQAState.retestPlans[0];
      if (activeCorrection === undefined || activeRetestPlan === undefined) {
        throw new Error("Expected an active correction and retest plan");
      }
      expect(
        localState.query({
          type: "READ_CONTEXT_SOURCES",
          stageAttemptId: correctionImplementation.id,
          sessionOrdinal: 1,
        }),
      ).toMatchObject({
        type: "CONTEXT_SOURCES",
        sources: {
          qaCorrection: {
            correctionRun: { id: activeCorrection.id, ordinal: 1, status: "ACTIVE" },
            sourceQARun: { id: reserved.qaRun.id, testedTree, targetOrigin: reserved.qaRun.targetOrigin },
            retestPlan: {
              id: activeRetestPlan.id,
              baselinePlanRevision: reserved.qaRun.plan.revision,
              baselinePlanContentHash: reserved.qaRun.plan.contentHash,
            },
            currentTree: testedTree,
            defects: [{ severity: "HIGH", status: "OPEN", targetId: "mobile-dark-ru" }],
          },
        },
      });

      const correctionAuthor = localState.execute(
        startAgentRun("q2-correction-author", correctionDispatch.id),
      );
      if (correctionAuthor.type !== "AGENT_RUN_STARTED")
        throw new Error("Expected correction author AgentRun");
      const correctedTree = "e".repeat(40);
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-q2-correction-implementation",
        correlationId: "correlation-apply-q2-correction-implementation",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: correctionDispatch.id,
          provider: "CODEX",
          template,
          outcome: { type: "COMPLETED", summary: "The measured mobile overflow is corrected." },
          resultTree: correctedTree,
        },
      });
      const correctionReviewDispatches = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (
        correctionReviewDispatches.type !== "WORKFLOW_DISPATCHES" ||
        correctionReviewDispatches.dispatches[0] === undefined
      ) {
        throw new Error("Expected the correction REVIEW dispatch");
      }
      const correctionReviewDispatch = correctionReviewDispatches.dispatches[0];
      expect(
        localState.query({
          type: "READ_CONTEXT_SOURCES",
          stageAttemptId: correctionReviewDispatch.stageAttemptId,
          sessionOrdinal: 1,
        }),
      ).toMatchObject({
        type: "CONTEXT_SOURCES",
        sources: {
          qaCorrection: {
            correctionRun: { id: activeCorrection.id },
            currentTree: correctedTree,
          },
          reviewInput: {
            implementationAttempt: { attempt: 1, resultTree: correctedTree },
          },
        },
      });
      const correctionReviewerCommand = startAgentRun("q2-correction-reviewer", correctionReviewDispatch.id);
      const correctionReviewer = localState.execute({
        ...correctionReviewerCommand,
        payload: { ...correctionReviewerCommand.payload, provider: "CLAUDE_CODE" },
      });
      if (correctionReviewer.type !== "AGENT_RUN_STARTED") {
        throw new Error("Expected correction reviewer AgentRun");
      }
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-q2-correction-review",
        correlationId: "correlation-apply-q2-correction-review",
        actor: { type: "SYSTEM", id: "claude-code-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: correctionReviewDispatch.id,
          provider: "CLAUDE_CODE",
          template,
          outcome: {
            type: "COMPLETED",
            summary: "The correction passed fresh independent review.",
            artifacts: [
              {
                kind: "REVIEW_REPORT",
                title: "Correction independent review",
                summary: "The mobile overflow correction is scoped and complete.",
                checks: ["Reproduced the original overflow and inspected the corrected tree."],
              },
            ],
            reviewReport: {
              kind: "REVIEW_REPORT",
              title: "Correction independent review",
              summary: "The mobile overflow correction is scoped and complete.",
              checks: ["Reproduced the original overflow and inspected the corrected tree."],
              verdict: "PASSED",
              findings: [],
            },
          },
          resultTree: correctedTree,
        },
      });
      const retestDispatches = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (retestDispatches.type !== "WORKFLOW_DISPATCHES" || retestDispatches.dispatches[0] === undefined) {
        throw new Error("Expected the correction QA dispatch");
      }
      const retestDispatch = retestDispatches.dispatches[0];
      const retestAgent = localState.execute(startAgentRun("q2-correction-browser-qa", retestDispatch.id));
      if (retestAgent.type !== "AGENT_RUN_STARTED") throw new Error("Expected retest Browser QA AgentRun");
      const erroredRetestReservation = localState.execute({
        schemaVersion: 1,
        commandId: "reserve-q2-correction-browser-qa",
        correlationId: "correlation-reserve-q2-correction-browser-qa",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "RESERVE_QA_RUN",
        payload: {
          stageAttemptId: retestDispatch.stageAttemptId,
          agentRunId: retestAgent.run.id,
          testedTree: correctedTree,
          targetOrigin: reserved.qaRun.targetOrigin,
          plan: reserved.qaRun.plan,
          scope: {
            type: "RETEST",
            correctionRunId: activeCorrection.id,
            retestPlanId: activeRetestPlan.id,
          },
        },
      });
      if (erroredRetestReservation.type !== "QA_RUN_RESERVED") {
        throw new Error("Expected QA retest reservation");
      }
      expect(erroredRetestReservation.qaRun).toMatchObject({
        testedTree: correctedTree,
        scope: {
          type: "RETEST",
          correctionRunId: activeCorrection.id,
          retestPlanId: activeRetestPlan.id,
        },
      });
      localState.execute({
        schemaVersion: 1,
        commandId: "error-q2-correction-browser-qa",
        correlationId: "correlation-error-q2-correction-browser-qa",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "COMPLETE_QA_RUN",
        payload: {
          qaRunId: erroredRetestReservation.qaRun.id,
          expectedVersion: 1,
          currentTree: correctedTree,
          result: {
            outcome: "ERROR",
            code: "TARGET_UNHEALTHY",
            summary: "The loopback target briefly refused connections.",
          },
          finalizedAttachments: [],
        },
      });
      const erroredSnapshot = localState.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      if (erroredSnapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected errored retest state");
      const retryRequest = erroredSnapshot.snapshot.humanRequests.at(-1);
      expect(erroredSnapshot.snapshot).toMatchObject({
        run: { status: "WAITING_HUMAN" },
        humanRequests: [expect.objectContaining({ status: "OPEN" })],
      });
      expect(
        erroredSnapshot.snapshot.stageAttempts.some(
          ({ id, correctionRunId, status }) =>
            id === retestDispatch.stageAttemptId &&
            correctionRunId === activeCorrection.id &&
            status === "WAITING_HUMAN",
        ),
      ).toBe(true);
      expect(localState.query({ type: "GET_QA_STATE", pipelineRunId: pipeline.run.id })).toMatchObject({
        type: "QA_STATE",
        runs: [{ status: "FAILED" }, { status: "ERROR" }],
        correctionRuns: [{ id: activeCorrection.id, ordinal: 1, status: "ACTIVE", version: 1 }],
      });
      if (retryRequest === undefined) throw new Error("Expected environment retry request");
      localState.execute({
        schemaVersion: 1,
        commandId: "answer-q2-correction-environment-retry",
        correlationId: "correlation-answer-q2-correction-environment-retry",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ANSWER_HUMAN_REQUEST",
        payload: {
          humanRequestId: retryRequest.id,
          expectedVersion: retryRequest.version,
          answer: { type: "OTHER", text: "The local target is healthy again; rerun the same retest." },
        },
      });
      const retryDispatches = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (retryDispatches.type !== "WORKFLOW_DISPATCHES" || retryDispatches.dispatches[0] === undefined) {
        throw new Error("Expected resumed correction QA dispatch");
      }
      const retryDispatch = retryDispatches.dispatches[0];
      const retryAgent = localState.execute(
        startAgentRun("q2-correction-browser-qa-environment-retry", retryDispatch.id),
      );
      if (retryAgent.type !== "AGENT_RUN_STARTED") throw new Error("Expected retry Browser QA AgentRun");
      const passingRetestReservation = localState.execute({
        schemaVersion: 1,
        commandId: "reserve-q2-correction-browser-qa-environment-retry",
        correlationId: "correlation-reserve-q2-correction-browser-qa-environment-retry",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "RESERVE_QA_RUN",
        payload: {
          stageAttemptId: retryDispatch.stageAttemptId,
          agentRunId: retryAgent.run.id,
          testedTree: correctedTree,
          targetOrigin: reserved.qaRun.targetOrigin,
          plan: reserved.qaRun.plan,
          scope: {
            type: "RETEST",
            correctionRunId: activeCorrection.id,
            retestPlanId: activeRetestPlan.id,
          },
        },
      });
      if (passingRetestReservation.type !== "QA_RUN_RESERVED") {
        throw new Error("Expected resumed QA retest reservation");
      }
      localState.execute({
        schemaVersion: 1,
        commandId: "complete-q2-correction-browser-qa",
        correlationId: "correlation-complete-q2-correction-browser-qa",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "COMPLETE_QA_RUN",
        payload: {
          qaRunId: passingRetestReservation.qaRun.id,
          expectedVersion: 1,
          currentTree: correctedTree,
          result: {
            outcome: "MEASURED",
            environment: completionCommand.payload.result.environment,
            executions: [
              {
                targetId: "mobile-dark-ru",
                scenarioId: "task-cockpit",
                durationMs: 80,
                steps: [{ id: "open", status: "PASSED", durationMs: 35 }],
                assertions: [{ id: "no-overflow", status: "PASSED", details: null }],
              },
            ],
            observations: [],
            attachments: [],
            defects: [],
          },
          finalizedAttachments: [],
        },
      });
      const passingSnapshot = localState.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      expect(passingSnapshot).toMatchObject({
        type: "WORKFLOW_SNAPSHOT",
        snapshot: {
          run: { status: "RUNNING" },
          acceptancePackage: null,
        },
      });
      if (passingSnapshot.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected passing workflow state");
      expect(
        passingSnapshot.snapshot.artifacts.some(
          ({ kind, qaRunId }) => kind === "QA_REPORT" && qaRunId === passingRetestReservation.qaRun.id,
        ),
      ).toBe(true);
      expect(
        passingSnapshot.snapshot.stageAttempts.some(
          ({ correctionRunId, stage, status }) =>
            correctionRunId === activeCorrection.id && stage === "ACCEPTANCE" && status === "QUEUED",
        ),
      ).toBe(true);
      expect(localState.query({ type: "GET_WORK_ITEM", workItemId: created.workItem.id })).toMatchObject({
        type: "WORK_ITEM",
        workItem: { currentStage: "ACCEPTANCE", state: "IN_PROGRESS" },
      });
      const passedQAState = localState.query({ type: "GET_QA_STATE", pipelineRunId: pipeline.run.id });
      expect(passedQAState).toMatchObject({
        type: "QA_STATE",
        defects: [{ status: "RESOLVED", version: 2 }],
        correctionRuns: [{ id: activeCorrection.id, status: "PASSED", version: 2 }],
      });
      const correctionEvents = localState.query({
        type: "LIST_EVENTS",
        aggregateId: created.workItem.id,
        direction: "ASC",
      });
      if (correctionEvents.type !== "EVENTS") throw new Error("Expected correction events");
      expect(correctionEvents.events.map(({ type }) => type)).toEqual(
        expect.arrayContaining(["QA_CORRECTION_STARTED", "QA_CORRECTION_PASSED"]),
      );
      expect(localState.query({ type: "LIST_EXPIRED_QA_ATTACHMENTS", closedBefore: timestamp })).toEqual({
        type: "QA_ATTACHMENTS",
        attachments: [],
      });
      if (passingSnapshot.snapshot.run === null) {
        throw new Error("Expected the corrected pipeline run");
      }
      localState.execute({
        schemaVersion: 1,
        commandId: "cancel-q1-failed-qa",
        correlationId: "correlation-cancel-q1-failed-qa",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CANCEL_PIPELINE",
        payload: {
          pipelineRunId: passingSnapshot.snapshot.run.id,
          expectedVersion: passingSnapshot.snapshot.run.version,
        },
      });
      expect(
        localState.query({
          type: "LIST_EXPIRED_QA_ATTACHMENTS",
          closedBefore: "2026-08-22T17:59:59.000Z",
        }),
      ).toEqual({ type: "QA_ATTACHMENTS", attachments: [] });
      expect(
        localState.query({ type: "LIST_EXPIRED_QA_ATTACHMENTS", closedBefore: timestamp }),
      ).toMatchObject({
        type: "QA_ATTACHMENTS",
        attachments: [{ id: "failed-qa-attachment" }],
      });
      const retentionCommand = {
        schemaVersion: 1 as const,
        commandId: "record-q1-retention",
        correlationId: "correlation-record-q1-retention",
        actor: { type: "SYSTEM" as const, id: "local-daemon" },
        type: "RECORD_QA_ATTACHMENT_RETENTION" as const,
        payload: { attachmentId: "failed-qa-attachment", outcome: "DELETED" as const },
      };
      expect(() =>
        localState.execute({
          ...retentionCommand,
          commandId: "record-q1-retention-as-owner",
          actor: { type: "HUMAN", id: "local-owner" },
        }),
      ).toThrow(expect.objectContaining({ code: "QA_RETENTION_ACTOR_FORBIDDEN" }));
      expect(localState.execute(retentionCommand)).toMatchObject({
        type: "QA_ATTACHMENT_RETENTION_RECORDED",
        replayed: false,
        attachmentId: "failed-qa-attachment",
        outcome: "DELETED",
      });
      expect(localState.execute(retentionCommand)).toMatchObject({
        type: "QA_ATTACHMENT_RETENTION_RECORDED",
        replayed: true,
      });
      expect(localState.query({ type: "LIST_EXPIRED_QA_ATTACHMENTS", closedBefore: timestamp })).toEqual({
        type: "QA_ATTACHMENTS",
        attachments: [],
      });
      localState.close();
      state = undefined;

      const reopened = await open();
      expect(reopened.execute(completionCommand)).toMatchObject({
        type: "QA_RUN_COMPLETED",
        replayed: true,
        qaRun: { status: "FAILED" },
      });
      expect(reopened.query({ type: "GET_QA_RUN", qaRunId: reserved.qaRun.id })).toMatchObject({
        type: "QA_RUN",
        qaRun: { status: "FAILED" },
      });
      expect(reopened.query({ type: "GET_QA_STATE", pipelineRunId: pipeline.run.id })).toMatchObject({
        type: "QA_STATE",
        runs: [{ status: "FAILED" }, { status: "ERROR" }, { status: "PASSED" }],
        defects: [{ status: "RESOLVED" }],
        correctionRuns: [{ ordinal: 1, status: "PASSED" }],
        retestPlans: [{ baselineQARunId: reserved.qaRun.id }],
      });
    });

    it("persists one owner-authorized review round and prevents a fourth round after restart", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const created = localState.execute(createWorkItem("create-r1-owner-round"));
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute(moveWorkItem("ready-r1-owner-round", created.workItem.id, 1, "READY"));
      const reviewLoopTemplate: StartMockPipelineCommand["payload"]["template"] = {
        schemaVersion: 1,
        id: "review-owner-round-v1",
        version: 1,
        name: "Owner-authorized review round",
        stages: [
          { stage: "IMPLEMENT", ordinal: 0, contextPack },
          { stage: "REVIEW", ordinal: 1, contextPack },
          { stage: "QA", ordinal: 2, contextPack },
        ],
      };
      localState.execute({
        schemaVersion: 1,
        commandId: "pipeline-r1-owner-round",
        correlationId: "correlation-pipeline-r1-owner-round",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: reviewLoopTemplate,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });

      const pendingDispatch = (target: LocalState) => {
        const pending = target.query({ type: "LIST_PENDING_DISPATCHES" });
        if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
        const dispatch = pending.dispatches.find(({ workItemId }) => workItemId === created.workItem.id);
        if (!dispatch) throw new Error("Expected a pending review-loop dispatch");
        return dispatch;
      };
      const completeImplementation = (target: LocalState, round: number, tree: string): void => {
        const dispatch = pendingDispatch(target);
        target.execute(startAgentRun(`owner-round-author-${round.toString()}`, dispatch.id));
        target.execute({
          schemaVersion: 1,
          commandId: `apply-owner-round-implementation-${round.toString()}`,
          correlationId: `correlation-owner-round-implementation-${round.toString()}`,
          actor: { type: "SYSTEM", id: "codex-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            dispatchId: dispatch.id,
            provider: "CODEX",
            template: reviewLoopTemplate,
            outcome: { type: "COMPLETED", summary: `Implementation ${round.toString()} completed.` },
            resultTree: tree,
          },
        });
      };
      const requestChanges = (target: LocalState, round: number, tree: string): void => {
        const dispatch = pendingDispatch(target);
        const reviewerCommand = startAgentRun(`owner-round-reviewer-${round.toString()}`, dispatch.id);
        target.execute({
          ...reviewerCommand,
          payload: { ...reviewerCommand.payload, provider: "CLAUDE_CODE" },
        });
        target.execute({
          schemaVersion: 1,
          commandId: `apply-owner-round-review-${round.toString()}`,
          correlationId: `correlation-owner-round-review-${round.toString()}`,
          actor: { type: "SYSTEM", id: "claude-code-provider" },
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            dispatchId: dispatch.id,
            provider: "CLAUDE_CODE",
            template: reviewLoopTemplate,
            outcome: {
              type: "COMPLETED",
              summary: `Review ${round.toString()} requested changes.`,
              artifacts: [
                {
                  kind: "REVIEW_REPORT",
                  title: `Review ${round.toString()}`,
                  summary: "A bounded synthetic defect remains.",
                  checks: ["Checked the synthetic invariant."],
                },
              ],
              reviewReport: {
                kind: "REVIEW_REPORT",
                title: `Review ${round.toString()}`,
                summary: "A bounded synthetic defect remains.",
                checks: ["Checked the synthetic invariant."],
                verdict: "CHANGES_REQUESTED",
                findings: [
                  {
                    severity: "HIGH",
                    title: `Finding ${round.toString()}`,
                    description: "The synthetic invariant is not yet enforced.",
                    path: "packages/domain/src/review.ts",
                    startLine: 1,
                    endLine: 1,
                    reproduction: "Run the bounded review fixture.",
                    criterion: "The automatic loop remains bounded.",
                    suggestedFix: "Enforce the invariant before the next review.",
                  },
                ],
              },
            },
            resultTree: tree,
          },
        });
      };

      completeImplementation(localState, 1, "1".repeat(40));
      requestChanges(localState, 1, "1".repeat(40));
      completeImplementation(localState, 2, "2".repeat(40));
      requestChanges(localState, 2, "2".repeat(40));

      const ownerRequests = localState.query({
        type: "LIST_HUMAN_REQUESTS",
        projectId: created.workItem.projectId,
        status: "OPEN",
      });
      if (ownerRequests.type !== "HUMAN_REQUESTS") throw new Error("Expected owner request list");
      const ownerRequest = ownerRequests.humanRequests.find(
        ({ workItemId }) => workItemId === created.workItem.id,
      );
      if (!ownerRequest) throw new Error("Expected exhausted review request");
      expect(ownerRequest.options).toHaveLength(2);
      const retryOption = ownerRequest.options[0];
      if (!retryOption) throw new Error("Expected the owner-authorized retry option");
      const authorized = localState.execute({
        schemaVersion: 1,
        commandId: "authorize-r1-owner-round",
        correlationId: "correlation-authorize-r1-owner-round",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ANSWER_HUMAN_REQUEST",
        payload: {
          humanRequestId: ownerRequest.id,
          expectedVersion: ownerRequest.version,
          answer: { type: "OPTION", optionIds: [retryOption.id] },
        },
      });
      expect(authorized).toMatchObject({
        type: "HUMAN_REQUEST_ANSWERED",
        dispatch: { mode: "START", status: "PENDING" },
        events: [{ type: "HUMAN_REQUEST_RESOLVED" }, { type: "STAGE_ATTEMPT_CHANGED" }],
      });

      localState.close();
      state = undefined;
      const reopened = await open();
      const afterRestart = reopened.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      if (afterRestart.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
      expect(afterRestart.snapshot.stageAttempts.at(-1)).toMatchObject({
        stage: "IMPLEMENT",
        attempt: 3,
        status: "QUEUED",
      });

      completeImplementation(reopened, 3, "3".repeat(40));
      requestChanges(reopened, 3, "3".repeat(40));
      const finalRequests = reopened.query({
        type: "LIST_HUMAN_REQUESTS",
        projectId: created.workItem.projectId,
        status: "OPEN",
      });
      if (finalRequests.type !== "HUMAN_REQUESTS") throw new Error("Expected final owner request list");
      const finalRequest = finalRequests.humanRequests.find(
        ({ workItemId }) => workItemId === created.workItem.id,
      );
      if (!finalRequest) throw new Error("Expected final exhausted review request");
      expect(finalRequest.options).toHaveLength(1);
      const cancelOption = finalRequest.options[0];
      if (!cancelOption) throw new Error("Expected the cancel option");
      expect(cancelOption.label).toBe("Cancel the work");
      const cancelled = reopened.execute({
        schemaVersion: 1,
        commandId: "cancel-r1-owner-round",
        correlationId: "correlation-cancel-r1-owner-round",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ANSWER_HUMAN_REQUEST",
        payload: {
          humanRequestId: finalRequest.id,
          expectedVersion: finalRequest.version,
          answer: { type: "OPTION", optionIds: [cancelOption.id] },
        },
      });
      expect(cancelled).toMatchObject({
        type: "HUMAN_REQUEST_ANSWERED",
        dispatch: null,
        events: [{ type: "HUMAN_REQUEST_RESOLVED" }, { type: "PIPELINE_CANCELLED" }],
      });
      const cancelledSnapshot = reopened.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: created.workItem.id,
      });
      expect(cancelledSnapshot).toMatchObject({
        type: "WORKFLOW_SNAPSHOT",
        snapshot: { run: { status: "CANCELLED" } },
      });
      expect(reopened.query({ type: "GET_WORK_ITEM", workItemId: created.workItem.id })).toMatchObject({
        type: "WORK_ITEM",
        workItem: { state: "CANCELLED" },
      });
      expect(
        reopened.query({ type: "LIST_REVIEW_REPORTS", pipelineRunId: afterRestart.snapshot.run?.id ?? "" }),
      ).toMatchObject({
        type: "REVIEW_REPORTS",
        reports: [{ round: 3 }, { round: 2 }, { round: 1 }],
      });
      expect(reopened.query({ type: "LIST_PENDING_DISPATCHES" })).toMatchObject({
        type: "WORKFLOW_DISPATCHES",
        dispatches: [],
      });
    });
  });

  it("keeps a historical APPLY_MOCK_PROVIDER_OUTCOME command receipt readable after the provider rename", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-legacy-outcome-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-legacy-outcome", created.workItem.id, 1, "READY"));
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-legacy-outcome",
      correlationId: "correlation-start-legacy-outcome",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    localState.execute({
      schemaVersion: 1,
      commandId: "mark-legacy-outcome-started",
      correlationId: "correlation-mark-legacy-outcome-started",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: started.dispatch.id },
    });
    // The pre-rename discriminant, still accepted so that a receipt recorded under it stays
    // replayable (docs/plans/07-a1-session-handoff-spec.ru.md §5.3).
    const legacyApply: LegacyApplyMockProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: "legacy-apply-outcome",
      correlationId: "correlation-legacy-apply-outcome",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_MOCK_PROVIDER_OUTCOME",
      payload: {
        resultTree: null,
        dispatchId: started.dispatch.id,
        template: mockTemplate,
        outcome: { type: "COMPLETED", summary: "Legacy discovery completed." },
      },
    };
    const applied = localState.execute(legacyApply);
    if (applied.type !== "MOCK_PROVIDER_OUTCOME_APPLIED") throw new Error("Expected the legacy outcome");
    localState.close();
    state = undefined;

    const stored = new DatabaseSync(databasePath);
    const receipt = stored
      .prepare("SELECT command_type, result_json FROM commands WHERE command_id = ?")
      .get("legacy-apply-outcome") as { command_type: string; result_json: string };
    stored.close();

    // "Readable" is the claim, so it is read: the receipt goes back through `execute`, which parses
    // it with stateCommandResultSchema before returning it. Asserting only that the row survived
    // would pass even for a receipt no reader can parse -- which is precisely what a stored payload
    // missing a newly required field is.
    const reopened = await open();
    const replayed = reopened.execute(legacyApply);
    expect(replayed).toMatchObject({
      type: "MOCK_PROVIDER_OUTCOME_APPLIED",
      replayed: true,
      run: { id: applied.run.id },
      stageAttempt: { id: applied.stageAttempt.id, status: applied.stageAttempt.status },
    });
    const events = reopened.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    expect(events.type).toBe("EVENTS");
    reopened.close();
    state = undefined;

    // And the audit row itself was neither renamed nor rewritten by the replay.
    const verify = new DatabaseSync(databasePath);
    expect(
      verify
        .prepare("SELECT command_type, result_json FROM commands WHERE command_id = ?")
        .get("legacy-apply-outcome"),
    ).toEqual(receipt);
    verify.close();
  });

  it("backfills the BudgetPolicy in M4 PIPELINE_STARTED events", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-migration-workflow"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-migration-workflow", created.workItem.id, 1, "READY"));
    const startCommand: StartMockPipelineCommand = {
      schemaVersion: 1,
      commandId: "start-migration-workflow",
      correlationId: "correlation-start-migration-workflow",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    };
    const started = localState.execute(startCommand);
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    localState.execute({
      schemaVersion: 1,
      commandId: "mark-migration-workflow-started",
      correlationId: "correlation-mark-migration-workflow-started",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: started.dispatch.id },
    });
    const applyCommand: LegacyApplyMockProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: "apply-migration-workflow",
      correlationId: "correlation-apply-migration-workflow",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_MOCK_PROVIDER_OUTCOME",
      payload: {
        resultTree: null,
        dispatchId: started.dispatch.id,
        template: mockTemplate,
        outcome: { type: "COMPLETED", summary: "Legacy M4 discovery completed." },
      },
    };
    localState.execute(applyCommand);
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER events_are_append_only_update");
    raw.exec("DROP TRIGGER commands_are_append_only_update");
    raw.exec(
      "UPDATE events SET data_json = json_remove(data_json, '$.budgetPolicy') WHERE type = 'PIPELINE_STARTED'",
    );
    raw.exec(`
      UPDATE commands
      SET result_json = json_remove(
        result_json,
        '$.budgetPolicy',
        '$.events[0].data.budgetPolicy'
      )
      WHERE command_type = 'START_MOCK_PIPELINE'
    `);
    raw.exec(`
      UPDATE commands
      SET result_json = json_remove(result_json, '$.usageRecords')
      WHERE command_type = 'APPLY_MOCK_PROVIDER_OUTCOME'
    `);
    raw.exec(`
      CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `);
    raw.exec(`
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands
      BEGIN
        SELECT RAISE(ABORT, 'commands are append-only');
      END;
    `);
    raw.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    raw.close();

    const migrated = await open();
    expect(migrated.startup.appliedMigrations).toEqual([4]);
    const events = migrated.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    const pipelineStarted =
      events.type === "EVENTS" ? events.events.find(({ type }) => type === "PIPELINE_STARTED") : undefined;
    if (pipelineStarted?.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline event");
    expect(pipelineStarted.data.budgetPolicy.id).toMatch(/^budget-migrated-/);
    expect(pipelineStarted.data.budgetPolicy.pipelineRunId).toBe(pipelineStarted.data.run.id);
    expect(pipelineStarted.data.budgetPolicy.maxEstimatedTokens).toBe(100);
    expect(pipelineStarted.data.budgetPolicy.warningThresholds).toEqual([0.5, 0.8, 0.95]);
    const replayedStart = migrated.execute(startCommand);
    if (replayedStart.type !== "PIPELINE_STARTED") throw new Error("Expected replayed pipeline start");
    expect(replayedStart.replayed).toBe(true);
    expect(replayedStart.budgetPolicy.id).toMatch(/^budget-migrated-/);
    expect(replayedStart.budgetPolicy.maxEstimatedTokens).toBe(100);
    expect(migrated.execute(applyCommand)).toMatchObject({
      type: "MOCK_PROVIDER_OUTCOME_APPLIED",
      replayed: true,
      usageRecords: [],
    });
    migrated.close();
    state = undefined;

    const beforeM6 = new DatabaseSync(databasePath);
    beforeM6.exec("DROP TRIGGER events_are_append_only_delete");
    beforeM6.exec("DELETE FROM events WHERE type = 'SQUAD_ASSIGNED'");
    beforeM6.exec(`
      CREATE TRIGGER events_are_append_only_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `);
    beforeM6.exec("DROP TABLE acceptance_packages");
    beforeM6.exec("DROP TABLE evidence_artifacts");
    beforeM6.exec("DROP TRIGGER commands_are_append_only_update");
    beforeM6.exec(`
      UPDATE commands
      SET result_json = json_remove(result_json, '$.artifacts', '$.acceptancePackage')
      WHERE command_type = 'APPLY_MOCK_PROVIDER_OUTCOME'
    `);
    beforeM6.exec(`
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands
      BEGIN
        SELECT RAISE(ABORT, 'commands are append-only');
      END;
    `);
    beforeM6.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
    beforeM6.close();

    const migratedM6 = await open();
    expect(migratedM6.startup.appliedMigrations).toEqual([5]);
    expect(migratedM6.execute(applyCommand)).toMatchObject({
      type: "MOCK_PROVIDER_OUTCOME_APPLIED",
      replayed: true,
      usageRecords: [],
      artifacts: [],
      acceptancePackage: null,
    });
  });

  // Every other test in this file starts from an empty database, so every payload it stores already
  // has the post-A1 shape -- which is exactly why nothing caught migration 0006 copying `data_json`
  // verbatim while `stageAttemptSchema` gained two required fields. This one starts from payloads
  // that lack them, i.e. from what an owner's pre-A1 database actually holds.
  it("backfills the session counters into StageAttempt payloads stored before A1", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-pre-a1-counters-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-pre-a1-counters", created.workItem.id, 1, "READY"));
    const acceptanceTemplate: StartMockPipelineCommand["payload"]["template"] = {
      schemaVersion: 1,
      id: "pre-a1-counters-v1",
      version: 1,
      name: "Pre-A1 counters fixture",
      stages: [
        { stage: "IMPLEMENT", ordinal: 0, contextPack },
        { stage: "REVIEW", ordinal: 1, contextPack },
        { stage: "QA", ordinal: 2, contextPack },
        { stage: "ACCEPTANCE", ordinal: 3, contextPack },
      ],
    };
    const startCommand: StartMockPipelineCommand = {
      schemaVersion: 1,
      commandId: "start-pre-a1-counters",
      correlationId: "correlation-start-pre-a1-counters",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: acceptanceTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    };
    localState.execute(startCommand);

    const applyNext = (
      outcome: ApplyProviderOutcomeCommand["payload"]["outcome"],
      resultTree: string | null = null,
    ): void => {
      const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
      const dispatch = pending.dispatches[0];
      if (!dispatch) throw new Error("Expected a pending dispatch");
      localState.execute({
        schemaVersion: 1,
        commandId: `mark-${dispatch.id}`,
        correlationId: `correlation-mark-${dispatch.id}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: dispatch.id },
      });
      localState.execute({
        schemaVersion: 1,
        commandId: `apply-${dispatch.id}`,
        correlationId: `correlation-apply-${dispatch.id}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: { dispatchId: dispatch.id, template: acceptanceTemplate, outcome, resultTree },
      });
    };

    const acceptedTree = "b".repeat(40);
    applyNext(
      {
        type: "COMPLETED",
        summary: "Implementation completed.",
      },
      acceptedTree,
    );
    applyNext({
      type: "COMPLETED",
      summary: "Review passed.",
      artifacts: [
        {
          kind: "REVIEW_REPORT",
          title: "Review report",
          summary: "Review passed.",
          checks: ["Contract review passed."],
        },
      ],
    });
    completeMeasuredQA(localState, "pre-a1-counters", acceptedTree);
    applyNext({
      type: "READY_FOR_ACCEPTANCE",
      releaseNote: "Ready for owner acceptance.",
      verifyInstructions: ["Run pnpm verify."],
      criteria: [
        {
          criterion: "State is durable",
          implementation: "The durable acceptance flow was implemented.",
          reviewCheck: "Contract review passed.",
          qaCheck: "1 required assertions passed.",
          ownerVerification: "Run pnpm verify.",
          knownRisk: null,
        },
      ],
    });

    const pending = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: created.workItem.id });
    if (
      pending.type !== "WORKFLOW_SNAPSHOT" ||
      !pending.snapshot.run ||
      !pending.snapshot.acceptancePackage
    ) {
      throw new Error("Expected a pending acceptance snapshot");
    }
    const acceptanceCommand = {
      schemaVersion: 1,
      commandId: "accept-pre-a1-counters",
      correlationId: "correlation-accept-pre-a1-counters",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RESOLVE_ACCEPTANCE",
      payload: {
        acceptancePackageId: pending.snapshot.acceptancePackage.id,
        expectedVersion: pending.snapshot.acceptancePackage.version,
        expectedRunVersion: pending.snapshot.run.version,
        action: "ACCEPT",
        reason: "Evidence accepted.",
      },
    } as const;
    localState.execute(acceptanceCommand);

    const before = localState.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    if (before.type !== "EVENTS") throw new Error("Expected events");
    const originalEvents = before.events.map((event) => ({ sequence: event.sequence, type: event.type }));
    const budgetPolicy = pending.snapshot.budgetPolicies[0];
    const anyAttempt = pending.snapshot.stageAttempts[0];
    if (!budgetPolicy || !anyAttempt) throw new Error("Expected a budget policy and a stage attempt");
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER events_are_append_only_update");
    raw.exec("DROP TRIGGER commands_are_append_only_update");
    // BUDGET_OVERRIDE_APPROVED is the one event type that embeds two StageAttempts, under two
    // different keys. The fixture above never triggers a budget override, so it is written here --
    // in the post-A1 shape, so that the strip below is what makes it legacy, the same as every
    // other row.
    raw
      .prepare(
        `INSERT INTO events (
          id, schema_version, type, aggregate_type, aggregate_id, project_id,
          actor_type, actor_id, occurred_at, correlation_id, data_json
        ) VALUES ('event-pre-a1-override', 1, 'BUDGET_OVERRIDE_APPROVED', 'WORK_ITEM', ?, ?,
          'HUMAN', 'local-owner', ?, 'correlation-pre-a1-override', ?)`,
      )
      .run(
        created.workItem.id,
        created.workItem.projectId,
        timestamp,
        JSON.stringify({
          run: pending.snapshot.run,
          previousStageAttempt: anyAttempt,
          stageAttempt: { ...anyAttempt, version: anyAttempt.version + 1 },
          budgetPolicy,
        }),
      );

    // The strip walks the stored JSON in JS rather than mirroring migration 0008's SQL: a test that
    // reverted the migration with the migration's own statements would only prove the statements
    // are their own inverse.
    const stripped = { events: 0, commands: 0 };
    for (const row of raw.prepare("SELECT sequence, data_json FROM events").all() as {
      sequence: number;
      data_json: string;
    }[]) {
      const legacy = JSON.stringify(withoutSessionCounters(JSON.parse(row.data_json)));
      if (legacy === row.data_json) continue;
      stripped.events += 1;
      raw.prepare("UPDATE events SET data_json = ? WHERE sequence = ?").run(legacy, row.sequence);
    }
    for (const row of raw.prepare("SELECT command_id, result_json FROM commands").all() as {
      command_id: string;
      result_json: string;
    }[]) {
      const legacy = JSON.stringify(withoutSessionCounters(JSON.parse(row.result_json)));
      if (legacy === row.result_json) continue;
      stripped.commands += 1;
      raw.prepare("UPDATE commands SET result_json = ? WHERE command_id = ?").run(legacy, row.command_id);
    }
    // Without this the whole test would still pass if the fixture stopped storing StageAttempts.
    expect(stripped.events).toBeGreaterThan(0);
    expect(stripped.commands).toBeGreaterThan(0);
    const legacyBefore = countLegacyStageAttempts(raw);
    // Strictly greater: the override event above holds two StageAttempts in one row.
    expect(legacyBefore.events).toBeGreaterThan(stripped.events);
    expect(legacyBefore.commands).toBeGreaterThan(0);

    raw.exec(`
      CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `);
    raw.exec(`
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands
      BEGIN
        SELECT RAISE(ABORT, 'commands are append-only');
      END;
    `);
    raw.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
    raw.close();

    const migrated = await open();
    expect(migrated.startup.appliedMigrations).toEqual([8]);

    // The failure this migration exists for: `eventFromRow` runs domainEventSchema.parse over every
    // stored payload, so a single StageAttempt missing either counter makes the whole timeline
    // unreadable rather than degrading one row.
    const after = migrated.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    if (after.type !== "EVENTS") throw new Error("Expected events");
    expect(
      after.events
        .filter(({ type }) => type !== "BUDGET_OVERRIDE_APPROVED")
        .map((event) => ({
          sequence: event.sequence,
          type: event.type,
        })),
    ).toEqual(originalEvents);
    const override = after.events.find(({ type }) => type === "BUDGET_OVERRIDE_APPROVED");
    if (override?.type !== "BUDGET_OVERRIDE_APPROVED") throw new Error("Expected the override event");
    expect(override.data.stageAttempt).toMatchObject({ unproductiveSessions: 0, packShareBackoffs: 0 });
    expect(override.data.previousStageAttempt).toMatchObject({
      unproductiveSessions: 0,
      packShareBackoffs: 0,
    });

    // The commands pass: a receipt written before A1 is replayed through stateCommandResultSchema,
    // which requires both counters just as strictly.
    const replayedStart = migrated.execute(startCommand);
    expect(replayedStart).toMatchObject({
      type: "PIPELINE_STARTED",
      replayed: true,
      stageAttempt: { unproductiveSessions: 0, packShareBackoffs: 0 },
    });
    expect(migrated.execute(acceptanceCommand)).toMatchObject({
      type: "ACCEPTANCE_RESOLVED",
      replayed: true,
      stageAttempt: { unproductiveSessions: 0, packShareBackoffs: 0 },
    });
    migrated.close();
    state = undefined;

    const swept = new DatabaseSync(databasePath);
    expect(countLegacyStageAttempts(swept)).toEqual({ events: 0, commands: 0 });
    swept.close();
  });

  // The half-legacy shape the test above cannot reach: it strips both counters, so a backfill that
  // keys its guard on `unproductiveSessions` alone still passes it. A database written by a build
  // between migration 0006 (which added `unproductive_sessions`) and 0007 (which added
  // `pack_share_backoffs`) holds payloads with the first field and not the second, and 0008 is
  // recorded as applied whether or not it touched them -- so a skip here is permanent.
  it("backfills a StageAttempt payload that carries one session counter and not the other", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-half-legacy-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-half-legacy", created.workItem.id, 1, "READY"));
    const startCommand: StartMockPipelineCommand = {
      schemaVersion: 1,
      commandId: "start-half-legacy",
      correlationId: "correlation-start-half-legacy",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    };
    if (localState.execute(startCommand).type !== "PIPELINE_STARTED") {
      throw new Error("Expected pipeline start");
    }
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER events_are_append_only_update");
    raw.exec("DROP TRIGGER commands_are_append_only_update");
    const rewritten = { events: 0, commands: 0 };
    for (const row of raw.prepare("SELECT sequence, data_json FROM events").all() as {
      sequence: number;
      data_json: string;
    }[]) {
      const halfLegacy = JSON.stringify(halfLegacySessionCounters(JSON.parse(row.data_json)));
      if (halfLegacy === row.data_json) continue;
      rewritten.events += 1;
      raw.prepare("UPDATE events SET data_json = ? WHERE sequence = ?").run(halfLegacy, row.sequence);
    }
    for (const row of raw.prepare("SELECT command_id, result_json FROM commands").all() as {
      command_id: string;
      result_json: string;
    }[]) {
      const halfLegacy = JSON.stringify(halfLegacySessionCounters(JSON.parse(row.result_json)));
      if (halfLegacy === row.result_json) continue;
      rewritten.commands += 1;
      raw.prepare("UPDATE commands SET result_json = ? WHERE command_id = ?").run(halfLegacy, row.command_id);
    }
    expect(rewritten.events).toBeGreaterThan(0);
    expect(rewritten.commands).toBeGreaterThan(0);
    raw.exec(`
      CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `);
    raw.exec(`
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands
      BEGIN
        SELECT RAISE(ABORT, 'commands are append-only');
      END;
    `);
    raw.close();

    // Migration 8 stays recorded as applied here, which is the whole point: this is the state a
    // skipped payload is left in for good. The history has to be unreadable in it, or the assertion
    // after the re-run would prove nothing.
    const skipped = await open();
    expect(skipped.startup.appliedMigrations).toEqual([]);
    expect(() => skipped.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id })).toThrow(
      StateStoreError,
    );
    expect(() => skipped.execute(startCommand)).toThrow();
    skipped.close();
    state = undefined;

    const reset = new DatabaseSync(databasePath);
    reset.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
    reset.close();

    const migrated = await open();
    expect(migrated.startup.appliedMigrations).toEqual([8]);
    const after = migrated.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    if (after.type !== "EVENTS") throw new Error("Expected events");
    const startedEvent = after.events.find(({ type }) => type === "PIPELINE_STARTED");
    if (startedEvent?.type !== "PIPELINE_STARTED") throw new Error("Expected the start event");
    // `unproductiveSessions` keeps the count the payload already carried: the backfill fills the
    // absent field in, it does not stamp both counters back to zero over a real count.
    expect(startedEvent.data.stageAttempt).toMatchObject({
      unproductiveSessions: 2,
      packShareBackoffs: 0,
    });
    expect(migrated.execute(startCommand)).toMatchObject({
      type: "PIPELINE_STARTED",
      replayed: true,
      stageAttempt: { unproductiveSessions: 2, packShareBackoffs: 0 },
    });
    migrated.close();
    state = undefined;

    const swept = new DatabaseSync(databasePath);
    expect(countLegacyStageAttempts(swept)).toEqual({ events: 0, commands: 0 });
    swept.close();
  });

  // Migration 0013's history half, and the same hazard 0008 exists for: the ALTER gives every
  // stored ROW a correct `result_tree`, but `stageAttemptSchema` is `.strict()` and requires
  // `resultTree`, and the entity is embedded verbatim in ten event payloads and in every command
  // receipt. A database written before E1.5 holds none of them, and no test that starts from an
  // empty database can see that -- which is precisely how the same defect shipped before 0008.
  //
  // The pre-0013 shape is reached by REVERTING a current database rather than by replaying old
  // migrations: the column is dropped and the stored JSON is stripped in JS, so the assertions
  // afterwards cannot be satisfied by the migration's own statements being their own inverse.
  it("backfills the stage-end tree label into StageAttempt payloads stored before it existed", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-pre-0013-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-pre-0013", created.workItem.id, 1, "READY"));
    const preLabelTemplate: StartMockPipelineCommand["payload"]["template"] = {
      schemaVersion: 1,
      id: "pre-0013-v1",
      version: 1,
      name: "Pre-0013 label fixture",
      stages: [
        { stage: "REVIEW", ordinal: 0, contextPack },
        { stage: "QA", ordinal: 1, contextPack },
      ],
    };
    const startCommand: StartMockPipelineCommand = {
      schemaVersion: 1,
      commandId: "start-pre-0013",
      correlationId: "correlation-start-pre-0013",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: preLabelTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    };
    localState.execute(startCommand);

    // A real label on the first stage, not null: a backfill that stamped every embedded attempt
    // rather than only the ones missing the key would flatten this one back and show up below.
    const reviewTree = "1".repeat(40);
    const applyNext = (
      outcome: ApplyProviderOutcomeCommand["payload"]["outcome"],
      resultTree: string | null,
    ): void => {
      const pendingDispatches = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pendingDispatches.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
      const dispatch = pendingDispatches.dispatches[0];
      if (!dispatch) throw new Error("Expected a pending dispatch");
      localState.execute({
        schemaVersion: 1,
        commandId: `mark-0013-${dispatch.id}`,
        correlationId: `correlation-mark-0013-${dispatch.id}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: dispatch.id },
      });
      localState.execute({
        schemaVersion: 1,
        commandId: `apply-0013-${dispatch.id}`,
        correlationId: `correlation-apply-0013-${dispatch.id}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: { dispatchId: dispatch.id, template: preLabelTemplate, outcome, resultTree },
      });
    };

    applyNext(
      {
        type: "COMPLETED",
        summary: "Review passed.",
        artifacts: [
          {
            kind: "REVIEW_REPORT",
            title: "Review report",
            summary: "Review passed.",
            checks: ["Contract review passed."],
          },
        ],
      },
      reviewTree,
    );

    const snapshot = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: created.workItem.id });
    if (snapshot.type !== "WORKFLOW_SNAPSHOT" || !snapshot.snapshot.run) {
      throw new Error("Expected a workflow snapshot");
    }
    const budgetPolicy = snapshot.snapshot.budgetPolicies[0];
    const anyAttempt = snapshot.snapshot.stageAttempts[0];
    if (!budgetPolicy || !anyAttempt) throw new Error("Expected a budget policy and a stage attempt");
    const originalEvents = (() => {
      const before = localState.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
      if (before.type !== "EVENTS") throw new Error("Expected events");
      return before.events.map((event) => ({ sequence: event.sequence, type: event.type }));
    })();
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER events_are_append_only_update");
    raw.exec("DROP TRIGGER commands_are_append_only_update");
    // The one event type embedding two StageAttempts under two different keys, so the migration's
    // recursive fold is exercised on a row with more than one occurrence rather than only on rows
    // with exactly one.
    raw
      .prepare(
        `INSERT INTO events (
          id, schema_version, type, aggregate_type, aggregate_id, project_id,
          actor_type, actor_id, occurred_at, correlation_id, data_json
        ) VALUES ('event-pre-0013-override', 1, 'BUDGET_OVERRIDE_APPROVED', 'WORK_ITEM', ?, ?,
          'HUMAN', 'local-owner', ?, 'correlation-pre-0013-override', ?)`,
      )
      .run(
        created.workItem.id,
        created.workItem.projectId,
        timestamp,
        JSON.stringify({
          run: snapshot.snapshot.run,
          previousStageAttempt: anyAttempt,
          stageAttempt: { ...anyAttempt, version: anyAttempt.version + 1 },
          budgetPolicy,
        }),
      );

    const stripped = { events: 0, commands: 0 };
    for (const row of raw.prepare("SELECT sequence, data_json FROM events").all() as {
      sequence: number;
      data_json: string;
    }[]) {
      const legacy = JSON.stringify(withoutResultTree(JSON.parse(row.data_json)));
      if (legacy === row.data_json) continue;
      stripped.events += 1;
      raw.prepare("UPDATE events SET data_json = ? WHERE sequence = ?").run(legacy, row.sequence);
    }
    for (const row of raw.prepare("SELECT command_id, result_json FROM commands").all() as {
      command_id: string;
      result_json: string;
    }[]) {
      const legacy = JSON.stringify(withoutResultTree(JSON.parse(row.result_json)));
      if (legacy === row.result_json) continue;
      stripped.commands += 1;
      raw.prepare("UPDATE commands SET result_json = ? WHERE command_id = ?").run(legacy, row.command_id);
    }
    // Without these the whole test would still pass if the fixture stopped storing StageAttempts.
    expect(stripped.events).toBeGreaterThan(0);
    expect(stripped.commands).toBeGreaterThan(0);
    const legacyBefore = countLegacyResultTrees(raw);
    // Strictly greater: the override event above holds two StageAttempts in one row.
    expect(legacyBefore.events).toBeGreaterThan(stripped.events);
    expect(legacyBefore.commands).toBeGreaterThan(0);
    raw.exec(`
      CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `);
    raw.exec(`
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands
      BEGIN
        SELECT RAISE(ABORT, 'commands are append-only');
      END;
    `);
    raw.close();

    // Migration 13 stays recorded as applied here, and the column stays: this is the state the
    // history would be left in by an ALTER with no history pass behind it. The timeline has to be
    // unreadable now, or the assertions after the pass prove nothing about why it exists.
    const skipped = await open();
    expect(skipped.startup.appliedMigrations).toEqual([]);
    expect(() => skipped.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id })).toThrow(
      StateStoreError,
    );
    expect(() => skipped.execute(startCommand)).toThrow();
    skipped.close();
    state = undefined;

    // Now the column goes too, which is what makes this a genuinely pre-0013 database rather than a
    // current one with damaged payloads.
    const reset = new DatabaseSync(databasePath);
    reset.exec("ALTER TABLE stage_attempts DROP COLUMN result_tree");
    reset.prepare("DELETE FROM schema_migrations WHERE version = 13").run();
    reset.close();

    const migrated = await open();
    expect(migrated.startup.appliedMigrations).toEqual([13]);

    // Every StageAttempt recorded before the migration keeps a null label, forever (spec §12.3),
    // and the row half says the same as the payload half.
    const attempts = migrated.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: created.workItem.id });
    if (attempts.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected a snapshot");
    expect(attempts.snapshot.stageAttempts.map(({ resultTree }) => resultTree)).toEqual(
      attempts.snapshot.stageAttempts.map(() => null),
    );

    // Each half of the pass named by its own assertion, and as a non-throw rather than by reading
    // the value out: an unbackfilled payload does not answer wrongly, it makes the reader throw --
    // so a half of the migration that went missing has to red here, not in a stack trace.
    expect(() => migrated.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id })).not.toThrow();
    expect(() => migrated.execute(startCommand)).not.toThrow();

    const after = migrated.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    if (after.type !== "EVENTS") throw new Error("Expected events");
    expect(
      after.events
        .filter(({ type }) => type !== "BUDGET_OVERRIDE_APPROVED")
        .map((event) => ({ sequence: event.sequence, type: event.type })),
    ).toEqual(originalEvents);
    const override = after.events.find(({ type }) => type === "BUDGET_OVERRIDE_APPROVED");
    if (override?.type !== "BUDGET_OVERRIDE_APPROVED") throw new Error("Expected the override event");
    expect(override.data.stageAttempt.resultTree).toBeNull();
    expect(override.data.previousStageAttempt.resultTree).toBeNull();

    // The commands pass: a receipt written before this milestone is replayed through
    // `stateCommandResultSchema`, which requires the field just as strictly.
    expect(migrated.execute(startCommand)).toMatchObject({
      type: "PIPELINE_STARTED",
      replayed: true,
      stageAttempt: { resultTree: null },
    });
    migrated.close();
    state = undefined;

    const sweptLabels = new DatabaseSync(databasePath);
    expect(countLegacyResultTrees(sweptLabels)).toEqual({ events: 0, commands: 0 });
    sweptLabels.close();
  });

  // A stored payload this build cannot parse is a storage fault, not a malformed request. Left as
  // the bare ZodError it starts as, apps/daemon answered the owner with 400 INVALID_REQUEST -- "the
  // request payload is invalid" for a request that was fine, and a status no log filter reads as a
  // server fault. Migration 0008 removes the known trigger, not the class.
  it("surfaces an unreadable stored Event payload as PERSISTENCE_FAILURE", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-unreadable-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER events_are_append_only_update");
    // Stands in for any field a future schema makes required after this payload was written.
    raw
      .prepare("UPDATE events SET data_json = json_remove(data_json, '$.workItem') WHERE type = ?")
      .run("WORK_ITEM_CREATED");
    raw.exec(`
      CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `);
    raw.close();

    const reopened = await open();
    const thrown = (() => {
      try {
        reopened.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(StateStoreError);
    expect(thrown).not.toBeInstanceOf(ZodError);
    expect((thrown as StateStoreError).code).toBe("PERSISTENCE_FAILURE");
    // The ZodError is kept as the cause, so the structured log still says what failed to parse.
    expect((thrown as StateStoreError).cause).toBeInstanceOf(ZodError);
    // A malformed *request* is still the caller's fault and still a ZodError, so the daemon keeps
    // answering that one with 400.
    expect(() => reopened.query({ type: "LIST_EVENTS", limit: -1 } as never)).toThrow(ZodError);
  });

  // Migration 0012. Before it, `projects.fixture_id` was `NOT NULL UNIQUE CHECK (fixture_id IN
  // ('web-app-a', 'api-service-b'))`, so the table could hold nothing but the two bundled demos and
  // the owner's own repository had nowhere to be recorded (spec §4). Relaxing a CHECK means
  // rebuilding the table, and thirteen tables hold foreign keys into this one -- so what this test
  // is really about is that the rebuild neither loses a Project nor leaves one of those thirteen
  // pointing at the table it replaced.
  it("relaxes the fixture constraint without losing a Project or a foreign key", async () => {
    const localState = await open();
    localState.execute(registerProject("project-web", "register-web-before-0012"));
    localState.execute(registerProject("project-api", "register-api-before-0012"));
    // Children on both sides of the rebuild: a WorkItem, and the PROJECT_REGISTERED events the two
    // registrations already wrote. Without them the rebuild has no foreign key to get wrong.
    localState.execute(createWorkItem("work-before-0012", "project-web"));
    const before = localState.query({ type: "LIST_PROJECTS" });
    if (before.type !== "PROJECTS") throw new Error("Expected the registered Projects");
    localState.close();
    state = undefined;

    // Revert exactly what 0012 does: rebuild `projects` with the constraint it removed. Foreign keys
    // are switched off first, which is what lets the old table be dropped at all -- the same reason
    // the migration itself runs with them off (`rebuildsAReferencedTable` in src/migrations.ts).
    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`
      CREATE TABLE projects_v11 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        fixture_id TEXT NOT NULL UNIQUE CHECK (fixture_id IN ('web-app-a', 'api-service-b')),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
        repository_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    raw.exec(`
      INSERT INTO projects_v11 (
        id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at
      )
      SELECT
        id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at
      FROM projects
    `);
    raw.exec("DROP TABLE projects");
    raw.exec("ALTER TABLE projects_v11 RENAME TO projects");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 12").run();
    raw.prepare("DELETE FROM schema_migrations WHERE version = 17").run();
    // Asserted before the migration runs, so this test cannot pass by starting from a database that
    // never carried the constraint: the reconstructed schema really does refuse a Project with no
    // fixture, which is the whole thing 0012 exists to change.
    expect(() => {
      raw.exec(
        `INSERT INTO projects (id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at)
         VALUES ('project-own', 'workspace-local', NULL, 'own', '/tmp/own-repository', 'ACTIVE', 1, '${timestamp}', '${timestamp}')`,
      );
    }).toThrow(/NOT NULL/);
    raw.close();

    const migrated = await open();
    expect(migrated.startup.appliedMigrations).toEqual([12, 17]);

    // Every row carried across, byte for byte. The owner's real database has Projects in it.
    const after = migrated.query({ type: "LIST_PROJECTS" });
    if (after.type !== "PROJECTS") throw new Error("Expected the migrated Projects");
    expect(after.projects).toEqual(before.projects);

    // And no child left pointing at the table the rebuild replaced.
    const check = new DatabaseSync(databasePath);
    expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    check.close();

    // What the migration was for: a Project with no fixture at all, and a second one beside it --
    // UNIQUE constrains only non-NULL values, so two Projects registered by path are not duplicates
    // of each other.
    const own = migrated.execute({
      ...registerProject("project-own-repository", "register-own-after-0012"),
      payload: {
        id: "project-own-repository",
        fixtureId: null,
        name: "own-repository",
        repositoryPath: join(temporaryDirectory, "own-repository"),
      },
    });
    if (own.type !== "PROJECT_REGISTERED") throw new Error("Expected the path Project to register");
    expect(own.project.fixtureId).toBeNull();
    const second = migrated.execute({
      ...registerProject("project-second-repository", "register-second-after-0012"),
      payload: {
        id: "project-second-repository",
        fixtureId: null,
        name: "second-repository",
        repositoryPath: join(temporaryDirectory, "second-repository"),
      },
    });
    expect(second.type).toBe("PROJECT_REGISTERED");
  });

  // The two UNIQUE constraints migration 0012 rewrites `projects` to keep, asserted against the
  // table rather than through a handler.
  //
  // Every other duplicate-registration test in this suite goes through `execute`, where
  // `executeFresh` reads the row first and refuses with PROJECT_ALREADY_REGISTERED before it
  // writes -- so all of them prove the application-level pre-check and none of them prove the
  // schema. Dropping `UNIQUE` from both `fixture_id` and `repository_path` in 0012 left this
  // package at 61/61 and the daemon at 123/123. These two insert straight into the table, so the
  // pre-check is not in the path at all and the only thing that can refuse is the constraint.
  //
  // `INSERT ... SELECT` from the row that is already there, overriding only the columns that must
  // differ: the duplicate is then identical to a real Project in every respect except the one
  // under test, which is what makes the named constraint the only possible reason for the refusal.
  it("refuses a second Project row recording the same bundled fixture, in the schema itself", async () => {
    const localState = await open();
    localState.execute(registerProject("project-web", "register-web-fixture-constraint"));
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    try {
      const insertDuplicateFixture = (): void => {
        raw
          .prepare(
            `INSERT INTO projects
               (id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at)
             SELECT 'project-duplicate-fixture', workspace_id, fixture_id, name, ?, status, version,
                    created_at, updated_at
             FROM projects WHERE id = 'project-web'`,
          )
          .run(join(temporaryDirectory, "a-second-directory"));
      };
      expect(insertDuplicateFixture).toThrow(/UNIQUE constraint failed: projects\.fixture_id/);
    } finally {
      raw.close();
    }
  });

  it("refuses a second Project row recording the same repository path, in the schema itself", async () => {
    const localState = await open();
    localState.execute(registerProject("project-web", "register-web-path-constraint"));
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    try {
      const insertDuplicatePath = (): void => {
        raw
          .prepare(
            `INSERT INTO projects
               (id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at)
             SELECT 'project-duplicate-path', workspace_id, NULL, name, repository_path, status, version,
                    created_at, updated_at
             FROM projects WHERE id = 'project-web'`,
          )
          .run();
      };
      expect(insertDuplicatePath).toThrow(/UNIQUE constraint failed: projects\.repository_path/);

      // And the other half of the same constraint, which is why `fixture_id` above is set to NULL
      // rather than left alone: in SQLite every NULL is distinct in a UNIQUE index, so any number
      // of path-registered Projects coexist. A row that differs only in its path lands.
      raw
        .prepare(
          `INSERT INTO projects
             (id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at)
           SELECT 'project-own-path', workspace_id, NULL, name, ?, status, version, created_at, updated_at
           FROM projects WHERE id = 'project-web'`,
        )
        .run(join(temporaryDirectory, "own-repository"));
      expect(
        raw.prepare("SELECT COUNT(*) AS total FROM projects WHERE fixture_id IS NULL").get(),
      ).toMatchObject({ total: 1 });
    } finally {
      raw.close();
    }
  });

  // The repair for the one database that matters. The owner's two demo Projects were registered
  // before a bundled fixture became a real repository, so their `repository_path` names a directory
  // inside Loomrail's own checkout; migration 0012 carried those paths across verbatim, as it must,
  // since a migration cannot know the data directory. Every stage that needs a workspace is refused
  // at such a path, and until REPOINT_FIXTURE_PROJECT nothing could move it.
  it("moves a fixture Project off the path it was registered at, and leaves that path in the log", async () => {
    const localState = await open();
    const stalePath = join(temporaryDirectory, "checkout", "fixtures", "projects", "web-app-a");
    const freshPath = join(temporaryDirectory, "data", "demo-projects", "web-app-a");
    const registered = localState.execute({
      ...registerProject("project-fixture-web-app-a", "register-stale-fixture"),
      payload: {
        id: "project-fixture-web-app-a",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath: stalePath,
      },
    });
    if (registered.type !== "PROJECT_REGISTERED") throw new Error("Expected the stale Project");

    const repointed = localState.execute({
      schemaVersion: 1,
      commandId: "repoint-web-app-a",
      correlationId: "correlation-repoint-web-app-a",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REPOINT_FIXTURE_PROJECT",
      payload: {
        projectId: "project-fixture-web-app-a",
        fixtureId: "web-app-a",
        expectedRepositoryPath: stalePath,
        repositoryPath: freshPath,
      },
    });
    if (repointed.type !== "PROJECT_REGISTERED") throw new Error("Expected the Project to be repointed");
    expect(repointed.project.repositoryPath).toBe(freshPath);
    // A change to the row, so the version moves; everything else about the Project is the same one.
    expect(repointed.project.version).toBe(registered.project.version + 1);
    expect(repointed.project.id).toBe(registered.project.id);
    expect(repointed.project.createdAt).toBe(registered.project.createdAt);

    // Read back through the store, not taken from the result: the point of the command is the row.
    const stored = localState.query({ type: "GET_PROJECT", projectId: "project-fixture-web-app-a" });
    expect(stored.type === "PROJECT" ? stored.project?.repositoryPath : null).toBe(freshPath);

    // Nothing is lost by reusing PROJECT_REGISTERED for the repoint: the append-only log holds both
    // paths, in order, so the path the Project was moved *off* is still recoverable.
    const events = localState.query({ type: "LIST_EVENTS" });
    expect(
      (events.type === "EVENTS" ? events.events : [])
        .filter((event) => event.type === "PROJECT_REGISTERED")
        .map((event) => event.data.project.repositoryPath),
    ).toEqual([stalePath, freshPath]);

    // And a second repoint naming the path the Project no longer records is refused rather than
    // applied twice: `expectedRepositoryPath` is the guard, not a convenience.
    let thrown: unknown;
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "repoint-web-app-a-again",
        correlationId: "correlation-repoint-web-app-a-again",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REPOINT_FIXTURE_PROJECT",
        payload: {
          projectId: "project-fixture-web-app-a",
          fixtureId: "web-app-a",
          expectedRepositoryPath: stalePath,
          repositoryPath: join(temporaryDirectory, "data", "somewhere-else"),
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StateStoreError);
    expect((thrown as StateStoreError).code).toBe("PROJECT_REPOINT_REFUSED");
    const unchanged = localState.query({ type: "GET_PROJECT", projectId: "project-fixture-web-app-a" });
    expect(unchanged.type === "PROJECT" ? unchanged.project?.repositoryPath : null).toBe(freshPath);
  });

  // The two hard constraints on the repair above. Both are checked here rather than in the daemon
  // route that issues the command, because they have to hold at the moment of the write.
  it("refuses to move a Project the owner registered by path, or one that already has a workspace", async () => {
    const localState = await open();
    const ownPath = join(temporaryDirectory, "acme-invoicing");
    const own = localState.execute({
      ...registerProject("project-own-repository", "register-own-repository"),
      payload: {
        id: "project-own-repository",
        fixtureId: null,
        name: "acme-invoicing",
        repositoryPath: ownPath,
      },
    });
    if (own.type !== "PROJECT_REGISTERED") throw new Error("Expected the owner's Project");

    // A Project registered by path carries a null fixture, so it can never match the fixture this
    // command names -- which is the whole of what keeps a repository the owner chose out of reach.
    let ownThrown: unknown;
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "repoint-owners-project",
        correlationId: "correlation-repoint-owners-project",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REPOINT_FIXTURE_PROJECT",
        payload: {
          projectId: "project-own-repository",
          fixtureId: "web-app-a",
          expectedRepositoryPath: ownPath,
          repositoryPath: join(temporaryDirectory, "data", "demo-projects", "web-app-a"),
        },
      });
    } catch (error: unknown) {
      ownThrown = error;
    }
    expect(ownThrown).toBeInstanceOf(StateStoreError);
    expect((ownThrown as StateStoreError).code).toBe("PROJECT_REPOINT_REFUSED");
    const stillOwn = localState.query({ type: "GET_PROJECT", projectId: "project-own-repository" });
    expect(stillOwn.type === "PROJECT" ? stillOwn.project?.repositoryPath : null).toBe(ownPath);

    // A fixture Project that has already had a workspace cut from it. Provisioning refuses a path
    // that is not its own repository's top level, so in practice the bundled template never has one
    // -- unless an owner ran `git init` in it themselves. This check makes the move safe without
    // depending on that: a workspace names a branch and a worktree in one specific repository, and
    // moving the Project out from under it would leave every later stage branching another one.
    const stalePath = join(temporaryDirectory, "checkout", "fixtures", "projects", "web-app-a");
    localState.execute({
      ...registerProject("project-fixture-web-app-a", "register-fixture-with-workspace"),
      payload: {
        id: "project-fixture-web-app-a",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath: stalePath,
      },
    });
    const workItem = localState.execute(
      createWorkItem("create-item-with-workspace", "project-fixture-web-app-a"),
    );
    if (workItem.type !== "WORK_ITEM_CREATED") throw new Error("Expected a WorkItem");
    const workspace = localState.execute({
      schemaVersion: 1,
      commandId: "record-workspace-under-stale-path",
      correlationId: "correlation-record-workspace-under-stale-path",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "CREATE_WORK_ITEM_WORKSPACE",
      payload: {
        workItemId: workItem.workItem.id,
        projectId: "project-fixture-web-app-a",
        branch: "loomrail/already-cut",
        worktreePath: join(temporaryDirectory, "workspaces", "already-cut"),
        baseCommit: null,
        snapshotCommit: null,
        carriedPaths: [],
      },
    });
    expect(workspace.type).toBe("WORK_ITEM_WORKSPACE_CREATED");

    let workspaceThrown: unknown;
    try {
      localState.execute({
        schemaVersion: 1,
        commandId: "repoint-project-with-workspace",
        correlationId: "correlation-repoint-project-with-workspace",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REPOINT_FIXTURE_PROJECT",
        payload: {
          projectId: "project-fixture-web-app-a",
          fixtureId: "web-app-a",
          expectedRepositoryPath: stalePath,
          repositoryPath: join(temporaryDirectory, "data", "demo-projects", "web-app-a"),
        },
      });
    } catch (error: unknown) {
      workspaceThrown = error;
    }
    expect(workspaceThrown).toBeInstanceOf(StateStoreError);
    expect((workspaceThrown as StateStoreError).code).toBe("PROJECT_REPOINT_REFUSED");
    const stillStale = localState.query({ type: "GET_PROJECT", projectId: "project-fixture-web-app-a" });
    expect(stillStale.type === "PROJECT" ? stillStale.project?.repositoryPath : null).toBe(stalePath);
  });

  // Migration 0012 runs with `PRAGMA foreign_keys` off -- SQLite's own procedure for rebuilding a
  // table thirteen others reference -- which makes this the one place in the codebase that turns
  // the check off. It used to turn it back ON unconditionally, which is right only for as long as
  // every caller happens to open with it on.
  it("restores the foreign-key setting a rebuilding migration found rather than assuming it was on", async () => {
    const localState = await open();
    localState.execute(registerProject("project-web", "register-web-before-pragma-check"));
    localState.close();
    state = undefined;

    // Migration 12 made pending again, the same way the rebuild test above does it, so a rebuilding
    // migration really runs here. Without this the test would pass with no migration applied at all.
    const revert = new DatabaseSync(databasePath);
    revert.exec("PRAGMA foreign_keys = OFF");
    revert.exec("CREATE TABLE projects_v11 AS SELECT * FROM projects");
    revert.exec("DROP TABLE projects");
    revert.exec("ALTER TABLE projects_v11 RENAME TO projects");
    revert.prepare("DELETE FROM schema_migrations WHERE version = 12").run();
    revert.close();

    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = OFF");
    const startup = await applyMigrations(database, {
      databasePath,
      now: () => new Date(timestamp),
      databaseWasNonEmpty: false,
    });
    expect(startup.appliedMigrations).toEqual([12]);
    // Restored to what this connection had, not to ON. `openLocalState` always opens with the check
    // on, so today both answers look the same from the outside -- which is exactly why the wrong
    // one could sit here unnoticed.
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    database.close();
  });

  it("fails closed when an applied migration checksum drifts", async () => {
    const localState = await open();
    localState.close();
    state = undefined;
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
    raw.close();

    await expect(open()).rejects.toBeInstanceOf(StateStoreError);
    state = undefined;
  });

  it("enforces append-only Events at the database layer", async () => {
    const localState = await open();
    localState.execute(registerProject());
    localState.close();
    state = undefined;
    const raw = new DatabaseSync(databasePath);

    expect(() => {
      raw.exec("UPDATE events SET type = type WHERE sequence = 1");
    }).toThrow(/append-only/);
    expect(() => {
      raw.exec("DELETE FROM events WHERE sequence = 1");
    }).toThrow(/append-only/);
    expect(() => {
      raw.exec("DELETE FROM commands");
    }).toThrow(/append-only/);
    raw.close();
  });

  it("persists a HumanRequest across restart and resumes the exact mock workflow once", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem());
    const independent = localState.execute(createWorkItem("create-independent"));
    if (created.type !== "WORK_ITEM_CREATED" || independent.type !== "WORK_ITEM_CREATED") {
      throw new Error("Expected WorkItem creation");
    }
    localState.execute(moveWorkItem("ready-workflow", created.workItem.id, 1, "READY"));
    localState.execute(moveWorkItem("ready-independent", independent.workItem.id, 1, "READY"));
    const start: StartMockPipelineCommand = {
      schemaVersion: 1,
      commandId: "start-mock-workflow",
      correlationId: "correlation-start-mock-workflow",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    };
    const started = localState.execute(start);
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    const needsHuman: ApplyProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: `apply-${started.dispatch.id}`,
      correlationId: "correlation-needs-human",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        resultTree: null,
        dispatchId: started.dispatch.id,
        template: mockTemplate,
        outcome: {
          type: "NEEDS_HUMAN",
          request: {
            kind: "SINGLE_CHOICE",
            blocking: true,
            title: "Choose the discovery depth",
            context: "A durable decision is required before discovery can continue.",
            recommendation: "Use the focused pass.",
            options: [
              {
                id: "focused-pass",
                label: "Focused pass",
                consequence: "Proceed with a bounded discovery.",
                recommended: true,
              },
            ],
            allowOther: true,
          },
        },
      },
    };
    localState.execute({
      schemaVersion: 1,
      commandId: `mark-started-${started.dispatch.id}`,
      correlationId: "correlation-start-discovery",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: started.dispatch.id },
    });
    localState.execute(needsHuman);
    const waiting = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: created.workItem.id });
    if (waiting.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected workflow snapshot");
    expect(waiting.snapshot).toMatchObject({
      run: { status: "WAITING_HUMAN" },
      humanRequests: [{ status: "OPEN", version: 1 }],
    });
    const request = waiting.snapshot.humanRequests[0];
    if (!request) throw new Error("Expected an open HumanRequest");
    expect(localState.query({ type: "GET_ATTENTION_INBOX" })).toMatchObject({
      type: "ATTENTION_INBOX",
      inbox: {
        items: [
          {
            id: request.id,
            project: { id: "project-web" },
            workItem: { id: created.workItem.id },
            stage: { name: "DISCOVERY" },
            section: "BLOCKING_NOW",
            category: "QUESTION",
            action: "ANSWER_REQUEST",
            acceptancePackageId: null,
          },
        ],
        hasMore: false,
      },
    });

    localState.close();
    state = undefined;
    const reopened = await open();
    const restored = reopened.query({ type: "LIST_HUMAN_REQUESTS", status: "OPEN" });
    expect(restored.type === "HUMAN_REQUESTS" ? restored.humanRequests : []).toHaveLength(1);
    expect(reopened.query({ type: "GET_ATTENTION_INBOX" })).toMatchObject({
      type: "ATTENTION_INBOX",
      inbox: { items: [{ id: request.id }], hasMore: false },
    });

    const answer: AnswerHumanRequestCommand = {
      schemaVersion: 1,
      commandId: "answer-human-request",
      correlationId: "correlation-answer-human-request",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ANSWER_HUMAN_REQUEST",
      payload: {
        humanRequestId: request.id,
        expectedVersion: 1,
        answer: { type: "OPTION", optionIds: ["focused-pass"] },
      },
    };
    reopened.execute(answer);
    expect(reopened.query({ type: "GET_ATTENTION_INBOX" })).toMatchObject({
      type: "ATTENTION_INBOX",
      inbox: { items: [], hasMore: false },
    });
    expect(() => reopened.execute({ ...answer, commandId: "answer-human-request-again" })).toThrow(
      expect.objectContaining({ code: "WORKFLOW_VERSION_CONFLICT" }),
    );

    const resumeQueue = reopened.query({ type: "LIST_PENDING_DISPATCHES" });
    if (resumeQueue.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatch queue");
    const resume = resumeQueue.dispatches[0];
    if (!resume) throw new Error("Expected resume dispatch");
    const applyCompleted = (dispatchId: string, commandId: string): void => {
      reopened.execute({
        schemaVersion: 1,
        commandId: `mark-started-${dispatchId}`,
        correlationId: `correlation-mark-${dispatchId}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId },
      });
      reopened.execute({
        schemaVersion: 1,
        commandId,
        correlationId: `correlation-${commandId}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          resultTree: null,
          dispatchId,
          template: mockTemplate,
          outcome: { type: "COMPLETED", summary: "Synthetic stage completed." },
        },
      });
    };
    applyCompleted(resume.id, "complete-discovery");
    const planQueue = reopened.query({ type: "LIST_PENDING_DISPATCHES" });
    if (planQueue.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected plan dispatch queue");
    const plan = planQueue.dispatches[0];
    if (!plan) throw new Error("Expected plan dispatch");
    applyCompleted(plan.id, "complete-plan");

    const completed = reopened.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: created.workItem.id });
    const independentItem = reopened.query({ type: "GET_WORK_ITEM", workItemId: independent.workItem.id });
    expect(completed.type === "WORKFLOW_SNAPSHOT" ? completed.snapshot.run?.status : null).toBe("SUCCEEDED");
    expect(
      completed.type === "WORKFLOW_SNAPSHOT"
        ? completed.snapshot.stageAttempts.map(({ stage, status }) => ({ stage, status }))
        : [],
    ).toEqual([
      { stage: "DISCOVERY", status: "SUCCEEDED" },
      { stage: "PLAN", status: "SUCCEEDED" },
    ]);
    expect(independentItem.type === "WORK_ITEM" ? independentItem.workItem?.state : null).toBe("READY");
  });

  it("bounds the Attention read before projection and fails closed on a missing relation", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-attention-overflow"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-attention-overflow", created.workItem.id, 1, "READY"));
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-attention-overflow",
      correlationId: "correlation-attention-overflow",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    localState.close();
    state = undefined;

    const raw = new DatabaseSync(databasePath);
    const insertRequest = raw.prepare(
      `INSERT INTO human_requests (
        id, project_id, work_item_id, stage_attempt_id, kind, blocking, title, context,
        recommendation, allow_other, status, version, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, 'FREE_TEXT', 1, ?, ?, NULL, 1, 'OPEN', 1, ?, NULL)`,
    );
    for (let index = 0; index < maxAttentionItems + 2; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      insertRequest.run(
        `request-overflow-${suffix}`,
        "project-web",
        created.workItem.id,
        started.stageAttempt.id,
        `Overflow request ${suffix}`,
        "Synthetic bounded Attention fixture.",
        timestamp,
      );
    }
    raw.close();

    const reopened = await open();
    const attention = reopened.query({ type: "GET_ATTENTION_INBOX" });
    if (attention.type !== "ATTENTION_INBOX") throw new Error("Expected Attention Inbox");
    expect(attention.inbox.items).toHaveLength(maxAttentionItems);
    expect(attention.inbox.hasMore).toBe(true);
    expect(attention.inbox.items.at(0)?.id).toBe("request-overflow-000");
    expect(attention.inbox.items.at(-1)?.id).toBe("request-overflow-199");
    reopened.close();
    state = undefined;

    const corrupted = new DatabaseSync(databasePath);
    corrupted.exec("PRAGMA foreign_keys = OFF");
    corrupted.prepare("DELETE FROM stage_attempts WHERE id = ?").run(started.stageAttempt.id);
    corrupted.close();

    const corruptedState = await open();
    expect(() => corruptedState.query({ type: "GET_ATTENTION_INBOX" })).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_FAILURE" }),
    );
  });

  it("reconciles an orphaned running attempt once and persists its RecoveryReport", async () => {
    const localState = await open();
    localState.execute(registerProject());
    const created = localState.execute(createWorkItem("create-recovery-item"));
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute(moveWorkItem("ready-recovery-item", created.workItem.id, 1, "READY"));
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-recovery-workflow",
      correlationId: "correlation-start-recovery",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    localState.execute({
      schemaVersion: 1,
      commandId: "mark-recovery-running",
      correlationId: "correlation-mark-recovery",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: started.dispatch.id },
    });

    const reconciled = localState.execute({
      schemaVersion: 1,
      commandId: "reconcile-startup-1",
      correlationId: "correlation-reconcile-1",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });
    expect(reconciled).toMatchObject({
      type: "WORKFLOWS_RECONCILED",
      recoveryReports: [{ reason: "DAEMON_RESTART", recoveredStatus: "INTERRUPTED" }],
    });
    const repeated = localState.execute({
      schemaVersion: 1,
      commandId: "reconcile-startup-2",
      correlationId: "correlation-reconcile-2",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });
    expect(repeated).toMatchObject({ type: "WORKFLOWS_RECONCILED", recoveryReports: [] });

    localState.close();
    state = undefined;
    const reopened = await open();
    const snapshot = reopened.query({
      type: "GET_WORKFLOW_SNAPSHOT",
      workItemId: created.workItem.id,
    });
    expect(snapshot.type === "WORKFLOW_SNAPSHOT" ? snapshot.snapshot : null).toMatchObject({
      run: { status: "INTERRUPTED" },
      stageAttempts: [{ status: "INTERRUPTED", failureCode: "DAEMON_RESTART" }],
      recoveryReports: [{ reason: "DAEMON_RESTART" }],
    });
  });

  // Task 6 of the A1 session-handoff plan (docs/plans/07-a1-session-handoff-spec.ru.md §4.2, §4.4,
  // §6.5): durable storage for ProviderSession, ContextPackRecipe and Checkpoint, plus the widened
  // Events CHECK and the StageAttempt unproductive-session counter.
  describe("session handoff storage (migration 0006)", () => {
    const startWorkflow = (
      localState: LocalState,
      commandId: string,
      workItemCommandId: string,
    ): { workItemId: string; stageAttemptId: string; projectId: string } => {
      localState.execute(registerProject());
      const created = localState.execute(createWorkItem(workItemCommandId));
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute(moveWorkItem(`ready-${commandId}`, created.workItem.id, 1, "READY"));
      const started = localState.execute({
        schemaVersion: 1,
        commandId,
        correlationId: `correlation-${commandId}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: mockTemplate,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      return {
        workItemId: created.workItem.id,
        stageAttemptId: started.stageAttempt.id,
        projectId: created.workItem.projectId,
      };
    };

    const seedContextPackRecipeAndCheckpoint = (
      raw: DatabaseSync,
      stageAttemptId: string,
      recipeId: string,
      sessionId: string,
      checkpointId: string,
    ): void => {
      // provider_sessions first: context_pack_recipes owns the (one-directional) link to it, so
      // the session row must already exist before the recipe can reference it.
      raw
        .prepare(
          `INSERT INTO provider_sessions (
            id, schema_version, stage_attempt_id, ordinal, status, end_reason,
            handoff_requested_at, started_at, ended_at, version
          ) VALUES (?, 1, ?, 1, 'RUNNING', NULL, NULL, ?, NULL, 1)`,
        )
        .run(sessionId, stageAttemptId, timestamp);
      raw
        .prepare(
          `INSERT INTO context_pack_recipes (
            id, schema_version, provider_session_id, template_id, template_version, spec_source,
            sections_json, omitted_json, content_hash, estimated_tokens, budget_tokens,
            estimate_quality, created_at
          ) VALUES (?, 1, ?, 'mock-delivery-v1', 1, 'WORKFLOW_TEMPLATE', ?, '[]', ?, 10, 100,
            'LOOMRAIL_ESTIMATE', ?)`,
        )
        .run(
          recipeId,
          sessionId,
          JSON.stringify([{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }]),
          `sha256:${"0".repeat(64)}`,
          timestamp,
        );
      raw
        .prepare(
          `INSERT INTO checkpoints (
            id, schema_version, stage_attempt_id, provider_session_id, ordinal, summary,
            completed_json, remaining_json, dead_ends_json, open_questions_json, created_at
          ) VALUES (?, 1, ?, ?, 1, 'Initial summary', '[]', '[]', '[]', '[]', ?)`,
        )
        .run(checkpointId, stageAttemptId, sessionId, timestamp);
    };

    it("rejects updates and deletes of a stored Checkpoint and ContextPackRecipe", async () => {
      const localState = await open();
      const { stageAttemptId } = startWorkflow(
        localState,
        "start-append-only-check",
        "create-append-only-item",
      );
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      const recipeId = "recipe-append-only";
      const checkpointId = "checkpoint-append-only";
      seedContextPackRecipeAndCheckpoint(raw, stageAttemptId, recipeId, "session-append-only", checkpointId);

      // D7: checkpoints are append-only, otherwise a rewritten checkpoint makes the recipe a lie.
      expect(() =>
        raw.prepare("UPDATE checkpoints SET summary = ? WHERE id = ?").run("tampered", checkpointId),
      ).toThrow(/append-only/);
      expect(() => raw.prepare("DELETE FROM checkpoints WHERE id = ?").run(checkpointId)).toThrow(
        /append-only/,
      );
      // D7: the recipe plus a hash only proves anything if the recipe itself can't be edited.
      expect(() =>
        raw.prepare("UPDATE context_pack_recipes SET template_version = 2 WHERE id = ?").run(recipeId),
      ).toThrow(/append-only/);
      expect(() => raw.prepare("DELETE FROM context_pack_recipes WHERE id = ?").run(recipeId)).toThrow(
        /append-only/,
      );

      // The rows are still exactly as inserted -- the triggers rejected the mutations, not the data.
      expect(raw.prepare("SELECT summary FROM checkpoints WHERE id = ?").get(checkpointId)).toEqual({
        summary: "Initial summary",
      });
      raw.close();
    });

    it("migrates historical workflow-template recipes to the role-aware schema without weakening append-only", async () => {
      const localState = await open();
      const { stageAttemptId } = startWorkflow(
        localState,
        "start-pre-role-recipe",
        "create-pre-role-recipe-item",
      );
      const started = localState.execute({
        schemaVersion: 1,
        commandId: "start-pre-role-provider-session",
        correlationId: "correlation-pre-role-provider-session",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "START_PROVIDER_SESSION",
        payload: {
          stageAttemptId,
          recipe: {
            schemaVersion: 1,
            templateId: mockTemplate.id,
            templateVersion: mockTemplate.version,
            specSource: "WORKFLOW_TEMPLATE",
            roleProfile: null,
            sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
            omitted: [],
            contentHash: `sha256:${"1".repeat(64)}`,
            estimatedTokens: 10,
            budgetTokens: 100,
            estimateQuality: "LOOMRAIL_ESTIMATE",
          },
        },
      });
      if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      raw.exec(`
        DROP TRIGGER context_pack_recipes_are_append_only_update;
        DROP TRIGGER context_pack_recipes_are_append_only_delete;
        ALTER TABLE context_pack_recipes RENAME TO context_pack_recipes_v30;
        CREATE TABLE context_pack_recipes (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          provider_session_id TEXT NOT NULL UNIQUE REFERENCES provider_sessions(id) ON DELETE RESTRICT,
          template_id TEXT NOT NULL,
          template_version INTEGER NOT NULL CHECK (template_version > 0),
          spec_source TEXT NOT NULL CHECK (spec_source = 'WORKFLOW_TEMPLATE'),
          sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
          omitted_json TEXT NOT NULL CHECK (json_valid(omitted_json)),
          content_hash TEXT NOT NULL CHECK (content_hash LIKE 'sha256:%'),
          estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
          budget_tokens INTEGER NOT NULL CHECK (budget_tokens > 0),
          estimate_quality TEXT NOT NULL
            CHECK (estimate_quality IN ('ACTUAL', 'PROVIDER_ESTIMATE', 'LOOMRAIL_ESTIMATE')),
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO context_pack_recipes (
          id, schema_version, provider_session_id, template_id, template_version, spec_source,
          sections_json, omitted_json, content_hash, estimated_tokens, budget_tokens,
          estimate_quality, created_at
        )
        SELECT
          id, schema_version, provider_session_id, template_id, template_version, spec_source,
          sections_json, omitted_json, content_hash, estimated_tokens, budget_tokens,
          estimate_quality, created_at
        FROM context_pack_recipes_v30;
        DROP TABLE context_pack_recipes_v30;
        CREATE TRIGGER context_pack_recipes_are_append_only_update
        BEFORE UPDATE ON context_pack_recipes BEGIN
          SELECT RAISE(ABORT, 'context pack recipes are append-only');
        END;
        CREATE TRIGGER context_pack_recipes_are_append_only_delete
        BEFORE DELETE ON context_pack_recipes BEGIN
          SELECT RAISE(ABORT, 'context pack recipes are append-only');
        END;
        DELETE FROM schema_migrations WHERE version = 30;
      `);
      raw.close();

      const migrated = await open();
      expect(migrated.startup.appliedMigrations).toEqual([30]);
      const sessions = migrated.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
      if (sessions.type !== "PROVIDER_SESSIONS") throw new Error("Expected provider sessions");
      expect(sessions.recipes).toMatchObject([
        {
          id: started.recipe.id,
          specSource: "WORKFLOW_TEMPLATE",
          roleProfile: null,
        },
      ]);
      migrated.close();
      state = undefined;

      const after = new DatabaseSync(databasePath);
      expect(() =>
        after
          .prepare("UPDATE context_pack_recipes SET template_version = 2 WHERE id = ?")
          .run(started.recipe.id),
      ).toThrow(/append-only/);
      after.close();
    });

    it("adds nullable policy snapshots without inventing policy for historical AgentRuns", async () => {
      const localState = await open();
      const { workItemId } = startWorkflow(localState, "start-historical-policy", "create-historical-policy");
      const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected pending dispatches");
      const dispatch = pending.dispatches.find((candidate) => candidate.workItemId === workItemId);
      if (dispatch === undefined) throw new Error("Expected the historical policy dispatch");
      const started = localState.execute({
        schemaVersion: 1,
        commandId: "start-historical-policy-agent",
        correlationId: "correlation-start-historical-policy-agent",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: dispatch.id,
          provider: "CODEX",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (started.type !== "AGENT_RUN_STARTED") throw new Error("Expected the historical AgentRun");
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      raw.exec(`
        DROP TRIGGER agent_runs_immutable_identity;
        ALTER TABLE agent_runs DROP COLUMN policy_snapshot_json;
        CREATE TRIGGER agent_runs_immutable_identity
        BEFORE UPDATE ON agent_runs
        WHEN
          NEW.id <> OLD.id
          OR NEW.schema_version <> OLD.schema_version
          OR NEW.project_id <> OLD.project_id
          OR NEW.work_item_id <> OLD.work_item_id
          OR NEW.pipeline_run_id <> OLD.pipeline_run_id
          OR NEW.stage_attempt_id <> OLD.stage_attempt_id
          OR NEW.ordinal <> OLD.ordinal
          OR NEW.squad_assignment_id <> OLD.squad_assignment_id
          OR NEW.profile_id <> OLD.profile_id
          OR NEW.profile_revision <> OLD.profile_revision
          OR NEW.profile_role <> OLD.profile_role
          OR NEW.provider <> OLD.provider
          OR NEW.policy_snapshot_hash <> OLD.policy_snapshot_hash
          OR NEW.started_at <> OLD.started_at
        BEGIN
          SELECT RAISE(ABORT, 'agent run identity is immutable');
        END;
        DELETE FROM schema_migrations WHERE version = 31;
      `);
      raw.close();

      const migrated = await open();
      expect(migrated.startup.appliedMigrations).toEqual([31]);
      const historical = migrated.query({ type: "GET_AGENT_RUN", agentRunId: started.run.id });
      if (historical.type !== "AGENT_RUNS") throw new Error("Expected the historical AgentRun");
      expect(historical.runs[0]?.policySnapshot).toBeNull();
      migrated.close();
      state = undefined;

      const after = new DatabaseSync(databasePath);
      expect(() =>
        after
          .prepare("UPDATE agent_runs SET policy_snapshot_hash = ? WHERE id = ?")
          .run(`sha256:${"f".repeat(64)}`, started.run.id),
      ).toThrow(/immutable/u);
      after.close();
    });

    it("accepts the five new session-handoff event types under the rebuilt Events CHECK", async () => {
      const localState = await open();
      const registered = localState.execute(registerProject());
      if (registered.type !== "PROJECT_REGISTERED") throw new Error("Expected project registration");
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      const insertEvent = raw.prepare(
        `INSERT INTO events (
          id, schema_version, type, aggregate_type, aggregate_id, project_id,
          actor_type, actor_id, occurred_at, correlation_id, data_json
        ) VALUES (?, 1, ?, 'WORK_ITEM', 'work-item-session-handoff', ?, 'SYSTEM', 'mock-provider', ?, ?, '{}')`,
      );
      const newEventTypes = [
        "PROVIDER_SESSION_STARTED",
        "CONTEXT_HANDOFF_REQUESTED",
        "CHECKPOINT_PUBLISHED",
        "PROVIDER_SESSION_ENDED",
        "CONTEXT_FLOOR_EXCEEDED",
      ] as const;
      for (const [index, type] of newEventTypes.entries()) {
        insertEvent.run(
          `event-${type}`,
          type,
          registered.project.id,
          timestamp,
          `correlation-${index.toString()}`,
        );
      }

      // A type outside the CHECK's list is still rejected -- proves the list is enforced, not wide open.
      expect(() =>
        raw
          .prepare(
            `INSERT INTO events (
              id, schema_version, type, aggregate_type, aggregate_id, project_id,
              actor_type, actor_id, occurred_at, correlation_id, data_json
            ) VALUES ('event-bogus', 1, 'NOT_A_REAL_TYPE', 'WORK_ITEM', 'work-item-session-handoff', ?,
              'SYSTEM', 'mock-provider', ?, 'correlation-bogus', '{}')`,
          )
          .run(registered.project.id, timestamp),
      ).toThrow();

      const stored = raw
        .prepare("SELECT type FROM events WHERE type IN (?, ?, ?, ?, ?) ORDER BY sequence")
        .all(...newEventTypes) as { type: string }[];
      expect(stored.map((row) => row.type)).toEqual(newEventTypes);
      raw.close();
    });

    // Both counters exist for one reason (spec §6.5, §7): a daemon restart is the ordinary end of a
    // ProviderSession, so a guard held in daemon memory would be cleared by the very event it has to
    // survive. Asserting only the DEFAULT 0 would pass even if `updateStageAttempt` never wrote
    // either field -- so each counter is driven to a non-zero value first, and read back after the
    // reopen.
    it("persists both StageAttempt session counters across a restart, not just their zero default", async () => {
      const localState = await open();
      const { workItemId, stageAttemptId } = startWorkflow(
        localState,
        "start-session-counters",
        "create-session-counters-item",
      );
      const counters = (
        activeState: LocalState,
      ): { unproductiveSessions: number; packShareBackoffs: number } => {
        const snapshot = activeState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
        const attempt =
          snapshot.type === "WORKFLOW_SNAPSHOT"
            ? snapshot.snapshot.stageAttempts.find((candidate) => candidate.id === stageAttemptId)
            : undefined;
        if (!attempt) throw new Error("Expected the StageAttempt in the snapshot");
        return {
          unproductiveSessions: attempt.unproductiveSessions,
          packShareBackoffs: attempt.packShareBackoffs,
        };
      };
      expect(counters(localState)).toEqual({ unproductiveSessions: 0, packShareBackoffs: 0 });

      // One session that ends without ever publishing a checkpoint: §6.5's definition of
      // unproductive, and the only thing that moves the counter.
      const session = localState.execute({
        schemaVersion: 1,
        commandId: "start-session-counters-session",
        correlationId: "correlation-start-session-counters-session",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "START_PROVIDER_SESSION",
        payload: {
          stageAttemptId,
          recipe: {
            schemaVersion: 1,
            templateId: mockTemplate.id,
            templateVersion: mockTemplate.version,
            specSource: "WORKFLOW_TEMPLATE",
            roleProfile: null,
            sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
            omitted: [],
            contentHash: `sha256:${"0".repeat(64)}`,
            estimatedTokens: 10,
            budgetTokens: 100,
            estimateQuality: "LOOMRAIL_ESTIMATE",
          },
        },
      });
      if (session.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");
      localState.execute({
        schemaVersion: 1,
        commandId: "end-session-counters-session",
        correlationId: "correlation-end-session-counters-session",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "END_PROVIDER_SESSION",
        payload: { providerSessionId: session.session.id, endReason: "HANDOFF", providerStarted: true },
      });
      // §7's one automatic step-down after a provider rejected a pack Loomrail judged as fitting.
      localState.execute({
        schemaVersion: 1,
        commandId: "reduce-session-counters-share",
        correlationId: "correlation-reduce-session-counters-share",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "REDUCE_CONTEXT_PACK_SHARE",
        payload: { stageAttemptId },
      });

      const beforeRestart = counters(localState);
      expect(beforeRestart).toEqual({ unproductiveSessions: 1, packShareBackoffs: 1 });
      localState.close();
      state = undefined;

      const reopened = await open();
      expect(counters(reopened)).toEqual(beforeRestart);
    });

    it("migrates a pre-M6 database without losing Events or their sequence numbers", async () => {
      const localState = await open();
      const { workItemId } = startWorkflow(
        localState,
        "start-pre-m6-migration",
        "create-pre-m6-migration-item",
      );
      const before = localState.query({ type: "LIST_EVENTS" });
      if (before.type !== "EVENTS") throw new Error("Expected events");
      const originalEvents = before.events
        .filter(({ type }) => type !== "SQUAD_ASSIGNED")
        .map((event) => ({
          sequence: event.sequence,
          id: event.id,
          type: event.type,
        }));
      expect(originalEvents.length).toBeGreaterThan(0);
      localState.close();
      state = undefined;

      // Revert exactly what migration 0006 does, to reconstruct a database that predates it.
      const raw = new DatabaseSync(databasePath);
      raw.exec("DROP TABLE checkpoints");
      raw.exec("DROP TABLE context_pack_recipes");
      raw.exec("DROP TABLE provider_sessions");
      raw.exec("DROP TABLE agent_runs");
      raw.exec("DROP TABLE squad_assignments");
      raw.exec("ALTER TABLE stage_attempts DROP COLUMN unproductive_sessions");

      raw.exec("DROP TRIGGER events_are_append_only_update");
      raw.exec("DROP TRIGGER events_are_append_only_delete");
      raw.exec("DROP INDEX events_project_sequence_idx");
      raw.exec("DROP INDEX events_aggregate_sequence_idx");
      raw.exec("ALTER TABLE events RENAME TO events_v6");
      raw.exec(`
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          type TEXT NOT NULL CHECK (
            type IN (
              'PROJECT_REGISTERED', 'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_STATE_CHANGED',
              'PIPELINE_STARTED', 'STAGE_ATTEMPT_CHANGED', 'HUMAN_REQUEST_OPENED',
              'HUMAN_REQUEST_RESOLVED', 'USAGE_RECORDED', 'BUDGET_THRESHOLD_REACHED',
              'PIPELINE_PAUSED', 'PIPELINE_RESUMED', 'PIPELINE_CANCELLED',
              'BUDGET_OVERRIDE_APPROVED', 'RECOVERY_REPORT_CREATED', 'PIPELINE_COMPLETED',
              'EVIDENCE_ARTIFACT_RECORDED', 'ACCEPTANCE_REQUESTED', 'ACCEPTANCE_RESOLVED'
            )
          ),
          aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('PROJECT', 'WORK_ITEM')),
          aggregate_id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM')),
          actor_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          data_json TEXT NOT NULL CHECK (json_valid(data_json))
        ) STRICT;
      `);
      raw.exec(`
        INSERT INTO events (
          sequence, id, schema_version, type, aggregate_type, aggregate_id, project_id,
          actor_type, actor_id, occurred_at, correlation_id, data_json
        )
        SELECT
          sequence, id, schema_version, type, aggregate_type, aggregate_id, project_id,
          actor_type, actor_id, occurred_at, correlation_id, data_json
        FROM events_v6
        WHERE type != 'SQUAD_ASSIGNED'
      `);
      raw.exec("DROP TABLE events_v6");
      raw.exec("CREATE INDEX events_project_sequence_idx ON events(project_id, sequence)");
      raw.exec("CREATE INDEX events_aggregate_sequence_idx ON events(aggregate_id, sequence)");
      raw.exec(`
        CREATE TRIGGER events_are_append_only_update
        BEFORE UPDATE ON events
        BEGIN
          SELECT RAISE(ABORT, 'events are append-only');
        END;
      `);
      raw.exec(`
        CREATE TRIGGER events_are_append_only_delete
        BEFORE DELETE ON events
        BEGIN
          SELECT RAISE(ABORT, 'events are append-only');
        END;
      `);
      // 0009, 0010, 0020, 0030 and 0031 all add columns or relations to the tables 0006 creates, so a database
      // that predates 0006 predates them too. All six migrations must be pending for the
      // reconstruction to be honest.
      raw.prepare("DELETE FROM schema_migrations WHERE version IN (6, 9, 10, 20, 30, 31)").run();
      raw.close();

      const migrated = await open();
      expect(migrated.startup.appliedMigrations).toEqual([6, 9, 10, 20, 30, 31]);

      const after = migrated.query({ type: "LIST_EVENTS" });
      if (after.type !== "EVENTS") throw new Error("Expected events");
      expect(
        after.events.map((event) => ({ sequence: event.sequence, id: event.id, type: event.type })),
      ).toEqual(originalEvents);

      // The append-only triggers on events survived the rebuild.
      const raw2 = new DatabaseSync(databasePath);
      expect(() => {
        raw2.exec("UPDATE events SET type = type WHERE sequence = 1");
      }).toThrow(/append-only/);
      raw2.close();

      // The existing StageAttempt got the new columns with their DEFAULT 0, not NULL. Both session
      // counters are checked: stageAttemptSchema requires each of them, so a NULL left behind by a
      // migration would throw on the first read of any pre-existing attempt.
      const snapshot = migrated.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
      expect(snapshot.type === "WORKFLOW_SNAPSHOT" ? snapshot.snapshot.stageAttempts[0] : null).toMatchObject(
        { unproductiveSessions: 0, packShareBackoffs: 0 },
      );
    });
  });

  describe("provider session lifecycle (Task 7)", () => {
    const startWorkflow = (
      localState: LocalState,
      commandId: string,
      workItemCommandId: string,
    ): { workItemId: string; stageAttemptId: string; projectId: string } => {
      localState.execute(registerProject());
      const created = localState.execute(createWorkItem(workItemCommandId));
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute(moveWorkItem(`ready-${commandId}`, created.workItem.id, 1, "READY"));
      const started = localState.execute({
        schemaVersion: 1,
        commandId,
        correlationId: `correlation-${commandId}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: mockTemplate,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      return {
        workItemId: created.workItem.id,
        stageAttemptId: started.stageAttempt.id,
        projectId: created.workItem.projectId,
      };
    };

    const startProviderSessionCommand = (
      commandId: string,
      stageAttemptId: string,
      recipeOverrides: Partial<ContextPackRecipeInput> = {},
    ): StartProviderSessionCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId,
        recipe: {
          schemaVersion: 1,
          templateId: mockTemplate.id,
          templateVersion: mockTemplate.version,
          specSource: "WORKFLOW_TEMPLATE",
          roleProfile: null,
          sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
          omitted: [],
          contentHash: `sha256:${"0".repeat(64)}`,
          estimatedTokens: 10,
          budgetTokens: 100,
          estimateQuality: "LOOMRAIL_ESTIMATE",
          ...recipeOverrides,
        },
      },
    });

    const publishCheckpointCommand = (
      commandId: string,
      providerSessionId: string,
      draft: PublishCheckpointCommand["payload"]["checkpoint"],
    ): PublishCheckpointCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "PUBLISH_CHECKPOINT",
      payload: { providerSessionId, checkpoint: draft },
    });

    const endProviderSessionCommand = (
      commandId: string,
      providerSessionId: string,
      endReason: EndProviderSessionCommand["payload"]["endReason"],
    ): EndProviderSessionCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "END_PROVIDER_SESSION",
      payload: { providerSessionId, endReason, providerStarted: true },
    });

    const countProviderSessions = (raw: DatabaseSync): number =>
      (raw.prepare("SELECT COUNT(*) AS count FROM provider_sessions").get() as { count: number }).count;
    const countContextPackRecipes = (raw: DatabaseSync): number =>
      (raw.prepare("SELECT COUNT(*) AS count FROM context_pack_recipes").get() as { count: number }).count;
    const countEventsOfType = (raw: DatabaseSync, type: string): number =>
      (raw.prepare("SELECT COUNT(*) AS count FROM events WHERE type = ?").get(type) as { count: number })
        .count;

    const seedEvidenceArtifact = (
      raw: DatabaseSync,
      ids: {
        id: string;
        projectId: string;
        workItemId: string;
        pipelineRunId: string;
        stageAttemptId: string;
      },
    ): void => {
      raw
        .prepare(
          `INSERT INTO evidence_artifacts (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            stage, kind, status, provider, title, summary, checks_json, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, 'REVIEW', 'REVIEW_REPORT', 'PASSED', 'MOCK', ?, ?,
            '["Contract review passed."]', ?)`,
        )
        .run(
          ids.id,
          ids.projectId,
          ids.workItemId,
          ids.pipelineRunId,
          ids.stageAttemptId,
          "Review report",
          "Looks good.",
          timestamp,
        );
    };

    const seedDecision = (
      raw: DatabaseSync,
      ids: {
        humanRequestId: string;
        decisionId: string;
        projectId: string;
        workItemId: string;
        stageAttemptId: string;
      },
    ): void => {
      raw
        .prepare(
          `INSERT INTO human_requests (
            id, project_id, work_item_id, stage_attempt_id, kind, blocking, title, context,
            recommendation, allow_other, status, version, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, 'FREE_TEXT', 0, ?, ?, NULL, 1, 'RESOLVED', 1, ?, ?)`,
        )
        .run(
          ids.humanRequestId,
          ids.projectId,
          ids.workItemId,
          ids.stageAttemptId,
          "Which parser library?",
          "Need a decision to keep going.",
          timestamp,
          timestamp,
        );
      raw
        .prepare(
          `INSERT INTO decisions (
            id, schema_version, project_id, work_item_id, human_request_id, answer_json,
            actor_type, actor_id, reason, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, 'HUMAN', 'local-owner', NULL, ?)`,
        )
        .run(
          ids.decisionId,
          ids.projectId,
          ids.workItemId,
          ids.humanRequestId,
          JSON.stringify({ type: "OTHER", text: "Use pdf-lib." }),
          timestamp,
        );
    };

    const seedActiveProjectConstitution = (raw: DatabaseSync, projectId: string): void => {
      const contentDigest = "c".repeat(64);
      const sourceDigest = "d".repeat(64);
      const renderedMarkdown = "# Project Constitution\n\n- Keep persistence reads coherent.";
      raw
        .prepare(
          `INSERT INTO constitution_proposals (
            id, schema_version, project_id, project_version, status, preset_id, preset_version,
            recommended_preset_id, scan_json, sections_json, rendered_markdown, content_digest,
            version, created_at, adopted_at
          ) VALUES (?, 1, ?, 1, 'ADOPTED', 'repository-baseline', 1, 'repository-baseline',
            '{}', '[]', ?, ?, 3, ?, ?)`,
        )
        .run("proposal-context-sources", projectId, renderedMarkdown, contentDigest, timestamp, timestamp);
      raw
        .prepare(
          `INSERT INTO project_constitution_versions (
            id, schema_version, project_id, proposal_id, ordinal, preset_id, preset_version,
            source_digest, content_digest, rendered_markdown, status, version, created_at, activated_at
          ) VALUES (?, 1, ?, ?, 1, 'repository-baseline', 1, ?, ?, ?, 'ACTIVE', 2, ?, ?)`,
        )
        .run(
          "constitution-context-sources",
          projectId,
          "proposal-context-sources",
          sourceDigest,
          contentDigest,
          renderedMarkdown,
          timestamp,
          timestamp,
        );
    };

    it("rejects a ProviderSession for a StageAttempt that does not exist, writing nothing", async () => {
      // No StageAttempt is ever created with this id: the FK on provider_sessions rejects the
      // insert. This is a real, useful guard on its own, but note what it does NOT prove: the
      // very first write attempted by this command fails, so a command that never wrote anything
      // at all would pass these same assertions. It cannot tell a working ROLLBACK apart from no
      // transaction existing in the first place -- see the next test for that.
      const localState = await open();

      expect(() =>
        localState.execute(startProviderSessionCommand("start-broken-attempt", "stage-attempt-missing")),
      ).toThrow();

      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      expect(countProviderSessions(raw)).toBe(0);
      expect(countContextPackRecipes(raw)).toBe(0);
      expect(countEventsOfType(raw, "PROVIDER_SESSION_STARTED")).toBe(0);
      raw.close();
    });

    it("rolls back a session's own successful insert when its recipe write fails afterward", async () => {
      // The scenario the previous test cannot reach: something DOES get written successfully
      // before the failure. `createId` is rigged to hand out the SAME "contextPackRecipe" id
      // every time, so the first session's recipe claims it, and a second session's recipe
      // collides on the PRIMARY KEY -- but only after that second session's own row has already
      // been inserted successfully. If BEGIN IMMEDIATE/COMMIT/ROLLBACK were removed from
      // `execute`, the second session's row would survive; the assertions below would then fail.
      let counter = 0;
      state = await openLocalState({
        databasePath,
        now: () => new Date(timestamp),
        createId: (kind) =>
          kind === "contextPackRecipe" ? "recipe-reused" : `${kind}-${(counter += 1).toString()}`,
      });
      const localState = state;

      const { stageAttemptId } = startWorkflow(
        localState,
        "start-recipe-collision",
        "create-recipe-collision-item",
      );

      const first = localState.execute(startProviderSessionCommand("start-session-first", stageAttemptId));
      if (first.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected the first session to start");

      const ended = localState.execute(
        endProviderSessionCommand("end-session-first", first.session.id, "HANDOFF"),
      );
      if (ended.type !== "PROVIDER_SESSION_ENDED") throw new Error("Expected the first session to end");

      // Qualified with the expected error code: an unqualified toThrow() would also be satisfied
      // by, say, a Zod parse failure that never touches SQL at all.
      expect(() =>
        localState.execute(startProviderSessionCommand("start-session-second", stageAttemptId)),
      ).toThrow(expect.objectContaining({ code: "PERSISTENCE_FAILURE" }));

      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      // Only the first session and its recipe survive -- the second session's insert, which by
      // itself succeeded, was rolled back along with the recipe write that failed after it.
      expect(countProviderSessions(raw)).toBe(1);
      expect(countContextPackRecipes(raw)).toBe(1);
      expect(countEventsOfType(raw, "PROVIDER_SESSION_STARTED")).toBe(1);
      raw.close();
    });

    it("refuses a second RUNNING ProviderSession for the same StageAttempt, and allows one after the first ends", async () => {
      const localState = await open();
      const { stageAttemptId } = startWorkflow(localState, "start-two-sessions", "create-two-sessions-item");

      const first = localState.execute(startProviderSessionCommand("start-session-one", stageAttemptId));
      if (first.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected the first session to start");
      expect(first.session.ordinal).toBe(1);

      expect(() =>
        localState.execute(startProviderSessionCommand("start-session-two", stageAttemptId)),
      ).toThrow(expect.objectContaining({ code: "PROVIDER_SESSION_ALREADY_RUNNING" }));

      const ended = localState.execute(
        endProviderSessionCommand("end-session-one", first.session.id, "HANDOFF"),
      );
      if (ended.type !== "PROVIDER_SESSION_ENDED") throw new Error("Expected the session to end");
      expect(ended.session).toMatchObject({ status: "ENDED", endReason: "HANDOFF" });

      const second = localState.execute(
        startProviderSessionCommand("start-session-two-after-end", stageAttemptId),
      );
      if (second.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected the second session to start");
      expect(second.session.ordinal).toBe(2);
    });

    // Migration 0009. Spec §6.2 says window occupancy is saved; before 0009 it was not, and the
    // cockpit rebuilt a number by scanning CONTEXT_HANDOFF_REQUESTED out of the audit log. What a
    // session keeps is the highest occupancy it was observed at.
    describe("peak window occupancy storage (migration 0009)", () => {
      const requestContextHandoffCommand = (
        commandId: string,
        providerSessionId: string,
        usage: RequestContextHandoffCommand["payload"]["usage"],
        handoffThreshold = 0.75,
      ): RequestContextHandoffCommand => ({
        schemaVersion: 1,
        commandId,
        correlationId: `correlation-${commandId}`,
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "REQUEST_CONTEXT_HANDOFF",
        payload: { providerSessionId, usage, handoffThreshold },
      });

      const readUsage = (
        localState: LocalState,
        stageAttemptId: string,
        providerSessionId: string,
      ): unknown => {
        const listed = localState.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
        if (listed.type !== "PROVIDER_SESSIONS") throw new Error("Expected the attempt's sessions");
        return listed.peakContextWindowUsage[providerSessionId];
      };

      it("stores a below-threshold occupancy report without requesting a handoff", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(
          localState,
          "start-below-threshold",
          "create-below-threshold-item",
        );
        const started = localState.execute(
          startProviderSessionCommand("start-below-threshold-session", stageAttemptId),
        );
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");

        const reported = localState.execute(
          requestContextHandoffCommand("usage-below-threshold", started.session.id, {
            usedTokens: 400,
            windowTokens: 1000,
            quality: "PROVIDER_ESTIMATE",
          }),
        );
        if (reported.type !== "CONTEXT_HANDOFF_REQUESTED") throw new Error("Expected the report result");

        // The decision itself is unchanged: 40% is below the threshold, so nothing winds down.
        expect(reported.requested).toBe(false);
        expect(reported.events).toEqual([]);
        expect(reported.session.handoffRequestedAt).toBeNull();

        // But the reading is now state, readable without any event to replay.
        expect(readUsage(localState, stageAttemptId, started.session.id)).toEqual({
          usedTokens: 400,
          windowTokens: 1000,
          quality: "PROVIDER_ESTIMATE",
        });
      });

      it("keeps a session with no report at all distinct from one reported at zero", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(localState, "start-no-report", "create-no-report-item");
        const started = localState.execute(
          startProviderSessionCommand("start-no-report-session", stageAttemptId),
        );
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");

        expect(readUsage(localState, stageAttemptId, started.session.id)).toBeUndefined();

        localState.execute(
          requestContextHandoffCommand("usage-zero", started.session.id, {
            usedTokens: 0,
            windowTokens: 1000,
            quality: "ACTUAL",
          }),
        );
        expect(readUsage(localState, stageAttemptId, started.session.id)).toEqual({
          usedTokens: 0,
          windowTokens: 1000,
          quality: "ACTUAL",
        });
      });

      it("requests a handoff exactly once when the threshold is crossed, and again is a no-op", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(localState, "start-crossing", "create-crossing-item");
        const started = localState.execute(
          startProviderSessionCommand("start-crossing-session", stageAttemptId),
        );
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");

        const first = localState.execute(
          requestContextHandoffCommand("usage-crossing-first", started.session.id, {
            usedTokens: 780,
            windowTokens: 1000,
            quality: "ACTUAL",
          }),
        );
        if (first.type !== "CONTEXT_HANDOFF_REQUESTED") throw new Error("Expected the first crossing");
        expect(first.requested).toBe(true);
        expect(first.session.handoffRequestedAt).toBe(timestamp);
        expect(first.events.map(({ type }) => type)).toEqual(["CONTEXT_HANDOFF_REQUESTED"]);

        // A second, higher crossing report -- a different commandId, so no receipt replay hides it.
        const second = localState.execute(
          requestContextHandoffCommand("usage-crossing-second", started.session.id, {
            usedTokens: 920,
            windowTokens: 1000,
            quality: "ACTUAL",
          }),
        );
        if (second.type !== "CONTEXT_HANDOFF_REQUESTED") throw new Error("Expected the second report");
        expect(second.requested).toBe(false);
        expect(second.events).toEqual([]);

        // Exactly one CONTEXT_HANDOFF_REQUESTED, and the stored occupancy is still the reading that
        // crossed: a report arriving after the session has already been asked to wind down can no
        // longer change anything, so it must not rewrite what was current when it could.
        localState.close();
        state = undefined;
        const raw = new DatabaseSync(databasePath);
        expect(countEventsOfType(raw, "CONTEXT_HANDOFF_REQUESTED")).toBe(1);
        expect(
          raw
            .prepare("SELECT context_used_tokens AS used FROM provider_sessions WHERE id = ?")
            .get(started.session.id),
        ).toEqual({ used: 780 });
        raw.close();
      });

      it("does not let a report reaching an ended session rewrite the occupancy it ended with", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(localState, "start-late-report", "create-late-report-item");
        const started = localState.execute(
          startProviderSessionCommand("start-late-report-session", stageAttemptId),
        );
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");
        localState.execute(
          requestContextHandoffCommand("usage-before-end", started.session.id, {
            usedTokens: 300,
            windowTokens: 1000,
            quality: "ACTUAL",
          }),
        );
        localState.execute(
          endProviderSessionCommand("end-late-report-session", started.session.id, "CONTEXT_EXHAUSTED"),
        );

        localState.execute(
          requestContextHandoffCommand("usage-after-end", started.session.id, {
            usedTokens: 999,
            windowTokens: 1000,
            quality: "ACTUAL",
          }),
        );
        expect(readUsage(localState, stageAttemptId, started.session.id)).toEqual({
          usedTokens: 300,
          windowTokens: 1000,
          quality: "ACTUAL",
        });
      });

      // The column is named for the peak, so the store has to make that true rather than inherit it
      // from the order a caller happens to report in. The daemon suppresses a return to a
      // percentage band it has already visited, which makes its own stream effectively monotonic
      // -- but a band never visited on the way up arrives here as a genuine, lower report, and a
      // column called "peak" that then dropped would be a falsehood the cockpit repeats.
      it("keeps the highest reading a session was observed at, not the last one", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(localState, "start-peak", "create-peak-item");
        const started = localState.execute(startProviderSessionCommand("start-peak-session", stageAttemptId));
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");
        const report = (percent: number, usedTokens: number): void => {
          localState.execute(
            requestContextHandoffCommand(
              `usage-${started.session.id}-${percent.toString()}`,
              started.session.id,
              { usedTokens, windowTokens: 1000, quality: "ACTUAL" },
            ),
          );
        };

        report(30, 300);
        expect(readUsage(localState, stageAttemptId, started.session.id)).toMatchObject({
          usedTokens: 300,
        });

        // Up: a higher reading is the new peak.
        report(66, 660);
        expect(readUsage(localState, stageAttemptId, started.session.id)).toMatchObject({
          usedTokens: 660,
        });

        // Down, into a band this session has never been in -- so nothing upstream suppresses it and
        // the report really does arrive here. The peak must not follow it down.
        report(45, 450);
        expect(readUsage(localState, stageAttemptId, started.session.id)).toEqual({
          usedTokens: 660,
          windowTokens: 1000,
          quality: "ACTUAL",
        });
      });

      // Not because two providers might disagree about the window -- these columns are per-session,
      // so a swap between sessions can never put two window sizes in one row. It is a window that
      // changes WITHIN a session that makes the unit matter: an adapter that compacts its own
      // context can report against a different window than it did a moment ago, and then more
      // tokens can be less of the window. "Higher" has to mean the share.
      it("compares peaks as a share of the window, not as a token count", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(localState, "start-share", "create-share-item");
        const started = localState.execute(
          startProviderSessionCommand("start-share-session", stageAttemptId),
        );
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");

        localState.execute(
          requestContextHandoffCommand("usage-share-small-window", started.session.id, {
            usedTokens: 600,
            windowTokens: 1000,
            quality: "ACTUAL",
          }),
        );
        // Five times the tokens, a fifth of the window. The peak is the share, so this is not it.
        localState.execute(
          requestContextHandoffCommand("usage-share-large-window", started.session.id, {
            usedTokens: 3000,
            windowTokens: 15_000,
            quality: "ACTUAL",
          }),
        );
        expect(readUsage(localState, stageAttemptId, started.session.id)).toEqual({
          usedTokens: 600,
          windowTokens: 1000,
          quality: "ACTUAL",
        });
      });

      // The point of migration 0009: occupancy is current state, so removing the audit log must not
      // remove it. Before 0009 this read scanned CONTEXT_HANDOFF_REQUESTED and returned nothing here.
      it("reads occupancy from the session's own columns, not from the events it wrote", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(localState, "start-no-events", "create-no-events-item");
        const started = localState.execute(
          startProviderSessionCommand("start-no-events-session", stageAttemptId),
        );
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");
        localState.execute(
          requestContextHandoffCommand("usage-no-events", started.session.id, {
            usedTokens: 880,
            windowTokens: 1000,
            quality: "LOOMRAIL_ESTIMATE",
          }),
        );
        localState.close();
        state = undefined;

        // `events` is append-only by trigger, so deleting from it means lifting the trigger first.
        // Nothing in the product does this; the test does it to prove where the number comes from.
        const raw = new DatabaseSync(databasePath);
        raw.exec("DROP TRIGGER events_are_append_only_delete");
        raw.prepare("DELETE FROM events WHERE type = ?").run("CONTEXT_HANDOFF_REQUESTED");
        expect(countEventsOfType(raw, "CONTEXT_HANDOFF_REQUESTED")).toBe(0);
        raw.exec(`
          CREATE TRIGGER events_are_append_only_delete
          BEFORE DELETE ON events
          BEGIN
            SELECT RAISE(ABORT, 'events are append-only');
          END;
        `);
        raw.close();

        const reopened = await open();
        expect(readUsage(reopened, stageAttemptId, started.session.id)).toEqual({
          usedTokens: 880,
          windowTokens: 1000,
          quality: "LOOMRAIL_ESTIMATE",
        });
      });

      it("adds the occupancy columns to a database that already holds provider_sessions rows", async () => {
        const localState = await open();
        const { stageAttemptId } = startWorkflow(localState, "start-pre-0009", "create-pre-0009-item");
        const started = localState.execute(
          startProviderSessionCommand("start-pre-0009-session", stageAttemptId),
        );
        if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");
        localState.close();
        state = undefined;

        // Revert exactly what 0009 does, leaving the session row 0006 wrote in place: this is a
        // database that has been running provider sessions since before occupancy had a home.
        const raw = new DatabaseSync(databasePath);
        raw.exec("ALTER TABLE provider_sessions DROP COLUMN context_usage_reported_at");
        raw.exec("ALTER TABLE provider_sessions DROP COLUMN context_usage_quality");
        raw.exec("ALTER TABLE provider_sessions DROP COLUMN context_window_tokens");
        raw.exec("ALTER TABLE provider_sessions DROP COLUMN context_used_tokens");
        raw.prepare("DELETE FROM schema_migrations WHERE version = 9").run();
        raw.close();

        const migrated = await open();
        expect(migrated.startup.appliedMigrations).toEqual([9]);

        // The pre-existing session survived with no occupancy rather than a fabricated zero, and
        // the columns work for it from the first report onward.
        const listed = migrated.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
        if (listed.type !== "PROVIDER_SESSIONS") throw new Error("Expected the attempt's sessions");
        expect(listed.sessions.map(({ id }) => id)).toEqual([started.session.id]);
        expect(listed.peakContextWindowUsage).toEqual({});

        migrated.execute(
          requestContextHandoffCommand("usage-after-0009", started.session.id, {
            usedTokens: 610,
            windowTokens: 1000,
            quality: "ACTUAL",
          }),
        );
        expect(readUsage(migrated, stageAttemptId, started.session.id)).toEqual({
          usedTokens: 610,
          windowTokens: 1000,
          quality: "ACTUAL",
        });
      });
    });

    // A database created before A3 can contain a RUNNING ProviderSession with no AgentRun. On the
    // first current-daemon startup it must be retained as history but may not resume with nullable
    // authority or current MCP grants.
    it("interrupts a historical unclaimed ProviderSession without automatically resuming it", async () => {
      const localState = await open();
      const { workItemId, stageAttemptId } = startWorkflow(
        localState,
        "start-orphaned-session",
        "create-orphaned-session-item",
      );
      const queued = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (queued.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected the dispatch queue");
      const dispatch = queued.dispatches[0];
      if (!dispatch) throw new Error("Expected a pending dispatch");
      localState.execute({
        schemaVersion: 1,
        commandId: "mark-orphaned-session-started",
        correlationId: "correlation-mark-orphaned-session-started",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: dispatch.id },
      });
      const legacySessionId = "legacy-unclaimed-provider-session";
      const rawSeed = new DatabaseSync(databasePath);
      rawSeed
        .prepare(
          `INSERT INTO provider_sessions (
            id, schema_version, agent_run_id, stage_attempt_id, ordinal, status, end_reason,
            handoff_requested_at, started_at, ended_at, version, process_pid
          ) VALUES (?, 1, NULL, ?, 1, 'RUNNING', NULL, NULL, ?, NULL, 1, NULL)`,
        )
        .run(legacySessionId, stageAttemptId, timestamp);
      rawSeed.close();

      // No END_PROVIDER_SESSION: the row stays RUNNING, which is what a daemon that died mid-session
      // leaves behind.
      const reconciled = localState.execute({
        schemaVersion: 1,
        commandId: "reconcile-orphaned-session",
        correlationId: "correlation-reconcile-orphaned-session",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "RECONCILE_WORKFLOWS",
        payload: {},
      });
      if (reconciled.type !== "WORKFLOWS_RECONCILED") throw new Error("Expected reconciliation");
      expect(reconciled.interruptedSessions).toEqual([
        expect.objectContaining({
          id: legacySessionId,
          status: "ENDED",
          endReason: "INTERRUPTED",
          endedAt: timestamp,
        }),
      ]);
      expect(reconciled.events.filter(({ type }) => type === "PROVIDER_SESSION_ENDED")).toHaveLength(1);
      expect(reconciled.recoveryReports).toEqual([
        expect.objectContaining({
          stageAttemptId,
          recoveredStatus: "INTERRUPTED",
          reason: "DAEMON_RESTART",
        }),
      ]);
      const stillQueued = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      expect(
        stillQueued.type === "WORKFLOW_DISPATCHES" ? stillQueued.dispatches.map(({ id }) => id) : [],
      ).toEqual([]);
      const snapshot = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
      expect(
        snapshot.type === "WORKFLOW_SNAPSHOT"
          ? snapshot.snapshot.stageAttempts.find(({ id }) => id === stageAttemptId)?.status
          : null,
      ).toBe("INTERRUPTED");

      localState.close();
      state = undefined;
      const raw = new DatabaseSync(databasePath);
      expect(
        raw.prepare("SELECT status, end_reason FROM provider_sessions WHERE id = ?").get(legacySessionId),
      ).toEqual({ status: "ENDED", end_reason: "INTERRUPTED" });
      raw.close();
    });

    // Task 10: no production caller sets `process_pid` yet -- no live adapter has a channel to
    // report its child's pid back to the session loop before `ProviderAdapter.start()` resolves
    // (see apps/daemon/src/session-loop.ts), so `startProviderSessionCommand` above never carries
    // one. This pokes the column directly over a second connection, the same way the migration
    // tests above reach past the command surface to set up a fact the public API cannot produce
    // today.
    const setProviderSessionProcessPid = (providerSessionId: string, pid: number): void => {
      const raw = new DatabaseSync(databasePath);
      raw.prepare("UPDATE provider_sessions SET process_pid = ? WHERE id = ?").run(pid, providerSessionId);
      raw.close();
    };

    const readProviderSessionRow = (
      providerSessionId: string,
    ): { status: string; process_pid: number | null } => {
      const raw = new DatabaseSync(databasePath);
      const row = raw
        .prepare("SELECT status, process_pid FROM provider_sessions WHERE id = ?")
        .get(providerSessionId) as { status: string; process_pid: number | null } | undefined;
      raw.close();
      if (!row) throw new Error("Expected the ProviderSession row to exist");
      return row;
    };

    const reconcileWorkflowsCommand = (commandId: string): ReconcileWorkflowsCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });

    // `process.kill(pid, 0)` sends no signal -- it only asks the kernel whether a process with
    // this pid still exists, throwing ESRCH when it does not. This is the same liveness check
    // reconciliation itself uses (packages/persistence-sqlite/src/index.ts), reused here so the
    // test asserts the fact reconciliation acts on rather than a proxy for it.
    const isProcessAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS = 2_000;
    const PROCESS_EXIT_POLL_INTERVAL_MS = 5;

    // Test-only: waits for a pid this test process itself spawned to actually be reaped, by
    // yielding to the event loop between checks (see the comment at its call site for why a
    // synchronous check right after `execute` cannot observe this). Nothing in production code
    // needs this -- an orphan reconciliation kills was never this daemon's own child, so there is
    // no reap for it to wait on.
    const waitUntilProcessExits = async (pid: number, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (isProcessAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_INTERVAL_MS));
      }
    };

    it("remembers the process a running session is driving", async () => {
      const localState = await open();
      const { stageAttemptId } = startWorkflow(localState, "start-pid-session", "create-pid-item");
      const started = localState.execute(
        startProviderSessionCommand("start-pid-provider-session", stageAttemptId),
      );
      if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");
      setProviderSessionProcessPid(started.session.id, 4242);

      const listed = localState.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
      if (listed.type !== "PROVIDER_SESSIONS") throw new Error("Expected the attempt's sessions");
      expect(listed.sessions.find(({ id }) => id === started.session.id)?.pid).toBe(4242);
    });

    // "no process was ever started" and "a process whose pid is 0" are different facts, and a
    // NOT NULL DEFAULT 0 column cannot tell them apart -- which is the difference between
    // reconciliation skipping a session and reconciliation trying to signal init.
    it("leaves the pid null for a session that never started a process", async () => {
      const localState = await open();
      const { stageAttemptId } = startWorkflow(localState, "start-no-pid-session", "create-no-pid-item");
      const started = localState.execute(
        startProviderSessionCommand("start-no-pid-provider-session", stageAttemptId),
      );
      if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");

      const listed = localState.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
      if (listed.type !== "PROVIDER_SESSIONS") throw new Error("Expected the attempt's sessions");
      expect(listed.sessions.find(({ id }) => id === started.session.id)?.pid).toBeNull();
    });

    // Spawns a real detached child, leaves a RUNNING session pointing at it, and reopens the store
    // -- which is exactly the state a daemon that died mid-session without killing its own child
    // leaves behind. Returns the pid and the session id, plus everything the orphan handling
    // reported while reconciling.
    // Every pid any of these tests put into the world, so that a test which fails before its own
    // cleanup line -- including one whose `execute` throws, which is exactly the defect the ESRCH
    // test below exists to catch -- cannot leave a `node` process spinning on the owner's machine.
    const orphanPids: number[] = [];

    afterEach(() => {
      for (const pid of orphanPids.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone, which is the ordinary case: most of these tests kill their own probe.
        }
      }
    });

    const spawnProbeChild = (): number => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true });
      const pid = child.pid;
      if (pid === undefined) throw new Error("The probe child did not start");
      child.unref();
      return pid;
    };

    const orphanAndReconcile = async (
      names: { session: string; item: string; reconcile: string },
      // A function of the ids the helper itself creates, so a test can write a probe that reads the
      // very session being reconciled.
      overrides: (context: {
        sessionId: string;
        stageAttemptId: string;
      }) => Partial<OpenLocalStateOptions> = () => ({}),
      // How the orphan itself is started. Only the ESRCH test overrides this, and only because
      // whose child the process is decides whether its pid can disappear mid-`execute` at all --
      // see `spawnReparentedProbeChild`.
      spawnOrphan: () => number = spawnProbeChild,
    ): Promise<{ pid: number; sessionId: string; reported: OrphanProcessEvent[] }> => {
      const before = await open();
      const { stageAttemptId } = startWorkflow(before, names.session, names.item);
      const started = before.execute(
        startProviderSessionCommand(`${names.session}-provider`, stageAttemptId),
      );
      if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");

      const pid = spawnOrphan();
      orphanPids.push(pid);
      setProviderSessionProcessPid(started.session.id, pid);

      before.close();
      state = undefined;

      const reported: OrphanProcessEvent[] = [];
      const after = await open({
        onOrphanProcess: (event) => reported.push(event),
        ...overrides({ sessionId: started.session.id, stageAttemptId }),
      });
      const reconciled = after.execute(reconcileWorkflowsCommand(names.reconcile));
      if (reconciled.type !== "WORKFLOWS_RECONCILED") throw new Error("Expected reconciliation");
      return { pid, sessionId: started.session.id, reported };
    };

    // The claim reconciliation makes is "killed first, marked second". Proven with a REAL detached
    // child, spawned outside anything this state store manages, because the whole point is that the
    // process outlives the daemon that spawned it.
    //
    // This also exercises the DEFAULT start-time probe -- the real synchronous `ps` call, on this
    // machine, against a real pid. `IDENTITY_CONFIRMED` below is only reachable when that probe
    // actually answered: a probe that cannot read a start time fails safe and skips the kill, so a
    // broken `ps` invocation reads here as a live process and a `START_TIME_UNKNOWN` report rather
    // than as a silent pass.
    it("kills a process orphaned by a daemon restart before ending its session", async () => {
      const { pid, sessionId, reported } = await orphanAndReconcile({
        session: "start-orphan-pid-session",
        item: "create-orphan-pid-item",
        reconcile: "reconcile-orphan-pid-session",
      });

      // `execute` sends SIGKILL synchronously and returns without waiting for it to land -- and in
      // production that is the whole story, because the orphan is never this process's own child.
      // Here it is: this test spawned the probe itself, so this process is the one the kernel
      // expects to reap it, and that reap only happens on an event-loop turn this synchronous
      // `execute` call never yields. Polling with a real `await` between checks is what lets that
      // turn happen; it is a fact about this test harness, not about reconciliation, which already
      // sent the kill before this line ever runs.
      await waitUntilProcessExits(pid, PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS);
      expect(isProcessAlive(pid)).toBe(false);
      expect(readProviderSessionRow(sessionId).status).toBe("ENDED");
      // The kill is recorded -- with the pid and the session it belonged to. A SIGKILL on the
      // owner's machine that nothing anywhere wrote down is the defect this assertion closes.
      expect(reported).toEqual([{ pid, sessionId, action: "KILLED", reason: "IDENTITY_CONFIRMED" }]);
    });

    // The ordering the test above NAMES could not previously be proven: swapping the two statements
    // into mark-then-kill left it green, because a dead process and an ENDED row hold either way.
    // The report callback fires at the moment of the kill decision, so reading the row from inside
    // it is the observable intermediate state -- and it must still say RUNNING.
    it("still has the session marked RUNNING at the moment it kills the process", async () => {
      const statusAtKill: string[] = [];
      const { pid, sessionId } = await orphanAndReconcile(
        {
          session: "start-orphan-order-session",
          item: "create-orphan-order-item",
          reconcile: "reconcile-orphan-order-session",
        },
        ({ stageAttemptId }) => ({
          // Read through the store's OWN connection (`state.query`), not a second `DatabaseSync` on
          // the same file: `execute` runs inside `BEGIN IMMEDIATE`, so a separate connection cannot
          // see the uncommitted mark and would report RUNNING whichever order the two statements are
          // in -- which is exactly why the previous version of this test could not fail.
          onOrphanProcess: (event) => {
            const sessions = state?.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
            if (sessions?.type !== "PROVIDER_SESSIONS") throw new Error("Expected the attempt's sessions");
            const session = sessions.sessions.find(({ id }) => id === event.sessionId);
            if (session === undefined) throw new Error("Expected the orphaned session");
            statusAtKill.push(session.status);
          },
        }),
      );

      expect(statusAtKill).toEqual(["RUNNING"]);
      // And the mark did happen, so this is an ordering assertion rather than a "never marked" one.
      expect(readProviderSessionRow(sessionId).status).toBe("ENDED");
      await waitUntilProcessExits(pid, PROCESS_EXIT_CONFIRMATION_TIMEOUT_MS);
    });

    // The only way an orphan exists is a crash or a power-off, which usually means a reboot -- and
    // after a reboot pid allocation restarts and walks back up through the recorded range. A reused
    // pid necessarily started LATER than the session that recorded the original, and that is the one
    // fact separating our dead child from the owner's editor or build.
    it("leaves a reused pid alone, because it started after the session that recorded it", async () => {
      const { pid, sessionId, reported } = await orphanAndReconcile(
        {
          session: "start-orphan-reuse-session",
          item: "create-orphan-reuse-item",
          reconcile: "reconcile-orphan-reuse-session",
        },
        // An hour after the session started: this process cannot be the one the session recorded.
        () => ({ processStartedAt: () => new Date(Date.parse(timestamp) + 3_600_000) }),
      );
      try {
        expect(isProcessAlive(pid)).toBe(true);
        expect(reported).toEqual([{ pid, sessionId, action: "SKIPPED", reason: "STARTED_AFTER_SESSION" }]);
        // The session is still reconciled -- the row must not stay RUNNING just because the process
        // was spared, or the next start would look for it forever.
        expect(readProviderSessionRow(sessionId).status).toBe("ENDED");
      } finally {
        process.kill(pid, "SIGKILL");
      }
    });

    // Fail safe. `ps` can be absent (Windows), refuse, or print something unparseable. An orphan
    // that survives is self-healing at the next daemon start; a SIGKILL to the wrong process is not.
    it("leaves the orphan alone, and says so, when it cannot tell when the process started", async () => {
      const { pid, sessionId, reported } = await orphanAndReconcile(
        {
          session: "start-orphan-unknown-session",
          item: "create-orphan-unknown-item",
          reconcile: "reconcile-orphan-unknown-session",
        },
        () => ({ processStartedAt: () => null }),
      );
      try {
        expect(isProcessAlive(pid)).toBe(true);
        expect(reported).toEqual([{ pid, sessionId, action: "SKIPPED", reason: "START_TIME_UNKNOWN" }]);
        expect(readProviderSessionRow(sessionId).status).toBe("ENDED");
      } finally {
        process.kill(pid, "SIGKILL");
      }
    });

    // The liveness check and the signal are not one atomic act: the identity guard runs a real
    // synchronous OS probe between them. An orphan that exits inside that window makes the signal
    // throw ESRCH -- which, unwrapped, escapes `killOrphanedSessionProcess`, is re-wrapped by
    // `execute` as a PERSISTENCE_FAILURE, and propagates out of the daemon's own unwrapped
    // RECONCILE_WORKFLOWS call, which runs before `app.listen`. The daemon then does not start at
    // all: a strictly worse failure than the orphan the kill exists to prevent.
    //
    // The OS race is injected at the signal boundary: that is both deterministic and portable,
    // unlike a reparented `/bin/sh` child (which cannot exist on Windows). The liveness and identity
    // guards still run against a real child before the injected signal reports ESRCH.
    //
    // Asserted through `resolves`, not a bare `await`: the defect is `execute` THROWING, and a bare
    // await would surface that as the raw StateStoreError rather than as a failed assertion about
    // what reconciliation did.
    it("survives, and records it, when the orphan vanishes before the signal", async () => {
      const reconciled = orphanAndReconcile(
        {
          session: "start-orphan-vanished-session",
          item: "create-orphan-vanished-item",
          reconcile: "reconcile-orphan-vanished-session",
        },
        () => ({
          processStartedAt: () => new Date(Date.parse(timestamp) - 1_000),
          signalProcess: () => {
            const vanished = new Error("No such process") as Error & { code: string };
            vanished.code = "ESRCH";
            throw vanished;
          },
        }),
      );

      await expect(reconciled).resolves.toMatchObject({
        reported: [{ action: "FAILED", reason: "VANISHED_BEFORE_SIGNAL" }],
      });
      const { pid, sessionId, reported } = await reconciled;
      // The miss is recorded with the pid and the session it belonged to, and NOT as a kill: the
      // previous version reported KILLED before attempting the signal, so a kill that threw was
      // written down as a kill that happened.
      expect(reported).toEqual([{ pid, sessionId, action: "FAILED", reason: "VANISHED_BEFORE_SIGNAL" }]);
      // And reconciliation still did its job, which is the point: the session is not left RUNNING
      // for the next start to look for forever.
      expect(readProviderSessionRow(sessionId).status).toBe("ENDED");
    });

    // The same guarantee, one layer out: no failure of this probe -- not the signal, not the
    // identity check itself -- may ever escape into `execute`. The default start-time probe
    // contains its own failures, so this can only be reached through an injected one, but "only
    // reachable through" is not "cannot happen", and the cost of being wrong is a daemon that will
    // not start.
    it("survives, and records it, when the identity probe itself throws", async () => {
      const reconciled = orphanAndReconcile(
        {
          session: "start-orphan-probe-failure-session",
          item: "create-orphan-probe-failure-item",
          reconcile: "reconcile-orphan-probe-failure-session",
        },
        () => ({
          processStartedAt: () => {
            throw new Error("ps is not available on this machine");
          },
        }),
      );

      await expect(reconciled).resolves.toMatchObject({
        reported: [{ action: "FAILED", reason: "PROBE_FAILED" }],
      });
      const { pid, sessionId, reported } = await reconciled;
      expect(reported).toEqual([{ pid, sessionId, action: "FAILED", reason: "PROBE_FAILED" }]);
      // Fail safe in the direction that matters: nothing was signalled.
      expect(isProcessAlive(pid)).toBe(true);
      expect(readProviderSessionRow(sessionId).status).toBe("ENDED");
    });

    it("assembles the context sources snapshot from a published Checkpoint, Evidence, and a Decision", async () => {
      const localState = await open();
      const { workItemId, stageAttemptId, projectId } = startWorkflow(
        localState,
        "start-context-sources",
        "create-context-sources-item",
      );
      const snapshot = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
      if (snapshot.type !== "WORKFLOW_SNAPSHOT" || !snapshot.snapshot.run) {
        throw new Error("Expected a running PipelineRun");
      }
      const pipelineRunId = snapshot.snapshot.run.id;

      const started = localState.execute(
        startProviderSessionCommand("start-context-session", stageAttemptId),
      );
      if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected the session to start");

      const published = localState.execute(
        publishCheckpointCommand("publish-context-checkpoint", started.session.id, {
          summary: "Implemented the size guard and added a regression test.",
          completed: ["Added a 5s parsing timeout"],
          remaining: ["Wire the timeout into the retry policy"],
          deadEnds: ["Tried streaming parse; the library does not support it"],
          openQuestions: ["Should the timeout be configurable per work item?"],
        }),
      );
      if (published.type !== "CHECKPOINT_PUBLISHED") throw new Error("Expected the checkpoint to publish");

      const ended = localState.execute(
        endProviderSessionCommand("end-context-session", started.session.id, "HANDOFF"),
      );
      if (ended.type !== "PROVIDER_SESSION_ENDED") throw new Error("Expected the session to end");

      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      seedActiveProjectConstitution(raw, projectId);
      seedEvidenceArtifact(raw, {
        id: "evidence-context-sources",
        projectId,
        workItemId,
        pipelineRunId,
        stageAttemptId,
      });
      seedDecision(raw, {
        humanRequestId: "human-request-context-sources",
        decisionId: "decision-context-sources",
        projectId,
        workItemId,
        stageAttemptId,
      });
      raw.close();

      const reopened = await open();
      const result = reopened.query({ type: "READ_CONTEXT_SOURCES", stageAttemptId, sessionOrdinal: 2 });
      if (result.type !== "CONTEXT_SOURCES") throw new Error("Expected context sources");
      const sources = result.sources;

      expect(sources.workItemBrief.id).toBe(workItemId);
      expect(sources.workflowPosition).toMatchObject({
        templateId: mockTemplate.id,
        templateVersion: mockTemplate.version,
        stage: "DISCOVERY",
        attempt: 1,
        sessionOrdinal: 2,
      });
      expect(sources.projectConstitution).toEqual({
        id: "constitution-context-sources",
        version: 2,
        ordinal: 1,
        contentDigest: "c".repeat(64),
        renderedMarkdown: "# Project Constitution\n\n- Keep persistence reads coherent.",
      });
      expect(sources.latestCheckpoint).toMatchObject({
        summary: "Implemented the size guard and added a regression test.",
        completed: ["Added a 5s parsing timeout"],
        remaining: ["Wire the timeout into the retry policy"],
        deadEnds: ["Tried streaming parse; the library does not support it"],
        openQuestions: ["Should the timeout be configurable per work item?"],
      });
      expect(sources.evidence).toEqual([
        {
          id: "evidence-context-sources",
          version: 1,
          kind: "REVIEW_REPORT",
          title: "Review report",
          summary: "Looks good.",
          checks: ["Contract review passed."],
        },
      ]);
      expect(sources.decisions).toEqual([
        {
          id: "decision-context-sources",
          version: 1,
          question: "Which parser library?",
          answer: "Use pdf-lib.",
        },
      ]);
    });

    // The recipe assembled from these sources is parsed with contextPackRecipeSectionSchema, whose
    // `sources` array is capped. An uncapped read made that cap a failure mode rather than a bound:
    // a work item with more decisions than the cap threw out of `runStageAttempt`, and out of
    // `startDaemon` when the boot drain was the caller. The boundary is asserted with the exported
    // constant, so raising one number cannot leave the other behind.
    it("caps the decisions a context pack cites at the recipe's own source limit", async () => {
      const localState = await open();
      const { workItemId, stageAttemptId, projectId } = startWorkflow(
        localState,
        "start-decision-cap",
        "create-decision-cap-item",
      );
      localState.close();
      state = undefined;

      const total = maxContextPackRecipeSources + 1;
      const idOf = (index: number): string => `decision-cap-${index.toString().padStart(4, "0")}`;
      const raw = new DatabaseSync(databasePath);
      for (let index = 0; index < total; index += 1) {
        seedDecision(raw, {
          humanRequestId: `human-request-cap-${index.toString().padStart(4, "0")}`,
          decisionId: idOf(index),
          projectId,
          workItemId,
          stageAttemptId,
        });
      }
      raw.close();

      const reopened = await open();
      const sources = reopened.query({ type: "READ_CONTEXT_SOURCES", stageAttemptId, sessionOrdinal: 1 });
      if (sources.type !== "CONTEXT_SOURCES") throw new Error("Expected the context sources");
      const cited = sources.sources.decisions;
      expect(cited).toHaveLength(maxContextPackRecipeSources);
      // The oldest decision is the one dropped, and the order the pack renders stays chronological.
      expect(cited.at(0)?.id).toBe(idOf(1));
      expect(cited.at(-1)?.id).toBe(idOf(total - 1));

      // What the read returns is exactly what the recipe contract accepts -- the property the cap
      // exists for, asserted against the schema itself rather than against a copy of its number.
      expect(() =>
        contextPackRecipeSectionSchema.parse({
          id: "DECISIONS",
          sources: cited.map((decision) => ({
            kind: "DECISION",
            id: decision.id,
            version: decision.version,
          })),
          bytes: 0,
        }),
      ).not.toThrow();
    });

    it("reads context sources even when a recent Event's type is not modeled by domainEventSchema", async () => {
      // Migration 0006's events CHECK admits CONTEXT_HANDOFF_REQUESTED and CONTEXT_FLOOR_EXCEEDED
      // (Task 8's events); domainEventSchema deliberately does not model them yet. ACTIVITY must
      // not route these rows through eventFromRow's full domainEventSchema.parse, or the mere
      // presence of one of these events in a work item's recent history would make it impossible
      // to start any session for that work item at all.
      const localState = await open();
      const { workItemId, stageAttemptId, projectId } = startWorkflow(
        localState,
        "start-unmodeled-event",
        "create-unmodeled-event-item",
      );
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      raw
        .prepare(
          `INSERT INTO events (
            id, schema_version, type, aggregate_type, aggregate_id, project_id,
            actor_type, actor_id, occurred_at, correlation_id, data_json
          ) VALUES (?, 1, 'CONTEXT_HANDOFF_REQUESTED', 'WORK_ITEM', ?, ?, 'SYSTEM', 'mock-provider', ?, ?, '{}')`,
        )
        .run("event-unmodeled", workItemId, projectId, timestamp, "correlation-unmodeled");
      raw.close();

      const reopened = await open();
      const result = reopened.query({ type: "READ_CONTEXT_SOURCES", stageAttemptId, sessionOrdinal: 1 });
      if (result.type !== "CONTEXT_SOURCES") throw new Error("Expected context sources");
      const unmodeled = result.sources.activity.find((item) => item.id === "event-unmodeled");
      expect(unmodeled).toMatchObject({ description: "Context Handoff Requested" });
    });

    it("keeps every context source pinned to one snapshot, immune to a write that commits mid-read", async () => {
      // A torn read across DECISIONS/LATEST_CHECKPOINT/EVIDENCE/ACTIVITY would silently make the
      // recipe's per-section sourceVersion describe a pack that never existed (spec §6.1 step 1).
      // Proving the snapshot is pinned requires a write to actually land *during* the read, so
      // this drives a second, independent connection to the same database file from inside a
      // hook fired after the read's first statement -- WAL's reader/writer concurrency is exactly
      // what a torn read would break and what one transaction around the read is meant to prevent.
      let hookCalls = 0;
      let workItemId = "";

      state = await openLocalState({
        databasePath,
        now: () => new Date(timestamp),
        createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
        onContextSourcesSnapshotStarted: () => {
          hookCalls += 1;
          const writer = new DatabaseSync(databasePath);
          try {
            writer
              .prepare("UPDATE work_items SET title = ?, version = version + 1, updated_at = ? WHERE id = ?")
              .run("Retitled mid-read", timestamp, workItemId);
          } finally {
            writer.close();
          }
        },
      });
      const localState = state;

      const { workItemId: seededWorkItemId, stageAttemptId } = startWorkflow(
        localState,
        "start-snapshot-isolation",
        "create-snapshot-isolation-item",
      );
      workItemId = seededWorkItemId;

      const baseline = localState.query({ type: "GET_WORK_ITEM", workItemId });
      if (baseline.type !== "WORK_ITEM" || !baseline.workItem) throw new Error("Expected the WorkItem");
      const baselineTitle = baseline.workItem.title;
      const baselineVersion = baseline.workItem.version;

      const result = localState.query({ type: "READ_CONTEXT_SOURCES", stageAttemptId, sessionOrdinal: 1 });
      if (result.type !== "CONTEXT_SOURCES") throw new Error("Expected context sources");

      expect(hookCalls).toBe(1);
      // The read observed the pre-write snapshot, not the write the hook committed mid-read.
      expect(result.sources.workItemBrief.title).toBe(baselineTitle);
      expect(result.sources.workItemBrief.version).toBe(baselineVersion);

      // The write genuinely committed -- a fresh read now sees it. Without this, the assertion
      // above would be equally true of a hook that silently did nothing.
      const after = localState.query({ type: "GET_WORK_ITEM", workItemId });
      expect(after.type === "WORK_ITEM" ? after.workItem?.title : null).toBe("Retitled mid-read");
      expect(after.type === "WORK_ITEM" ? after.workItem?.version : null).toBe(baselineVersion + 1);
    });
  });

  describe("workspace storage (migration 0011)", () => {
    // Independent of "provider session lifecycle (Task 7)"'s own startWorkflow: this one only
    // needs a real StageAttempt id to satisfy work_item_workspaces.lease_holder's FK, not the
    // workspace-under-test's own WorkItem -- a lease is a valid StageAttempt id, not necessarily
    // one working the same WorkItem the workspace belongs to (that pairing is a daemon-level
    // concern this migration does not enforce).
    const startWorkflow = (
      localState: LocalState,
      commandId: string,
      workItemCommandId: string,
    ): { workItemId: string; stageAttemptId: string; projectId: string } => {
      const created = localState.execute(createWorkItem(workItemCommandId));
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      localState.execute(moveWorkItem(`ready-${commandId}`, created.workItem.id, 1, "READY"));
      const started = localState.execute({
        schemaVersion: 1,
        commandId,
        correlationId: `correlation-${commandId}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: mockTemplate,
          budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      return {
        workItemId: created.workItem.id,
        stageAttemptId: started.stageAttempt.id,
        projectId: created.workItem.projectId,
      };
    };

    const createWorkspaceCommand = (
      commandId: string,
      workItemId: string,
      projectId: string,
      overrides: Partial<CreateWorkItemWorkspaceCommand["payload"]> = {},
    ): CreateWorkItemWorkspaceCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "workspace-manager" },
      type: "CREATE_WORK_ITEM_WORKSPACE",
      payload: {
        workItemId,
        projectId,
        branch: `loomrail/${workItemId}`,
        worktreePath: join(temporaryDirectory, "worktrees", workItemId),
        baseCommit: null,
        snapshotCommit: null,
        carriedPaths: [],
        ...overrides,
      },
    });

    const acquireLeaseCommand = (
      commandId: string,
      workspaceId: string,
      stageAttemptId: string,
      expectedVersion: number,
    ): AcquireWorkspaceLeaseCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "workspace-manager" },
      type: "ACQUIRE_WORKSPACE_LEASE",
      payload: { workspaceId, stageAttemptId, expectedVersion },
    });

    const releaseLeaseCommand = (
      commandId: string,
      workspaceId: string,
      stageAttemptId: string,
      expectedVersion: number,
    ): ReleaseWorkspaceLeaseCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "workspace-manager" },
      type: "RELEASE_WORKSPACE_LEASE",
      payload: { workspaceId, stageAttemptId, expectedVersion },
    });

    const markOrphanedCommand = (
      commandId: string,
      workspaceId: string,
      expectedVersion: number,
    ): MarkWorkspaceOrphanedCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "workspace-reconciler" },
      type: "MARK_WORKSPACE_ORPHANED",
      payload: { workspaceId, expectedVersion },
    });

    const countWorkItemWorkspaces = (raw: DatabaseSync): number =>
      (raw.prepare("SELECT COUNT(*) AS count FROM work_item_workspaces").get() as { count: number }).count;

    // Task 10 (spec §6, "Восстановление"): a real repository and a real `git worktree`, built the
    // same way packages/workspace/test/helpers.ts's makeThrowawayRepo does, so RECONCILE_WORKFLOWS's
    // default `listProjectWorktrees` runs actual `git worktree list --porcelain` against it rather
    // than a stub -- these tests exercise the production subprocess call end to end, the parser it
    // shares with @loomrail/workspace, and the path canonicalisation the comparison needs (the OS
    // temp directory itself is a macOS symlink target, so this is not a contrived case).
    const testCommitterArgs = ["-c", "user.email=loomrail-test@example.com", "-c", "user.name=Loomrail Test"];

    const makeThrowawayRepo = (dir: string): void => {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      execFileSync("git", [...testCommitterArgs, "commit", "--allow-empty", "--quiet", "-m", "initial"], {
        cwd: dir,
      });
    };

    const addRealWorktree = (repositoryPath: string, branch: string, worktreePath: string): void => {
      execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repositoryPath });
    };

    const branchStillExists = (repositoryPath: string, branch: string): boolean =>
      execFileSync("git", ["branch", "--list", branch], { cwd: repositoryPath, encoding: "utf8" }).trim()
        .length > 0;

    const reconcileWorkflowsCommand = (commandId: string): ReconcileWorkflowsCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });

    it("creates a workspace and reads it back by WorkItem id", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(localState, "start-create", "create-work-item-create");

      const created = localState.execute(
        createWorkspaceCommand("create-workspace", workItemId, projectId, {
          carriedPaths: ["src/index.ts"],
        }),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      expect(created.workspace).toMatchObject({
        workItemId,
        projectId,
        status: "READY",
        leaseHolder: null,
        version: 1,
      });
      expect(created.event).toMatchObject({
        type: "WORK_ITEM_WORKSPACE_CREATED",
        data: { carriedPaths: ["src/index.ts"] },
      });

      const read = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(read).toMatchObject({ type: "WORKSPACE", workspace: { id: created.workspace.id } });
    });

    it("refuses a second workspace for one work item", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(localState, "start-unique", "create-work-item-unique");
      const raw = new DatabaseSync(databasePath);

      try {
        localState.execute(createWorkspaceCommand("create-workspace-first", workItemId, projectId));
        expect(countWorkItemWorkspaces(raw)).toBe(1);

        expect(() =>
          localState.execute(
            createWorkspaceCommand("create-workspace-second", workItemId, projectId, {
              branch: "loomrail/a-different-branch",
            }),
          ),
        ).toThrow(expect.objectContaining({ code: "WORKSPACE_ALREADY_EXISTS" }));

        expect(countWorkItemWorkspaces(raw)).toBe(1);
      } finally {
        raw.close();
      }
    });

    it("does not hand a second stage attempt the workspace a first one is writing in", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(
        localState,
        "start-lease-a",
        "create-work-item-lease-a",
      );
      const { stageAttemptId: attemptA } = startWorkflow(
        localState,
        "start-lease-b",
        "create-work-item-lease-b",
      );
      const { stageAttemptId: attemptB } = startWorkflow(
        localState,
        "start-lease-c",
        "create-work-item-lease-c",
      );

      const created = localState.execute(
        createWorkspaceCommand("create-workspace-lease", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      const workspaceId = created.workspace.id;

      const acquiredA = localState.execute(acquireLeaseCommand("acquire-a", workspaceId, attemptA, 1));
      if (acquiredA.type !== "WORKSPACE_LEASE_ACQUIRED") throw new Error("Expected the lease to be acquired");
      expect(acquiredA.workspace.leaseHolder).toBe(attemptA);

      // attemptB reads the workspace's real, current version -- 2, after attemptA's acquire bumped
      // it -- so only the `lease_holder IS NULL` clause is what can still block this UPDATE. That is
      // what makes this test able to fail under Step 5's mutation: if that clause is removed, an
      // UPDATE with a matching version has nothing left to stop it from succeeding.
      expect(() =>
        localState.execute(
          acquireLeaseCommand("acquire-b", workspaceId, attemptB, acquiredA.workspace.version),
        ),
      ).toThrow(/lease/i);

      const stillA = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(stillA.type === "WORKSPACE" ? stillA.workspace?.leaseHolder : null).toBe(attemptA);
      expect(stillA.type === "WORKSPACE" ? stillA.workspace?.version : null).toBe(
        acquiredA.workspace.version,
      );
    });

    it("releases a lease and lets a different stage attempt reacquire it", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(
        localState,
        "start-release-a",
        "create-work-item-release-a",
      );
      const { stageAttemptId: attemptA } = startWorkflow(
        localState,
        "start-release-b",
        "create-work-item-release-b",
      );
      const { stageAttemptId: attemptB } = startWorkflow(
        localState,
        "start-release-c",
        "create-work-item-release-c",
      );

      const created = localState.execute(
        createWorkspaceCommand("create-workspace-release", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      const workspaceId = created.workspace.id;

      const acquired = localState.execute(acquireLeaseCommand("acquire-release-a", workspaceId, attemptA, 1));
      if (acquired.type !== "WORKSPACE_LEASE_ACQUIRED") throw new Error("Expected the lease to be acquired");

      const released = localState.execute(
        releaseLeaseCommand("release-a", workspaceId, attemptA, acquired.workspace.version),
      );
      if (released.type !== "WORKSPACE_LEASE_RELEASED") throw new Error("Expected the lease to be released");
      expect(released.workspace.leaseHolder).toBeNull();

      const acquiredB = localState.execute(
        acquireLeaseCommand("acquire-release-b", workspaceId, attemptB, released.workspace.version),
      );
      if (acquiredB.type !== "WORKSPACE_LEASE_ACQUIRED")
        throw new Error("Expected the second acquire to succeed");
      expect(acquiredB.workspace.leaseHolder).toBe(attemptB);
    });

    it("refuses to release a lease held by a different stage attempt", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(
        localState,
        "start-refuse-a",
        "create-work-item-refuse-a",
      );
      const { stageAttemptId: attemptA } = startWorkflow(
        localState,
        "start-refuse-b",
        "create-work-item-refuse-b",
      );
      const { stageAttemptId: attemptB } = startWorkflow(
        localState,
        "start-refuse-c",
        "create-work-item-refuse-c",
      );

      const created = localState.execute(
        createWorkspaceCommand("create-workspace-refuse", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      const workspaceId = created.workspace.id;

      const acquired = localState.execute(acquireLeaseCommand("acquire-refuse-a", workspaceId, attemptA, 1));
      if (acquired.type !== "WORKSPACE_LEASE_ACQUIRED") throw new Error("Expected the lease to be acquired");

      expect(() =>
        localState.execute(
          releaseLeaseCommand("release-refuse-b", workspaceId, attemptB, acquired.workspace.version),
        ),
      ).toThrow(/lease/i);

      const stillHeld = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(stillHeld.type === "WORKSPACE" ? stillHeld.workspace?.leaseHolder : null).toBe(attemptA);
    });

    it("marks a READY workspace orphaned and records the previous status", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(localState, "start-orphan", "create-work-item-orphan");

      const created = localState.execute(
        createWorkspaceCommand("create-workspace-orphan", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      const workspaceId = created.workspace.id;

      const orphaned = localState.execute(markOrphanedCommand("mark-orphaned", workspaceId, 1));
      if (orphaned.type !== "WORK_ITEM_WORKSPACE_ORPHANED")
        throw new Error("Expected the workspace to be orphaned");
      expect(orphaned.workspace.status).toBe("ORPHANED");
      expect(orphaned.event).toMatchObject({
        type: "WORK_ITEM_WORKSPACE_ORPHANED",
        data: { previousStatus: "READY" },
      });

      expect(() => localState.execute(markOrphanedCommand("mark-orphaned-again", workspaceId, 2))).toThrow(
        /ready/i,
      );
    });

    // Task 10 (spec §6, "Восстановление"): the reconciliation counterpart to MARK_WORKSPACE_ORPHANED
    // above -- this is what actually notices a worktree is gone at startup, rather than a caller
    // saying so directly. A real `git worktree`, deleted the way an owner's own cleanup or a crashed
    // tool would delete it, so the administrative record git keeps under `.git/worktrees/` survives
    // (git only drops that on an explicit `prune`/`remove`) and is reported `prunable` -- the
    // "gone outside Loomrail's control" case spec §6 and workItemWorkspaceOrphanedEventSchema's own
    // comment describe.
    it("notices the workspace whose worktree directory went away, and leaves the branch alone", async () => {
      const localState = await open();
      const repositoryPath = join(temporaryDirectory, "project-web");
      await mkdir(repositoryPath, { recursive: true });
      makeThrowawayRepo(repositoryPath);
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(
        localState,
        "start-worktree-gone",
        "create-work-item-worktree-gone",
      );

      const branch = `loomrail/${workItemId}`;
      const worktreePath = join(temporaryDirectory, "worktrees", workItemId);
      await mkdir(join(temporaryDirectory, "worktrees"), { recursive: true });
      addRealWorktree(repositoryPath, branch, worktreePath);

      const created = localState.execute(
        createWorkspaceCommand("create-workspace-worktree-gone", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");

      // What an owner's own cleanup, or a crashed tool, leaves behind: the directory is gone, but
      // nothing told git about it, so `.git/worktrees/<name>` is still there.
      await rm(worktreePath, { recursive: true, force: true });

      const reconciled = localState.execute(reconcileWorkflowsCommand("reconcile-worktree-gone"));
      if (reconciled.type !== "WORKFLOWS_RECONCILED") throw new Error("Expected reconciliation");
      expect(reconciled.orphanedWorkspaces).toEqual([
        expect.objectContaining({ id: created.workspace.id, status: "ORPHANED" }),
      ]);
      expect(reconciled.events).toHaveLength(1);
      expect(reconciled.events[0]).toMatchObject({
        type: "WORK_ITEM_WORKSPACE_ORPHANED",
        data: { previousStatus: "READY" },
      });

      const after = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(after.type === "WORKSPACE" ? after.workspace?.status : null).toBe("ORPHANED");

      // AD-008 / D12: nothing is resurrected, and the branch is the only copy of whatever the agent
      // committed to it -- it must survive even though the directory that held it did not.
      expect(branchStillExists(repositoryPath, branch)).toBe(true);
    });

    // C9-d (Task 9): a lease a daemon crash leaves behind on an otherwise-healthy workspace must not
    // sit there forever. The StageAttempt holding it here never started a ProviderSession at all --
    // exactly what "reconciles an orphaned running attempt once and persists its RecoveryReport"
    // above reconciles into INTERRUPTED via decideRecoverInterruptedWorkflow -- so it is never coming
    // back to release the lease itself.
    it("releases a workspace lease left by a StageAttempt reconciliation just gave up on", async () => {
      const localState = await open();
      const repositoryPath = join(temporaryDirectory, "project-web");
      await mkdir(repositoryPath, { recursive: true });
      makeThrowawayRepo(repositoryPath);
      localState.execute(registerProject());
      const { workItemId, stageAttemptId, projectId } = startWorkflow(
        localState,
        "start-dead-lease",
        "create-work-item-dead-lease",
      );

      const worktreePath = join(temporaryDirectory, "worktrees", workItemId);
      await mkdir(join(temporaryDirectory, "worktrees"), { recursive: true });
      addRealWorktree(repositoryPath, `loomrail/${workItemId}`, worktreePath);

      const created = localState.execute(
        createWorkspaceCommand("create-workspace-dead-lease", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      const acquired = localState.execute(
        acquireLeaseCommand("acquire-dead-lease", created.workspace.id, stageAttemptId, 1),
      );
      if (acquired.type !== "WORKSPACE_LEASE_ACQUIRED") throw new Error("Expected the lease to be acquired");

      // Marked started, but no ProviderSession is ever started for it -- what a daemon that died
      // before dispatching leaves behind (mirrors "reconciles an orphaned running attempt" above).
      const queued = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (queued.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected the dispatch queue");
      const dispatch = queued.dispatches.find((candidate) => candidate.stageAttemptId === stageAttemptId);
      if (!dispatch) throw new Error("Expected a pending dispatch for this StageAttempt");
      localState.execute({
        schemaVersion: 1,
        commandId: "mark-dead-lease-dispatch-started",
        correlationId: "correlation-mark-dead-lease-dispatch-started",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: dispatch.id },
      });

      const reconciled = localState.execute(reconcileWorkflowsCommand("reconcile-dead-lease"));
      if (reconciled.type !== "WORKFLOWS_RECONCILED") throw new Error("Expected reconciliation");
      expect(reconciled.recoveryReports).toEqual([
        expect.objectContaining({ reason: "DAEMON_RESTART", recoveredStatus: "INTERRUPTED", stageAttemptId }),
      ]);
      // The worktree itself is healthy, so nothing here is ORPHANED -- only the dead lease is cleared.
      expect(reconciled.orphanedWorkspaces).toEqual([]);

      const after = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(after.type === "WORKSPACE" ? after.workspace : null).toMatchObject({
        status: "READY",
        leaseHolder: null,
      });
    });

    // The lease the test above does NOT cover, and the one the product actually loses. The session
    // loop applies the provider's outcome and releases the lease as two separate commands, so a
    // SIGKILL between them leaves the lease held by a StageAttempt that is already SUCCEEDED.
    // Reconciliation only ever released leases held by attempts it had ITSELF just moved to
    // INTERRUPTED (a PENDING dispatch on a RUNNING attempt), and a finished attempt is neither --
    // so nothing cleared it, `acquireWorkspaceLease` answered POSTPONED on every later dispatch,
    // and because the pending-dispatch queue is strict FIFO and the worker reads only
    // `dispatches[0]`, every newer work item in the product waited behind this one, with nothing
    // logged above `info` and no question to the owner.
    //
    // The state is left behind exactly as a kill would leave it -- the outcome applied, the release
    // never sent -- and then the daemon restarts.
    it("releases a workspace lease left behind by a StageAttempt that already finished", async () => {
      const localState = await open();
      const repositoryPath = join(temporaryDirectory, "project-web");
      await mkdir(repositoryPath, { recursive: true });
      makeThrowawayRepo(repositoryPath);
      localState.execute(registerProject());
      const { workItemId, stageAttemptId, projectId } = startWorkflow(
        localState,
        "start-finished-lease",
        "create-work-item-finished-lease",
      );

      const worktreePath = join(temporaryDirectory, "worktrees", workItemId);
      await mkdir(join(temporaryDirectory, "worktrees"), { recursive: true });
      addRealWorktree(repositoryPath, `loomrail/${workItemId}`, worktreePath);

      const created = localState.execute(
        createWorkspaceCommand("create-workspace-finished-lease", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      const acquired = localState.execute(
        acquireLeaseCommand("acquire-finished-lease", created.workspace.id, stageAttemptId, 1),
      );
      if (acquired.type !== "WORKSPACE_LEASE_ACQUIRED") throw new Error("Expected the lease to be acquired");

      const queued = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (queued.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected the dispatch queue");
      const dispatch = queued.dispatches.find((candidate) => candidate.stageAttemptId === stageAttemptId);
      if (!dispatch) throw new Error("Expected a pending dispatch for this StageAttempt");
      localState.execute({
        schemaVersion: 1,
        commandId: "mark-finished-lease-dispatch-started",
        correlationId: "correlation-mark-finished-lease-dispatch-started",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: dispatch.id },
      });
      // The session finished and its stage closed. The RELEASE_WORKSPACE_LEASE that would have
      // followed in the session loop's `finally` is deliberately never sent: that is the kill.
      localState.execute({
        schemaVersion: 1,
        commandId: "apply-finished-lease-outcome",
        correlationId: "correlation-apply-finished-lease-outcome",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          resultTree: null,
          dispatchId: dispatch.id,
          template: mockTemplate,
          outcome: { type: "COMPLETED", summary: "Discovery finished." },
        },
      });

      // The premise, asserted rather than assumed: the attempt is finished and still holds the
      // lease. Without this a reconciliation that released nothing would be indistinguishable from
      // one that released the right thing.
      const beforeRestart = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
      expect(
        beforeRestart.type === "WORKFLOW_SNAPSHOT"
          ? beforeRestart.snapshot.stageAttempts.find(({ id }) => id === stageAttemptId)?.status
          : null,
      ).toBe("SUCCEEDED");
      const held = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(held.type === "WORKSPACE" ? held.workspace?.leaseHolder : null).toBe(stageAttemptId);

      const reconciled = localState.execute(reconcileWorkflowsCommand("reconcile-finished-lease"));
      if (reconciled.type !== "WORKFLOWS_RECONCILED") throw new Error("Expected reconciliation");
      // The worktree is healthy: only the dead lease is cleared, nothing is orphaned.
      expect(reconciled.orphanedWorkspaces).toEqual([]);
      const after = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(after.type === "WORKSPACE" ? after.workspace : null).toMatchObject({
        status: "READY",
        leaseHolder: null,
      });

      // And the consequence that matters: the next attempt can actually take it. A row reading
      // `leaseHolder: null` is the claim; an ACQUIRE that succeeds is the fact.
      const nextAttempt = startWorkflow(
        localState,
        "start-finished-lease-next",
        "create-work-item-finished-lease-next",
      );
      const reacquired = localState.execute(
        acquireLeaseCommand(
          "acquire-after-finished-lease",
          created.workspace.id,
          nextAttempt.stageAttemptId,
          after.type === "WORKSPACE" ? (after.workspace?.version ?? 0) : 0,
        ),
      );
      expect(reacquired).toMatchObject({
        type: "WORKSPACE_LEASE_ACQUIRED",
        workspace: { leaseHolder: nextAttempt.stageAttemptId },
      });
    });

    // Companion to "survives... when the identity probe itself throws" (orphaned-process
    // reconciliation, above): the same fail-safe guarantee, for the worktree check. `git` missing,
    // a repository path that no longer resolves, a permissions problem -- none of it may reach
    // `execute`, because `execute` runs unwrapped before `app.listen` (see killOrphanedSessionProcess's
    // own comment). An inconclusive check must never orphan a workspace that might still be healthy.
    it("does not fail reconciliation, and leaves the workspace READY, when the worktree check itself cannot run", async () => {
      const reported: OrphanWorkspaceEvent[] = [];
      const localState = await open({
        listProjectWorktrees: () => null,
        onOrphanWorkspace: (event) => reported.push(event),
      });
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(
        localState,
        "start-probe-failure",
        "create-work-item-probe-failure",
      );
      const created = localState.execute(
        createWorkspaceCommand("create-workspace-probe-failure", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");

      const reconciled = localState.execute(reconcileWorkflowsCommand("reconcile-probe-failure"));
      expect(reconciled).toMatchObject({ type: "WORKFLOWS_RECONCILED", orphanedWorkspaces: [] });
      expect(reported).toEqual([
        expect.objectContaining({
          workspaceId: created.workspace.id,
          action: "SKIPPED",
          reason: "WORKTREE_LIST_FAILED",
        }),
      ]);

      const after = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
      expect(after.type === "WORKSPACE" ? after.workspace?.status : null).toBe("READY");
    });

    // 0011's own comment says it plainly -- "that invariant belongs to the schema, not to a
    // convention callers are trusted to follow" -- and nothing checked that the schema kept it.
    // Dropping `UNIQUE` from `work_item_id` and the status CHECK from the table left this package
    // at 61/61 and the daemon at 123/123, because every test that touches a second workspace goes
    // through CREATE_WORK_ITEM_WORKSPACE, which reads the existing row and refuses first. These two
    // write into the table directly, so the refusal can only come from the constraint.
    it("refuses a second workspace row for the same WorkItem, in the schema itself", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(
        localState,
        "start-work-item-unique",
        "create-work-item-unique",
      );
      const created = localState.execute(
        createWorkspaceCommand("create-workspace-unique", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      try {
        const insertSecondWorkspace = (): void => {
          raw
            .prepare(
              `INSERT INTO work_item_workspaces
                 (id, schema_version, project_id, work_item_id, branch, worktree_path, base_commit,
                  snapshot_commit, status, lease_holder, created_at, version)
               SELECT 'workspace-second-writer', schema_version, project_id, work_item_id, ?, ?,
                      base_commit, snapshot_commit, status, lease_holder, created_at, version
               FROM work_item_workspaces WHERE id = ?`,
            )
            .run(
              `loomrail/${workItemId}-second`,
              join(temporaryDirectory, "worktrees", `${workItemId}-second`),
              created.workspace.id,
            );
        };
        // A second row for one WorkItem is two writers past the lease -- the outcome the lease
        // exists to make impossible -- so the table refuses it whatever the caller believed.
        expect(insertSecondWorkspace).toThrow(/UNIQUE constraint failed: work_item_workspaces\.work_item_id/);
      } finally {
        raw.close();
      }
    });

    it("refuses a workspace status outside the three the schema names, in the schema itself", async () => {
      const localState = await open();
      localState.execute(registerProject());
      const { workItemId, projectId } = startWorkflow(
        localState,
        "start-work-item-status-check",
        "create-work-item-status-check",
      );
      const created = localState.execute(
        createWorkspaceCommand("create-workspace-status-check", workItemId, projectId),
      );
      if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected workspace creation");
      localState.close();
      state = undefined;

      const raw = new DatabaseSync(databasePath);
      try {
        const writeUnknownStatus = (): void => {
          raw
            .prepare("UPDATE work_item_workspaces SET status = 'ABANDONED' WHERE id = ?")
            .run(created.workspace.id);
        };
        expect(writeUnknownStatus).toThrow(/CHECK constraint failed/);
        // The row is untouched, which is the point of a CHECK rather than a convention: a status
        // reconciliation cannot read back is not a state this table can be left in.
        expect(
          raw.prepare("SELECT status FROM work_item_workspaces WHERE id = ?").get(created.workspace.id),
        ).toMatchObject({ status: "READY" });
        // And each of the three the schema does name is accepted, so the CHECK is not passing this
        // test by refusing everything.
        for (const status of ["ORPHANED", "REMOVED", "READY"]) {
          raw
            .prepare("UPDATE work_item_workspaces SET status = ? WHERE id = ?")
            .run(status, created.workspace.id);
        }
      } finally {
        raw.close();
      }
    });
  });
});
