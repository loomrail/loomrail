import { providerOutcomeSchema, type CheckpointDraft, type ProviderOutcome } from "@loomrail/contracts";
import {
  providerCapabilitiesSchema,
  ProviderPackTooLargeError,
  type ProviderAdapter,
  type ProviderInvocation,
  type ProviderSessionListener,
} from "@loomrail/provider-core";

const discoveryQuestion = () =>
  providerOutcomeSchema.parse({
    type: "NEEDS_HUMAN",
    request: {
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Choose the discovery depth",
      context:
        "The mock delivery pipeline needs one product decision before it can turn the brief into a plan.",
      recommendation:
        "Use the focused pass for a bounded task. Choose the extended pass when unknowns could change the approach.",
      options: [
        {
          id: "focused-pass",
          label: "Focused pass",
          consequence: "Validate the brief and proceed with the smallest sufficient plan.",
          recommended: true,
        },
        {
          id: "extended-pass",
          label: "Extended pass",
          consequence: "Spend another discovery round mapping constraints and edge cases.",
          recommended: false,
        },
      ],
      allowOther: true,
    },
  });

const complete = (invocation: ProviderInvocation) =>
  providerOutcomeSchema.parse({
    type: "COMPLETED",
    summary:
      invocation.session.stage === "DISCOVERY"
        ? "Discovery resumed from the recorded human decision."
        : invocation.session.stage === "PLAN"
          ? "The bounded mock plan was produced from the accepted discovery direction."
          : invocation.session.stage === "IMPLEMENT"
            ? "The mock implementation completed inside the approved budget revision."
            : invocation.session.stage === "REVIEW"
              ? "Independent mock review completed without open findings."
              : "Deterministic mock browser QA completed without regressions.",
    ...(invocation.session.stage === "REVIEW"
      ? {
          artifacts: [
            {
              kind: "REVIEW_REPORT",
              title: "Independent mock review",
              summary:
                "The synthetic reviewer found no blocking correctness, security, or maintainability issues.",
              checks: ["Requirements traced", "No blocking findings", "Regression scope recorded"],
            },
          ],
        }
      : invocation.session.stage === "QA"
        ? {
            artifacts: [
              {
                kind: "QA_REPORT",
                title: "Deterministic mock QA",
                summary:
                  "The synthetic browser and runtime checks passed for the bounded acceptance fixture.",
                checks: [
                  "Primary journey passed",
                  "Desktop and mobile checked",
                  "No application console errors",
                ],
              },
            ],
          }
        : {}),
  });

const requestAcceptance = () =>
  providerOutcomeSchema.parse({
    type: "READY_FOR_ACCEPTANCE",
    releaseNote: "Completes the deterministic mock delivery flow with budget, review, QA, and owner control.",
    verifyInstructions: [
      "Run pnpm verify.",
      "Run pnpm test:e2e.",
      "Inspect the acceptance evidence in Loomrail.",
    ],
  });

const exhaustInitialImplementationBudget = () =>
  providerOutcomeSchema.parse({
    type: "BUDGET_LIMIT_REACHED",
    usageIncrements: [50, 30, 15, 5],
    quality: "LOOMRAIL_ESTIMATE",
  });

// This is the deterministic scripted M6 demo scenario: a discovery question, a budget-exhaustion
// beat on an implementation's first attempt, review and QA artifacts, then acceptance. It gates
// the budget-exhaustion beat on `invocation.session.attempt`, the durable `StageAttempt.attempt`
// (spec §6.5) passed through structurally on the session ref -- not on adapter-local bookkeeping,
// which would forget on a daemon restart, and not on parsing prose out of the rendered pack,
// which coupled this script to wording `context-assembly`'s render step owns.
const outcomeFor = (invocation: ProviderInvocation): ProviderOutcome => {
  const { stage, attempt } = invocation.session;
  if (stage === "DISCOVERY" && invocation.dispatch.mode === "START") {
    return discoveryQuestion();
  }
  if (stage === "IMPLEMENT" && attempt === 1) {
    return exhaustInitialImplementationBudget();
  }
  if (stage === "ACCEPTANCE") return requestAcceptance();
  return complete(invocation);
};

