import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventSignal, ProviderActivityEntry, ProviderOutcome, StateCommand } from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import {
  providerCapabilitiesSchema,
  type ProviderAdapter,
  type ProviderSessionListener,
} from "@loomrail/provider-core";
import { deliveryTemplate } from "@loomrail/workflow-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_QUEUE_LIMIT,
  runStageAttempt,
  type RunStageAttemptDeps,
  type SessionLoopLogger,
} from "../src/session-loop.js";

import { seedQueuedAttempt, snapshotOf, type SeededAttempt } from "./state-fixtures.js";

const timestamp = "2026-09-02T10:00:00.000Z";

const silentLogger: SessionLoopLogger = {
  info: () => undefined,
  warn: () => undefined,
};

const toolCall = (overrides: Partial<ProviderActivityEntry> = {}): ProviderActivityEntry => ({
  actionKey: "call-1",
  kind: "TOOL_CALL",
  label: "pnpm test",
  detail: null,
  status: null,
  terminal: false,
  truncated: false,
  ...overrides,
});

const completingOutcome = (): ProviderOutcome => ({
  type: "COMPLETED",
  summary: "The provider test session finished the stage.",
});

/**
 * An adapter that reports whatever the test hands it on `listener.onActivity` and then completes
 * normally, exactly the way both live adapters do: they call `onActivity` from inside their stdout
 * handler and go on to produce their own outcome. `onUsage` and `onCheckpoint` are always reported
 * too, because what these tests pin is that a broken feed changes NEITHER.
 */
const reportingAdapter = (report: (listener: ProviderSessionListener) => void): ProviderAdapter => ({
  capabilities: () =>
    providerCapabilitiesSchema.parse({
      provider: "CODEX",
      start: true,
      interrupt: true,
      eventStream: true,
      usageReporting: true,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens: 128_000,
      stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
      costReporting: false,
      tokenBudgetEnforcement: "HARD",
    }),
  start: (_invocation, listener) => {
    listener.onCheckpoint({
      summary: "The synthetic session published progress before reporting any action.",
      completed: ["Read the brief."],
      remaining: ["Finish the implementation."],
      deadEnds: [],
      openQuestions: [],
    });
    listener.onUsage({ inputTokens: 40, outputTokens: 20, quality: "ACTUAL" });
    report(listener);
    return Promise.resolve(completingOutcome());
  },
  requestHandoff: () => Promise.resolve(),
  abortSession: () => Promise.resolve(),
});

/**
 * The same store with one command type made to fail, so a test can break the activity feed without
 * breaking anything else the session writes. Wrapping `execute` is how `broadcastingState` composes
 * over a store too, so this is the production seam rather than a test-only hole.
 */
const failingCommands = (state: LocalState, types: ReadonlySet<StateCommand["type"]>): LocalState => ({
  ...state,
  execute: (command) => {
    if (types.has(command.type)) throw new Error("The activity write was refused by this test");
    return state.execute(command);
  },
});

type ActivityFeed = {
  entries: readonly { label: string | null; detail: string | null; status: string | null }[];
  degraded: boolean;
};

