import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AnswerHumanRequestCommand,
  ApplyProviderOutcomeCommand,
  CreateWorkItemCommand,
  LegacyApplyMockProviderOutcomeCommand,
  MoveWorkItemCommand,
  RegisterProjectCommand,
  StartMockPipelineCommand,
  UpdateWorkItemCommand,
} from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

const timestamp = "2026-08-22T18:00:00.000Z";

const mockTemplate: StartMockPipelineCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "DISCOVERY", ordinal: 0 },
    { stage: "PLAN", ordinal: 1 },
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
        { stage: "REVIEW", ordinal: 0 },
        { stage: "QA", ordinal: 1 },
        { stage: "ACCEPTANCE", ordinal: 2 },
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
    expect(localState.startup.appliedMigrations).toEqual([1, 2, 3, 4, 5]);
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
});
