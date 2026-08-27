import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  StartProviderSessionCommand,
  UpdateWorkItemCommand,
} from "@loomrail/contracts";
import { contextPackRecipeSectionSchema, maxContextPackRecipeSources } from "@loomrail/contracts";
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
        { stage: "REVIEW", ordinal: 0, contextPack },
        { stage: "QA", ordinal: 1, contextPack },
        { stage: "ACCEPTANCE", ordinal: 2, contextPack },
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

    const applyNext = (outcome: ApplyProviderOutcomeCommand["payload"]["outcome"]): void => {
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
        payload: { dispatchId: dispatch.id, template: acceptanceTemplate, outcome },
      });
    };

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
    applyNext({
      type: "COMPLETED",
      summary: "QA passed.",
      artifacts: [
        {
          kind: "QA_REPORT",
          title: "QA report",
          summary: "QA passed.",
          checks: ["Scenario D passed."],
        },
      ],
    });
    applyNext({
      type: "READY_FOR_ACCEPTANCE",
      releaseNote: "The bounded fixture is ready for owner acceptance.",
      verifyInstructions: ["Run pnpm verify."],
    });

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
      artifacts: [{ kind: "REVIEW_REPORT" }, { kind: "QA_REPORT" }],
      acceptancePackage: { status: "PENDING" },
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
    expect(() => raw.prepare("UPDATE evidence_artifacts SET title = ?").run("Tampered")).toThrow();
    raw.close();
  });

  it("creates a backup before migrating an existing non-empty database", async () => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL) STRICT");
    legacy.prepare("INSERT INTO legacy_marker (value) VALUES (?)").run("preserve-me");
    legacy.close();

    const localState = await open();
    expect(localState.startup.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(localState.startup.backupPath).toBeDefined();
    if (!localState.startup.backupPath) throw new Error("Expected a migration backup");
    await access(localState.startup.backupPath);
    const backup = new DatabaseSync(localState.startup.backupPath, { readOnly: true });
    expect(backup.prepare("SELECT value FROM legacy_marker").get()).toEqual({ value: "preserve-me" });
    backup.close();
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
        { stage: "REVIEW", ordinal: 0, contextPack },
        { stage: "QA", ordinal: 1, contextPack },
        { stage: "ACCEPTANCE", ordinal: 2, contextPack },
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

    const applyNext = (outcome: ApplyProviderOutcomeCommand["payload"]["outcome"]): void => {
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
        payload: { dispatchId: dispatch.id, template: acceptanceTemplate, outcome },
      });
    };

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
    applyNext({
      type: "COMPLETED",
      summary: "QA passed.",
      artifacts: [
        { kind: "QA_REPORT", title: "QA report", summary: "QA passed.", checks: ["Scenario D passed."] },
      ],
    });
    applyNext({
      type: "READY_FOR_ACCEPTANCE",
      releaseNote: "Ready for owner acceptance.",
      verifyInstructions: ["Run pnpm verify."],
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
    raw.exec("INSERT INTO projects_v11 SELECT * FROM projects");
    raw.exec("DROP TABLE projects");
    raw.exec("ALTER TABLE projects_v11 RENAME TO projects");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 12").run();
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
    expect(migrated.startup.appliedMigrations).toEqual([12]);

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

    localState.close();
    state = undefined;
    const reopened = await open();
    const restored = reopened.query({ type: "LIST_HUMAN_REQUESTS", status: "OPEN" });
    expect(restored.type === "HUMAN_REQUESTS" ? restored.humanRequests : []).toHaveLength(1);

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
      const originalEvents = before.events.map((event) => ({
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
      // 0009 and 0010 both add columns to the table 0006 creates, so a database that predates 0006
      // predates them too: dropping provider_sessions took those columns with it, and all three
      // migrations have to be pending for the reconstruction to be honest.
      raw.prepare("DELETE FROM schema_migrations WHERE version IN (6, 9, 10)").run();
      raw.close();

      const migrated = await open();
      expect(migrated.startup.appliedMigrations).toEqual([6, 9, 10]);

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

    // Spec §9 asks for this at the package level, and this is the only place the SQL branch behind
    // `selectOrphanedRunningSessions` is reachable: a session left RUNNING when the process that
    // ran it is gone. §6.4 makes that the ordinary end of a session, not a failed StageAttempt, so
    // the dispatch must survive for the session loop to pick the attempt back up.
    it("ends a ProviderSession left RUNNING at reconciliation without failing its StageAttempt", async () => {
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
      const started = localState.execute(
        startProviderSessionCommand("start-orphaned-provider-session", stageAttemptId),
      );
      if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a started session");

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
          id: started.session.id,
          status: "ENDED",
          endReason: "INTERRUPTED",
          endedAt: timestamp,
        }),
      ]);
      expect(reconciled.events.filter(({ type }) => type === "PROVIDER_SESSION_ENDED")).toHaveLength(1);
      // The attempt was not routed through dispatch-level recovery: no RecoveryReport, the dispatch
      // is still PENDING, and the attempt is still RUNNING.
      expect(reconciled.recoveryReports).toEqual([]);
      const stillQueued = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      expect(
        stillQueued.type === "WORKFLOW_DISPATCHES" ? stillQueued.dispatches.map(({ id }) => id) : [],
      ).toEqual([dispatch.id]);
      const snapshot = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
      expect(
        snapshot.type === "WORKFLOW_SNAPSHOT"
          ? snapshot.snapshot.stageAttempts.find(({ id }) => id === stageAttemptId)?.status
          : null,
      ).toBe("RUNNING");

      localState.close();
      state = undefined;
      const raw = new DatabaseSync(databasePath);
      expect(
        raw.prepare("SELECT status, end_reason FROM provider_sessions WHERE id = ?").get(started.session.id),
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

    // How long the reparented probe child may take to stop existing after its SIGKILL. Measured at
    // about a millisecond -- init reaps it, and this process is not waiting on an event-loop turn
    // to hear about it. Generous by three orders of magnitude, and a miss reads as a report of
    // PROBE_FAILED rather than as a hang.
    const ORPHAN_VANISH_TIMEOUT_MS = 2_000;

    // A process this test process is NOT the parent of, and that distinction is the test.
    // A direct child that is SIGKILLed becomes a zombie -- and a zombie still answers
    // `process.kill(pid, 0)` -- until this process reaps it, which happens on an event-loop turn
    // that a synchronous `execute` never yields. `/bin/sh` starts the child and exits, so the child
    // is reparented to init, which reaps it at once; only then can a pid really stop existing in
    // the middle of one synchronous `execute` call.
    const spawnReparentedProbeChild = (): number => {
      const printed = execFileSync(
        "/bin/sh",
        ["-c", `"${process.execPath}" -e 'setInterval(() => {}, 1000);' >/dev/null 2>&1 & echo $!`],
        { encoding: "utf8" },
      );
      const pid = Number(printed.trim());
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error("The reparented probe child did not start");
      }
      return pid;
    };

    // The liveness check and the signal are not one atomic act: the identity guard runs a real
    // synchronous `ps` between them. An orphan that exits inside that window makes `process.kill`
    // throw ESRCH -- which, unwrapped, escapes `killOrphanedSessionProcess`, is re-wrapped by
    // `execute` as a PERSISTENCE_FAILURE, and propagates out of the daemon's own unwrapped
    // RECONCILE_WORKFLOWS call, which runs before `app.listen`. The daemon then does not start at
    // all: a strictly worse failure than the orphan the kill exists to prevent.
    //
    // The window is closed here for real rather than simulated -- the probe kills the child and
    // waits for its pid to actually stop existing before returning a start time -- so the kill
    // that follows signals a pid that is genuinely gone.
    //
    // Asserted through `resolves`, not a bare `await`: the defect is `execute` THROWING, and a bare
    // await would surface that as the raw StateStoreError rather than as a failed assertion about
    // what reconciliation did.
    it("survives, and records it, when the orphan exits between the liveness check and the kill", async () => {
      const reconciled = orphanAndReconcile(
        {
          session: "start-orphan-vanished-session",
          item: "create-orphan-vanished-item",
          reconcile: "reconcile-orphan-vanished-session",
        },
        () => ({
          processStartedAt: (pid: number) => {
            process.kill(pid, "SIGKILL");
            const deadline = Date.now() + ORPHAN_VANISH_TIMEOUT_MS;
            // A synchronous spin, not an `await`: `execute` is synchronous end to end, so there is
            // no turn to yield to -- and needing one is precisely what a zombie would impose.
            while (Date.now() < deadline) {
              if (!isProcessAlive(pid)) {
                // Believable identity: a second before the session that recorded it, so the guard
                // passes and the kill below is actually attempted.
                return new Date(Date.parse(timestamp) - 1_000);
              }
            }
            throw new Error("The probe child was still alive when the identity probe gave up");
          },
        }),
        spawnReparentedProbeChild,
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
  });
});
