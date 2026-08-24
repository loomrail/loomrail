import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AnswerHumanRequestCommand,
  ApplyMockProviderOutcomeCommand,
  CreateWorkItemCommand,
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

  it("creates a backup before migrating an existing non-empty database", async () => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL) STRICT");
    legacy.prepare("INSERT INTO legacy_marker (value) VALUES (?)").run("preserve-me");
    legacy.close();

    const localState = await open();
    expect(localState.startup.appliedMigrations).toEqual([1, 2]);
    expect(localState.startup.backupPath).toBeDefined();
    if (!localState.startup.backupPath) throw new Error("Expected a migration backup");
    await access(localState.startup.backupPath);
    const backup = new DatabaseSync(localState.startup.backupPath, { readOnly: true });
    expect(backup.prepare("SELECT value FROM legacy_marker").get()).toEqual({ value: "preserve-me" });
    backup.close();
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
      payload: { workItemId: created.workItem.id, expectedVersion: 2, template: mockTemplate },
    };
    const started = localState.execute(start);
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
    const needsHuman: ApplyMockProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: `apply-${started.dispatch.id}`,
      correlationId: "correlation-needs-human",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_MOCK_PROVIDER_OUTCOME",
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
        commandId,
        correlationId: `correlation-${commandId}`,
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_MOCK_PROVIDER_OUTCOME",
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
});
