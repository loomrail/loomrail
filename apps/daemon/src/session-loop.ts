import { assembleContextPack } from "@loomrail/context-assembly";
import {
  checkpointDraftSchema,
  contextPackRecipeInputSchema,
  contextWindowUsageSchema,
  type CheckpointDraft,
  type ContextPackSpec,
  type EndProviderSessionCommand,
  type ProviderOutcome,
  type ProviderSessionEndReason,
  type StageAttempt,
  type WorkflowDispatch,
  type WorkflowTemplate,
} from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import {
  ProviderPackTooLargeError,
  type ProviderAdapter,
  type ProviderSessionListener,
  type ProviderSessionRef,
} from "@loomrail/provider-core";

/**
 * The share of the provider's context window handed to the assembled pack. The rest is the agent's
 * workspace: a pack that filled the window would leave no room for the work itself.
 */
const MAX_PACK_SHARE = 0.35;

/**
 * The reported occupancy at which a session starts winding down (spec §D6). It means "start
 * wrapping up", not "stop": the cut happens at the first checkpoint after it, which is why a
 * threshold below full is what buys the tail back.
 */
const HANDOFF_THRESHOLD = 0.75;

/**
 * How long to wait for a checkpoint after asking a session to wind down before cutting it (§7).
 * `requestHandoff` is a request, not a command; without a deadline an agent that ignores it holds
 * the attempt open forever.
 */
const HANDOFF_DEADLINE_MS = 60_000;

/**
 * How far the pack share drops after a provider rejects a pack Loomrail judged as fitting (§7).
 * One automatic retry, then a Human Request: narrowing the share blindly is guessing, not recovery.
 */
const PACK_SHARE_BACKOFF = 0.1;

/**
 * Bytes per token for LOOMRAIL_ESTIMATE. Deliberately coarse, and deliberately erring toward
 * over-counting bytes: being wrong here should shrink the pack, never overflow the window.
 */
const BYTES_PER_TOKEN = 4;

/**
 * A backstop, not a policy. Spec §6.5's real guards are the unproductive-session counter and the
 * token budget; this exists so that a provider which hands off productively forever cannot spin
 * this loop without bound before either of them fires.
 */
const MAX_SESSIONS_PER_ATTEMPT = 50;

export type SessionLoopLogger = {
  info: (details: Record<string, string | number>, message: string) => void;
  warn: (details: Record<string, string | number>, message: string) => void;
};

export type HandoffDeadline = { cancel: () => void };

/**
 * Injected rather than calling `setTimeout` directly, for the same reason `now` and `createId` are
 * injected everywhere else in this codebase: a test for a wind-down request that is ignored would
 * otherwise have to wait a real HANDOFF_DEADLINE_MS.
 */
export type ScheduleHandoffDeadline = (delayMs: number, onDeadline: () => void) => HandoffDeadline;

export type RunStageAttemptDeps = {
  state: LocalState;
  adapter: ProviderAdapter;
  /** A dispatch already marked started, i.e. one whose StageAttempt is RUNNING. */
  dispatch: WorkflowDispatch;
  template: WorkflowTemplate;
  // No `now` here on purpose: every timestamp this loop writes is stamped inside the state store's
  // own transaction from its injected clock, so a second clock here could only disagree with it.
  createCommandId: () => string;
  correlationId: string;
  logger: SessionLoopLogger;
  scheduleHandoffDeadline?: ScheduleHandoffDeadline;
};

const defaultScheduleHandoffDeadline: ScheduleHandoffDeadline = (delayMs, onDeadline) => {
  const handle = setTimeout(onDeadline, delayMs);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
};

const actor = { type: "SYSTEM", id: "session-loop" } as const;

type SessionOutcome =
  { type: "OUTCOME"; outcome: ProviderOutcome } | { type: "DEADLINE" } | { type: "FAILED"; error: unknown };

const errorName = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";

