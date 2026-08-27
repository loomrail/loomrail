import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { stateCommandResultSchema } from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEventStreamRegistry,
  MAX_OPEN_STREAMS,
  type EventStreamRegistry,
} from "../src/event-stream.js";
import { startDaemon, SESSION_TTL_MS, type RunningDaemon } from "../src/server.js";

import { gatedAdapter } from "./gated-adapter.js";
import {
  authenticate,
  bootstrapToken,
  mutationHeaders,
  type AuthenticatedSession,
} from "./daemon-fixtures.js";
import { silentLogger } from "./silent-logger.js";
import { FIXTURE_PROJECT_ID, seedQueuedAttempt } from "./state-fixtures.js";

// A minimal ServerResponse double that records written frames and remembers that it was closed,
// without pulling in a real HTTP response.
const fakeResponse = (written: string[]) => {
  const response = {
    ended: false,
    write: (frame: string) => {
      written.push(frame);
      return true;
    },
    end: () => {
      response.ended = true;
    },
  };
  return response as unknown as ServerResponse & { ended: boolean };
};

// Reads the body of an SSE response up to the first data frame. Bounded by a chunk count, not a
// timer: "nothing arrived" here always means "the stream closed or is silent", and a timer cannot
// tell those apart.
const readFirstSignal = async (body: ReadableStream<Uint8Array>): Promise<unknown> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (let chunk = 0; chunk < 32; chunk += 1) {
    const { done, value } = await reader.read();
    if (done) throw new Error("The stream ended before a data frame arrived");
    buffered += decoder.decode(value, { stream: true });
    for (const frame of buffered.split("\n\n")) {
      const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (line) {
        // Release the lock this reader took on `body`, so a caller can still `body.cancel()` it.
        reader.releaseLock();
        return JSON.parse(line.slice("data: ".length));
      }
    }
  }
  throw new Error("No data frame arrived within the frame budget");
};

// Reads until a frame carrying a `data:` line has arrived and returns that frame's raw text. The
// route's first frame is the `: open` comment that flushes headers, so a helper counting frames
// stops on the comment and never sees the signal -- which is how this test came to assert against
// the wrong bytes while looking correct.
const readFirstDataFrameText = async (body: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (let chunk = 0; chunk < 32; chunk += 1) {
    const { done, value } = await reader.read();
    if (done) throw new Error("The stream ended before a data frame arrived");
    buffered += decoder.decode(value, { stream: true });
    const dataFrame = buffered
      .split("\n\n")
      .find((frame) => frame.split("\n").some((line) => line.startsWith("data: ")));
    if (dataFrame !== undefined) {
      reader.releaseLock();
      return dataFrame;
    }
  }
  throw new Error("No data frame arrived within the frame budget");
};

// Drains an SSE body until the server ends it, discarding whatever frames arrive on the way.
// Answers "ended" or "open" rather than hanging: a stream the daemon never closes has to fail the
// assertion that names that behaviour, not vitest's blanket per-test timeout, which names nothing.
const streamOutcome = async (
  body: ReadableStream<Uint8Array>,
  budgetMs: number,
): Promise<"ended" | "open"> => {
  const reader = body.getReader();
  const drained = (async (): Promise<"ended"> => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return "ended";
    }
  })();
  const outcome = await Promise.race([drained, delay(budgetMs, "open" as const)]);
  if (outcome === "open") await reader.cancel();
  return outcome;
};

// Registers the bundled "web-app-a" fixture on its own, ahead of opening a stream a test wants to
// observe. REGISTER_PROJECT commits its own PROJECT_REGISTERED event and is now published
// like any other command -- a test that opens the stream first and calls `createWorkItem` alone
// would see that PROJECT signal arrive before the WORK_ITEM one it is asserting on. Registering
// here, before the stream opens, and letting `createWorkItem`'s internal registration replay the
// same commandId from its cached receipt (no new event, so no second signal) keeps the signal a
// test waits for after opening the stream to the one it actually names.
const registerFixtureProject = async (
  daemon: RunningDaemon,
  session: AuthenticatedSession,
): Promise<void> => {
  const response = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
    method: "POST",
    headers: mutationHeaders(daemon, session),
    body: JSON.stringify({ schemaVersion: 1, commandId: "register-web-app-a", fixtureId: "web-app-a" }),
  });
  if (response.status !== 200) {
    throw new Error(`Fixture registration failed with status ${String(response.status)}`);
  }
};