// Everything below is the session-behaviour double (spec §9, Task 10). It is the instrument A1's
// acceptance criteria are measured with: a stage surviving a context handoff, work continuing
// across a provider swap, and an ignored wind-down request being cut at a deadline are all only
// verifiable if the mock can actually produce those situations. `MockProviderOptions` is opt-in
// on purpose -- a default-constructed `createMockProvider()` must keep running the M6 script
// above untouched, so a caller that never asked for session behaviour never gets it.
export type MockProviderOptions = {
  contextWindowTokens?: number;
  tokensPerTurn?: number;
  checkpointEvery?: number;
  ignoreHandoffRequest?: boolean;
  emitInvalidCheckpoint?: boolean;
  hitTheWallAfterTurns?: number;
  // Spec §7's mis-estimated-pack branch: the adapter is handed a pack Loomrail sized from its own
  // estimate and refuses it, so a test can drive both the automatic retry with a smaller share and
  // the give-up after it. Measured in characters of rendered pack text rather than bytes -- this
  // package deliberately carries no Node typings, and the branch under test is "the provider said
  // no", for which the unit of the threshold makes no difference.
  rejectPacksLongerThan?: number;
};

type ResolvedMockProviderOptions = {
  contextWindowTokens: number;
  tokensPerTurn: number;
  checkpointEvery: number;
  ignoreHandoffRequest: boolean;
  emitInvalidCheckpoint: boolean;
  hitTheWallAfterTurns: number;
  rejectPacksLongerThan: number;
};

const resolveOptions = (options: MockProviderOptions): ResolvedMockProviderOptions => ({
  contextWindowTokens: options.contextWindowTokens ?? 128_000,
  tokensPerTurn: options.tokensPerTurn ?? 20_000,
  checkpointEvery: options.checkpointEvery ?? 3,
  ignoreHandoffRequest: options.ignoreHandoffRequest ?? false,
  emitInvalidCheckpoint: options.emitInvalidCheckpoint ?? false,
  // No forced wall by default: the session runs until the simulated window itself fills up.
  hitTheWallAfterTurns: options.hitTheWallAfterTurns ?? Number.POSITIVE_INFINITY,
  // No pack is ever rejected by default.
  rejectPacksLongerThan: options.rejectPacksLongerThan ?? Number.POSITIVE_INFINITY,
});

const validCheckpointDraft = (turn: number): CheckpointDraft => ({
  summary: `Deterministic mock checkpoint after turn ${String(turn)}.`,
  completed: [`Completed the mock work planned for turn ${String(turn)}.`],
  remaining: ["Continue the mock session on the next turn."],
  deadEnds: [],
  openQuestions: [],
});

// An empty summary fails `checkpointDraftSchema` (spec §5.1's draft requires a non-empty,
// trimmed summary) -- deliberately, so the invalid-checkpoint branch of spec §7 has a fixture to
// reject rather than assuming one exists.
const invalidCheckpointDraft = (): CheckpointDraft => ({
  summary: "",
  completed: [],
  remaining: [],
  deadEnds: [],
  openQuestions: [],
});

type SessionRuntime = {
  handoffRequested: boolean;
  aborted: boolean;
};

