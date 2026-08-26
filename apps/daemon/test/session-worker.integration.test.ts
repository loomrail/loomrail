import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import type { ProviderAdapter } from "@loomrail/provider-core";
import { createMockProvider } from "@loomrail/provider-mock";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionWorker, type SessionWorker } from "../src/session-worker.js";
import { gatedAdapter } from "./gated-adapter.js";
import {
  pendingDispatchModes,
  seedQueuedAttempt as seedQueuedAttemptFixture,
  snapshotOf,
  type SeededAttempt,
} from "./state-fixtures.js";

const timestamp = "2026-08-26T00:00:00.000Z";

type RecordedLog = { level: string; msg: string; details?: Record<string, unknown> };
type RecordingLogger = FastifyBaseLogger & { records: RecordedLog[] };

// A FastifyBaseLogger that keeps every call instead of discarding it, so the unmoved-head guard's
// log line can be asserted on directly rather than through a raw JSON stream (the way
// `session.integration.test.ts` does it for the same guard through the real daemon).
const createRecordingLogger = (): RecordingLogger => {
  const records: RecordedLog[] = [];
  const record =
    (level: string) =>
    (detailsOrMsg: unknown, msg?: string): void => {
      if (typeof detailsOrMsg === "string") {
        records.push({ level, msg: detailsOrMsg });
      } else {
        records.push({ level, msg: msg ?? "", details: detailsOrMsg as Record<string, unknown> });
      }
    };
  const logger: RecordingLogger = {
    level: "info",
    fatal: record("fatal"),
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    debug: record("debug"),
    trace: record("trace"),
    silent: record("silent"),
    child: () => logger,
    records,
  };
  return logger;
};

// An adapter whose `start` is never expected to be called: used for the unmoved-head guard test,
// where `runStageAttempt` returns before ever reaching the provider. If a mutation removed the
// guard and let the loop reach the provider instead of spinning quietly to the cycle limit, this
// throws and fails the test loudly rather than passing by accident.
const adapterThatDoesNothing = (): ProviderAdapter => ({
  capabilities: () => ({
    provider: "MOCK",
    start: true,
    interrupt: false,
    eventStream: false,
    usageReporting: false,
    contextWindowReporting: false,
    checkpointOnRequest: false,
    contextWindowTokens: 200_000,
  }),
  start: async () => {
    throw new Error("adapterThatDoesNothing.start should never be called");
  },
  requestHandoff: async () => undefined,
  abortSession: async () => undefined,
});

// `capabilities()` is called synchronously at the very top of `runStageAttempt`, outside any
// try/catch there -- throwing from it is the simplest way to make the loop itself throw, as
// opposed to a rejected `start()`, which `runStageAttempt` already turns into a handled FAILED
// outcome and is not "a throw inside the loop" at all.
const adapterThatThrows = (): ProviderAdapter => ({
  capabilities: () => {
    throw new Error("synthetic capabilities failure");
  },
  start: async () => {
    throw new Error("unreachable: capabilities() throws first");
  },
  requestHandoff: async () => undefined,
  abortSession: async () => undefined,
});

const IDLE_TIMEOUT_MS = 2_000;

// Bounds every "wait for the worker to finish" checkpoint below. A mutation that breaks the pump's
// re-looping (a single `if` instead of `while (pending && !stopping)`, for instance) leaves
// `whenIdle()` never resolving; without this, a broken implementation fails the whole test on
// vitest's blanket per-test timeout rather than on the assertion that names the behaviour under
// test, which is exactly the "incidental failure" the task's own review has flagged twice before.
const awaitIdle = async (worker: Pick<SessionWorker, "whenIdle">): Promise<void> => {
  const settled = await Promise.race([
    worker.whenIdle().then((): "idle" => "idle"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), IDLE_TIMEOUT_MS)),
  ]);
  expect(settled).toBe("idle");
};