// Registers the bundled "web-app-a" fixture (idempotently: a repeated call replays the cached
// receipt for the same commandId rather than conflicting) and creates one WorkItem under it,
// following the same POST /api/v1/work-items flow server.integration.test.ts exercises.
const createWorkItem = async (
  daemon: RunningDaemon,
  session: AuthenticatedSession,
  options: { title: string },
): Promise<{ id: string; projectId: string }> => {
  const fixtureId = "web-app-a";
  const projectId = `project-fixture-${fixtureId}`;

  const registration = await fetch(`${daemon.baseUrl}/api/v1/projects/fixtures/register`, {
    method: "POST",
    headers: mutationHeaders(daemon, session),
    body: JSON.stringify({ schemaVersion: 1, commandId: `register-${fixtureId}`, fixtureId }),
  });
  if (registration.status !== 200) {
    throw new Error(`Fixture registration failed with status ${String(registration.status)}`);
  }

  const response = await fetch(`${daemon.baseUrl}/api/v1/work-items`, {
    method: "POST",
    headers: mutationHeaders(daemon, session),
    body: JSON.stringify({
      schemaVersion: 1,
      commandId: `create-work-item-${randomUUID()}`,
      projectId,
      type: "TASK",
      title: options.title,
      acceptanceCriteria: ["Acceptance criterion"],
    }),
  });
  const result = stateCommandResultSchema.parse(await response.json());
  if (result.type !== "WORK_ITEM_CREATED") throw new Error("Expected the WorkItem to be created");
  return { id: result.workItem.id, projectId: result.workItem.projectId };
};

