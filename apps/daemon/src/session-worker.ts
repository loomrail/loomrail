import type { WorkflowTemplate } from "@loomrail/contracts";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import type { ProviderAdapter } from "@loomrail/provider-core";
import type { FastifyBaseLogger } from "fastify";

import { runStageAttempt } from "./session-loop.js";

/**
 * The bound on how many pending dispatches one pass through the queue may hand to `runStageAttempt`
 * before stopping. Moved from `server.ts`'s `drainProviderDispatches` unchanged (spec §12 Q1).
 */
export const DISPATCH_CYCLE_LIMIT = 20;

export type SessionWorker = {
  wake: () => void;
  whenIdle: () => Promise<void>;
  stop: () => Promise<void>;
};

export type SessionWorkerDeps = {
  state: LocalState;
  adapter: ProviderAdapter;
  template: WorkflowTemplate;
  /** Where a WorkItem's worktree is cut; handed straight to `runStageAttempt` (spec D2). */
  workspacesRoot: string;
  createCommandId: () => string;
  logger: FastifyBaseLogger;
};

/**
 * Runs the whole workflow-dispatch queue as a single background worker (milestone A1.5, spec D4/D5).
 *
 * `wake()` schedules a pass over the pending-dispatch queue; at most one pass runs at a time, and a
 * wake that arrives while a pass is already running is honoured by another pass immediately after,
 * never dropped. `whenIdle()` resolves once no pass is running and none is scheduled. `stop()` asks
 * the live provider session to abort and returns without waiting for it to actually stop (spec D5;
 * that gap belongs to the milestone with an adapter that can fail to stop).
 *
 * Task 8 wires this in as the replacement for `server.ts`'s synchronous `drainProviderDispatches`,
 * which `runOnce` below is a straight copy of.
 */
