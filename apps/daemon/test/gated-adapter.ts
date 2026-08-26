import type { WorkflowStage } from "@loomrail/contracts";
import type { ProviderAdapter, ProviderId } from "@loomrail/provider-core";

const ALL_STAGES: readonly WorkflowStage[] = ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"];

// An adapter whose start() does not resolve until the test lets it. Every session-worker test is
// deterministic because of this: nothing ever waits on a duration, only on a gate the test itself
// opens. Shared by `session-worker.integration.test.ts` and Task 8's daemon tests, so it lives here
// once instead of being pasted into both.
export type GatedAdapter = ProviderAdapter & {
  started: Promise<void>;
  release: () => void;
  startCallCount: number;
  releasedCount: number;
  abortedSessions: readonly string[];
};

// `capabilityOverrides` is here for Task 9's stage-capability gate (server.integration.test.ts):
// every other caller wants the adapter to declare every stage, so `stages` defaults to `ALL_STAGES`
// and only the gate test narrows it.
export const gatedAdapter = (
  contextWindowTokens = 200_000,
  capabilityOverrides: { provider?: ProviderId; stages?: readonly WorkflowStage[] } = {},
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

  const adapter: GatedAdapter = {
    started,
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
      start: true,
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
      await gate;
      // `providerOutcomeSchema`'s COMPLETED variant is just `{ type, summary, artifacts? }` -- no
      // session id or checkpoint travels on it, those are session-level outcomes (HANDED_OFF,
      // CONTEXT_EXHAUSTED). REVIEW and QA are the two stages `decideApplyProviderOutcome`
      // (packages/domain/src/workflow.ts) refuses to complete without their typed evidence
      // artifact; a caller that lets a queued attempt run to completion through the real workflow
      // template needs those or the drain stalls on REVIEW for a reason that has nothing to do with
      // whatever the caller's test is actually about.
      const { stage } = invocation.session;
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