describe("daemon event stream", () => {
  let daemon: RunningDaemon | undefined;
  const temporaryDirectories: string[] = [];
  const token = bootstrapToken();
  // Registries built directly (not via startDaemon) own an unref'd heartbeat timer that only
  // `stopHeartbeat()` clears; without this, each such test leaks one live interval per run.
  const openRegistries: EventStreamRegistry[] = [];
  const trackRegistry = (registry: EventStreamRegistry): EventStreamRegistry => {
    openRegistries.push(registry);
    return registry;
  };

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    for (const registry of openRegistries) registry.stopHeartbeat();
    openRegistries.length = 0;
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a stream to a caller without a session", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });

    const response = await fetch(`${daemon.baseUrl}/api/v1/stream`);

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("refuses a stream when an Origin is sent and does not match", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);

    const response = await fetch(`${daemon.baseUrl}/api/v1/stream`, {
      headers: { cookie: session.cookie, origin: "http://evil.example" },
    });

    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  // Proven by mutation: removing the `publishCommitted()` call from `broadcastingState`'s `execute`
  // wrapper makes this the only test in the suite that goes red, because it is the only one that
  // waits for a signal frame to actually arrive at a connected client rather than asserting against
  // the registry directly.
  it("opens a stream for a session and delivers a signal for a committed event", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const localDaemon = daemon;
    // Registered before the stream opens so the only signal it sees is the WORK_ITEM_CREATED one
    // this test asserts on -- see registerFixtureProject's comment.
    await registerFixtureProject(localDaemon, session);
    const stream = await fetch(`${localDaemon.baseUrl}/api/v1/stream`, {
      headers: { cookie: session.cookie },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    if (!stream.body) throw new Error("The stream carried no body");

    const signalArrived = readFirstSignal(stream.body);
    const created = await createWorkItem(localDaemon, session, { title: "Ship the billing page" });
    // Raced against a bounded delay, well under the 10s test timeout below: a signal that never
    // arrives (e.g. `publishCommitted()` never gets called) must fail this assertion, not hang
    // until Vitest's own per-test timeout decides the outcome instead. Same reasoning as "closes
    // while a stream is still open" above.
    const outcome = await Promise.race([
      signalArrived.then((signal) => ({ arrived: true as const, signal })),
      delay(5_000, { arrived: false as const, signal: undefined }),
    ]);
    expect(outcome).toEqual({
      arrived: true,
      signal: { projectId: created.projectId, aggregateType: "WORK_ITEM", aggregateId: created.id },
    });
    await stream.body.cancel();
  }, 10_000);

  // Spec §9: «signal reaches the client for an event written by background work». Every other
  // delivery test in this file drives a handler command, and handlers get the wrapped `localState`
  // whichever state `createSessionWorker` was handed -- so handing the *worker* the unwrapped one
  // disconnects the entire background half of the product from the channel with all 87 daemon and
  // 28 browser tests still green. Here the daemon is parked inside `runStageAttempt` before the
  // stream is even opened, so every event after `release()` is worker-written and nothing else can
  // account for the frame that arrives.
  it("delivers a signal for an event written by the background worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail event stream "));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "local state.sqlite");
    let nextCommandId = 0;
    const seedState = await openLocalState({ databasePath });
    const seeded = seedQueuedAttempt(seedState, () => `seed-${(nextCommandId += 1).toString()}`, directory);
    seedState.close();

    const adapter = gatedAdapter();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: databasePath,
      providerAdapter: adapter,
    });
    const localDaemon = daemon;
    const session = await authenticate(localDaemon, token);
    // The daemon's startup `wake()` already put the worker inside the seeded attempt; the gate is
    // what guarantees it has written nothing since, so the stream opened below cannot miss anything
    // and cannot see anything written before it.
    await adapter.started;

    const stream = await fetch(`${localDaemon.baseUrl}/api/v1/stream`, {
      headers: { cookie: session.cookie },
    });
    expect(stream.status).toBe(200);
    if (!stream.body) throw new Error("The stream carried no body");
    const signalArrived = readFirstSignal(stream.body);

    adapter.release();

    // Raced against a bounded delay for the same reason as the handler test above: a signal that
    // never arrives has to fail this assertion rather than run out the per-test timeout.
    const outcome = await Promise.race([
      signalArrived.then((signal) => ({ arrived: true as const, signal })),
      delay(5_000, { arrived: false as const, signal: undefined }),
    ]);
    expect(outcome).toEqual({
      arrived: true,
      signal: {
        projectId: FIXTURE_PROJECT_ID,
        aggregateType: "WORK_ITEM",
        aggregateId: seeded.workItemId,
      },
    });
    await stream.body.cancel();
  }, 15_000);

  it("opens a stream for a session and flushes headers immediately", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);

    const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });

    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });

  // Spec §7, last row: the frame carries opaque identifiers and no content. Proven by mutation:
  // publishing `{ ...signal, leaked: event.data.workItem.title }` for WORK_ITEM_CREATED in
  // `broadcastingState` makes this test go red. `readFirstDataFrameText` rather than "the first
  // frame": the connect-time `: open\n\n` comment is a frame too, and waiting for any frame would
  // leave this assertion green with the WorkItem title on the wire. The fixture is registered before
  // the stream opens -- see registerFixtureProject's comment -- so the first frame carrying a
  // `data:` line is the WORK_ITEM_CREATED signal this test means to inspect, not PROJECT_REGISTERED.
  it("carries no work item text on the wire", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    await registerFixtureProject(daemon, session);
    const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });
    if (!stream.body) throw new Error("The stream carried no body");
    const frame = readFirstDataFrameText(stream.body);
    await createWorkItem(daemon, session, { title: "Ship the billing page" });
    expect(await frame).not.toContain("Ship the billing page");
    await stream.body.cancel();
  });

  // Without closeAll() in preClose this never resolves: the held response has no idle period, so the
  // server waits for a request that will never arrive. Any finite budget discriminates, because the
  // failure is an unbounded wait rather than a slow one.
  it("closes while a stream is still open", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });
    expect(stream.status).toBe(200);
    const closed = daemon.close().then(() => "closed" as const);
    // Kept well under the 15s test timeout below, so a real hang is decided by this race -- as an
    // assertion failure -- rather than by Vitest's own default per-test timeout winning the tie.
    const timedOut = delay(3_000, "hung" as const);
    await expect(Promise.race([closed, timedOut])).resolves.toBe("closed");
    await stream.body?.cancel();
  }, 15_000);

  // Holding a stream older than the session that opened it turns the channel into a way to hold
  // authenticated access forever. This covers the registry's middle link on its own -- `tick()`
  // drops a subscriber whose `isAuthorized` says no -- with a flag the test owns. The two links on
  // either side of it (the timer that calls `tick`, and the `isAuthorized` the route actually
  // builds) are covered by "closes a real stream once its session has expired" below, which is what
  // makes the chain claimed by THREAT-MODEL.md's T03 delta true end to end.
  it("closes an open stream once its session has expired", () => {
    const registry = trackRegistry(createEventStreamRegistry({ logger: silentLogger }));
    const written: string[] = [];
    let authorized = true;
    const response = fakeResponse(written);
    registry.open({ response, isAuthorized: () => authorized });

    registry.tick();
    expect(written.at(-1)).toBe(": ping\n\n");
    expect(registry.openCount()).toBe(1);

    authorized = false;
    registry.tick();
    expect(registry.openCount()).toBe(0);
    expect(response.ended).toBe(true);
  });

  // THREAT-MODEL.md's T03 delta states the heartbeat as fifteen seconds, but every other test in
  // this file injects `intervalMs`, so `HEARTBEAT_INTERVAL_MS` itself is never exercised -- it could
  // be changed to an hour and the suite would stay green while the document's stated bound quietly
  // stopped being true. This pins the schedule a registry actually uses when nothing is injected
  // against that fifteen-second figure written as a literal, deliberately not against an imported
  // `HEARTBEAT_INTERVAL_MS`: importing it would make the boundary move in lockstep with any change
  // to the constant, so a mutated constant and a correctly-wired fallback would look identical to
  // this test. Fake timers rather than a real wait: `tick()` is a public method precisely so the
  // heartbeat's own cadence never has to be driven by the clock in a test, and this machine's load
  // average makes a duration-based assertion indistinguishable from a defect. The boundary pair is
  // the point: advancing straight past the interval would pass for any constant smaller than the
  // advance, so this stops one millisecond short and asserts silence before crossing into the ping.
  it("schedules its heartbeat on HEARTBEAT_INTERVAL_MS (15s) when no intervalMs is injected", () => {
    const documentedHeartbeatIntervalMs = 15_000;
    vi.useFakeTimers();
    try {
      const registry = trackRegistry(createEventStreamRegistry({ logger: silentLogger }));
      const written: string[] = [];
      registry.open({ response: fakeResponse(written), isAuthorized: () => true });

      vi.advanceTimersByTime(documentedHeartbeatIntervalMs - 1);
      expect(written).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(written).toEqual([": ping\n\n"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to open more streams than the limit and leaves the open ones alone", () => {
    const registry = trackRegistry(createEventStreamRegistry({ logger: silentLogger }));
    const releases = Array.from({ length: MAX_OPEN_STREAMS }, () =>
      registry.open({ response: fakeResponse([]), isAuthorized: () => true }),
    );
    expect(releases.every((release) => release !== null)).toBe(true);
    expect(registry.open({ response: fakeResponse([]), isAuthorized: () => true })).toBeNull();
    expect(registry.openCount()).toBe(MAX_OPEN_STREAMS);
  });

  // The whole chain THREAT-MODEL.md's T03 delta and ADR-0003's required tests claim, driven through
  // a real HTTP stream: the heartbeat timer fires, `tick()` re-asks the `isAuthorized` the route
  // itself built, the injected clock has taken the session past `SESSION_TTL_MS`, and the held
  // response ends. Proven by mutation twice, because the chain has two links the registry test
  // above cannot reach: pinning `isAuthorized: () => true` on the route, and dropping the
  // `registry.tick()` call from the interval callback, each turn this red on the assertion below.
  it("closes a real stream once its session has expired", async () => {
    let clock = new Date("2026-08-26T00:00:00.000Z");
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      now: () => clock,
      // The interval length is not what is under test -- the recheck it drives is. Shortening it is
      // what keeps this test from having to wait out the real fifteen seconds to observe that.
      heartbeatIntervalMs: 10,
    });
    const session = await authenticate(daemon, token);
    const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, {
      headers: { cookie: session.cookie },
    });
    expect(stream.status).toBe(200);
    if (!stream.body) throw new Error("The stream carried no body");

    clock = new Date(clock.getTime() + SESSION_TTL_MS + 1_000);

    await expect(streamOutcome(stream.body, 3_000)).resolves.toBe("ended");
  }, 15_000);

  it("answers a stream request over the limit with a status rather than an opened stream", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const localDaemon = daemon;
    const held = await Promise.all(
      Array.from({ length: MAX_OPEN_STREAMS }, () =>
        fetch(`${localDaemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } }),
      ),
    );
    const refused = await fetch(`${localDaemon.baseUrl}/api/v1/stream`, {
      headers: { cookie: session.cookie },
    });
    expect(refused.status).toBe(503);
    await refused.body?.cancel();
    await Promise.all(held.map((response) => response.body?.cancel() ?? Promise.resolve()));
  });
});
