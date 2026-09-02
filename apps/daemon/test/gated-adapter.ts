import type { WorkflowStage } from "@loomrail/contracts";
import type { ProviderAdapter, ProviderId } from "@loomrail/provider-core";

const ALL_STAGES: readonly WorkflowStage[] = ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"];

// An adapter whose start() does not resolve until the test lets it. Every session-worker test is
// deterministic because of this: nothing ever waits on a duration, only on a gate the test itself
// opens. Shared by `session-worker.integration.test.ts` and Task 8's daemon tests, so it lives here
// once instead of being pasted into both.
export type GatedAdapter = ProviderAdapter & {
  started: Promise<void>;
  whenStarted: (count: number) => Promise<void>;
  release: () => void;
  startCallCount: number;
  releasedCount: number;
  abortedSessions: readonly string[];
};

// `capabilityOverrides` is here for Task 9's stage-capability gate (server.integration.test.ts):
// every other caller wants the adapter to declare every stage, so `stages` defaults to `ALL_STAGES`
// and only the gate test narrows it. `start` is here for the same reason, added for task 10.5's own
// half of that gate (an adapter whose CLI is not installed): every other caller wants a startable
// adapter, so `start` defaults to `true` and only that test overrides it to `false`.
export const gatedAdapter = (
  contextWindowTokens = 200_000,
  capabilityOverrides: { provider?: ProviderId; stages?: readonly WorkflowStage[]; start?: boolean } = {},
): GatedAdapter => {
  let announceStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const aborted: string[] = [];
  const startWaiters: { count: number; resolve: () => void }[] = [];

  const adapter: GatedAdapter = {
    started,
    whenStarted: (count) =>
      adapter.startCallCount >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            startWaiters.push({ count, resolve });
          }),
    startCallCount: 0,
    releasedCount: 0,
    get abortedSessions() {
      return aborted;
    },
    release: () => {
      adapter.releasedCount += 1;
      openGate();
    },
    capabilities: () => ({
      provider: capabilityOverrides.provider ?? "MOCK",
      start: capabilityOverrides.start ?? true,
      interrupt: false,
      eventStream: false,
      usageReporting: false,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens,
      stages: [...(capabilityOverrides.stages ?? ALL_STAGES)],
      costReporting: false,
    }),
    start: async (invocation) => {
      adapter.startCallCount += 1;
      announceStarted();
      for (let index = startWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = startWaiters[index];
        if (waiter && adapter.startCallCount >= waiter.count) {
          startWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
      await gate;
      // No session id or checkpoint travels on COMPLETED; those are session-level outcomes
      // (HANDED_OFF, CONTEXT_EXHAUSTED). REVIEW and QA need typed evidence, and a scheduled REVIEW
      // also needs the structured independent-review report. A caller that drains the real workflow
      // needs those fixtures or it would stall for a reason unrelated to the test's actual subject.
      const { stage } = invocation.session;
      if (stage === "ACCEPTANCE") {
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
          releaseNote: "The gated delivery is ready for its owner.",
          verifyInstructions: ["Inspect the recorded Review and QA evidence."],
          criteria: acceptanceInput.criteria.map((criterion) => ({
            criterion,
            implementation: "The gated workflow completed its bounded implementation.",
            reviewCheck,
            qaCheck,
            ownerVerification: "Inspect the recorded Review and QA evidence.",
            knownRisk: null,
          })),
        };
      }
      const artifacts =
        stage === "REVIEW"
          ? [
              {
                kind: "REVIEW_REPORT" as const,
                title: "Gated review",
                summary: "Held until the test released it, then reviewed.",
                checks: ["Reviewed once the gate opened"],
              },
            ]
          : stage === "QA"
            ? [
                {
                  kind: "QA_REPORT" as const,
                  title: "Gated QA",
                  summary: "Held until the test released it, then tested.",
                  checks: ["Tested once the gate opened"],
                },
              ]
            : undefined;
      return {
        type: "COMPLETED",
        summary: "Held until the test released it, then completed the stage.",
        artifacts,
        reviewReport:
          stage === "REVIEW"
            ? {
                kind: "REVIEW_REPORT",
                title: "Gated review",
                summary: "Held until the test released it, then reviewed.",
                checks: ["Reviewed once the gate opened"],
                verdict: "PASSED",
                findings: [],
              }
            : undefined,
      };
    },
    requestHandoff: () => Promise.resolve(undefined),
    abortSession: (sessionId) => {
      aborted.push(sessionId);
      return Promise.resolve();
    },
  };
  return adapter;
};
