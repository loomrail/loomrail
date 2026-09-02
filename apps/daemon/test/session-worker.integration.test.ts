import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import type { ProviderAdapter, ProviderInvocation } from "@loomrail/provider-core";
import { createMockProvider } from "@loomrail/provider-mock";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import { summariseChanges } from "@loomrail/workspace";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionWorker, DISPATCH_CYCLE_LIMIT, type SessionWorker } from "../src/session-worker.js";
import { createBrowserQAStageRunner } from "../src/browser-qa-runner.js";
import { passingBrowserQADriver, readyBrowserQAConfig } from "./browser-qa-fixture.js";
import { gatedAdapter } from "./gated-adapter.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";
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
    stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
    costReporting: false,
  }),
  start: () => Promise.reject(new Error("adapterThatDoesNothing.start should never be called")),
  requestHandoff: () => Promise.resolve(undefined),
  abortSession: () => Promise.resolve(undefined),
});

// `capabilities()` is called synchronously at the very top of `runStageAttempt`, outside any
// try/catch there -- throwing from it is the simplest way to make the loop itself throw, as
// opposed to a rejected `start()`, which `runStageAttempt` already turns into a handled FAILED
// outcome and is not "a throw inside the loop" at all.
const adapterThatThrows = (): ProviderAdapter => ({
  capabilities: () => {
    throw new Error("synthetic capabilities failure");
  },
  start: () => Promise.reject(new Error("unreachable: capabilities() throws first")),
  requestHandoff: () => Promise.resolve(undefined),
  abortSession: () => Promise.resolve(undefined),
});

// Measured against "takes another pass", the heaviest test in this file: two work items cascading
// through all six `mockDeliveryTemplate` stages (~24 provider sessions, each with context assembly
// and synchronous SQLite writes) took well under a second on an idle machine. This machine
// periodically runs at load average 60-90, though, where the same work can take many times that --
// so the bound is set an order of magnitude above the idle measurement, as a backstop against a
// worker that is genuinely stuck rather than a race against one that is merely slow.
const IDLE_TIMEOUT_MS = 15_000;

// Bounds every "wait for the worker to finish" checkpoint below, so that a worker which is
// genuinely stuck -- a pass that never returns, an idle waiter nothing ever settles -- fails on the
// `expect` here rather than on vitest's blanket per-test timeout, which reports the whole test as
// having timed out and names no behaviour at all.
//
// It is a backstop, not a discriminator: none of the mutations these tests are written against
// leave `whenIdle()` unresolved. `settleIdle()` runs in `pump`'s `finally` unconditionally, so
// every pass that starts settles its waiters however it ends. Any test that means to discriminate
// has to assert something else as well; see "takes another pass ..." below.
type HidingState = LocalState & { hideUntilQueueLooksEmpty: (workItemId: string) => void };

/**
 * A `LocalState` that withholds one work item's dispatches from `LIST_PENDING_DISPATCHES` until the
 * worker has read the queue and found it (apparently) empty, and reveals them from then on.
 *
 * This is what gives "takes another pass" a discriminator. `runOnce`'s own cycle loop re-reads the
 * pending-dispatch table on every cycle, so work enqueued while a pass is still running is picked up
 * by *that* pass -- which is why asserting on a drained queue alone cannot tell
 * `while (pending && !stopping)` from a single `if`. Withholding the second work item until the
 * running pass has already concluded the queue is empty puts it strictly out of that pass's reach:
 * only a pass that starts afterwards can see it, and only the `while` starts one.
 *
 * Nothing else is intercepted -- every other query and every `execute` goes straight through -- so
 * the worker still drives the real persistence layer and the real workflow template.
 */