// Two checkpoints are the same publication when every field matches. Adapters that cannot stream
// deliver their only checkpoint in the outcome (spec §5.1), while streaming adapters deliver it
// through `onCheckpoint` and then repeat it in the outcome -- persisting both would record work
// that happened once as though it happened twice.
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameCheckpoint = (left: CheckpointDraft | null, right: CheckpointDraft): boolean =>
  left !== null &&
  left.summary === right.summary &&
  sameStrings(left.completed, right.completed) &&
  sameStrings(left.remaining, right.remaining) &&
  sameStrings(left.deadEnds, right.deadEnds) &&
  sameStrings(left.openQuestions, right.openQuestions);

const contextPackSpecFor = (template: WorkflowTemplate, stage: StageAttempt["stage"]): ContextPackSpec => {
  const declared = template.stages.find((candidate) => candidate.stage === stage);
  if (!declared) {
    throw new Error(`The workflow template declares no context pack for the ${stage} stage`);
  }
  return declared.contextPack;
};

const readStageAttempt = (deps: RunStageAttemptDeps): StageAttempt => {
  const snapshot = deps.state.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: deps.dispatch.workItemId });
  const attempt =
    snapshot.type === "WORKFLOW_SNAPSHOT"
      ? snapshot.snapshot.stageAttempts.find(({ id }) => id === deps.dispatch.stageAttemptId)
      : undefined;
  if (!attempt) throw new Error("The StageAttempt backing this dispatch no longer exists");
  return attempt;
};

const nextSessionOrdinalFor = (deps: RunStageAttemptDeps): number => {
  const sessions = deps.state.query({
    type: "LIST_PROVIDER_SESSIONS",
    stageAttemptId: deps.dispatch.stageAttemptId,
  });
  if (sessions.type !== "PROVIDER_SESSIONS") throw new Error("Provider sessions could not be read");
  return sessions.sessions.reduce((highest, { ordinal }) => Math.max(highest, ordinal), 0) + 1;
};

const endSessionCommand = (
  deps: RunStageAttemptDeps,
  providerSessionId: string,
  endReason: ProviderSessionEndReason,
  providerStarted = true,
): EndProviderSessionCommand => ({
  schemaVersion: 1,
  commandId: deps.createCommandId(),
  correlationId: deps.correlationId,
  actor,
  type: "END_PROVIDER_SESSION",
  payload: { providerSessionId, endReason, providerStarted },
});

// The adapter's input surface is the pack plus identifiers for correlation (spec §5): `stage` and
// `attempt` are what an adapter legitimately keys a model tier or tool set on, and they are passed
// structurally rather than being parsed back out of the rendered pack text.
const providerSessionRef = (
  session: { id: string; ordinal: number },
  attempt: StageAttempt,
): ProviderSessionRef => ({
  id: session.id,
  ordinal: session.ordinal,
  stageAttemptId: attempt.id,
  stage: attempt.stage,
  attempt: attempt.attempt,
});

/**
 * Runs one StageAttempt as a sequence of context-assembled provider sessions (spec §6).
 *
 * Every session -- the first and every later one alike -- is started the same way: read the context
 * sources as one snapshot, assemble a pack against a share of the adapter's declared window, and
 * write the session, its recipe and the event in one transaction. There is no separate "resume"
 * path, because a resume is just the next assembly from state Loomrail already owns (D1).
 */
