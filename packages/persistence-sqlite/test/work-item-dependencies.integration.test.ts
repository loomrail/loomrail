import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CreateWorkItemCommand,
  MoveWorkItemCommand,
  SetWorkItemDependenciesCommand,
  StartPipelineCommand,
  WorkItem,
} from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

const timestamp = "2026-09-09T09:00:00.000Z";
const contextPack: StartPipelineCommand["payload"]["template"]["stages"][number]["contextPack"] = {
  schemaVersion: 1,
  sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
};
const template: StartPipelineCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "dependency-test-v1",
  version: 1,
  name: "Dependency test",
  stages: [{ stage: "DISCOVERY", ordinal: 0, contextPack }],
};

describe("SQLite WorkItem dependency graph", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail dependency граф "));
    databasePath = join(directory, "state with spaces.sqlite");
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-dependency-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const registerProject = (projectId: string, commandId: string): void => {
    state?.execute({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: projectId,
        fixtureId: null,
        name: projectId,
        repositoryPath: join(directory, projectId),
      },
    });
  };

  const create = (projectId: string, name: string, parentId: string | null = null): WorkItem => {
    const command: CreateWorkItemCommand = {
      schemaVersion: 1,
      commandId: `create-${name}`,
      correlationId: `correlation-create-${name}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId,
        parentId,
        type: parentId === null ? "TASK" : "SUBTASK",
        title: `Работа ${name}`,
        description: "Path fixture: C:\\Проекты\\Recurkit folder",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["Состояние восстановлено"],
      },
    };
    const result = state?.execute(command);
    if (result?.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    return result.workItem;
  };

  const setDependencies = (
    workItem: WorkItem,
    blockerWorkItemIds: readonly string[],
    commandId: string,
  ): SetWorkItemDependenciesCommand => ({
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "SET_WORK_ITEM_DEPENDENCIES",
    payload: {
      workItemId: workItem.id,
      expectedVersion: workItem.version,
      blockerWorkItemIds: [...blockerWorkItemIds],
    },
  });

  it("persists an Epic child chain, one audit event and its idempotent receipt across restart", async () => {
    const localState = await open();
    registerProject("project-recurkit", "register-recurkit");
    const epic = create("project-recurkit", "epic");
    const first = create("project-recurkit", "first", epic.id);
    const second = create("project-recurkit", "second", epic.id);
    const third = create("project-recurkit", "third", epic.id);

    const setSecond = setDependencies(second, [first.id], "set-second");
    const secondResult = localState.execute(setSecond);
    expect(secondResult).toMatchObject({
      type: "WORK_ITEM_DEPENDENCIES_SET",
      replayed: false,
      blockedWorkItemId: second.id,
      workItemVersion: 2,
      dependencies: [{ blockerWorkItemId: first.id, blockedWorkItemId: second.id }],
      event: { type: "WORK_ITEM_DEPENDENCIES_SET" },
    });
    localState.execute(setDependencies(third, [second.id], "set-third"));

    expect(
      localState.query({ type: "LIST_WORK_ITEM_DEPENDENCIES", projectId: "project-recurkit" }),
    ).toMatchObject({
      type: "WORK_ITEM_DEPENDENCIES",
      dependencies: [
        { blockerWorkItemId: first.id, blockedWorkItemId: second.id },
        { blockerWorkItemId: second.id, blockedWorkItemId: third.id },
      ],
    });
    const eventsBeforeReplay = localState.query({
      type: "LIST_EVENTS",
      aggregateId: second.id,
    });
    expect(localState.execute(setSecond)).toMatchObject({ replayed: true, workItemVersion: 2 });
    expect(localState.query({ type: "LIST_EVENTS", aggregateId: second.id })).toEqual(eventsBeforeReplay);

    localState.close();
    state = undefined;
    const reopened = await open();
    expect(
      reopened.query({ type: "LIST_WORK_ITEM_DEPENDENCIES", projectId: "project-recurkit" }),
    ).toMatchObject({
      dependencies: [
        { blockerWorkItemId: first.id, blockedWorkItemId: second.id },
        { blockerWorkItemId: second.id, blockedWorkItemId: third.id },
      ],
    });
    expect(reopened.execute(setSecond)).toMatchObject({ replayed: true, workItemVersion: 2 });
    expect(() =>
      reopened.execute({
        ...setSecond,
        payload: { ...setSecond.payload, blockerWorkItemIds: [] },
      }),
    ).toThrow(StateStoreError);
  });

  it("rejects cycles, missing and foreign blockers without partial graph changes", async () => {
    const localState = await open();
    registerProject("project-a", "register-a");
    registerProject("project-b", "register-b");
    const first = create("project-a", "a");
    const second = create("project-a", "b");
    const third = create("project-a", "c");
    const foreign = create("project-b", "foreign");
    localState.execute(setDependencies(second, [first.id], "set-a-b"));
    const thirdSet = localState.execute(setDependencies(third, [second.id], "set-b-c"));
    if (thirdSet.type !== "WORK_ITEM_DEPENDENCIES_SET") throw new Error("Expected dependency set");

    expect(() => localState.execute(setDependencies(first, [third.id], "set-cycle"))).toThrow(
      expect.objectContaining({ code: "DEPENDENCY_CYCLE" }),
    );
    expect(() => localState.execute(setDependencies(first, ["work-item-missing"], "set-missing"))).toThrow(
      expect.objectContaining({ code: "DEPENDENCY_WORK_ITEM_NOT_FOUND" }),
    );
    expect(() => localState.execute(setDependencies(first, [foreign.id], "set-foreign"))).toThrow(
      expect.objectContaining({ code: "DEPENDENCY_PROJECT_MISMATCH" }),
    );
    expect(() => localState.execute(setDependencies(first, [second.id, second.id], "set-duplicate"))).toThrow(
      expect.objectContaining({ code: "DEPENDENCY_DUPLICATE" }),
    );

    const graph = localState.query({ type: "LIST_WORK_ITEM_DEPENDENCIES", projectId: "project-a" });
    expect(graph.type === "WORK_ITEM_DEPENDENCIES" ? graph.dependencies : []).toHaveLength(2);
  });

  it("serializes opposing graph mutations from separate connections so only one can commit", async () => {
    const firstConnection = await open();
    registerProject("project-concurrent", "register-concurrent");
    const first = create("project-concurrent", "concurrent-a");
    const second = create("project-concurrent", "concurrent-b");
    const secondConnection = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-dependency-secondary-${(nextId += 1).toString()}`,
    });

    try {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() =>
          firstConnection.execute(setDependencies(second, [first.id], "concurrent-a-blocks-b")),
        ),
        Promise.resolve().then(() =>
          secondConnection.execute(setDependencies(first, [second.id], "concurrent-b-blocks-a")),
        ),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejection = outcomes.find(({ status }) => status === "rejected");
      expect(rejection?.status).toBe("rejected");
      if (rejection?.status !== "rejected") throw new Error("Expected one rejected dependency mutation");
      const rejectionReason: unknown = rejection.reason;
      expect(rejectionReason).toMatchObject({ code: "DEPENDENCY_CYCLE" });
      const graph = firstConnection.query({
        type: "LIST_WORK_ITEM_DEPENDENCIES",
        projectId: "project-concurrent",
      });
      expect(graph.type === "WORK_ITEM_DEPENDENCIES" ? graph.dependencies : []).toHaveLength(1);
    } finally {
      secondConnection.close();
    }
  });

  it("rechecks current blocker states inside START_PIPELINE", async () => {
    const localState = await open();
    registerProject("project-start", "register-start");
    const blocker = create("project-start", "blocker");
    const blocked = create("project-start", "blocked");
    const set = localState.execute(setDependencies(blocked, [blocker.id], "set-start-blocker"));
    if (set.type !== "WORK_ITEM_DEPENDENCIES_SET") throw new Error("Expected dependency set");
    const move: MoveWorkItemCommand = {
      schemaVersion: 1,
      commandId: "move-blocked-ready",
      correlationId: "correlation-move-blocked-ready",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: blocked.id, expectedVersion: set.workItemVersion, targetState: "READY" },
    };
    const moved = localState.execute(move);
    if (moved.type !== "WORK_ITEM_MOVED") throw new Error("Expected WorkItem move");
    const start = (commandId: string): StartPipelineCommand => ({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_PIPELINE",
      payload: {
        workItemId: blocked.id,
        expectedVersion: moved.workItem.version,
        template,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5] },
      },
    });
    expect(() => localState.execute(start("start-too-early"))).toThrow(
      expect.objectContaining({ code: "WORKFLOW_DEPENDENCIES_BLOCKED", details: { count: 1 } }),
    );

    localState.close();
    state = undefined;
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE work_items SET state = 'DONE' WHERE id = ?").run(blocker.id);
    raw.close();
    const reopened = await open();
    expect(reopened.execute(start("start-after-done"))).toMatchObject({ type: "PIPELINE_STARTED" });
  });
});