export const createSessionWorker = (deps: SessionWorkerDeps): SessionWorker => {
  let running = false;
  let pending = false;
  let stopping = false;
  let liveSessionId: string | null = null;
  const idleWaiters: (() => void)[] = [];

  const settleIdle = (): void => {
    for (const waiter of idleWaiters.splice(0)) waiter();
  };

  // The body of `drainProviderDispatches` (server.ts), moved rather than rewritten: the head-of-
  // queue read, the unmoved-head guard and its log line, MARK_WORKFLOW_DISPATCH_STARTED and the
  // runStageAttempt call are all copies. Exactly two outcomes differ from the original, both noted
  // where they happen below.
  const runOnce = async (): Promise<void> => {
    // Dispatches this pass tried and could not move, so it does not try them again and does not
    // stop at them either.
    //
    // `LIST_PENDING_DISPATCHES` is strict FIFO, and this loop used to take `dispatches[0]` and
    // return as soon as the head had not moved. A head that cannot start yet -- its work item's
    // workspace lease is held by a concurrent attempt, or a session is already RUNNING on the
    // attempt -- therefore blocked every newer dispatch behind it until the daemon restarted. A
    // queue that stops at the head is not a queue.
    //
    // Skipping cannot spin, because each cycle does one of exactly two things and both are
    // bounded: it moves a dispatch out of the pending set, or it adds one to `blocked`. Once every
    // pending dispatch is blocked there is nothing left to pick and the pass returns, so a stuck
    // queue costs one pass over it rather than a busy loop -- DISPATCH_CYCLE_LIMIT stays as the
    // backstop it was, not as the thing that ends the pass.
    //
    // And skipping cannot starve: once nothing unblocked is left to pick, `blocked` is cleared and
    // everything gets one more turn in the same pass -- whatever was holding a lease may have given
    // it back while the rest of the queue ran. A dispatch still blocked after that second turn is
    // retried on the next wake, which is what `wake()` is for.
    //
    // WHEN that clear happens is the whole of this loop's cost. Clearing on every completion, which
    // is what this did first, gives a permanently unstartable head a fresh turn after each dispatch
    // that runs -- so every runnable dispatch costs two cycles instead of one, and one such head
    // spends half of DISPATCH_CYCLE_LIMIT. Measured: one unstartable head and fifteen runnable
    // dispatches ran ten of the fifteen, ended by hitting the safety limit, and logged the limit at
    // error level on a queue that was working perfectly; the five that never ran then waited for an
    // external `wake()`, of which there is no timer. Deferring the clear to "nothing left to pick"
    // runs all fifteen in eighteen cycles with the limit untouched.
    const blocked = new Set<string>();
    // Whether any dispatch has actually completed since `blocked` was last given a clean slate. It
    // is what keeps the retry above from becoming the spin the skip was designed to avoid: without
    // it, clearing whenever nothing is pickable would re-offer the same unstartable rows forever,
    // and DISPATCH_CYCLE_LIMIT would be the only thing ending the pass. With it, a retry is only
    // ever spent when something changed that could plausibly have unblocked them.
    let progressedSinceRetry = false;
    let attempted: string | undefined;
    for (let cycle = 0; cycle < DISPATCH_CYCLE_LIMIT; cycle += 1) {
      // `stop()` only sets a flag and aborts the live session -- it does not (and per spec D5,
      // cannot) unwind an `await runStageAttempt(...)` already in flight. Without this check, the
      // cycle that resumes once that await settles would happily pull the *next* pending dispatch
      // and open a brand-new provider session on a daemon that was just told to shut down.
      if (stopping) return;
      const queued = deps.state.query({ type: "LIST_PENDING_DISPATCHES" });
      const dispatches = queued.type === "WORKFLOW_DISPATCHES" ? queued.dispatches : [];

      // What the previous cycle's `runStageAttempt` did, read off the queue rather than off a
      // return value: a dispatch stays PENDING for its whole attempt and is completed by
      // APPLY_PROVIDER_OUTCOME, so "still listed" is exactly "did not close out". `runStageAttempt`
      // returns quietly in that case -- another caller owns the attempt's session, or another
      // StageAttempt holds the work item's workspace lease -- and says so in its own log.
      if (attempted !== undefined) {
        // Copied to a const because the callback below is a closure: TypeScript's narrowing of a
        // `let` does not survive into one, and a non-null assertion would be the wrong way to say
        // what this line already knows.
        const previous = attempted;
        if (dispatches.some(({ id }) => id === previous)) {
          blocked.add(previous);
          deps.logger.info(
            { dispatchId: previous },
            "This pending workflow dispatch could not be started yet; the drain moves past it",
          );
        } else {
          progressedSinceRetry = true;
        }
        attempted = undefined;
      }

      let dispatch = dispatches.find(({ id }) => !blocked.has(id));
      if (!dispatch) {
        // Nothing unblocked left. If something completed since these rows were set aside, they get
        // one more turn in this pass -- that completion may be exactly the lease they were waiting
        // on. If nothing did, this pass has done all it can and the next wake owns the retry.
        if (!progressedSinceRetry) return;
        blocked.clear();
        progressedSinceRetry = false;
        // Nothing is set aside any more, so this is the head of the queue: the same row a pass that
        // had skipped nothing would have taken.
        dispatch = dispatches[0];
        if (!dispatch) return;
      }
      attempted = dispatch.id;

      const snapshotResult = deps.state.query({
        type: "GET_WORKFLOW_SNAPSHOT",
        workItemId: dispatch.workItemId,
      });
      const stageAttempt =
        snapshotResult.type === "WORKFLOW_SNAPSHOT"
          ? snapshotResult.snapshot.stageAttempts.find(({ id }) => id === dispatch.stageAttemptId)
          : undefined;
      if (!stageAttempt) {
        throw new StateStoreError("PERSISTENCE_FAILURE", "A pending workflow dispatch is incomplete");
      }

      // A dispatch whose attempt is already RUNNING was picked back up after a restart: spec §6.4
      // makes that the ordinary end of a ProviderSession, so reconciliation closed the orphaned
      // session and the attempt keeps going from its last checkpoint rather than starting over.
      if (stageAttempt.status !== "RUNNING") {
        const started = deps.state.execute({
          schemaVersion: 1,
          commandId: `mark-started-${dispatch.id}`,
          correlationId: `dispatch-${dispatch.id}`,
          actor: { type: "SYSTEM", id: "local-daemon" },
          type: "MARK_WORKFLOW_DISPATCH_STARTED",
          payload: { dispatchId: dispatch.id },
        });
        if (started.type !== "WORKFLOW_DISPATCH_STARTED") {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The workflow dispatch did not start");
        }
      }

      await runStageAttempt({
        state: deps.state,
        adapter: deps.adapter,
        dispatch,
        template: deps.template,
        workspacesRoot: deps.workspacesRoot,
        createCommandId: deps.createCommandId,
        correlationId: `dispatch-${dispatch.id}`,
        logger: deps.logger,
        onSessionLive: (providerSessionId) => {
          liveSessionId = providerSessionId;
        },
      });
    }
    // There is no HTTP caller left to turn this into a 500 for: the worker has no caller at all.
    // Logging and returning leaves the dispatch exactly where a request-driven drain would have left
    // it after raising -- the next wake tries again rather than taking the whole worker down.
    deps.logger.error(
      { limit: DISPATCH_CYCLE_LIMIT },
      "The workflow dispatch queue exceeded its safety limit",
    );
  };

  const pump = async (): Promise<void> => {
    // A wake arriving mid-pass leaves `pending` set; the loop below picks it up rather than starting
    // a second, concurrent attempt.
    if (running) return;
    running = true;
    try {
      while (pending && !stopping) {
        pending = false;
        try {
          await runOnce();
        } catch (error: unknown) {
          // There is no caller to hand a 500 to any more. The durable consequences of a failed
          // session already live on the StageAttempt (A1 spec §6.5), and a throw leaves a bounded
          // state that RECONCILE_WORKFLOWS repairs on the next start.
          deps.logger.error(
            { error: error instanceof Error ? error.name : "unknown" },
            "The background session worker could not finish a pass",
          );
        }
      }
    } finally {
      running = false;
      // The `while` loop above can only exit once `!pending || stopping` already holds -- nothing
      // between that exit and here can change either flag -- so settling here is unconditional
      // rather than re-testing a condition that is always true by construction.
      settleIdle();
    }
  };

  return {
    wake: () => {
      if (stopping) return;
      pending = true;
      // `pump()` cannot reject today -- every path inside it that can throw is already wrapped by
      // the try/catch around `runOnce()`. The catch is here because nothing enforces that: a future
      // edit that moves work outside that try would turn a rejection here into an unhandled promise
      // rejection, which on Node's default settings terminates the daemon rather than logging.
      void pump().catch((error: unknown) => {
        deps.logger.error(
          { error: error instanceof Error ? error.name : "unknown" },
          "The background session worker's pump rejected",
        );
      });
    },
    whenIdle: () =>
      stopping || (!running && !pending)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
    stop: async () => {
      stopping = true;
      pending = false;
      // Spec D5: the provider is told to stop, and we do not wait to be told it did. `abortSession`
      // resolving is not proof the run ended -- that gap is the next milestone's, where there will
      // finally be an adapter capable of failing to stop.
      if (liveSessionId !== null) {
        await deps.adapter.abortSession(liveSessionId).catch(() => undefined);
      }
      settleIdle();
    },
  };
};
