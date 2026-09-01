import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderSelectionDomainError } from "@loomrail/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

describe("Project Provider Preference local state", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail provider selection "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date("2026-08-31T01:00:00.000Z"),
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

  const setCodex = (localState: LocalState) =>
    localState.execute({
      schemaVersion: 1,
      commandId: "set-provider",
      correlationId: "correlation-provider",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "SET_PROJECT_PROVIDER_PREFERENCE",
      payload: { projectId: "project-one", expectedProjectVersion: 1, preference: "CODEX" },
    });

  it("stores Project, Event and replay receipt atomically and survives restart", async () => {
    const first = await open();
    register(first);
    const changed = setCodex(first);
    const replayed = setCodex(first);

    expect(changed).toMatchObject({
      type: "PROJECT_PROVIDER_PREFERENCE_CHANGED",
      selection: { preference: "CODEX", projectVersion: 2 },
    });
    expect(replayed).toMatchObject({ type: "PROJECT_PROVIDER_PREFERENCE_CHANGED", replayed: true });
    first.close();
    state = undefined;

    const reopened = await open();
    const project = reopened.query({ type: "GET_PROJECT", projectId: "project-one" });
    expect(project.type === "PROJECT" ? project.project : null).toMatchObject({
      providerPreference: "CODEX",
      version: 2,
    });
    const events = reopened.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_REGISTERED",
      "PROJECT_PROVIDER_PREFERENCE_CHANGED",
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
        type: "SET_PROJECT_PROVIDER_PREFERENCE",
        payload: { projectId: "project-one", expectedProjectVersion: 1, preference: "AUTO" },
      }),
    ).toThrow(ProviderSelectionDomainError);
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "stale",
        correlationId: "correlation-stale",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "SET_PROJECT_PROVIDER_PREFERENCE",
        payload: { projectId: "project-one", expectedProjectVersion: 9, preference: "CODEX" },
      }),
    ).toThrow(expect.objectContaining({ code: "PROJECT_VERSION_CONFLICT" }));
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(1);
  });
});
