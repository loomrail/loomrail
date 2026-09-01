import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RequestProjectScaffoldCommand, ScaffoldProposal } from "@loomrail/contracts";
import { ScaffoldDomainError } from "@loomrail/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

describe("Project Scaffold local state", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail scaffold state "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date("2026-09-01T09:00:00.000Z"),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const proposal = (): ScaffoldProposal => ({
    schemaVersion: 1,
    recipeId: "typescript-node",
    recipeVersion: 1,
    targetPath: join(directory, "new-project"),
    projectName: "new-project",
    packageName: "new-project",
    files: [{ path: "README.md", bytes: 10, contentDigest: "a".repeat(64) }],
    systemFiles: [".loomrail/scaffold.json"],
    proposalDigest: "b".repeat(64),
  });

  const request = (commandId = "request-scaffold"): RequestProjectScaffoldCommand => ({
    schemaVersion: 1,
    commandId,
    correlationId: "correlation-scaffold",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "REQUEST_PROJECT_SCAFFOLD",
    payload: { proposal: proposal() },
  });

  it("stores the provisioning Project, operation, Event and replay receipt atomically", async () => {
    const localState = await open();
    const created = localState.execute(request());
    const replayed = localState.execute(request());
    if (created.type !== "PROJECT_SCAFFOLD_REQUESTED") throw new Error("Expected scaffold request");

    expect(created).toMatchObject({
      replayed: false,
      operation: { status: "PENDING", attempts: 0, version: 1 },
      event: { type: "PROJECT_SCAFFOLD_REQUESTED" },
    });
    expect(replayed).toMatchObject({ type: "PROJECT_SCAFFOLD_REQUESTED", replayed: true });
    expect(localState.query({ type: "LIST_PROJECTS" })).toEqual({ type: "PROJECTS", projects: [] });
    const project = localState.query({ type: "GET_PROJECT", projectId: created.operation.projectId });
    expect(project.type === "PROJECT" ? project.project : null).toMatchObject({
      status: "PROVISIONING",
      repositoryPath: proposal().targetPath,
    });
    expect(localState.query({ type: "LIST_PENDING_SCAFFOLD_OPERATIONS" })).toMatchObject({
      type: "SCAFFOLD_OPERATIONS",
      operations: [{ id: created.operation.id, status: "PENDING" }],
    });

    localState.close();
    state = undefined;
    const reopened = await open();
    expect(
      reopened.query({ type: "GET_SCAFFOLD_OPERATION", operationId: created.operation.id }),
    ).toMatchObject({
      type: "SCAFFOLD_OPERATION",
      operation: { status: "PENDING", proposal: { proposalDigest: proposal().proposalDigest } },
    });
  });

  it("activates the Project and completes the operation in one command", async () => {
    const localState = await open();
    const created = localState.execute(request());
    if (created.type !== "PROJECT_SCAFFOLD_REQUESTED") throw new Error("Expected scaffold request");

    const completed = localState.execute({
      schemaVersion: 1,
      commandId: "complete-scaffold",
      correlationId: "correlation-complete",
      actor: { type: "SYSTEM", id: "scaffold-publisher" },
      type: "COMPLETE_PROJECT_SCAFFOLD",
      payload: { operationId: created.operation.id, expectedVersion: 1 },
    });

    expect(completed).toMatchObject({
      type: "PROJECT_SCAFFOLD_COMPLETED",
      operation: { status: "COMPLETED", attempts: 1, version: 2 },
    });
    const listed = localState.query({ type: "LIST_PROJECTS" });
    expect(listed.type === "PROJECTS" ? listed.projects : []).toEqual([
      expect.objectContaining({ id: created.operation.projectId, status: "ACTIVE", version: 2 }),
    ]);
    expect(localState.query({ type: "LIST_PENDING_SCAFFOLD_OPERATIONS" })).toEqual({
      type: "SCAFFOLD_OPERATIONS",
      operations: [],
    });
    const events = localState.query({ type: "LIST_EVENTS", projectId: created.operation.projectId });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_SCAFFOLD_REQUESTED",
      "PROJECT_SCAFFOLD_COMPLETED",
    ]);
  });

  it("records a failed attempt and permits only an explicit versioned retry", async () => {
    const localState = await open();
    const created = localState.execute(request());
    if (created.type !== "PROJECT_SCAFFOLD_REQUESTED") throw new Error("Expected scaffold request");
    const failed = localState.execute({
      schemaVersion: 1,
      commandId: "fail-scaffold",
      correlationId: "correlation-fail",
      actor: { type: "SYSTEM", id: "scaffold-publisher" },
      type: "FAIL_PROJECT_SCAFFOLD",
      payload: {
        operationId: created.operation.id,
        expectedVersion: 1,
        errorCode: "TARGET_CONFLICT",
      },
    });
    expect(failed).toMatchObject({
      type: "PROJECT_SCAFFOLD_FAILED",
      operation: { status: "FAILED", attempts: 1, version: 2, lastErrorCode: "TARGET_CONFLICT" },
    });
    expect(localState.query({ type: "LIST_PENDING_SCAFFOLD_OPERATIONS" })).toMatchObject({ operations: [] });
    expect(localState.query({ type: "LIST_OPEN_SCAFFOLD_OPERATIONS" })).toMatchObject({
      operations: [{ id: created.operation.id, status: "FAILED" }],
    });

    const retried = localState.execute({
      schemaVersion: 1,
      commandId: "retry-scaffold",
      correlationId: "correlation-retry",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RETRY_PROJECT_SCAFFOLD",
      payload: { operationId: created.operation.id, expectedVersion: 2 },
    });
    expect(retried).toMatchObject({
      type: "PROJECT_SCAFFOLD_RETRIED",
      operation: { status: "PENDING", attempts: 1, version: 3, lastErrorCode: null },
    });
    expect(localState.query({ type: "LIST_OPEN_SCAFFOLD_OPERATIONS" })).toMatchObject({
      operations: [{ id: created.operation.id, status: "PENDING" }],
    });
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "stale-retry",
        correlationId: "correlation-stale",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "RETRY_PROJECT_SCAFFOLD",
        payload: { operationId: created.operation.id, expectedVersion: 2 },
      }),
    ).toThrow(ScaffoldDomainError);
  });

  it("refuses a second Project for the same target without adding state or Event", async () => {
    const localState = await open();
    const created = localState.execute(request());
    if (created.type !== "PROJECT_SCAFFOLD_REQUESTED") throw new Error("Expected scaffold request");
    expect(() => localState.execute(request("request-scaffold-again"))).toThrow(
      expect.objectContaining({ code: "PROJECT_ALREADY_EXISTS" }),
    );
    const events = localState.query({ type: "LIST_EVENTS", projectId: created.operation.projectId });
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(1);
  });
});
