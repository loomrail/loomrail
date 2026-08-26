import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { stateCommandResultSchema } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";

import {
  authenticate,
  bootstrapToken,
  mutationHeaders,
  type AuthenticatedSession,
} from "./server.integration.test.js";

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
      if (line) return JSON.parse(line.slice("data: ".length));
    }
  }
  throw new Error("No data frame arrived within the frame budget");
};

// Reads the raw decoded bytes of an SSE response until at least `frameCount` frames (delimited by a
// blank line) have arrived, and returns the text as-is so a caller can assert on the wire content
// rather than on a parsed shape. Bounded by a chunk count for the same reason as `readFirstSignal`.
const readRawFrames = async (body: ReadableStream<Uint8Array>, frameCount: number): Promise<string> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (let chunk = 0; chunk < 32; chunk += 1) {
    const { done, value } = await reader.read();
    if (done) throw new Error("The stream ended before the requested frame count arrived");
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split("\n\n").filter((frame) => frame.length > 0);
    if (frames.length >= frameCount) {
      // Release the lock this reader took on `body`, so a caller can still `body.cancel()` it.
      reader.releaseLock();
      return buffered;
    }
  }
  throw new Error("The requested frame count did not arrive within the frame budget");
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
    throw new Error(`Fixture registration failed with status ${registration.status}`);
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

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
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

  // This test needs a signal published on the wire in response to a committed event. Nothing wires
  // `eventStreams.publish` into a mutation route yet -- Task 4 (`broadcastingState`) wraps `localState`
  // once and is what makes this real. Skipped rather than deleted so its body carries over verbatim.
  it.skip("opens a stream for a session and delivers a signal for a committed event", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const localDaemon = daemon;
    const stream = await fetch(`${localDaemon.baseUrl}/api/v1/stream`, {
      headers: { cookie: session.cookie },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    if (!stream.body) throw new Error("The stream carried no body");

    const signalArrived = readFirstSignal(stream.body);
    const created = await createWorkItem(localDaemon, session, { title: "Ship the billing page" });
    await expect(signalArrived).resolves.toEqual({
      projectId: created.projectId,
      aggregateType: "WORK_ITEM",
      aggregateId: created.id,
    });
    await stream.body.cancel();
  });

  it("opens a stream for a session and flushes headers immediately", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);

    const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });

    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });

  // Spec §7, last row: the frame carries opaque identifiers and no content. This cannot be proven
  // yet: `readRawFrames(stream.body, 1)` is satisfied by the connect-time `: open\n\n` comment, which
  // is the only frame this route can produce before Task 4 wires `eventStreams.publish` in -- nothing
  // calls `publish` yet, so the assertion never actually waits for a signal frame and would pass even
  // if a future `publish()` put the WorkItem title on the wire. Same missing wiring as the skipped
  // "delivers a signal" test above; skipped for the same honest reason rather than left green on a
  // technicality. Task 4 takes over both tests, replaces `readRawFrames` with a helper that stops on
  // the first *data* frame, and carries a mutation that puts real text into the frame so this goes red.
  it.skip("carries no work item text on the wire", async () => {
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const session = await authenticate(daemon, token);
    const stream = await fetch(`${daemon.baseUrl}/api/v1/stream`, { headers: { cookie: session.cookie } });
    if (!stream.body) throw new Error("The stream carried no body");
    const frames = readRawFrames(stream.body, 1);
    await createWorkItem(daemon, session, { title: "Ship the billing page" });
    expect(await frames).not.toContain("Ship the billing page");
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
});
