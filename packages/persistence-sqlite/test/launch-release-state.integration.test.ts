import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

const now = "2026-09-10T12:00:00.000Z";
const tree = "b".repeat(40);

describe("durable launch release evidence", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail release state тест "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(now),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const register = (localState: LocalState): void => {
    localState.execute({
      schemaVersion: 1,
      commandId: "register-project",
      correlationId: "correlation-register",
      actor: { type: "HUMAN", id: "owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-1",
        fixtureId: null,
        name: "Recurkit",
        repositoryPath: join(directory, "Репозиторий with spaces"),
      },
    });
  };

  const saveEnvironment = (localState: LocalState) =>
    localState.execute({
      schemaVersion: 1,
      commandId: "save-environment",
      correlationId: "correlation-save-environment",
      actor: { type: "HUMAN", id: "owner" },
      type: "SAVE_LAUNCH_ENVIRONMENT",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 1,
        environmentId: null,
        expectedEnvironmentVersion: null,
        configuration: {
          kind: "PREVIEW",
          name: "Рекуркит Preview",
          presetId: "WEB_APP_V1",
          presetRevision: 1,
          publicBaseUrl: "https://preview.example.test",
          healthPath: "/api/health",
          requiredEnvironmentVariables: ["DATABASE_URL", "AUTH_SECRET"],
        },
      },
    });

  it("commits Environment and immutable Release with Events and replay receipts", async () => {
    const localState = await open();
    register(localState);
    const changed = saveEnvironment(localState);
    expect(changed).toMatchObject({
      type: "LAUNCH_ENVIRONMENT_CHANGED",
      replayed: false,
      projectVersion: 2,
      environment: { projectId: "project-1", kind: "PREVIEW", version: 1 },
    });
    if (changed.type !== "LAUNCH_ENVIRONMENT_CHANGED") throw new Error("Expected Environment result");

    const command = {
      schemaVersion: 1 as const,
      commandId: "create-release",
      correlationId: "correlation-create-release",
      actor: { type: "HUMAN" as const, id: "owner" },
      type: "CREATE_LAUNCH_RELEASE" as const,
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 2,
        environmentId: changed.environment.id,
        expectedEnvironmentVersion: changed.environment.version,
        expectedEnvironmentContentHash: changed.environment.contentHash,
        sourceTree: tree,
        sourceHead: null,
        sourceHeadTree: null,
        workItemIds: [],
      },
    };
    const created = localState.execute(command);
    expect(created).toMatchObject({
      type: "LAUNCH_RELEASE_CREATED",
      replayed: false,
      projectVersion: 3,
      release: { projectId: "project-1", sourceTree: tree, requiredGateCount: 24 },
    });
    expect(localState.execute(command)).toMatchObject({
      type: "LAUNCH_RELEASE_CREATED",
      replayed: true,
      release: { id: created.type === "LAUNCH_RELEASE_CREATED" ? created.release.id : "missing" },
    });
    expect(localState.query({ type: "GET_PROJECT_LAUNCH_RELEASE", projectId: "project-1" })).toMatchObject({
      type: "PROJECT_LAUNCH_RELEASE",
      project: { version: 3 },
      environments: [{ id: changed.environment.id }],
      latestRelease: { id: created.type === "LAUNCH_RELEASE_CREATED" ? created.release.id : "missing" },
    });
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-1" });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_REGISTERED",
      "LAUNCH_ENVIRONMENT_CHANGED",
      "LAUNCH_RELEASE_CREATED",
    ]);
  });

  it("reads identical evidence after restart and SQLite refuses Release mutation", async () => {
    const localState = await open();
    register(localState);
    const environment = saveEnvironment(localState);
    if (environment.type !== "LAUNCH_ENVIRONMENT_CHANGED") throw new Error("Expected Environment result");
    const created = localState.execute({
      schemaVersion: 1,
      commandId: "create-release-restart",
      correlationId: "correlation-create-release-restart",
      actor: { type: "HUMAN", id: "owner" },
      type: "CREATE_LAUNCH_RELEASE",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 2,
        environmentId: environment.environment.id,
        expectedEnvironmentVersion: 1,
        expectedEnvironmentContentHash: environment.environment.contentHash,
        sourceTree: tree,
        sourceHead: null,
        sourceHeadTree: null,
        workItemIds: [],
      },
    });
    if (created.type !== "LAUNCH_RELEASE_CREATED") throw new Error("Expected Release result");
    const expected = created.release;
    localState.close();
    state = undefined;
    const reopened = await open();
    expect(reopened.query({ type: "GET_LAUNCH_RELEASE", releaseId: expected.id })).toEqual({
      type: "LAUNCH_RELEASE",
      release: expected,
    });
    reopened.close();
    state = undefined;

    const database = new DatabaseSync(databasePath);
    expect(() =>
      database.prepare("UPDATE launch_releases SET created_at = ? WHERE id = ?").run(now, expected.id),
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM launch_releases WHERE id = ?").run(expected.id)).toThrow(
      /cannot be deleted/u,
    );
    database.close();
  });

  it("refuses duplicate kind, stale update and provider-authored mutation", async () => {
    const localState = await open();
    register(localState);
    const environment = saveEnvironment(localState);
    if (environment.type !== "LAUNCH_ENVIRONMENT_CHANGED") throw new Error("Expected Environment result");

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "duplicate-preview",
        correlationId: "correlation-duplicate-preview",
        actor: { type: "HUMAN", id: "owner" },
        type: "SAVE_LAUNCH_ENVIRONMENT",
        payload: {
          projectId: "project-1",
          expectedProjectVersion: 2,
          environmentId: null,
          expectedEnvironmentVersion: null,
          configuration: {
            kind: "PREVIEW",
            name: "Second preview",
            presetId: "WEB_APP_V1",
            presetRevision: 1,
            publicBaseUrl: "https://other.example.test",
            healthPath: "/health",
            requiredEnvironmentVariables: [],
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "ENVIRONMENT_KIND_CONFLICT" }));

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "provider-release",
        correlationId: "correlation-provider-release",
        actor: { type: "SYSTEM", id: "provider" },
        type: "CREATE_LAUNCH_RELEASE",
        payload: {
          projectId: "project-1",
          expectedProjectVersion: 2,
          environmentId: environment.environment.id,
          expectedEnvironmentVersion: 1,
          expectedEnvironmentContentHash: environment.environment.contentHash,
          sourceTree: tree,
          sourceHead: null,
          sourceHeadTree: null,
          workItemIds: [],
        },
      }),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
  });
});
