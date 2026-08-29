import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateWorkItemCommand, EventSignal, WorkItem } from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { broadcastingState } from "../src/broadcasting-state.js";

import { silentLogger } from "./silent-logger.js";

const timestamp = "2026-08-22T18:00:00.000Z";

// Directories created by `tempDatabasePath`, removed after every test so a run does not leak
// files into the OS temp directory.
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

// A path for a SQLite database that does not exist yet -- the caller decides whether to open it
// once (most tests) or open it, close it, and reopen it at the same path (the history-replay test).
const tempDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "loomrail-broadcasting-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
};

// Opens a fresh LocalState. A deterministic clock and id sequence keep the tests independent of
// wall-clock time and of call order between tests.
const openTemp = async (databasePath?: string): Promise<LocalState> => {
  let nextId = 0;
  return openLocalState({
    databasePath: databasePath ?? ":memory:",
    now: () => new Date(timestamp),
    createId: (kind) => `${kind}-${randomUUID()}-${(nextId += 1).toString()}`,
  });
};

const registerProject = (state: LocalState): { id: string } => {
  const commandId = `register-project-${randomUUID()}`;
  const result = state.execute({
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "REGISTER_PROJECT",
    payload: {
      id: `project-${randomUUID()}`,
      fixtureId: "web-app-a",
      name: "Web fixture",
      repositoryPath: "/tmp/loomrail-fixture",
    },
  });
  if (result.type !== "PROJECT_REGISTERED") throw new Error("Expected the project to be registered");
  return { id: result.project.id };
};

// Builds a CREATE_WORK_ITEM command without executing it, so a caller can execute the exact same
// command object twice to exercise the idempotent-replay path.
const createWorkItemCommand = (projectId: string, title: string): CreateWorkItemCommand => {
  const commandId = `create-work-item-${randomUUID()}`;
  return {
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "CREATE_WORK_ITEM",
    payload: {
      projectId,
      parentId: null,
      type: "TASK",
      title,
      description: "",
      priority: "MEDIUM",
      risk: "MEDIUM",
      acceptanceCriteria: ["Acceptance criterion"],
    },
  };
};

const createWorkItem = (state: LocalState, projectId: string, title: string): { id: string } => {
  const result = state.execute(createWorkItemCommand(projectId, title));
  if (result.type !== "WORK_ITEM_CREATED") throw new Error("Expected the WorkItem to be created");
  return { id: result.workItem.id };
};

const readWorkItem = (state: LocalState, workItemId: string): WorkItem => {
  const result = state.query({ type: "GET_WORK_ITEM", workItemId });
  if (result.type !== "WORK_ITEM" || result.workItem === null) {
    throw new Error("Expected the WorkItem to exist");
  }
  return result.workItem;
};

describe("broadcastingState", () => {
  it("publishes one signal per committed event, carrying its scope", async () => {
    const published: EventSignal[] = [];
    const state = broadcastingState(await openTemp(), (signal) => published.push(signal), silentLogger);
    const project = registerProject(state);
    published.length = 0;

    const created = createWorkItem(state, project.id, "Ship the billing page");

    expect(published).toEqual([
      { projectId: project.id, aggregateType: "WORK_ITEM", aggregateId: created.id },
    ]);
  });

  it("publishes nothing when the command was rolled back", async () => {
    const published: EventSignal[] = [];
    const state = broadcastingState(await openTemp(), (signal) => published.push(signal), silentLogger);
    const project = registerProject(state);
    published.length = 0;

    // An empty title fails `titleSchema`'s `min(1)` during `stateCommandSchema.parse`, before the
    // transaction opens: nothing is committed, so this is "rolled back" in the strongest sense --
    // there was never anything to roll back.
    expect(() => createWorkItem(state, project.id, "")).toThrow();

    expect(published).toEqual([]);
  });

  // The replay path writes no new event, so the cursor must not move and nothing must be published.
  // A cumulative "read everything since the last publish" implementation passes the first test and
  // fails this one.
  it("publishes nothing for an idempotent replay of the same command", async () => {
    const published: EventSignal[] = [];
    const state = broadcastingState(await openTemp(), (signal) => published.push(signal), silentLogger);
    const project = registerProject(state);
    const command = createWorkItemCommand(project.id, "Ship the billing page");
    state.execute(command);
    published.length = 0;

    state.execute(command);

    expect(published).toEqual([]);
  });

  // Without seeding lastSequence from the table, opening a database with history would broadcast the
  // entire history on the first command -- invisible on the empty databases every other test uses.
  it("does not replay existing history when it wraps a database that already has some", async () => {
    const databasePath = await tempDatabasePath();
    const seeded = await openTemp(databasePath);
    const project = registerProject(seeded);
    createWorkItem(seeded, project.id, "Older work");
    seeded.close();

    const published: EventSignal[] = [];
    const state = broadcastingState(
      await openTemp(databasePath),
      (signal) => published.push(signal),
      silentLogger,
    );
    try {
      const created = createWorkItem(state, project.id, "Newer work");

      expect(published).toEqual([
        { projectId: project.id, aggregateType: "WORK_ITEM", aggregateId: created.id },
      ]);
    } finally {
      // Windows does not allow the afterEach cleanup to unlink an open SQLite database.
      state.close();
    }
  });

  // ADR-0002: a publication failure does not roll the state back. A throw from the channel must not
  // become a failed command for the owner.
  it("keeps the command applied when publication throws", async () => {
    const state = broadcastingState(
      await openTemp(),
      () => {
        throw new Error("channel is gone");
      },
      silentLogger,
    );
    const project = registerProject(state);

    const created = createWorkItem(state, project.id, "Ship the billing page");

    expect(readWorkItem(state, created.id).title).toBe("Ship the billing page");
  });
});