const stateHidingOneWorkItem = (localState: LocalState): HidingState => {
  let hiddenWorkItemId: string | null = null;
  return {
    ...localState,
    hideUntilQueueLooksEmpty: (workItemId) => {
      hiddenWorkItemId = workItemId;
    },
    query: (request) => {
      const result = localState.query(request);
      if (hiddenWorkItemId === null) return result;
      if (request.type !== "LIST_PENDING_DISPATCHES" || result.type !== "WORKFLOW_DISPATCHES") {
        return result;
      }
      const visible = result.dispatches.filter(({ workItemId }) => workItemId !== hiddenWorkItemId);
      // The read that returns nothing is the one that ends the pass in progress (`runOnce` returns
      // on an empty head). Revealing here, on that read, means the reveal lands after that pass has
      // committed to finishing and before any later pass takes its first look.
      if (visible.length === 0) hiddenWorkItemId = null;
      return { ...result, dispatches: visible };
    },
  };
};

const awaitIdle = async (worker: Pick<SessionWorker, "whenIdle">): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      worker.whenIdle().then((): "idle" => "idle"),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, IDLE_TIMEOUT_MS);
      }),
    ]);
    expect(settled).toBe("idle");
  } finally {
    clearTimeout(timer);
  }
};

// The pending queue by id rather than by mode: which dispatches are still there is what the
// skip-and-continue behaviour is about, and `pendingDispatchModes` cannot tell two apart.
const pendingDispatchIds = (localState: LocalState): string[] => {
  const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
  if (pending.type !== "WORKFLOW_DISPATCHES") throw new Error("Expected dispatches");
  return pending.dispatches.map(({ id }) => id);
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
      // Zero-padded, so a generated id sorts the way it was created. `LIST_PENDING_DISPATCHES`
      // orders by `created_at` then `id`, and every row here carries the same fixed timestamp --
      // with a bare counter, `workflowDispatch-20` sorts before `workflowDispatch-8`, so which of
      // two seeded dispatches is the head of the queue depended on how many ids happened to have
      // been minted before them.
      createId: (kind) => `${kind}-${(nextId += 1).toString().padStart(4, "0")}`,
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

  it("starts at most three attempts and does not oversubscribe on wakes mid-flight", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger,
    });
    const seeded = Array.from({ length: 4 }, () => seedQueuedAttempt(localState));
    const fourth = seeded[3];
    if (!fourth) throw new Error("Expected a fourth queued attempt");

    worker.wake();
    await adapter.whenStarted(3);
    worker.wake();
    worker.wake();

    expect(adapter.startCallCount).toBe(3);
    expect(localState.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" })).toMatchObject({
      type: "AGENT_RUNS",
      runs: [{}, {}, {}],
    });
    expect(pendingDispatchIds(localState)).toContain(fourth.dispatch.id);

    // Mid-flight wakes neither create a fourth slot nor settle idle waiters while three provider
    // sessions still own their durable reservations.
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
  }, 20_000);

  it("applies Project and provider limits without blocking an independent scope", async () => {
    const localState = state();
    const codex = gatedAdapter(200_000, { provider: "CODEX" });
    const mock = gatedAdapter(200_000, { provider: "MOCK" });
    const projectOne = "project-one";
    const projectTwo = "project-two";
    const projectThree = "project-three";
    const first = seedQueuedAttemptFixture(localState, createCommandId, temporaryDirectory, projectOne);
    const sameProject = seedQueuedAttemptFixture(localState, createCommandId, temporaryDirectory, projectOne);
    const independent = seedQueuedAttemptFixture(localState, createCommandId, temporaryDirectory, projectTwo);
    const sameProvider = seedQueuedAttemptFixture(
      localState,
      createCommandId,
      temporaryDirectory,
      projectThree,
    );
    const worker = createSessionWorker({
      state: localState,
      resolveAdapter: (projectId) => (projectId === projectTwo ? mock : codex),
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger: createRecordingLogger(),
      schedulingLimits: {
        global: 3,
        projects: { [projectOne]: 1 },
        providers: { CODEX: 1 },
      },
    });

    worker.wake();
    await Promise.all([codex.whenStarted(1), mock.whenStarted(1)]);

    expect(codex.startCallCount).toBe(1);
    expect(mock.startCallCount).toBe(1);
    const active = localState.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" });
    if (active.type !== "AGENT_RUNS") throw new Error("Expected active AgentRuns");
    expect(active.runs.map(({ stageAttemptId }) => stageAttemptId)).toHaveLength(2);
    expect(active.runs.map(({ stageAttemptId }) => stageAttemptId)).toEqual(
      expect.arrayContaining([first.stageAttemptId, independent.stageAttemptId]),
    );
    expect(pendingDispatchIds(localState)).toEqual(
      expect.arrayContaining([sameProject.dispatch.id, sameProvider.dispatch.id]),
    );

    codex.release();
    mock.release();
    await awaitIdle(worker);
  }, 20_000);

  // Spec §4, «сигнал не теряется»: the wake that arrived mid-attempt has to be honoured after it,
  // or a dispatch enqueued by an HTTP request after `runOnce`'s last queue read would sit there
  // until something unrelated woke the worker.
  //
  // The discriminator is `stateHidingOneWorkItem`, not `awaitIdle`. `pending` is cleared at the top
  // of the pump's loop body and `settleIdle()` in its `finally` is unconditional, so reducing
  // `while (pending && !stopping)` to a single `if` strands nothing and leaves `whenIdle()`
  // resolving exactly as before -- an earlier version of this test claimed otherwise and stayed
  // green under that mutation. What the second pass is genuinely needed for is work the first pass
  // could no longer see, which is what the hiding state manufactures deterministically.
  it("takes another pass for a wake that arrived while it was busy", async () => {
    const localState = state();
    const workerState = stateHidingOneWorkItem(localState);
    const adapter = gatedAdapter();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: workerState,
      adapter,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger,
    });
    seedQueuedAttempt(localState);

    worker.wake();
    await adapter.started;
    const late = seedQueuedAttempt(localState);
    workerState.hideUntilQueueLooksEmpty(late.workItemId);
    worker.wake();
    adapter.release();

    await awaitIdle(worker);

    // The late work item was invisible to the pass that was running when it was seeded, so a queue
    // that is empty now says a *second* pass ran and drained it. Under `if`, its dispatch is still
    // sitting here.
    expect(pendingDispatchModes(localState)).toEqual([]);
    expect(snapshotOf(localState, late.workItemId).run?.status).not.toBe("RUNNING");
    // The reveal is triggered by a read that comes back empty, and a pass that stops at
    // DISPATCH_CYCLE_LIMIT never makes one -- so a template long enough to hit the limit would
    // strand the late item for a reason that has nothing to do with the property under test.
    expect(logger.records.map(({ msg }) => msg)).not.toContain(
      "The workflow dispatch queue exceeded its safety limit",
    );
  }, 20_000);

  it("resolves whenIdle only once the queue is empty", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);
    worker.wake();
    await adapter.started;

    // Registered while `running` is true and the session is still gated, this waiter is only ever
    // notified through `settleIdle()` -- a fresh call to `whenIdle()` made *after* the queue empties
    // would instead take the immediate `Promise.resolve()` branch and prove nothing about this one.
    // There is no check here for "still unsettled before release()": nothing between registering
    // this waiter and calling release() re-enters `pump()`, which is the only place a premature
    // settle could happen, so that check would hold no matter what `settleIdle()` did. The
    // discriminating question is only answered after release(): does *this* waiter get notified.
    let settled = false;
    void worker.whenIdle().then(() => {
      settled = true;
    });

    adapter.release();
    await awaitIdle(worker);
    expect(settled).toBe(true);
  }, 20_000);

  it("drives a CODEX-shaped real-repository route to the owner acceptance gate", async () => {
    const localState = state();
    await makeThrowawayRepo(join(temporaryDirectory, "project-web"));
    const seenStages: ProviderInvocation["session"]["stage"][] = [];
    const seenHumanRequestPolicies: ProviderInvocation["humanRequests"][] = [];
    let discoveryResumeContext = "";
    let acceptanceHadWorkspace = true;
    const adapter: ProviderAdapter = {
      capabilities: () => ({
        provider: "CODEX",
        start: true,
        interrupt: true,
        eventStream: false,
        usageReporting: false,
        contextWindowReporting: false,
        checkpointOnRequest: false,
        contextWindowTokens: 128_000,
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: false,
      }),
      start: async (invocation) => {
        const stage = invocation.session.stage;
        seenStages.push(stage);
        seenHumanRequestPolicies.push(invocation.humanRequests);
        if (stage === "DISCOVERY" && invocation.dispatch.mode === "RESUME") {
          discoveryResumeContext = invocation.contextPack.text;
        }
        if (stage === "DISCOVERY" && invocation.dispatch.mode === "START") {
          return {
            type: "NEEDS_HUMAN",
            request: {
              kind: "SINGLE_CHOICE",
              blocking: true,
              title: "Choose the compatibility target",
              context: "The synthetic repository supports one bounded target at a time.",
              recommendation: "Keep the existing target.",
              options: [
                {
                  id: "existing-target",
                  label: "Existing target",
                  consequence: "Implement the smallest compatible change.",
                  recommended: true,
                },
              ],
              allowOther: false,
            },
          };
        }
        if (stage === "IMPLEMENT") {
          if (!invocation.workspace) throw new Error("IMPLEMENT must receive its worktree");
          await writeFile(
            join(invocation.workspace.path, "d2-live-result.txt"),
            "A live-shaped implementation changed this real Git worktree.\n",
            "utf8",
          );
        }
        if (stage === "REVIEW") {
          return {
            type: "COMPLETED",
            summary: "The independent review passed.",
            artifacts: [
              {
                kind: "REVIEW_REPORT",
                title: "Independent live-shaped review",
                summary: "The bounded worktree change matches the recorded decision.",
                checks: ["Decision traced", "Changed path reviewed"],
              },
            ],
            reviewReport: {
              kind: "REVIEW_REPORT",
              title: "Independent live-shaped review",
              summary: "The bounded worktree change matches the recorded decision.",
              checks: ["Decision traced", "Changed path reviewed"],
              verdict: "PASSED",
              findings: [],
            },
          };
        }
        if (stage === "QA") {
          return {
            type: "COMPLETED",
            summary: "The bounded QA pass completed.",
            artifacts: [
              {
                kind: "QA_REPORT",
                title: "Live-shaped QA",
                summary: "The synthetic acceptance check passed.",
                checks: ["Expected file exists", "Expected content recorded"],
              },
            ],
          };
        }
        if (stage === "ACCEPTANCE") {
          acceptanceHadWorkspace = "workspace" in invocation;
          const acceptanceInput = invocation.acceptanceInput;
          const reviewCheck = acceptanceInput?.evidence.filter(({ kind }) => kind === "REVIEW_REPORT").at(-1)
            ?.checks[0];
          const qaCheck = acceptanceInput?.evidence.filter(({ kind }) => kind === "QA_REPORT").at(-1)
            ?.checks[0];
          if (!acceptanceInput || !reviewCheck || !qaCheck) {
            throw new Error("Acceptance requires current criteria and evidence checks");
          }
          return {
            type: "READY_FOR_ACCEPTANCE",
            releaseNote: "Adds the bounded D2 result after Review and QA.",
            verifyInstructions: ["Inspect d2-live-result.txt in the worktree."],
            criteria: acceptanceInput.criteria.map((criterion) => ({
              criterion,
              implementation: "The bounded D2 result was written to the leased worktree.",
              reviewCheck,
              qaCheck,
              ownerVerification: "Inspect d2-live-result.txt in the worktree.",
              knownRisk: null,
            })),
          };
        }
        return {
          type: "COMPLETED",
          summary: `${stage} completed from the durable context pack.`,
        };
      },
      requestHandoff: () => Promise.resolve(),
      abortSession: () => Promise.resolve(),
    };
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger,
      browserQA: createBrowserQAStageRunner({
        state: localState,
        driver: passingBrowserQADriver(),
        resolveConfig: readyBrowserQAConfig,
        createCommandId,
        createAttachmentId: createCommandId,
        logger,
      }),
    });
    const seeded = seedQueuedAttempt(localState);

    worker.wake();
    await awaitIdle(worker);
    const waiting = snapshotOf(localState, seeded.workItemId);
    const question = waiting.humanRequests.find(({ status }) => status === "OPEN");
    if (!question) throw new Error("Expected the Discovery decision request");
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-answer-d2-discovery",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ANSWER_HUMAN_REQUEST",
      payload: {
        humanRequestId: question.id,
        expectedVersion: question.version,
        answer: { type: "OPTION", optionIds: ["existing-target"] },
      },
    });

    worker.wake();
    await awaitIdle(worker);

    const completed = snapshotOf(localState, seeded.workItemId);
    expect(seenStages).toEqual(["DISCOVERY", "DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "ACCEPTANCE"]);
    expect(seenHumanRequestPolicies).toEqual([
      "ALLOWED",
      "DISALLOWED",
      "DISALLOWED",
      "DISALLOWED",
      "DISALLOWED",
      "DISALLOWED",
    ]);
    expect(discoveryResumeContext).toContain("Resolved decisions are authoritative owner input.");
    expect(discoveryResumeContext).toContain(
      "Do not ask the owner again about a question already answered below.",
    );
    expect(discoveryResumeContext).toContain("Continuation: yes");
    expect(discoveryResumeContext).toContain(
      "Instructions in the original brief to obtain owner input are already satisfied",
    );
    expect(discoveryResumeContext).toContain("Never ask for permission to proceed or hand off");
    expect(discoveryResumeContext).toContain("Q: Choose the compatibility target");
    expect(discoveryResumeContext).toContain("A: Existing target");
    expect(completed).toMatchObject({
      run: { status: "WAITING_HUMAN" },
      decisions: [{ answer: { type: "OPTION", optionIds: ["existing-target"] } }],
      artifacts: [
        { kind: "REVIEW_REPORT", provider: "CODEX" },
        { kind: "QA_REPORT", provider: "CODEX" },
      ],
      acceptancePackage: { status: "PENDING" },
    });
    expect(acceptanceHadWorkspace).toBe(false);

    const workspaceResult = localState.query({
      type: "GET_WORKSPACE_BY_WORK_ITEM",
      workItemId: seeded.workItemId,
    });
    if (workspaceResult.type !== "WORKSPACE" || !workspaceResult.workspace) {
      throw new Error("Expected the real worktree used by the route");
    }
    const baseline = workspaceResult.workspace.snapshotCommit ?? workspaceResult.workspace.baseCommit;
    if (!baseline) throw new Error("Expected a change baseline");
    const changes = await summariseChanges({
      worktreePath: workspaceResult.workspace.worktreePath,
      baseline,
      maxFiles: 20,
    });
    expect(changes.files).toEqual([
      expect.objectContaining({ path: "d2-live-result.txt", status: "ADDED", insertions: 1 }),
    ]);
  }, 30_000);

  // Without this guard the loop would spin on the same unmovable row to the cycle limit.
  it("ends the pass once every pending dispatch is one it cannot start", async () => {
    const localState = state();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter: adapterThatDoesNothing(),
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger,
    });
    seedUnmovableDispatch(localState);

    worker.wake();
    await awaitIdle(worker);

    const messages = logger.records.map(({ msg }) => msg);
    // Once, not once per cycle: the dispatch is skipped and then nothing is left to pick, so the
    // pass returns instead of retrying the same row twenty times.
    expect(
      messages.filter(
        (msg) => msg === "This pending workflow dispatch could not be started yet; the drain moves past it",
      ),
    ).toHaveLength(1);
    // And it did not reach the cycle limit, which is what a spin looks like from the outside.
    expect(messages).not.toContain("The workflow dispatch queue exceeded its safety limit");
  }, 20_000);

  // Spec §7 postpones a dispatch whose work item's workspace is being written by another attempt,
  // and `runStageAttempt` returns quietly when a session is already running on the attempt. Both
  // leave the dispatch PENDING. The queue is strict FIFO, so while the worker took `dispatches[0]`
  // and returned as soon as the head had not moved, either of those -- legitimate, concurrent, or
  // transient -- stopped every newer dispatch behind it until the daemon restarted.
  it("runs a newer dispatch that is queued behind one it cannot start yet", async () => {
    const localState = state();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter: createMockProvider(),
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger,
    });
    // Seeded in this order, so the unmovable one is genuinely the head the FIFO query returns
    // first and the runnable one is genuinely behind it.
    const blockedHead = seedUnmovableDispatch(localState);
    const behind = seedQueuedAttempt(localState);

    // The premise, asserted rather than assumed: `LIST_PENDING_DISPATCHES` orders by `created_at`
    // then `id`, and every id in these tests carries the same fixed timestamp -- so which of the
    // two is the head is decided by a string comparison, and a test that merely seeded them in
    // order could be passing with the runnable one in front and never touch the defect at all.
    expect(pendingDispatchIds(localState)[0]).toBe(blockedHead.dispatch.id);

    worker.wake();
    await awaitIdle(worker);

    // The work item behind the blocked head ran to a decision of its own rather than waiting for a
    // daemon restart. Asserted first: this is the whole defect.
    expect(snapshotOf(localState, behind.workItemId).stageAttempts[0]?.status).not.toBe("QUEUED");
    const stillPending = pendingDispatchIds(localState);
    expect(stillPending).not.toContain(behind.dispatch.id);
    // And the head was not lost, run twice, or completed on its behalf -- it is exactly where it
    // was, for the next wake to pick up once whoever holds it lets go.
    expect(stillPending).toContain(blockedHead.dispatch.id);
    expect(logger.records.map(({ msg }) => msg)).toContain(
      "This pending workflow dispatch could not be started yet; the drain moves past it",
    );
  }, 20_000);

  // Skipping a head is only half the fix; not PAYING for the skip on every dispatch behind it is
  // the other half. `blocked` was cleared the moment any dispatch completed, so a permanently
  // unstartable head was offered a fresh turn after each one that ran: every runnable dispatch then
  // cost two cycles instead of one, and half of DISPATCH_CYCLE_LIMIT went on a row that could never
  // move. The queue ended by hitting its safety limit -- logged at error level, on a queue that was
  // working -- and whatever it had not reached waited for an external `wake()`, of which there is
  // no timer.
  it("does not spend the pass's safety budget re-offering a head it cannot start", async () => {
    const localState = state();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter: createMockProvider(),
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger,
    });
    const blockedHead = seedUnmovableDispatch(localState);
    // Enough runnable dispatches that the old two-cycles-each cost cannot finish them, and few
    // enough that one cycle each comfortably can. The fixed loop spends `runnable + 3` cycles here
    // -- one to pick the head, one per runnable dispatch, one to give the head its single retry once
    // nothing else is left, and one to find nothing pickable and stop -- so 15 fits inside 20 with
    // room to spare, while the old loop reached the limit after running only 10 of them.
    const runnableCount = DISPATCH_CYCLE_LIMIT - 5;
    const runnable = Array.from({ length: runnableCount }, () => seedQueuedAttempt(localState));

    // The premise, asserted rather than assumed, as in the test above: the unstartable dispatch is
    // genuinely the head of the FIFO, and everything else is genuinely behind it.
    expect(pendingDispatchIds(localState)[0]).toBe(blockedHead.dispatch.id);
    expect(pendingDispatchIds(localState)).toHaveLength(runnableCount + 1);

    worker.wake();
    await awaitIdle(worker);

    // Every one of them ran, in this single pass. Under the defect, five were still sitting here
    // with nothing scheduled to come back for them.
    expect(pendingDispatchIds(localState)).toEqual([blockedHead.dispatch.id]);
    for (const seeded of runnable) {
      expect(snapshotOf(localState, seeded.workItemId).stageAttempts[0]?.status).not.toBe("QUEUED");
    }
    const messages = logger.records.map(({ msg }) => msg);
    // The pass ended because it was finished, not because it ran out of budget. This is the line
    // that appeared at error level on a perfectly healthy queue.
    expect(messages).not.toContain("The workflow dispatch queue exceeded its safety limit");
    // Twice, not once per completed dispatch: the head is tried, set aside for the rest of the
    // queue, and offered exactly one more turn once nothing else is left -- because by then a
    // completion may have released whatever it was waiting on.
    expect(
      messages.filter(
        (msg) => msg === "This pending workflow dispatch could not be started yet; the drain moves past it",
      ),
    ).toHaveLength(2);
  }, 40_000);

  // The background loop has no caller to hand a 500 to. A throw must stay inside it, and must not
  // leave the worker permanently busy -- which is what would make every later wake a no-op.
  it("keeps a throw inside the loop and stays able to run again", async () => {
    const localState = state();
    const logger = createRecordingLogger();
    const worker = createSessionWorker({
      state: localState,
      adapter: adapterThatThrows(),
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
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
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger: createRecordingLogger(),
    });
    healthy.wake();
    await awaitIdle(healthy);
    expect(snapshotOf(localState, seeded.workItemId).run?.status).not.toBe("RUNNING");
  }, 20_000);

  it("asks the live session to abort when stopped", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);
    seedQueuedAttempt(localState);
    seedQueuedAttempt(localState);
    worker.wake();
    await adapter.whenStarted(3);

    await worker.stop();

    expect(adapter.abortedSessions).toHaveLength(3);
    adapter.release();
  }, 20_000);

  it("aborts through the adapter captured by the live session after selection changes", async () => {
    const localState = state();
    const first = gatedAdapter();
    const second = gatedAdapter();
    let selected: ProviderAdapter = first;
    const worker = createSessionWorker({
      state: localState,
      resolveAdapter: () => selected,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);
    worker.wake();
    await first.started;

    selected = second;
    await worker.stop();

    expect(first.abortedSessions).toHaveLength(1);
    expect(second.abortedSessions).toHaveLength(0);
    first.release();
  }, 20_000);

  // Before the fix, `whenIdle()` called after `stop()` still took the "register a waiter" branch
  // whenever a pass was in flight, and only `pump`'s own `finally` -- reached when the gated session
  // actually finishes -- could resolve it. `stopping` is never reset and `wake()` is a permanent
  // no-op once it is set, so that waiter was unreachable: nothing left could ever call `settleIdle()`
  // again. `stop()` exists precisely so a caller does not have to wait for the in-flight session; a
  // `whenIdle()` call made here, before `release()`, while the session is still gated, can only pass
  // if `whenIdle()` itself short-circuits on `stopping` rather than waiting on the pass to finish.
  it("resolves whenIdle immediately after stop, even mid-pass", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);
    worker.wake();
    await adapter.started;

    await worker.stop();
    await awaitIdle(worker);

    adapter.release();
  }, 20_000);

  // `stop()` only sets a flag and aborts the live sessions -- it cannot unwind the provider calls
  // already in flight. Without a check inside `runOnce`'s own cycle loop, the cycle that resumes
  // once those calls settle would fill the newly empty slot on a daemon that was just told to stop.
  it("does not open a new session in the same pass once stopped", async () => {
    const localState = state();
    const adapter = gatedAdapter();
    const worker = createSessionWorker({
      state: localState,
      adapter,
      template: mockDeliveryTemplate,
      workspacesRoot: join(temporaryDirectory, "workspaces"),
      createCommandId,
      logger: createRecordingLogger(),
    });
    seedQueuedAttempt(localState);
    seedQueuedAttempt(localState);
    seedQueuedAttempt(localState);
    seedQueuedAttempt(localState);
    worker.wake();
    await adapter.whenStarted(3);
    const startedBeforeStop = adapter.startCallCount;

    await worker.stop();
    adapter.release();

    // Not `awaitIdle(worker)`: `whenIdle()` short-circuits the instant `stopping` is set (the fix
    // above), so it resolves immediately here regardless of what the in-flight pass goes on to do
    // next -- that immediacy is exactly what it is *for*, which is also exactly why it cannot be
    // used to observe whether that pass wrongly starts a second session afterwards. This instead
    // flushes the promise chain `release()` sets off (the gated session ending, its outcome being
    // applied, the cycle loop's next iteration) with a macrotask tick: Node drains the entire
    // microtask queue, however many hops long, before any timer callback runs, so one
    // `setTimeout(0)` is enough regardless of how deep that chain is.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The gated adapter's own count of `start()` invocations -- a real number, not a log line. The
    // second seeded dispatch must never reach it.
    expect(adapter.startCallCount).toBe(startedBeforeStop);
  }, 20_000);
});