describe("session worker", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let openState: LocalState | undefined;
  let nextId = 0;
  let nextCommandId = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail session worker "));
    databasePath = join(temporaryDirectory, "local state.sqlite");
    nextId = 0;
    nextCommandId = 0;
    openState = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
  });

  afterEach(async () => {
    openState?.close();
    openState = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const state = (): LocalState => {
    if (!openState) throw new Error("Expected an open LocalState");
    return openState;
  };

  const createCommandId = (): string => `command-${(nextCommandId += 1).toString()}`;

  const seedQueuedAttempt = (localState: LocalState): SeededAttempt =>
    seedQueuedAttemptFixture(localState, createCommandId, temporaryDirectory);

  // The same seed as `session.integration.test.ts`'s "stops without starting a session when one is
  // already running on the attempt": a queued attempt whose dispatch is marked started and which
  // already has a RUNNING ProviderSession recorded directly, bypassing `runStageAttempt`. Nothing
  // serialises the drain, so `runStageAttempt` meets this the same way a genuine second caller would
  // -- it returns quietly, and the dispatch stays PENDING and unmoved.
  const seedUnmovableDispatch = (localState: LocalState): SeededAttempt => {
    const seeded = seedQueuedAttempt(localState);
    const dispatched = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-dispatch",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: seeded.dispatch.id },
    });
    if (dispatched.type !== "WORKFLOW_DISPATCH_STARTED") throw new Error("Expected a started dispatch");
    const running = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-concurrent-session",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId: seeded.stageAttemptId,
        recipe: {
          schemaVersion: 1,
          templateId: mockDeliveryTemplate.id,
          templateVersion: mockDeliveryTemplate.version,
          specSource: "WORKFLOW_TEMPLATE",
          sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
          omitted: [],
          contentHash: `sha256:${"0".repeat(64)}`,
          estimatedTokens: 10,
          budgetTokens: 100,
          estimateQuality: "LOOMRAIL_ESTIMATE",
        },
      },
    });
    if (running.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected a running session");
    return { ...seeded, dispatch: dispatched.dispatch };
  };

  it("runs one attempt at a time and does not start a second on a wake mid-flight", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);

    worker.wake();
    await adapter.started;
    worker.wake();
    worker.wake();

    expect(adapter.startCallCount).toBe(1);

    // `session-loop.ts`'s own "another caller already running a session on this attempt" check
    // means a second, concurrent `pump()` can never reach a second `adapter.start()` call even
    // without the single-flight guard here -- so `startCallCount` alone cannot tell the two apart.
    // What the guard alone is responsible for is the bookkeeping: without it, the extra `wake()`
    // calls above start their own `pump()` runs that finish almost immediately (the dispatch they
    // find is already spoken for) and reach their own `finally` block while the *first* pump is
    // still gated on the adapter -- settling every idle waiter early. Catching that requires
    // observing `whenIdle()` before the gate opens, not just counting provider starts.
    let settled = false;
    void worker.whenIdle().then(() => {
      settled = true;
    });
    // The extra pumps' race, if unguarded, resolves across several chained microtasks (each of
    // their `runOnce` cycles is its own await boundary) rather than in the single tick a plain
    // `await Promise.resolve()` flushes, so this waits out a full macrotask instead.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    adapter.release();
    await awaitIdle(worker);
    expect(settled).toBe(true);
  });

  // The wake that arrived mid-attempt has to be honoured after it, or a dispatch created by a
  // request while a stage was running would sit in the queue until something unrelated woke the
  // worker.
  it("takes another pass for a wake that arrived while it was busy", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);

    worker.wake();
    await adapter.started;
    seedQueuedAttempt(localState);
    worker.wake();
    adapter.release();
    await awaitIdle(worker);

    expect(pendingDispatchModes(localState)).toEqual([]);
  });

  it("resolves whenIdle only once the queue is empty", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);
    worker.wake();
    await adapter.started;

    let settled = false;
    void worker.whenIdle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    adapter.release();
    await awaitIdle(worker);
    expect(settled).toBe(true);
  });

  // The guard that used to catch a second concurrent drain now catches an unmovable head. Without it
  // the loop would spin on the same row to the cycle limit.
  it("stops the pass when the head of the queue did not move", async () => {
    const localState = state();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter: adapterThatDoesNothing(),
      template: mockDeliveryTemplate,
      createCommandId,
      logger,
    });
    seedUnmovableDispatch(localState);

    worker.wake();
    await awaitIdle(worker);

    expect(logger.records.map(({ msg }) => msg)).toContain(
      "The pending workflow dispatch is already being run elsewhere; this drain stops",
    );
  });

  // The background loop has no caller to hand a 500 to. A throw must stay inside it, and must not
  // leave the worker permanently busy -- which is what would make every later wake a no-op.
  it("keeps a throw inside the loop and stays able to run again", async () => {
    const localState = state();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter: adapterThatThrows(),
      template: mockDeliveryTemplate,
      createCommandId,
      logger,
    });
    const seeded = seedQueuedAttempt(localState);

    worker.wake();
    await awaitIdle(worker);

    // `awaitIdle` resolving is not proof the throw was caught inside the loop: the outer
    // `try/finally` around the whole pass clears `running` and settles idle waiters regardless of
    // whether the inner `try/catch` around `runOnce()` exists, because `wake()` calls `pump()` as
    // `void pump()` -- a rejection there becomes an unhandled promise rejection, not a stuck worker.
    // Only the log line the inner catch writes proves the throw was actually handled, not merely
    // survived by bookkeeping that would stay correct either way.
    expect(logger.records.map(({ msg }) => msg)).toContain(
      "The background session worker could not finish a pass",
    );

    // DISCOVERY's default mock script asks a question rather than completing outright (its
    // `dispatch.mode === "START"` branch), which is exactly a case that leaves the run something
    // other than RUNNING without needing a second worker pass or any cascading through the template.
    const healthy = createSessionWorker({
      state: localState,
      adapter: createMockProvider(),
      template: mockDeliveryTemplate,
      createCommandId,
      logger: createRecordingLogger(),
    });
    healthy.wake();
    await awaitIdle(healthy);
    expect(snapshotOf(localState, seeded.workItemId).run?.status).not.toBe("RUNNING");
  });

  it("asks the live session to abort when stopped", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);
    worker.wake();
    await adapter.started;

    await worker.stop();

    expect(adapter.abortedSessions).toHaveLength(1);
    adapter.release();
  });
});
