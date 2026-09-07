import { providerOutcomeSchema, type CheckpointDraft, type ProviderOutcome } from "@loomrail/contracts";
import {
  providerCapabilitiesSchema,
  ProviderPackTooLargeError,
  type ProviderAdapter,
  type ProviderInvocation,
  type ProviderSessionListener,
} from "@loomrail/provider-core";

/** Test-only provider behavior. Production code must use the OpenAI or Anthropic API adapter. */
export type ProviderTestDoubleOptions = {
  contextWindowTokens?: number;
  tokensPerTurn?: number;
  checkpointEvery?: number;
  ignoreHandoffRequest?: boolean;
  emitInvalidCheckpoint?: boolean;
  hitTheWallAfterTurns?: number;
  rejectPacksLongerThan?: number;
};

type ResolvedOptions = Required<ProviderTestDoubleOptions>;
type SessionRuntime = { handoffRequested: boolean; aborted: boolean };

const resolveOptions = (options: ProviderTestDoubleOptions): ResolvedOptions => ({
  contextWindowTokens: options.contextWindowTokens ?? 128_000,
  tokensPerTurn: options.tokensPerTurn ?? 20_000,
  checkpointEvery: options.checkpointEvery ?? 3,
  ignoreHandoffRequest: options.ignoreHandoffRequest ?? false,
  emitInvalidCheckpoint: options.emitInvalidCheckpoint ?? false,
  hitTheWallAfterTurns: options.hitTheWallAfterTurns ?? Number.POSITIVE_INFINITY,
  rejectPacksLongerThan: options.rejectPacksLongerThan ?? Number.POSITIVE_INFINITY,
});

const validCheckpoint = (turn: number): CheckpointDraft => ({
  summary: `Deterministic test checkpoint after turn ${String(turn)}.`,
  completed: [`Completed the test work planned for turn ${String(turn)}.`],
  remaining: ["Continue the test session on the next turn."],
  deadEnds: [],
  openQuestions: [],
});

const invalidCheckpoint = (): CheckpointDraft => ({
  summary: "",
  completed: [],
  remaining: [],
  deadEnds: [],
  openQuestions: [],
});