export const runStageAttempt = async (deps: RunStageAttemptDeps): Promise<void> => {
  const scheduleDeadline = deps.scheduleHandoffDeadline ?? defaultScheduleHandoffDeadline;
  const capabilities = deps.adapter.capabilities();
  const stageAttemptId = deps.dispatch.stageAttemptId;

  for (let session = 0; session < MAX_SESSIONS_PER_ATTEMPT; session += 1) {
    const attempt = readStageAttempt(deps);
    if (attempt.status !== "RUNNING") {
      deps.logger.info(
        { stageAttemptId, status: attempt.status },
        "The stage attempt is no longer running; the session loop stops",
      );
      return;
    }

    const sessionOrdinal = nextSessionOrdinalFor(deps);
    const sources = deps.state.query({ type: "READ_CONTEXT_SOURCES", stageAttemptId, sessionOrdinal });
    if (sources.type !== "CONTEXT_SOURCES") throw new Error("The context sources could not be read");

    // Spec §6.1 step 2: a share of the window declared by the adapter, never the whole window.
    // The share is derived from the attempt's own durable backoff count, not from a local variable:
    // §6.4 makes a daemon restart an ordinary end of a session, and a share held in memory would be
    // silently restored to full by the very event §7's "one automatic retry" has to survive.
    const packShare = MAX_PACK_SHARE - attempt.packShareBackoffs * PACK_SHARE_BACKOFF;
    const budgetTokens = Math.max(1, Math.floor(capabilities.contextWindowTokens * packShare));
    const assembled = assembleContextPack({
      sources: sources.sources,
      spec: contextPackSpecFor(deps.template, attempt.stage),
      budgetTokens,
      bytesPerToken: BYTES_PER_TOKEN,
    });

    if (assembled.type === "FLOOR_EXCEEDED") {
      // Spec §D8: the required sections do not fit, so the session does not start at all. Trimming
      // a required section would hand the agent an input Loomrail knows is incomplete.
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "HARD_PAUSE_STAGE_ATTEMPT",
        payload: {
          stageAttemptId,
          reason: {
            type: "CONTEXT_FLOOR_EXCEEDED",
            sessionOrdinal,
            requiredBytes: assembled.requiredBytes,
            budgetBytes: assembled.budgetBytes,
            budgetTokens,
          },
        },
      });
      deps.logger.warn(
        { stageAttemptId, sessionOrdinal, requiredBytes: assembled.requiredBytes, budgetTokens },
        "The required context sections do not fit the pack budget; the attempt is hard-paused",
      );
      return;
    }

    const started = deps.state.execute({
      schemaVersion: 1,
      commandId: deps.createCommandId(),
      correlationId: deps.correlationId,
      actor,
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId,
        // Parsed rather than cast: `ContextSourceRef.kind` is a plain string on the assembler's
        // side, and the recipe is the audit record spec D7 rests on, so the narrowing to the
        // contract's source kinds happens through the schema that defines them.
        recipe: contextPackRecipeInputSchema.parse({
          schemaVersion: 1,
          templateId: deps.template.id,
          templateVersion: deps.template.version,
          specSource: "WORKFLOW_TEMPLATE",
          sections: assembled.recipe.sections,
          omitted: assembled.recipe.omitted,
          contentHash: assembled.pack.contentHash,
          estimatedTokens: assembled.recipe.estimatedTokens,
          budgetTokens: assembled.recipe.budgetTokens,
          // Loomrail sized this pack from its own byte count, whatever the adapter can report about
          // occupancy later: the estimate quality describes how the size was arrived at, not how
          // well the provider can measure itself.
          estimateQuality: "LOOMRAIL_ESTIMATE",
        }),
      },
    });
    if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("The ProviderSession did not start");
    const providerSession = started.session;

    // One mutable record rather than four `let`s: the listener callbacks below run while `start()`
    // is still in flight, so these are shared between this function body and those closures.
    const live = { closed: false, handoffRequested: false, checkpointWriteFailed: false };
    let lastPublished: CheckpointDraft | null = null;
    let deadline: HandoffDeadline | undefined;
    let signalDeadline: (() => void) | undefined;
    const deadlineReached = new Promise<SessionOutcome>((resolve) => {
      signalDeadline = () => {
        resolve({ type: "DEADLINE" });
      };
    });

    const publishCheckpoint = (draft: CheckpointDraft): boolean => {
      try {
        deps.state.execute({
          schemaVersion: 1,
          commandId: deps.createCommandId(),
          correlationId: deps.correlationId,
          actor,
          type: "PUBLISH_CHECKPOINT",
          payload: { providerSessionId: providerSession.id, checkpoint: draft },
        });
        lastPublished = draft;
        return true;
      } catch (error: unknown) {
        // Spec §6.2: a failed checkpoint write cannot be swallowed. The agent believes it published
        // progress, and the next pack would be assembled without it, so the session ends
        // INTERRUPTED and stays unproductive rather than dissolving into a log line.
        live.checkpointWriteFailed = true;
        deps.logger.warn(
          { providerSessionId: providerSession.id, error: errorName(error) },
          "A published checkpoint could not be persisted; the session will be cut",
        );
        return false;
      }
    };

    const listener: ProviderSessionListener = {
      onContextWindow: (reported) => {
        if (live.closed || live.handoffRequested) return;
        // Provider output is untrusted input: a report that does not satisfy the contract is
        // recorded and dropped rather than driving a cut.
        const usage = contextWindowUsageSchema.safeParse(reported);
        if (!usage.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider reported context-window occupancy that does not satisfy the contract",
          );
          return;
        }
        const requested = deps.state.execute({
          schemaVersion: 1,
          commandId: deps.createCommandId(),
          correlationId: deps.correlationId,
          actor,
          type: "REQUEST_CONTEXT_HANDOFF",
          payload: {
            providerSessionId: providerSession.id,
            usage: usage.data,
            handoffThreshold: HANDOFF_THRESHOLD,
          },
        });
        if (requested.type !== "CONTEXT_HANDOFF_REQUESTED" || !requested.requested) return;
        live.handoffRequested = true;
        deps.logger.info(
          { providerSessionId: providerSession.id, usedTokens: usage.data.usedTokens },
          "Asked the provider to wind this session down",
        );
        // Deliberately not awaited: `onContextWindow` is called while `start()` is still running,
        // and the request is idempotent and safe for a session that has already ended (§6.2).
        void deps.adapter.requestHandoff(providerSession.id).catch((error: unknown) => {
          deps.logger.warn(
            { providerSessionId: providerSession.id, error: errorName(error) },
            "The provider could not be asked to wind down",
          );
        });
        deadline = scheduleDeadline(HANDOFF_DEADLINE_MS, () => signalDeadline?.());
      },
      onCheckpoint: (draft) => {
        if (live.closed) return;
        // Spec §7: an invalid checkpoint is rejected rather than half-accepted -- the next pack is
        // built on it. The session then simply published nothing, which §6.5 already accounts for.
        const validated = checkpointDraftSchema.safeParse(draft);
        if (!validated.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider published a checkpoint that does not satisfy the contract; it was rejected",
          );
          return;
        }
        publishCheckpoint(validated.data);
      },
    };

    const result: SessionOutcome = await Promise.race([
      deps.adapter
        .start(
          {
            dispatch: deps.dispatch,
            session: providerSessionRef(providerSession, attempt),
            contextPack: assembled.pack,
          },
          listener,
        )
        .then(
          (outcome): SessionOutcome => ({ type: "OUTCOME", outcome }),
          (error: unknown): SessionOutcome => ({ type: "FAILED", error }),
        ),
      deadlineReached,
    ]);
    live.closed = true;
    deadline?.cancel();

    if (result.type === "FAILED") {
      // `providerStarted: false`: the adapter refused the invocation, so this session never had a
      // chance to publish anything and §6.5's guard does not apply to it. §7's branches below own
      // this case, and pausing twice for one failure would ask the owner two questions about it.
      deps.state.execute(endSessionCommand(deps, providerSession.id, "INTERRUPTED", false));
      // Only a size rejection is something Loomrail can act on by itself (spec §7). Any other
      // failure is the provider's, and shrinking the pack in response would treat a transient error
      // as an estimation mistake and then ask the owner a question about a context size that had
      // nothing to do with it.
      const packWasTooLarge = result.error instanceof ProviderPackTooLargeError;
      const canRetrySmaller =
        packWasTooLarge && attempt.packShareBackoffs === 0 && packShare - PACK_SHARE_BACKOFF > 0;
      if (canRetrySmaller) {
        deps.state.execute({
          schemaVersion: 1,
          commandId: deps.createCommandId(),
          correlationId: deps.correlationId,
          actor,
          type: "REDUCE_CONTEXT_PACK_SHARE",
          payload: { stageAttemptId },
        });
        deps.logger.warn(
          { stageAttemptId, sessionOrdinal, error: errorName(result.error) },
          "The provider rejected the assembled pack; retrying once with a smaller pack share",
        );
        continue;
      }
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "HARD_PAUSE_STAGE_ATTEMPT",
        payload: {
          stageAttemptId,
          reason: {
            type: packWasTooLarge ? "PROVIDER_REJECTED_PACK" : "PROVIDER_START_FAILED",
            sessionOrdinal,
          },
        },
      });
      deps.logger.warn(
        { stageAttemptId, sessionOrdinal, error: errorName(result.error) },
        packWasTooLarge
          ? "The provider rejected the assembled pack after a retry; the attempt is hard-paused"
          : "The provider session failed to start; the attempt is hard-paused",
      );
      return;
    }

    let endReason: ProviderSessionEndReason;
    let stageResult: ProviderOutcome | null = null;
    if (result.type === "DEADLINE") {
      // Spec §7: the wind-down request was ignored, so the session is cut hard. Awaited, unlike
      // `requestHandoff`: the next session must not open while this one is still running. Loomrail
      // records the end either way -- a provider that cannot be reached to be stopped is exactly the
      // case the owner has to be able to see -- but it stops as soon as the abort settles rather
      // than leaving two live sessions on one StageAttempt.
      try {
        await deps.adapter.abortSession(providerSession.id);
      } catch (error: unknown) {
        deps.logger.warn(
          { providerSessionId: providerSession.id, error: errorName(error) },
          "The cut session could not be aborted; it may still be running on the provider",
        );
      }
      endReason = "CONTEXT_EXHAUSTED";
      deps.logger.warn(
        { providerSessionId: providerSession.id, deadlineMs: HANDOFF_DEADLINE_MS },
        "The provider did not wind down before the handoff deadline; the session was cut",
      );
    } else if (result.outcome.type === "HANDED_OFF" || result.outcome.type === "CONTEXT_EXHAUSTED") {
      const carried = result.outcome.checkpoint;
      if (carried !== undefined && !sameCheckpoint(lastPublished, carried)) {
        const validated = checkpointDraftSchema.safeParse(carried);
        if (validated.success) {
          publishCheckpoint(validated.data);
        } else {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider's final checkpoint does not satisfy the contract; it was rejected",
          );
        }
      }
      endReason = result.outcome.type === "HANDED_OFF" ? "HANDOFF" : "CONTEXT_EXHAUSTED";
    } else {
      endReason = "COMPLETED";
      stageResult = result.outcome;
    }
    // Only when the session ended without a stage result. §6.2 cuts a session whose checkpoint
    // could not be persisted because the *next* session's pack would be assembled without it -- and
    // a session that finished the stage has no next session on this attempt, so nothing is carried
    // forward and nothing is lost. Rewriting the reason there would also route a completed stage
    // through §6.5, hard-pause the attempt on the second occurrence, and then hand
    // APPLY_PROVIDER_OUTCOME an attempt that is no longer RUNNING.
    if (live.checkpointWriteFailed && stageResult === null) endReason = "INTERRUPTED";

    const ended = deps.state.execute(endSessionCommand(deps, providerSession.id, endReason));
    if (ended.type !== "PROVIDER_SESSION_ENDED") throw new Error("The ProviderSession did not end");

    if (stageResult !== null) {
      // The stage-level result. The outcome is untrusted provider output and is validated where it
      // is written: `execute` parses the whole command, outcome included, before touching state.
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "APPLY_PROVIDER_OUTCOME",
        payload: { dispatchId: deps.dispatch.id, outcome: stageResult, template: deps.template },
      });
      return;
    }

    if (ended.nextSessionOrdinal === null) {
      deps.logger.info(
        { stageAttemptId, status: ended.stageAttempt.status },
        "The stage attempt stopped producing sessions",
      );
      return;
    }
  }

  deps.logger.warn(
    { stageAttemptId },
    "The stage attempt reached the session backstop without finishing; the loop stops",
  );
};
