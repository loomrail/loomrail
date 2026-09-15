import type { LocalState, StateQueryResult } from "@loomrail/persistence-sqlite";
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
// @loomrail/persistence-sqlite's public surface; only LocalState and StateQueryResult are).
//
// Every fake's `query` throws unconditionally (fix-round-3): cleanupExpiredAgentRunActivity no
// longer calls it at all -- the LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES round trip it used to make
// was dropped as vestigial, since its predicate duplicates the delete's own -- so a throwing stub
// both satisfies LocalState's required `query` field and stands as a regression guard: if this
// suite ever starts failing with "must not query", the vestigial call came back.
const queryMustNotBeCalled = (): StateQueryResult => {
  throw new Error("cleanupExpiredAgentRunActivity must not call state.query");
};

const now = new Date("2026-09-05T12:00:00.000Z");

describe("daemon agent run activity retention", () => {
  it("derives closedBefore as exactly 30 days before `now` and stops once a batch comes back short of a full page", async () => {
    let observedClosedBefore = "";
    let executeCalls = 0;
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: queryMustNotBeCalled,
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        executeCalls += 1;
        observedClosedBefore = command.payload.closedBefore;
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
      entriesDeleted: 2,
      stateRowsDeleted: 1,
    });
    expect(observedClosedBefore).toBe("2026-08-06T12:00:00.000Z");
    // Both sides came back short of a full page (2 of a possible 1,000 entries, 1 of a possible
    // 1,000 state rows), so this stops after the one call rather than re-scanning for more.
    expect(executeCalls).toBe(1);
    await app.close();
  });

  // fix-round-1, finding 2: DELETE_EXPIRED_AGENT_RUN_ACTIVITY also prunes an `agent_run_activity_state`
  // row for a closed, expired run that never recorded any entries (MARK_AGENT_RUN_ACTIVITY_DEGRADED
  // can create one with zero entries) -- a run the old entries LIST never surfaced, since it only
  // ever listed `agent_run_activity` rows. Calling the delete unconditionally every batch (fix-round-3
  // dropped the LIST entirely, so there is no page left to gate on) is what prunes that orphan even
  // when no other entries happen to be expired at the same time.
  it("prunes an orphaned state row even when no agent_run_activity entries are expired", async () => {
    let executeCalls = 0;
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: queryMustNotBeCalled,
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        executeCalls += 1;
        return {
          schemaVersion: 1,
          type: "AGENT_RUN_ACTIVITY_RETENTION_APPLIED",
          replayed: false,
          entriesDeleted: 0,
          stateRowsDeleted: 1,
        };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    expect(cleanupExpiredAgentRunActivity({ state, now, logger: app.log })).toEqual({
      entriesDeleted: 0,
      stateRowsDeleted: 1,
    });
    // Both sides came back short of a full page (0 entries, 1 of a possible 1,000 state rows), so
    // this stops after the one call that found the orphan rather than re-scanning for more.
    expect(executeCalls).toBe(1);
    await app.close();
  });

  // fix-round-1, finding 4: a batch that removes nothing on either side cannot make progress on a
  // later one either -- this is the ordinary steady state (a healthy database with nothing expired
  // at all) and must cost exactly one call, not up to twenty scans that all come back empty.
  it("stops after one call when a batch makes no progress on either side", async () => {
    let executeCalls = 0;
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: queryMustNotBeCalled,
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        executeCalls += 1;
        return {
          schemaVersion: 1,
          type: "AGENT_RUN_ACTIVITY_RETENTION_APPLIED",
          replayed: false,
          entriesDeleted: 0,
          stateRowsDeleted: 0,
        };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    expect(cleanupExpiredAgentRunActivity({ state, now, logger: app.log })).toEqual({
      entriesDeleted: 0,
      stateRowsDeleted: 0,
    });
    expect(executeCalls).toBe(1);
    await app.close();
  });

  // Proves the batch cap actually bounds the work: a backlog far larger than any single batch --
  // every batch comes back full, so on its own the loop would run forever -- but the startup cap
  // stops it at a fixed, small number of calls instead of stalling startup indefinitely.
  it("stops after the startup batch cap even when every batch comes back full", async () => {
    let calls = 0;
    let observedLimit = 0;
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: queryMustNotBeCalled,
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        calls += 1;
        observedLimit = command.payload.limit;
        // A full page on both sides, so entriesDeleted/stateRowsDeleted < limit never fires: only
        // the startup cap can end this loop.
        return {
          schemaVersion: 1,
          type: "AGENT_RUN_ACTIVITY_RETENTION_APPLIED",
          replayed: false,
          entriesDeleted: command.payload.limit,
          stateRowsDeleted: command.payload.limit,
        };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    const summary = cleanupExpiredAgentRunActivity({ state, now, logger: app.log });
    // fix-round-1, finding 3: an exact count, not just "some small bound" -- `toBeLessThanOrEqual`
    // alone passed unchanged when the reviewer shrank the batch-cap constant to 1, since 1 is also
    // "<= 20". Pinning the exact value (20, the constant's own current value) is what a twentyfold
    // shrink of the startup budget actually fails.
    expect(calls).toBe(20);
    expect(observedLimit).toBeGreaterThan(0);
    expect(summary.entriesDeleted).toBe(calls * observedLimit);
    expect(summary.stateRowsDeleted).toBe(calls * observedLimit);
    await app.close();
  });

  it("does not log a completion summary when a call makes no progress", async () => {
    const infoMessages: unknown[] = [];
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: queryMustNotBeCalled,
      execute: (command) => {
        if (command.type !== "DELETE_EXPIRED_AGENT_RUN_ACTIVITY") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        return {
          schemaVersion: 1,
          type: "AGENT_RUN_ACTIVITY_RETENTION_APPLIED",
          replayed: false,
          entriesDeleted: 0,
          stateRowsDeleted: 0,
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

    cleanupExpiredAgentRunActivity({ state, now, logger: app.log });
    expect(infoMessages).toHaveLength(0);
    await app.close();
  });

  it("logs a completion summary with the observed counts once something was deleted", async () => {
    const infoMessages: unknown[] = [];
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      query: queryMustNotBeCalled,
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
      entriesDeleted: 1,
      stateRowsDeleted: 1,
    });
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0]).toMatchObject([
      { entriesDeleted: 1, stateRowsDeleted: 1 },
      "Agent run activity retention cleanup completed",
    ]);
    await app.close();
  });
});
