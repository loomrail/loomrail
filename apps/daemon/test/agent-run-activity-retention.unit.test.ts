import type { LocalState, StateQuery, StateQueryResult } from "@loomrail/persistence-sqlite";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { cleanupExpiredAgentRunActivity } from "../src/agent-run-activity-retention.js";

// Task 13: this suite fakes LocalState the same way browser-qa-retention.unit.test.ts and
// verification-output-retention.unit.test.ts do -- it exists to prove apps/daemon's orchestration
// (the closedBefore arithmetic, the batch loop, the startup cap, the summary), not the SQL itself,
// which packages/persistence-sqlite/test/agent-run-activity-retention.integration.test.ts already
// covers against a real database. `execute`'s `command` parameter is deliberately left untyped here,
// exactly like those two precedents -- it is inferred from the `LocalState` type these object
// literals are assigned to, rather than imported and annotated by hand (StateCommand is not part of
// @loomrail/persistence-sqlite's public surface; only LocalState, StateQuery and StateQueryResult
// are).

const now = new Date("2026-09-05T12:00:00.000Z");

describe("daemon agent run activity retention", () => {
  it("derives closedBefore as exactly 30 days before `now` and stops once a page comes back short", async () => {
    let seenClosedBefore = "";
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type !== "LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES") {
          throw new Error(`Unexpected query ${query.type}`);
        }
        seenClosedBefore = query.closedBefore;
        return { type: "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES", entryIds: ["activity-1", "activity-2"] };
      },
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        expect(command.payload.closedBefore).toBe(seenClosedBefore);
        expect(command.actor).toEqual({ type: "SYSTEM", id: "local-daemon" });
        return {
          schemaVersion: 1,
          type: "AGENT_RUN_ACTIVITY_RETENTION_APPLIED",
          replayed: false,
          entriesDeleted: 2,
          stateRowsDeleted: 1,
        };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    expect(cleanupExpiredAgentRunActivity({ state, now, logger: app.log })).toEqual({
      selected: 2,
      entriesDeleted: 2,
      stateRowsDeleted: 1,
    });
    expect(seenClosedBefore).toBe("2026-08-06T12:00:00.000Z");
    await app.close();
  });

  it("does not call execute at all once the LIST query finds nothing left to sweep", async () => {
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type !== "LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES") {
          throw new Error(`Unexpected query ${query.type}`);
        }
        return { type: "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES", entryIds: [] };
      },
      execute: () => {
        throw new Error("Nothing was selected -- the sweep must not write an empty-effect command");
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    expect(cleanupExpiredAgentRunActivity({ state, now, logger: app.log })).toEqual({
      selected: 0,
      entriesDeleted: 0,
      stateRowsDeleted: 0,
    });
    await app.close();
  });

  // Proves the batch cap actually bounds the work: a backlog far larger than any single batch --
  // every page comes back full, so on its own the loop would run forever -- but the startup cap
  // stops it at a fixed, small number of calls instead of stalling startup indefinitely.
  it("stops after the startup batch cap even when every page comes back full", async () => {
    let calls = 0;
    let observedLimit = 0;
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type !== "LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES") {
          throw new Error(`Unexpected query ${query.type}`);
        }
        // Every page is exactly `limit` long, so entryIds.length < limit never fires: only the
        // startup cap can end this loop.
        observedLimit = query.limit ?? 0;
        return {
          type: "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES",
          entryIds: Array.from({ length: observedLimit }, (_, index) => `activity-${index.toString()}`),
        };
      },
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        calls += 1;
        return {
          schemaVersion: 1,
          type: "AGENT_RUN_ACTIVITY_RETENTION_APPLIED",
          replayed: false,
          entriesDeleted: command.payload.limit,
          stateRowsDeleted: 0,
        };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    const summary = cleanupExpiredAgentRunActivity({ state, now, logger: app.log });
    // The batch cap (20) and the per-batch size (1,000) are apps/daemon's own internal constants,
    // not part of the public contract -- this asserts the OBSERVABLE consequence (a small, fixed
    // number of execute calls despite an inexhaustible backlog), not the constants themselves, so
    // the test does not need to import or duplicate them to stay meaningful.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(20);
    expect(observedLimit).toBeGreaterThan(0);
    expect(summary.entriesDeleted).toBe(calls * observedLimit);
    expect(summary.selected).toBe(summary.entriesDeleted);
    await app.close();
  });

  it("does not log a completion summary when nothing was selected", async () => {
    const infoMessages: unknown[] = [];
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: (): StateQueryResult => ({ type: "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES", entryIds: [] }),
      execute: () => {
        throw new Error("Nothing to sweep -- execute must not be called");
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });
    const originalInfo = app.log.info.bind(app.log);
    app.log.info = (...args: Parameters<typeof originalInfo>) => {
      infoMessages.push(args);
      originalInfo(...args);
    };

    cleanupExpiredAgentRunActivity({ state, now, logger: app.log });
    expect(infoMessages).toHaveLength(0);
    await app.close();
  });

  it("logs a completion summary with the observed counts once something was deleted", async () => {
    const infoMessages: unknown[] = [];
    let served = false;
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: (): StateQueryResult => {
        if (served) return { type: "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES", entryIds: [] };
        served = true;
        return { type: "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES", entryIds: ["activity-1"] };
      },
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        return {
          schemaVersion: 1,
          type: "AGENT_RUN_ACTIVITY_RETENTION_APPLIED",
          replayed: false,
          entriesDeleted: 1,
          stateRowsDeleted: 1,
        };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });
    const originalInfo = app.log.info.bind(app.log);
    app.log.info = (...args: Parameters<typeof originalInfo>) => {
      infoMessages.push(args);
      originalInfo(...args);
    };

    expect(cleanupExpiredAgentRunActivity({ state, now, logger: app.log })).toEqual({
      selected: 1,
      entriesDeleted: 1,
      stateRowsDeleted: 1,
    });
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0]).toMatchObject([
      { selected: 1, entriesDeleted: 1, stateRowsDeleted: 1 },
      "Agent run activity retention cleanup completed",
    ]);
    await app.close();
  });
});
