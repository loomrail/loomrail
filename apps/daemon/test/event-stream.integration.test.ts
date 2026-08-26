import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { stateCommandResultSchema } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEventStreamRegistry,
  MAX_OPEN_STREAMS,
  type EventStreamRegistry,
} from "../src/event-stream.js";
import { startDaemon, type RunningDaemon } from "../src/server.js";

import {
  authenticate,
  bootstrapToken,
  mutationHeaders,
  type AuthenticatedSession,
} from "./server.integration.test.js";
import { silentLogger } from "./silent-logger.js";

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

// Registers the bundled "web-app-a" fixture on its own, ahead of opening a stream a test wants to
// observe. REGISTER_FIXTURE_PROJECT commits its own PROJECT_REGISTERED event and is now published
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
  // `broadcastingState` makes this test go red. It previously used `readRawFrames(stream.body, 1)`,
  // which is satisfied by the connect-time `: open\n\n` comment -- the first frame this route ever
  // produces -- so the assertion never actually waited for a signal frame and stayed green even with
  // the WorkItem title on the wire. `readFirstDataFrameText` waits for a frame carrying a `data:`
  // line instead, and the fixture is registered before the stream opens -- see
  // registerFixtureProject's comment -- so that first data frame is the WORK_ITEM_CREATED signal
  // this test means to inspect, not the PROJECT_REGISTERED one from registration.
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

  // Held a stream dolder than the session that opened it turns the channel into a way to hold
  // authenticated access forever. Proven through `tick()`, not by waiting out the real interval: the
  // difference between "proven" and "runs" is the one line the production timer calls it with.
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

  it("refuses to open more streams than the limit and leaves the open ones alone", () => {
    const registry = trackRegistry(createEventStreamRegistry({ logger: silentLogger }));
    const releases = Array.from({ length: MAX_OPEN_STREAMS }, () =>
      registry.open({ response: fakeResponse([]), isAuthorized: () => true }),
    );
    expect(releases.every((release) => release !== null)).toBe(true);
    expect(registry.open({ response: fakeResponse([]), isAuthorized: () => true })).toBeNull();
    expect(registry.openCount()).toBe(MAX_OPEN_STREAMS);
  });

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
