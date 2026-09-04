import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAllowanceSnapshot } from "@loomrail/contracts";
import { ProviderAllowanceDomainError } from "@loomrail/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, StateStoreError, type LocalState } from "../src/index.js";

describe("durable provider allowance", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let clock = new Date("2026-09-04T20:00:00.000Z");
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail provider allowance тест "));
    databasePath = join(directory, "state.sqlite");
    clock = new Date("2026-09-04T20:00:00.000Z");
    nextId = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    const localState = await openLocalState({
      databasePath,
      now: () => new Date(clock),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    state = localState;
    return localState;
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
        name: "Allowance project",
        repositoryPath: join(directory, "repository"),
      },
    });
  };

  const snapshot = (observedAt: string, remainingPercent: number): ProviderAllowanceSnapshot => ({
    schemaVersion: 1,
    provider: "CODEX",
    observedAt,
    freshness: "LIVE",
    buckets: [
      {
        id: "codex:primary",
        name: "Codex",
        kind: "PRIMARY",
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        windowDurationMins: 300,
        resetsAt: "2026-09-05T00:00:00.000Z",
        limitReached: remainingPercent === 0,
      },
    ],
    unavailableReason: null,
  });

  const record = (localState: LocalState, commandId: string, value: ProviderAllowanceSnapshot) =>
    localState.execute({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "provider-allowance" },
      type: "RECORD_PROVIDER_ALLOWANCE",
      payload: { projectId: "project-1", snapshot: value },
    });

  it("commits the normalized snapshot, Event and idempotency receipt together across restart", async () => {
    const first = await open();
    register(first);
    const value = snapshot("2026-09-04T19:59:00.000Z", 75);
    const result = record(first, "allowance-1", value);
    expect(result).toMatchObject({
      type: "PROVIDER_ALLOWANCE_RECORDED",
      replayed: false,
      snapshot: { provider: "CODEX", buckets: [{ remainingPercent: 75 }] },
      event: { type: "PROVIDER_ALLOWANCE_RECORDED", actor: { type: "SYSTEM" } },
    });
    expect(record(first, "allowance-1", value)).toMatchObject({ replayed: true });
    first.close();
    state = undefined;

    const reopened = await open();
    const saved = reopened.query({ type: "GET_PROVIDER_ALLOWANCES", projectId: "project-1" });
    expect(saved).toEqual({ type: "PROVIDER_ALLOWANCES", snapshots: [value] });
    const events = reopened.query({ type: "LIST_EVENTS", projectId: "project-1" });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_REGISTERED",
      "PROVIDER_ALLOWANCE_RECORDED",
    ]);
  });

  it("rejects stale ordering without changing the snapshot or appending an Event", async () => {
    const localState = await open();
    register(localState);
    const latest = snapshot("2026-09-04T19:59:00.000Z", 70);
    record(localState, "allowance-latest", latest);
    expect(() => record(localState, "allowance-stale", snapshot("2026-09-04T19:58:00.000Z", 10))).toThrow(
      expect.objectContaining({ code: "PROVIDER_ALLOWANCE_STALE" }),
    );
    expect(localState.query({ type: "GET_PROVIDER_ALLOWANCES", projectId: "project-1" })).toEqual({
      type: "PROVIDER_ALLOWANCES",
      snapshots: [latest],
    });
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-1" });
    expect(events.type === "EVENTS" ? events.events : []).toHaveLength(2);
  });

  it("rolls back the snapshot, Event and receipt when the transaction fails after the row write", async () => {
    const localState = await openLocalState({
      databasePath,
      now: () => new Date(clock),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
      onProviderAllowanceSnapshotPersisted: () => {
        throw new Error("injected provider allowance transaction failure");
      },
    });
    state = localState;
    register(localState);
    const value = snapshot("2026-09-04T19:59:00.000Z", 75);
    let failure: unknown;
    try {
      record(localState, "allowance-rollback", value);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StateStoreError);
    if (!(failure instanceof StateStoreError)) throw new Error("Expected a typed persistence failure");
    expect(failure.code).toBe("PERSISTENCE_FAILURE");
    expect(failure.cause).toBeInstanceOf(Error);
    expect(failure.cause).toMatchObject({ message: "injected provider allowance transaction failure" });
    expect(localState.query({ type: "GET_PROVIDER_ALLOWANCES", projectId: "project-1" })).toEqual({
      type: "PROVIDER_ALLOWANCES",
      snapshots: [],
    });
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-1" });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_REGISTERED",
    ]);

    localState.close();
    state = undefined;
    const reopened = await open();
    expect(reopened.query({ type: "GET_PROVIDER_ALLOWANCES", projectId: "project-1" })).toEqual({
      type: "PROVIDER_ALLOWANCES",
      snapshots: [],
    });
    expect(() => record(reopened, "allowance-rollback", value)).not.toThrow();
  });

  it("rejects human-authored telemetry and never stores raw provider data", async () => {
    const localState = await open();
    register(localState);
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "forged-allowance",
        correlationId: "correlation-forged",
        actor: { type: "HUMAN", id: "owner" },
        type: "RECORD_PROVIDER_ALLOWANCE",
        payload: { projectId: "project-1", snapshot: snapshot("2026-09-04T19:59:00.000Z", 75) },
      }),
    ).toThrow(ProviderAllowanceDomainError);
    localState.close();
    state = undefined;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const serialized = JSON.stringify(database.prepare("SELECT * FROM provider_allowance_snapshots").all());
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("transcript");
    database.close();
  });
});