const scriptedOutcome = (invocation: ProviderInvocation): ProviderOutcome => {
  const { stage, attempt } = invocation.session;
  if (stage === "DISCOVERY" && invocation.dispatch.mode === "START") {
    return providerOutcomeSchema.parse({
      type: "NEEDS_HUMAN",
      request: {
        kind: "SINGLE_CHOICE",
        blocking: true,
        title: "Choose the discovery depth",
        context: "The test delivery pipeline needs one product decision before planning.",
        recommendation: "Use the focused pass for a bounded task.",
        options: [
          {
            id: "focused-pass",
            label: "Focused pass",
            consequence: "Proceed with the smallest sufficient plan.",
            recommended: true,
          },
          {
            id: "extended-pass",
            label: "Extended pass",
            consequence: "Map additional constraints and edge cases.",
            recommended: false,
          },
        ],
        allowOther: true,
      },
    });
  }
  if (stage === "IMPLEMENT" && attempt === 1) {
    return providerOutcomeSchema.parse({
      type: "BUDGET_LIMIT_REACHED",
      usageIncrements: [50, 30, 15, 5],
      quality: "LOOMRAIL_ESTIMATE",
    });
  }
  if (stage === "ACCEPTANCE") {
    const input = invocation.acceptanceInput;
    const reviewCheck = input?.evidence.filter(({ kind }) => kind === "REVIEW_REPORT").at(-1)?.checks[0];
    const qaCheck = input?.evidence.filter(({ kind }) => kind === "QA_REPORT").at(-1)?.checks[0];
    if (!input || !reviewCheck || !qaCheck) {
      throw new Error("Acceptance requires criterion, Review, and QA input");
    }
    return providerOutcomeSchema.parse({
      type: "READY_FOR_ACCEPTANCE",
      releaseNote: "Completes the deterministic test delivery flow.",
      verifyInstructions: ["Run pnpm verify.", "Run pnpm test:e2e.", "Inspect the evidence."],
      criteria: input.criteria.map((criterion) => ({
        criterion,
        implementation: "The implementation completed under the approved policy.",
        reviewCheck,
        qaCheck,
        ownerVerification: "Inspect the recorded Review and QA evidence.",
        knownRisk: null,
      })),
    });
  }

  return providerOutcomeSchema.parse({
    type: "COMPLETED",
    summary: `${stage} completed by the deterministic provider test double.`,
    ...(stage === "REVIEW"
      ? {
          artifacts: [
            {
              kind: "REVIEW_REPORT",
              title: "Independent test review",
              summary: "The test reviewer found no blocking issues.",
              checks: ["Requirements traced", "No blocking findings", "Regression scope recorded"],
            },
          ],
          reviewReport: {
            kind: "REVIEW_REPORT",
            title: "Independent test review",
            summary: "The test reviewer found no blocking issues.",
            checks: ["Requirements traced", "No blocking findings", "Regression scope recorded"],
            verdict: "PASSED",
            findings: [],
          },
        }
      : stage === "QA"
        ? {
            artifacts: [
              {
                kind: "QA_REPORT",
                title: "Deterministic test QA",
                summary: "The bounded acceptance fixture passed.",
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
};

const runSession = async (
  invocation: ProviderInvocation,
  listener: ProviderSessionListener,
  options: ResolvedOptions,
  sessions: Map<string, SessionRuntime>,
): Promise<ProviderOutcome> => {
  invocation.authoritySignal.throwIfAborted();
  const sessionId = invocation.session.id;
  const runtime: SessionRuntime = { handoffRequested: false, aborted: false };
  sessions.set(sessionId, runtime);
  try {
    if (invocation.contextPack.text.length > options.rejectPacksLongerThan) {
      throw new ProviderPackTooLargeError(sessionId, "The provider test double rejected the context pack");
    }
    let lastCheckpoint: CheckpointDraft | undefined;
    for (let turn = 1; ; turn += 1) {
      await Promise.resolve();
      invocation.authoritySignal.throwIfAborted();
      if (runtime.aborted) {
        return lastCheckpoint === undefined
          ? { type: "CONTEXT_EXHAUSTED" }
          : { type: "CONTEXT_EXHAUSTED", checkpoint: lastCheckpoint };
      }
      const usedTokens = Math.min(options.tokensPerTurn * turn, options.contextWindowTokens);
      listener.onContextWindow({ usedTokens, windowTokens: options.contextWindowTokens, quality: "ACTUAL" });
      if (turn % options.checkpointEvery === 0) {
        lastCheckpoint = options.emitInvalidCheckpoint ? invalidCheckpoint() : validCheckpoint(turn);
        listener.onCheckpoint(lastCheckpoint);
      }
      if (runtime.handoffRequested && !options.ignoreHandoffRequest) {
        return { type: "HANDED_OFF", checkpoint: lastCheckpoint ?? validCheckpoint(turn) };
      }
      if (turn >= options.hitTheWallAfterTurns || usedTokens >= options.contextWindowTokens) {
        return lastCheckpoint === undefined
          ? { type: "CONTEXT_EXHAUSTED" }
          : { type: "CONTEXT_EXHAUSTED", checkpoint: lastCheckpoint };
      }
    }
  } finally {
    sessions.delete(sessionId);
  }
};

export const createProviderTestDouble = (options?: ProviderTestDoubleOptions): ProviderAdapter => {
  const sessionBehavior = options !== undefined;
  const resolved = resolveOptions(options ?? {});
  const sessions = new Map<string, SessionRuntime>();
  return {
    modelMapping: () => ({
      FAST: "gpt-5.6-luna",
      STANDARD: "gpt-5.6-terra",
      DEEP: "gpt-5.6-sol",
    }),
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CODEX",
        start: true,
        interrupt: true,
        eventStream: sessionBehavior,
        usageReporting: true,
        contextWindowReporting: sessionBehavior,
        checkpointOnRequest: sessionBehavior,
        contextWindowTokens: sessionBehavior ? resolved.contextWindowTokens : 128_000,
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: false,
        tokenBudgetEnforcement: "HARD",
      }),
    start: (invocation, listener) =>
      sessionBehavior
        ? runSession(invocation, listener, resolved, sessions)
        : Promise.resolve(scriptedOutcome(invocation)),
    requestHandoff: (sessionId) => {
      const runtime = sessions.get(sessionId);
      if (runtime) runtime.handoffRequested = true;
      return Promise.resolve();
    },
    abortSession: (sessionId) => {
      const runtime = sessions.get(sessionId);
      if (runtime) runtime.aborted = true;
      return Promise.resolve();
    },
  };
};
