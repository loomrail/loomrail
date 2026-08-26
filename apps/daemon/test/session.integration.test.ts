import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Checkpoint,
  ContextPackRecipe,
  ProviderOutcome,
  ProviderSession,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import {
  providerCapabilitiesSchema,
  type ProviderAdapter,
  type ProviderInvocation,
  type ProviderSessionListener,
} from "@loomrail/provider-core";
import { createMockProvider } from "@loomrail/provider-mock";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDaemon } from "../src/server.js";
import { runStageAttempt, type RunStageAttemptDeps, type SessionLoopLogger } from "../src/session-loop.js";

const timestamp = "2026-08-25T18:00:00.000Z";

const silentLogger: SessionLoopLogger = {
  info: () => undefined,
  warn: () => undefined,
};

// Fires the wind-down deadline on the next macrotask instead of after a real minute. The loop only
// ever reaches for this through the injected scheduler, which is the whole reason the deadline is
// injectable: a test for an ignored wind-down request must not wait HANDOFF_DEADLINE_MS.
const immediateDeadline: NonNullable<RunStageAttemptDeps["scheduleHandoffDeadline"]> = (
  _delayMs,
  onDeadline,
) => {
  const handle = setTimeout(onDeadline, 0);
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
};

type SeededAttempt = {
  workItemId: string;
  stageAttemptId: string;
  dispatch: WorkflowDispatch;
};

type SessionRows = {
  sessions: ProviderSession[];
  recipes: ContextPackRecipe[];
  checkpoints: Checkpoint[];
};

