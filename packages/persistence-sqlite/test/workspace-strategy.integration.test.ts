import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceStrategyDomainError } from "@loomrail/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

describe("Project Workspace Strategy local state", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail workspace strategy "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date("2026-09-06T10:00:00.000Z"),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const register = (localState: LocalState): void => {
    localState.execute({
      schemaVersion: 1,
      commandId: "register-project",
      correlationId: "correlation-register",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-one",
        fixtureId: null,
        name: "Project one",
        repositoryPath: join(directory, "project-one"),
      },
    });
  };

  const setShared = (localState: LocalState) =>
    localState.execute({
      schemaVersion: 1,
      commandId: "set-workspace-strategy",
      correlationId: "correlation-workspace-strategy",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "SET_PROJECT_WORKSPACE_STRATEGY",
      payload: {
        projectId: "project-one",
        expectedProjectVersion: 1,
        strategy: "SHARED_CURRENT_DIRECTORY",
      },
    });

  it("derives isolated by default, then persists selection, Event and replay across restart", async () => {
    const first = await open();
    register(first);

    const initial = first.query({ type: "GET_PROJECT_WORKSPACE_STRATEGY", projectId: "project-one" });
    expect(initial).toMatchObject({
      type: "PROJECT_WORKSPACE_STRATEGY",
      selection: { strategy: "ISOLATED_WORKTREE", projectVersion: 1 },
    });

    const changed = setShared(first);
    const replayed = setShared(first);
    expect(changed).toMatchObject({
      type: "PROJECT_WORKSPACE_STRATEGY_CHANGED",
      selection: { strategy: "SHARED_CURRENT_DIRECTORY", projectVersion: 2 },
    });
    expect(replayed).toMatchObject({ type: "PROJECT_WORKSPACE_STRATEGY_CHANGED", replayed: true });
    first.close();
    state = undefined;

    const reopened = await open();
    expect(
      reopened.query({ type: "GET_PROJECT_WORKSPACE_STRATEGY", projectId: "project-one" }),
    ).toMatchObject({
      type: "PROJECT_WORKSPACE_STRATEGY",
      selection: { strategy: "SHARED_CURRENT_DIRECTORY", projectVersion: 2 },
    });
    expect(reopened.query({ type: "GET_PROJECT", projectId: "project-one" })).toMatchObject({
      type: "PROJECT",
      project: { version: 2 },
    });
    const events = reopened.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_REGISTERED",
      "PROJECT_WORKSPACE_STRATEGY_CHANGED",
    ]);
  });

  it("rolls back stale and no-op changes", async () => {
    const localState = await open();
    register(localState);
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "no-op",
        correlationId: "correlation-no-op",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "SET_PROJECT_WORKSPACE_STRATEGY",
        payload: {
          projectId: "project-one",
          expectedProjectVersion: 1,
          strategy: "ISOLATED_WORKTREE",
        },
      }),
    ).toThrow(WorkspaceStrategyDomainError);
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "stale",
        correlationId: "correlation-stale",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "SET_PROJECT_WORKSPACE_STRATEGY",
        payload: {
          projectId: "project-one",
          expectedProjectVersion: 9,
          strategy: "SHARED_CURRENT_DIRECTORY",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "PROJECT_VERSION_CONFLICT" }));
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(1);
  });
});