describe("activity recorder", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let nextCommandId = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail session activity "));
    databasePath = join(temporaryDirectory, "local state.sqlite");
    nextId = 0;
    nextCommandId = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
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

  const seedRunningAttempt = (localState: LocalState): SeededAttempt & { agentRunId: string } => {
    const seeded = seedQueuedAttempt(localState, createCommandId, temporaryDirectory);
    const started = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-agent-run",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: seeded.dispatch.id,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    if (started.type !== "AGENT_RUN_STARTED") throw new Error("Expected a started AgentRun");
    return { ...seeded, agentRunId: started.run.id };
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
    template: deliveryTemplate,
    workspacesRoot: join(temporaryDirectory, "workspaces"),
    createCommandId,
    correlationId: "correlation-session-activity",
    logger: silentLogger,
    ...overrides,
  });

  // Read through the raw buffer query rather than the merged feed: this suite is about the recorder
  // that fills the buffer, and Task 8's reader is a separate thing to be wrong about.
  const activityOf = (localState: LocalState, agentRunId: string): ActivityFeed => {
    const result = localState.query({ type: "LIST_AGENT_RUN_ACTIVITY", agentRunId, limit: 1_000 });
    if (result.type !== "AGENT_RUN_ACTIVITY") throw new Error("Expected an activity page");
    return {
      entries: result.entries.map(({ label, detail, status }) => ({ label, detail, status })),
      degraded: result.degraded,
    };
  };

  const usageTotals = (localState: LocalState, stageAttemptId: string): number[] => {
    const result = localState.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
    if (result.type !== "PROVIDER_SESSIONS") throw new Error("Expected provider sessions");
    return result.usageReports.map(({ totalTokens }) => totalTokens);
  };

  const checkpointSummaries = (localState: LocalState, stageAttemptId: string): string[] => {
    const result = localState.query({ type: "LIST_PROVIDER_SESSIONS", stageAttemptId });
    if (result.type !== "PROVIDER_SESSIONS") throw new Error("Expected provider sessions");
    return result.checkpoints.map(({ summary }) => summary);
  };

  it("finishes the run and marks the feed degraded when every activity write throws", async () => {
    // The defect this closes is the one that would matter most: a diagnostic feed able to change
    // what a run did. The recorder sits inside the adapter's stdout handler, where `process-runner`
    // turns a throw into a stopped child and a failed session, so a broken write has to cost the
    // feed and nothing else -- not the outcome, not the usage, not the checkpoints.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const adapter = reportingAdapter((listener) => {
      listener.onActivity?.(toolCall());
      listener.onActivity?.(toolCall({ actionKey: "call-2", label: "git status" }));
    });

    await runStageAttempt(
      depsFor(localState, seeded, adapter, {
        state: failingCommands(localState, new Set(["RECORD_AGENT_RUN_ACTIVITY"])),
      }),
    );

    const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.find(
      ({ id }) => id === seeded.stageAttemptId,
    );
    expect(attempt?.status).toBe("SUCCEEDED");
    expect(usageTotals(localState, seeded.stageAttemptId)).toEqual([60]);
    expect(checkpointSummaries(localState, seeded.stageAttemptId)).toHaveLength(1);
    const activity = activityOf(localState, seeded.agentRunId);
    expect(activity.entries).toHaveLength(0);
    expect(activity.degraded).toBe(true);
  });

  it("finishes the run even when the degraded mark cannot be written either", async () => {
    // The end of the same road: the recorder could not record, and could not record that it could
    // not record. There is nothing left for it to do, and still nothing it may do to the session.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const adapter = reportingAdapter((listener) => {
      listener.onActivity?.(toolCall());
    });

    await runStageAttempt(
      depsFor(localState, seeded, adapter, {
        state: failingCommands(
          localState,
          new Set(["RECORD_AGENT_RUN_ACTIVITY", "MARK_AGENT_RUN_ACTIVITY_DEGRADED"]),
        ),
      }),
    );

    const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.find(
      ({ id }) => id === seeded.stageAttemptId,
    );
    expect(attempt?.status).toBe("SUCCEEDED");
    expect(usageTotals(localState, seeded.stageAttemptId)).toEqual([60]);
    expect(activityOf(localState, seeded.agentRunId).entries).toHaveLength(0);
  });

  it("rejects an entry that does not satisfy the contract without failing the run", async () => {
    // Provider output is untrusted input. An empty `actionKey` is the case that matters most: it is
    // the correlation key between an action's start and its completion, so accepting one would
    // merge every keyless report into a single row.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const adapter = reportingAdapter((listener) => {
      listener.onActivity?.(toolCall({ actionKey: "" }));
    });

    await runStageAttempt(depsFor(localState, seeded, adapter));

    const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.find(
      ({ id }) => id === seeded.stageAttemptId,
    );
    expect(attempt?.status).toBe("SUCCEEDED");
    const activity = activityOf(localState, seeded.agentRunId);
    expect(activity.entries).toHaveLength(0);
    // A rejected entry is not a degraded feed: nothing was lost that Loomrail was willing to show.
    expect(activity.degraded).toBe(false);
  });

  it("writes the queue's tail at session end rather than losing it with the session", async () => {
    // Fake timers are the assertion, not a convenience: with `setTimeout` frozen the drain interval
    // can never fire, so an entry that reached the database can only have got there through the
    // forced drain in the session's own `finally`.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const adapter = reportingAdapter((listener) => {
      listener.onActivity?.(toolCall({ label: "  pnpm   test  ", status: "exit 0", terminal: true }));
    });

    vi.useFakeTimers();
    await runStageAttempt(depsFor(localState, seeded, adapter));
    vi.useRealTimers();

    expect(activityOf(localState, seeded.agentRunId)).toEqual({
      entries: [{ label: "pnpm   test", detail: null, status: "exit 0" }],
      degraded: false,
    });
  });

  it("drops the newest entries and degrades the feed when the provider outruns the drain", async () => {
    // The queue is a buffer, not a backlog. An unbounded one would trade a visibly incomplete feed
    // for an invisible memory leak inside a daemon that runs for days.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const overflow = 5;
    const adapter = reportingAdapter((listener) => {
      for (let index = 0; index < ACTIVITY_QUEUE_LIMIT + overflow; index += 1) {
        listener.onActivity?.(toolCall({ actionKey: `call-${index.toString()}` }));
      }
    });

    // Frozen for the same reason as above: without it the drain could fire mid-burst, empty the
    // queue and make the bound unreachable, which would leave this test asserting nothing.
    vi.useFakeTimers();
    await runStageAttempt(depsFor(localState, seeded, adapter));
    vi.useRealTimers();

    const activity = activityOf(localState, seeded.agentRunId);
    expect(activity.entries).toHaveLength(ACTIVITY_QUEUE_LIMIT);
    expect(activity.degraded).toBe(true);
  });

  it("signals the work item once for a burst of actions and never says what changed", async () => {
    // Spec §5.2: three opaque identifiers. The client learns THAT something changed at a scope and
    // refetches over HTTP; a frame that carried the action would put provider output on the channel.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const signals: EventSignal[] = [];
    const adapter = reportingAdapter((listener) => {
      for (let index = 0; index < 20; index += 1) {
        listener.onActivity?.(toolCall({ actionKey: `call-${index.toString()}` }));
      }
    });

    vi.useFakeTimers();
    await runStageAttempt(
      depsFor(localState, seeded, adapter, {
        publishSignal: (signal) => signals.push(signal),
      }),
    );
    // The debounce is what is under test: nothing has been published yet at this point.
    expect(signals).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();

    expect(signals).toEqual([
      {
        projectId: seeded.dispatch.projectId,
        aggregateType: "WORK_ITEM",
        aggregateId: seeded.workItemId,
      },
    ]);
  });

  it("redacts a secret and reduces a worktree path the provider reported", async () => {
    // SD-003: an absolute personal path and a credential are the two things that must never reach
    // the buffer. The path is reduced rather than replaced, because a relative path is what makes
    // the feed readable; anything that does not resolve inside the worktree becomes opaque instead.
    const localState = await open();
    const seeded = seedRunningAttempt(localState);
    const secret = "kx7Qm2ZpLr9TvWs4";
    const adapter = reportingAdapter((listener) => {
      listener.onActivity?.(
        toolCall({
          actionKey: "call-secret",
          label: `export API_KEY=${secret}`,
          terminal: true,
        }),
      );
      listener.onActivity?.(
        toolCall({
          actionKey: "change-1",
          kind: "FILE_CHANGE",
          // This stage runs without a worktree, so there is nothing an absolute path could be
          // relative TO -- and reporting it verbatim is exactly the leak SD-003 forbids.
          label: "/Users/someone/private/notes.md",
          detail: "src/a.ts, ../outside.ts",
          terminal: true,
        }),
      );
    });

    vi.useFakeTimers();
    await runStageAttempt(depsFor(localState, seeded, adapter, { redactValues: [secret] }));
    vi.useRealTimers();

    // Order-insensitive on purpose: the buffer is ordered by observation time, and this suite's
    // clock is frozen, so asserting on order here would pin an id's spelling rather than behaviour.
    const activity = activityOf(localState, seeded.agentRunId);
    expect(activity.entries).toHaveLength(2);
    expect(activity.entries).toEqual(
      expect.arrayContaining([
        { label: "export API_KEY=[REDACTED]", detail: null, status: null },
        { label: "[path outside workspace]", detail: "src/a.ts, ../outside.ts", status: null },
      ]),
    );
  });
});