describe("stage attempt session loop", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let nextCommandId = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail session loop "));
    databasePath = join(temporaryDirectory, "local state.sqlite");
    nextId = 0;
    nextCommandId = 0;
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const createCommandId = (): string => `command-${(nextCommandId += 1).toString()}`;

  const seedRunningAttempt = (localState: LocalState): SeededAttempt => {
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_FIXTURE_PROJECT",
      payload: {
        id: "project-web",
        fixtureId: "web-app-a",
        name: "Web fixture",
        repositoryPath: join(temporaryDirectory, "project-web"),
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-web",
        parentId: null,
        type: "TASK",
        title: "Carry a stage attempt across provider sessions",
        description: "Synthetic fixture work for the session loop.",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["The attempt survives a context handoff"],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected a WorkItem");
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-ready",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const started = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: mockDeliveryTemplate,
        budget: { maxEstimatedTokens: 100_000, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected a started pipeline");
    const dispatched = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-dispatch",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: started.dispatch.id },
    });
    if (dispatched.type !== "WORKFLOW_DISPATCH_STARTED") throw new Error("Expected a started dispatch");
    return {
      workItemId: created.workItem.id,
      stageAttemptId: started.stageAttempt.id,
      dispatch: dispatched.dispatch,
    };
  };

  const depsFor = (
    localState: LocalState,
    seeded: SeededAttempt,
    adapter: ProviderAdapter,
    overrides: Partial<RunStageAttemptDeps> = {},
  ): RunStageAttemptDeps => ({
    state: localState,
    adapter,
    dispatch: seeded.dispatch,
    template: mockDeliveryTemplate,
    createCommandId,
    correlationId: "correlation-session-loop",
    logger: silentLogger,
    scheduleHandoffDeadline: immediateDeadline,
    ...overrides,
  });

  const sessionRows = (localState: LocalState, stageAttemptId: string): SessionRows => {
    const result = localState.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
    if (result.type !== "PROVIDER_SESSIONS") throw new Error("Expected provider sessions");
    return { sessions: result.sessions, recipes: result.recipes, checkpoints: result.checkpoints };
  };

  const eventTypes = (localState: LocalState): string[] => {
    const events = localState.query({ type: "LIST_EVENTS", limit: 500 });
    if (events.type !== "EVENTS") throw new Error("Expected events");
    return events.events.map(({ type }) => type);
  };

  const snapshotOf = (localState: LocalState, workItemId: string) => {
    const result = localState.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId });
    if (result.type !== "WORKFLOW_SNAPSHOT") throw new Error("Expected a workflow snapshot");
    return result.snapshot;
  };

  const completingOutcome = (): ProviderOutcome => ({
    type: "COMPLETED",
    summary: "The mock session finished the stage.",
  });

  // A ProviderAdapter built from two genuinely separate `createMockProvider` instances, each of
  // which sees only the sessions routed to it. The routing key is the session ordinal, so the
  // swap test can assert which instance actually started which session -- a wrapper that simply
  // forwarded everything to one instance would make the swap unobservable and the test hollow.
  type RecordingAdapter = ProviderAdapter & { startedSessionIds: readonly string[] };

  const recording = (adapter: ProviderAdapter): RecordingAdapter => {
    const startedSessionIds: string[] = [];
    return {
      capabilities: adapter.capabilities,
      start: (invocation, listener) => {
        startedSessionIds.push(invocation.session.id);
        return adapter.start(invocation, listener);
      },
      requestHandoff: (sessionId) => adapter.requestHandoff(sessionId),
      abortSession: (sessionId) => adapter.abortSession(sessionId),
      get startedSessionIds(): readonly string[] {
        return startedSessionIds;
      },
    };
  };

  const routedByOrdinal = (first: ProviderAdapter, rest: ProviderAdapter): ProviderAdapter => ({
    capabilities: first.capabilities,
    start: (invocation, listener) =>
      invocation.session.ordinal === 1 ? first.start(invocation, listener) : rest.start(invocation, listener),
    requestHandoff: async (sessionId) => {
      await first.requestHandoff(sessionId);
      await rest.requestHandoff(sessionId);
    },
    abortSession: async (sessionId) => {
      await first.abortSession(sessionId);
      await rest.abortSession(sessionId);
    },
  });

  const finishingAdapter = (contextWindowTokens = 128_000): ProviderAdapter => ({
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "MOCK",
        start: true,
        interrupt: true,
        eventStream: false,
        usageReporting: true,
        contextWindowReporting: false,
        checkpointOnRequest: false,
        contextWindowTokens,
      }),
    start: () => Promise.resolve(completingOutcome()),
    requestHandoff: () => Promise.resolve(),
    abortSession: () => Promise.resolve(),
  });

  it("continues the same attempt in a second session after a handoff", async () => {
    // The point of A1: the work survives the context window filling up.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const handingOff = createMockProvider({
      contextWindowTokens: 4_000,
      tokensPerTurn: 3_500,
      checkpointEvery: 1,
    });

    await runStageAttempt(depsFor(localState, seeded, routedByOrdinal(handingOff, finishingAdapter(4_000))));

    const { sessions } = sessionRows(localState, seeded.stageAttemptId);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.endReason).toBe("HANDOFF");
    expect(sessions[0]?.handoffRequestedAt).toBe(timestamp);
    expect(sessions[1]?.ordinal).toBe(2);
    expect(eventTypes(localState)).toContain("CONTEXT_HANDOFF_REQUESTED");
  });

  it("carries the previous checkpoint into the next pack", async () => {
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const handingOff = createMockProvider({
      contextWindowTokens: 4_000,
      tokensPerTurn: 3_500,
      checkpointEvery: 1,
    });

    await runStageAttempt(depsFor(localState, seeded, routedByOrdinal(handingOff, finishingAdapter(4_000))));

    const { recipes, checkpoints } = sessionRows(localState, seeded.stageAttemptId);
    const secondRecipe = recipes[1];
    if (!secondRecipe) throw new Error("Expected a recipe for the second session");
    const carried = secondRecipe.sections.find(({ id }) => id === "LATEST_CHECKPOINT");
    // Not merely "the section is declared" -- every stage declares LATEST_CHECKPOINT as required,
    // so its presence alone would pass even if no checkpoint had been carried at all. The section's
    // provenance is what proves the first session's checkpoint actually reached the second pack.
    expect(carried?.sources).toEqual([{ kind: "CHECKPOINT", id: checkpoints[0]?.id, version: 1 }]);
  });

  it("continues after the adapter is swapped between sessions", async () => {
    // The property PD-008 claims: a handoff survives a change of provider.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const firstAdapter = recording(
      createMockProvider({ contextWindowTokens: 4_000, tokensPerTurn: 3_500, checkpointEvery: 1 }),
    );
    const secondAdapter = recording(finishingAdapter(4_000));

    await runStageAttempt(depsFor(localState, seeded, routedByOrdinal(firstAdapter, secondAdapter)));

    const { sessions, recipes, checkpoints } = sessionRows(localState, seeded.stageAttemptId);
    expect(sessions).toHaveLength(2);
    expect(firstAdapter.startedSessionIds).toEqual([sessions[0]?.id]);
    expect(secondAdapter.startedSessionIds).toEqual([sessions[1]?.id]);
    // The swap is only meaningful if the work crossed it: the second provider's pack carries the
    // first provider's checkpoint.
    expect(recipes[1]?.sections.find(({ id }) => id === "LATEST_CHECKPOINT")?.sources).toEqual([
      { kind: "CHECKPOINT", id: checkpoints[0]?.id, version: 1 },
    ]);
  });

  it("cuts a session that ignored the handoff request once the deadline passes", async () => {
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    // A provider that reports a full window, accepts `requestHandoff`, and then never winds down
    // and never returns. Without a deadline the loop would wait on `start()` forever, so this test
    // fails by timing out rather than by asserting the wrong end reason. Using the real mock's
    // `ignoreHandoffRequest` here would not discriminate: that mock still ends by itself with
    // CONTEXT_EXHAUSTED once its simulated window fills, so the assertion below would pass with no
    // deadline logic at all.
    const abortedSessionIds: string[] = [];
    const stubborn: ProviderAdapter = {
      capabilities: () =>
        providerCapabilitiesSchema.parse({
          provider: "MOCK",
          start: true,
          interrupt: true,
          eventStream: true,
          usageReporting: true,
          contextWindowReporting: true,
          checkpointOnRequest: true,
          contextWindowTokens: 4_000,
        }),
      start: (_invocation: ProviderInvocation, listener: ProviderSessionListener) =>
        new Promise<ProviderOutcome>(() => {
          listener.onContextWindow({ usedTokens: 3_900, windowTokens: 4_000, quality: "ACTUAL" });
        }),
      requestHandoff: () => Promise.resolve(),
      abortSession: (sessionId) => {
        abortedSessionIds.push(sessionId);
        return Promise.resolve();
      },
    };

    await runStageAttempt(depsFor(localState, seeded, stubborn));

    const { sessions } = sessionRows(localState, seeded.stageAttemptId);
    expect(sessions[0]?.endReason).toBe("CONTEXT_EXHAUSTED");
    expect(sessions[0]?.handoffRequestedAt).toBe(timestamp);
    // Spec §7 promises a *hard* cut. `requestHandoff` cannot deliver one -- the agent is free to
    // keep ignoring it -- so the cut has to reach the provider through `abortSession`, or the next
    // session would open while this one was still running and still billing.
    expect(abortedSessionIds).toEqual(sessions.map(({ id }) => id));
  });

  it("opens a Human Request when two sessions in a row produce nothing", async () => {
    // §6.5 needs a HARD pause AND a question to the owner. A pause with no question is a pipeline
    // that stopped without telling its owner anything. `decideSessionEnded` cannot build a Human
    // Request from its signature, so the caller builds it -- and this is where that is checked.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    // Occupancy stays far below the handoff threshold, so no wind-down is ever requested and the
    // mock never synthesises the checkpoint that a HANDED_OFF outcome always carries: the session
    // simply runs into the wall having published nothing, which is the case §6.5 guards.
    const unproductive = createMockProvider({
      contextWindowTokens: 4_000,
      tokensPerTurn: 100,
      checkpointEvery: 1_000,
      hitTheWallAfterTurns: 1,
    });

    await runStageAttempt(depsFor(localState, seeded, unproductive));

    const { sessions, checkpoints } = sessionRows(localState, seeded.stageAttemptId);
    expect(checkpoints).toHaveLength(0);
    expect(sessions).toHaveLength(2);
    expect(sessions.map(({ endReason }) => endReason)).toEqual(["CONTEXT_EXHAUSTED", "CONTEXT_EXHAUSTED"]);

    const snapshot = snapshotOf(localState, seeded.workItemId);
    expect(snapshot.run?.status).toBe("HARD_PAUSED");
    expect(snapshot.stageAttempts.at(-1)?.status).toBe("HARD_PAUSED");
    expect(snapshot.stageAttempts.at(-1)?.unproductiveSessions).toBe(2);
    expect(snapshot.humanRequests).toHaveLength(1);
    expect(snapshot.humanRequests[0]?.blocking).toBe(true);
    expect(snapshot.humanRequests[0]?.status).toBe("OPEN");
  });

  it("hard-pauses instead of starting a session whose required sections do not fit", async () => {
    // §D8: silently trimming a required section is not allowed.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    let started = 0;
    const tinyWindow: ProviderAdapter = {
      capabilities: () =>
        providerCapabilitiesSchema.parse({
          provider: "MOCK",
          start: true,
          interrupt: true,
          eventStream: false,
          usageReporting: true,
          contextWindowReporting: false,
          checkpointOnRequest: false,
          contextWindowTokens: 40,
        }),
      start: () => {
        started += 1;
        return Promise.resolve(completingOutcome());
      },
      requestHandoff: () => Promise.resolve(),
      abortSession: () => Promise.resolve(),
    };

    await runStageAttempt(depsFor(localState, seeded, tinyWindow));

    expect(started).toBe(0);
    expect(sessionRows(localState, seeded.stageAttemptId).sessions).toHaveLength(0);
    expect(eventTypes(localState)).toContain("CONTEXT_FLOOR_EXCEEDED");
    const snapshot = snapshotOf(localState, seeded.workItemId);
    expect(snapshot.run?.status).toBe("HARD_PAUSED");
    expect(snapshot.humanRequests).toHaveLength(1);
    expect(snapshot.humanRequests[0]?.blocking).toBe(true);
  });

  it("survives a daemon restart mid-attempt and resumes from the last checkpoint", async () => {
    // §6.4: a restart and a context handoff are the same case -- the session is gone, the state is
    // still there.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    let checkpointDelivered: (() => void) | undefined;
    const publishedCheckpoint = new Promise<void>((resolve) => {
      checkpointDelivered = resolve;
    });
    const crashing: ProviderAdapter = {
      capabilities: () =>
        providerCapabilitiesSchema.parse({
          provider: "MOCK",
          start: true,
          interrupt: true,
          eventStream: true,
          usageReporting: true,
          contextWindowReporting: true,
          checkpointOnRequest: true,
          contextWindowTokens: 4_000,
        }),
      start: (_invocation: ProviderInvocation, listener: ProviderSessionListener) =>
        new Promise<ProviderOutcome>(() => {
          listener.onCheckpoint({
            summary: "Half of the mock work is done.",
            completed: ["Read the brief."],
            remaining: ["Finish the implementation."],
            deadEnds: [],
            openQuestions: [],
          });
          checkpointDelivered?.();
        }),
      requestHandoff: () => Promise.resolve(),
      abortSession: () => Promise.resolve(),
    };

    // Never resolves: the process is supposed to die while this session is still running.
    void runStageAttempt(depsFor(localState, seeded, crashing)).catch(() => undefined);
    await publishedCheckpoint;
    localState.close();
    state = undefined;

    // A real daemon boot against the same database: it reconciles, then drains the still-pending
    // dispatch. Reconciliation and the resumed session are the daemon's own doing here, not the
    // test's -- that is the behaviour §6.4 names.
    const restartedDaemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      stateDatabasePath: databasePath,
      logger: false,
    });
    await restartedDaemon.close();

    const restarted = await open();
    const resumed = sessionRows(restarted, seeded.stageAttemptId);
    expect(resumed.sessions[0]?.endReason).toBe("INTERRUPTED");
    expect(resumed.checkpoints).toHaveLength(1);
    expect(resumed.sessions).toHaveLength(2);
    expect(resumed.sessions[1]?.ordinal).toBe(2);
    // The attempt continued rather than being restarted: the second session's pack was assembled
    // from the checkpoint the interrupted session had already published.
    expect(resumed.recipes[1]?.sections.find(({ id }) => id === "LATEST_CHECKPOINT")?.sources).toEqual([
      { kind: "CHECKPOINT", id: resumed.checkpoints[0]?.id, version: 1 },
    ]);
    expect(snapshotOf(restarted, seeded.workItemId).stageAttempts.at(0)?.status).not.toBe("INTERRUPTED");
  });

  it("retries once with a smaller pack share when the provider rejects the pack, then asks the owner", () => {
    // Spec §7's mis-estimated-pack branch. Nothing exercised PACK_SHARE_BACKOFF before this.
    return (async () => {
      const localState = await open();
      const seeded = seedRunningAttempt(localState);
      // Rejects every pack it is handed, so both the retry and the give-up after it are reached.
      const fussy = createMockProvider({ contextWindowTokens: 4_000, rejectPacksLongerThan: 10 });

      await runStageAttempt(depsFor(localState, seeded, fussy));

      const { sessions, recipes } = sessionRows(localState, seeded.stageAttemptId);
      expect(sessions).toHaveLength(2);
      expect(sessions.map(({ endReason }) => endReason)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
      // The reduction is visible where §7 asks for it to be recorded: the second session's recipe
      // was assembled against a strictly smaller budget than the first.
      const firstBudget = recipes[0]?.budgetTokens ?? 0;
      const secondBudget = recipes[1]?.budgetTokens ?? 0;
      expect(secondBudget).toBeLessThan(firstBudget);

      const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.at(0);
      // One automatic retry, not an unbounded search.
      expect(attempt?.packShareBackoffs).toBe(1);
      // A session the provider refused to start never had the chance to publish anything, so
      // §6.5's guard -- which is about an agent that ran and stayed silent -- must not claim it,
      // and the owner must be asked one question about this failure rather than two.
      expect(attempt?.unproductiveSessions).toBe(0);
      expect(attempt?.status).toBe("HARD_PAUSED");
      expect(attempt?.failureCode).toBe("PROVIDER_REJECTED_PACK");
      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.title).toMatch(/context pack/);
    })();
  });

  it("keeps a reduced pack share across a restart instead of starting over at the full share", async () => {
    // §6.5 argues the unproductive counter cannot live in daemon memory because §6.4 makes a
    // restart an ordinary end of a session. The same is true of the pack share: held in a local,
    // it would be silently restored to full by the very event the one-retry rule must survive.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-earlier-backoff",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "REDUCE_CONTEXT_PACK_SHARE",
      payload: { stageAttemptId: seeded.stageAttemptId },
    });

    // A brand new loop, as after a restart: it has never reduced anything itself.
    await runStageAttempt(depsFor(localState, seeded, finishingAdapter(4_000)));

    const atFullShare = Math.floor(4_000 * 0.35);
    const { recipes } = sessionRows(localState, seeded.stageAttemptId);
    expect(recipes[0]?.budgetTokens).toBe(Math.floor(4_000 * (0.35 - 0.1)));
    expect(recipes[0]?.budgetTokens).not.toBe(atFullShare);
  });

  it("hard-pauses on a provider failure without shrinking the pack first", async () => {
    // §6.3 routes failures to existing handling; only a size rejection belongs in §7's backoff.
    // Answering a transient error by shrinking the pack would send the owner after the wrong thing.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const broken: ProviderAdapter = {
      capabilities: () =>
        providerCapabilitiesSchema.parse({
          provider: "MOCK",
          start: true,
          interrupt: true,
          eventStream: false,
          usageReporting: true,
          contextWindowReporting: false,
          checkpointOnRequest: false,
          contextWindowTokens: 4_000,
        }),
      start: () => Promise.reject(new Error("the provider socket closed")),
      requestHandoff: () => Promise.resolve(),
      abortSession: () => Promise.resolve(),
    };

    await runStageAttempt(depsFor(localState, seeded, broken));

    const snapshot = snapshotOf(localState, seeded.workItemId);
    expect(sessionRows(localState, seeded.stageAttemptId).sessions).toHaveLength(1);
    expect(snapshot.stageAttempts.at(0)?.packShareBackoffs).toBe(0);
    expect(snapshot.stageAttempts.at(0)?.failureCode).toBe("PROVIDER_START_FAILED");
    expect(snapshot.humanRequests[0]?.title).not.toMatch(/context pack/);
  });

  it("rejects a checkpoint that does not satisfy the contract and leaves the session unproductive", async () => {
    // Spec §7: half-accepting a checkpoint is not an option, because the next pack is built on it.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const sloppy = createMockProvider({
      contextWindowTokens: 4_000,
      tokensPerTurn: 100,
      checkpointEvery: 1,
      hitTheWallAfterTurns: 1,
      emitInvalidCheckpoint: true,
    });

    await runStageAttempt(depsFor(localState, seeded, sloppy));

    const { sessions, checkpoints } = sessionRows(localState, seeded.stageAttemptId);
    // The provider published on every turn; none of it was accepted, so none of it was recorded.
    expect(checkpoints).toHaveLength(0);
    expect(sessions).toHaveLength(2);
    const snapshot = snapshotOf(localState, seeded.workItemId);
    expect(snapshot.stageAttempts.at(0)?.unproductiveSessions).toBe(2);
    expect(snapshot.run?.status).toBe("HARD_PAUSED");
  });

  it("does not let a failed checkpoint write dissolve into a log line", async () => {
    // Spec §6.2: the agent believes it published progress and the next pack would be assembled
    // without it. If the loop merely ended the session, the attempt would sit RUNNING with a
    // consumed dispatch and nobody would ever be told.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const refusesCheckpoints: LocalState = {
      ...localState,
      execute: (command) => {
        if (command.type === "PUBLISH_CHECKPOINT") throw new Error("the checkpoint could not be written");
        return localState.execute(command);
      },
    };
    const publishing = createMockProvider({
      contextWindowTokens: 4_000,
      tokensPerTurn: 100,
      checkpointEvery: 1,
      hitTheWallAfterTurns: 1,
    });

    await runStageAttempt(depsFor(refusesCheckpoints, seeded, publishing));

    const { sessions, checkpoints } = sessionRows(localState, seeded.stageAttemptId);
    expect(checkpoints).toHaveLength(0);
    expect(sessions.map(({ endReason }) => endReason)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
    const snapshot = snapshotOf(localState, seeded.workItemId);
    expect(snapshot.run?.status).toBe("HARD_PAUSED");
    expect(snapshot.humanRequests).toHaveLength(1);
  });

  it("lets the owner answer the hard pause and puts the stage back to work", async () => {
    // The property the whole pause exists for, and the one nothing proved before: a pause with a
    // question the system will never accept an answer to is a stopped pipeline, not a question.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const unproductive = createMockProvider({
      contextWindowTokens: 4_000,
      tokensPerTurn: 100,
      checkpointEvery: 1_000,
      hitTheWallAfterTurns: 1,
    });
    await runStageAttempt(depsFor(localState, seeded, unproductive));

    const paused = snapshotOf(localState, seeded.workItemId);
    expect(paused.run?.status).toBe("HARD_PAUSED");
    const request = paused.humanRequests[0];
    if (!request) throw new Error("The hard pause did not open a Human Request");

    const answered = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-answer",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ANSWER_HUMAN_REQUEST",
      payload: {
        humanRequestId: request.id,
        expectedVersion: request.version,
        answer: { type: "OTHER", text: "Split the migration out first, then run this stage again." },
      },
    });
    expect(answered.type).toBe("HUMAN_REQUEST_ANSWERED");

    const resumed = snapshotOf(localState, seeded.workItemId);
    expect(resumed.run?.status).toBe("RUNNING");
    expect(resumed.stageAttempts.at(0)?.status).toBe("QUEUED");
    expect(resumed.stageAttempts.at(0)?.failureCode).toBeNull();
    expect(resumed.humanRequests.every(({ status }) => status === "RESOLVED")).toBe(true);
    // The owner's words become a Decision, so the next session's pack carries what they said about
    // the stall -- the reason for asking rather than merely pausing.
    expect(resumed.decisions).toHaveLength(1);
    const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
    if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatches");
    expect(pending.dispatches.map(({ mode }) => mode)).toContain("RESUME");
  });
});
