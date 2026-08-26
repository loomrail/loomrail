import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AnswerHumanRequestCommand,
  ApplyProviderOutcomeCommand,
  ContextPackRecipeInput,
  CreateWorkItemCommand,
  EndProviderSessionCommand,
  LegacyApplyMockProviderOutcomeCommand,
  MoveWorkItemCommand,
  PublishCheckpointCommand,
  RegisterProjectCommand,
  StartMockPipelineCommand,
  StartProviderSessionCommand,
  UpdateWorkItemCommand,
} from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

const timestamp = "2026-08-22T18:00:00.000Z";

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

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const registerProject = (id = "project-web", commandId = "register-project"): RegisterProjectCommand => ({
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "REGISTER_FIXTURE_PROJECT",
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
    expect(localState.startup.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
    localState.close();
    state = undefined;

    // The commands table is append-only audit history and is never rewritten (see the provider
    // rename decision in docs/plans/07-a1-session-handoff-spec.ru.md §5.3): a receipt recorded
    // under the pre-rename command_type must remain exactly as it was written.
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER commands_are_append_only_update");
    raw
      .prepare(
        `INSERT INTO commands (command_id, command_type, input_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-apply-outcome",
        "APPLY_MOCK_PROVIDER_OUTCOME",
        "0".repeat(64),
        JSON.stringify({ schemaVersion: 1, type: "MOCK_PROVIDER_OUTCOME_APPLIED", replayed: false }),
        timestamp,
      );
    raw.exec(`
      CREATE TRIGGER commands_are_append_only_update
      BEFORE UPDATE ON commands
      BEGIN
        SELECT RAISE(ABORT, 'commands are append-only');
      END;
    `);
    raw.close();

    const reopened = await open();
    const events = reopened.query({ type: "LIST_EVENTS", aggregateId: created.workItem.id });
    expect(events.type).toBe("EVENTS");
    reopened.close();
    state = undefined;

    const verify = new DatabaseSync(databasePath);
    expect(
      verify.prepare("SELECT command_type FROM commands WHERE command_id = ?").get("legacy-apply-outcome"),
    ).toEqual({ command_type: "APPLY_MOCK_PROVIDER_OUTCOME" });
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

    it("persists StageAttempt.unproductiveSessions across a restart with a zero default", async () => {
      const localState = await open();
      const { workItemId, stageAttemptId } = startWorkflow(
        localState,
        "start-unproductive-sessions",
        "create-unproductive-sessions-item",
      );
      const snapshotBeforeRestart = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
      expect(
        snapshotBeforeRestart.type === "WORKFLOW_SNAPSHOT"
          ? snapshotBeforeRestart.snapshot.stageAttempts.find((attempt) => attempt.id === stageAttemptId)
              ?.unproductiveSessions
          : null,
      ).toBe(0);
      localState.close();
      state = undefined;

      const reopened = await open();
      const snapshot = reopened.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
      expect(
        snapshot.type === "WORKFLOW_SNAPSHOT"
          ? snapshot.snapshot.stageAttempts.find((attempt) => attempt.id === stageAttemptId)
              ?.unproductiveSessions
          : null,
      ).toBe(0);
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
      raw.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
      raw.close();

      const migrated = await open();
      expect(migrated.startup.appliedMigrations).toEqual([6]);

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
});