// Tracks only which sessions this adapter instance currently has in flight, and whether each has
// a pending wind-down request. This is transient, in-memory bookkeeping scoped to the lifetime of
// a running `start()` call -- unlike the attempt-counting hazard the M6 script above avoids, there
// is no persistence expectation here for `requestHandoff` to violate: a daemon restart simply
// means the session is gone, and a fresh session id starts with a clean runtime entry.
const runSession = async (
  invocation: ProviderInvocation,
  listener: ProviderSessionListener,
  options: ResolvedMockProviderOptions,
  runningSessions: Map<string, SessionRuntime>,
): Promise<ProviderOutcome> => {
  const sessionId = invocation.session.id;
  const runtime: SessionRuntime = { handoffRequested: false, aborted: false };
  runningSessions.set(sessionId, runtime);
  try {
    // Spec §7's mis-estimated-pack branch. Thrown before any turn runs, because a provider that
    // cannot accept the input never starts working on it.
    if (invocation.contextPack.text.length > options.rejectPacksLongerThan) {
      throw new ProviderPackTooLargeError(
        sessionId,
        `The mock provider accepts at most ${String(options.rejectPacksLongerThan)} characters of context`,
      );
    }
    let lastCheckpoint: CheckpointDraft | undefined;
    for (let turn = 1; ; turn += 1) {
      // Yield to the microtask queue so a `requestHandoff` call made concurrently with `start()`
      // (the pattern every handoff test uses) gets a chance to register before this turn reads
      // the flag it sets. No timers and no randomness -- this is a plain microtask tick.
      await Promise.resolve();

      // A hard cut, unlike `requestHandoff` above: the run really stops rather than being asked
      // to. Checked before the turn does anything, so an aborted session bills for no further
      // work and publishes nothing more.
      if (runtime.aborted) {
        return lastCheckpoint === undefined
          ? { type: "CONTEXT_EXHAUSTED" }
          : { type: "CONTEXT_EXHAUSTED", checkpoint: lastCheckpoint };
      }

      const usedTokens = Math.min(options.tokensPerTurn * turn, options.contextWindowTokens);
      listener.onContextWindow({
        usedTokens,
        windowTokens: options.contextWindowTokens,
        // ACTUAL, not PROVIDER_ESTIMATE: `usedTokens` is an exact deterministic formula
        // (min(tokensPerTurn * turn, contextWindowTokens)) that defines its own ground truth --
        // nothing here is being approximated, so a label borrowed from a real adapter's
        // imprecision would misdescribe what this double actually reports.
        quality: "ACTUAL",
      });

      if (turn % options.checkpointEvery === 0) {
        const draft = options.emitInvalidCheckpoint ? invalidCheckpointDraft() : validCheckpointDraft(turn);
        lastCheckpoint = draft;
        listener.onCheckpoint(draft);
      }

      const handoffPending = runtime.handoffRequested && !options.ignoreHandoffRequest;
      if (handoffPending) {
        // HANDED_OFF always carries a checkpoint (spec §5.2): synthesize one if the wind-down
        // did not land on a configured checkpoint turn.
        return { type: "HANDED_OFF", checkpoint: lastCheckpoint ?? validCheckpointDraft(turn) };
      }

      const hitTheWall = turn >= options.hitTheWallAfterTurns || usedTokens >= options.contextWindowTokens;
      if (hitTheWall) {
        // CONTEXT_EXHAUSTED may or may not carry a checkpoint (spec §5.2): only attach one if a
        // cadence turn actually published one before the wall arrived. Constructed by hand,
        // not `providerOutcomeSchema.parse`, on purpose -- with `emitInvalidCheckpoint` this
        // checkpoint is intentionally invalid, and the outcome must still reach the caller for
        // `onCheckpoint`'s draft to be inspectable rather than being swallowed by a parse throw.
        return lastCheckpoint === undefined
          ? { type: "CONTEXT_EXHAUSTED" }
          : { type: "CONTEXT_EXHAUSTED", checkpoint: lastCheckpoint };
      }
    }
  } finally {
    runningSessions.delete(sessionId);
  }
};

export const createMockProvider = (options?: MockProviderOptions): ProviderAdapter => {
  const sessionBehaviourEnabled = options !== undefined;
  const resolvedOptions = resolveOptions(options ?? {});
  const runningSessions = new Map<string, SessionRuntime>();

  return {
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "MOCK",
        start: true,
        interrupt: true,
        eventStream: sessionBehaviourEnabled,
        usageReporting: true,
        contextWindowReporting: sessionBehaviourEnabled,
        checkpointOnRequest: sessionBehaviourEnabled,
        contextWindowTokens: sessionBehaviourEnabled ? resolvedOptions.contextWindowTokens : 128_000,
        // Every stage of `mockDeliveryTemplate` (packages/workflow-engine): the mock is what the
        // whole daemon and e2e suite dispatches through, so it must be able to serve every stage
        // those suites drive it across, not just the ones a real adapter can serve before E1.
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: false,
      }),
    start: (invocation, listener) =>
      sessionBehaviourEnabled
        ? runSession(invocation, listener, resolvedOptions, runningSessions)
        : Promise.resolve(outcomeFor(invocation)),
    requestHandoff: (sessionId) => {
      const runtime = runningSessions.get(sessionId);
      if (runtime) runtime.handoffRequested = true;
      // Idempotent and safe for a session that has already ended or was never in session-
      // behaviour mode (spec §6.2): there is simply no runtime entry to flag in that case.
      return Promise.resolve();
    },
    abortSession: (sessionId) => {
      const runtime = runningSessions.get(sessionId);
      if (runtime) runtime.aborted = true;
      // Same idempotence as `requestHandoff`: aborting a session that already ended is a no-op.
      return Promise.resolve();
    },
  };
};
