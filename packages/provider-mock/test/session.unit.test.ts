import { createHash } from "node:crypto";

import { checkpointDraftSchema, type CheckpointDraft, type ContextWindowUsage } from "@loomrail/contracts";
import {
  providerCapabilitiesSchema,
  ProviderPackTooLargeError,
  type ProviderInvocation,
} from "@loomrail/provider-core";
import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/index.js";

// A single fixed invocation shared by every scenario below: the session-behaviour options this
// file exercises are orthogonal to stage or dispatch content, so nothing about the scenario
// depends on which stage or attempt is named here. The session id "session-1" is what
// `requestHandoff` targets in the tests that call it.
const implementInvocation = (): ProviderInvocation => {
  const text = "placeholder pack for session-behaviour tests";
  return {
    dispatch: {
      schemaVersion: 1,
      id: "dispatch-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      pipelineRunId: "run-1",
      stageAttemptId: "attempt-1",
      mode: "START",
      status: "PENDING",
      createdAt: "2026-08-24T10:00:00.000Z",
      completedAt: null,
    },
    session: { id: "session-1", ordinal: 1, stageAttemptId: "attempt-1", stage: "IMPLEMENT", attempt: 1 },
    contextPack: {
      schemaVersion: 1,
      text,
      contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    },
    humanRequests: "ALLOWED",
    mcpConnections: [],
  };
};

const listener = () => {
  const usages: ContextWindowUsage[] = [];
  const checkpoints: CheckpointDraft[] = [];
  return {
    usages,
    checkpoints,
    onContextWindow: (usage: ContextWindowUsage) => usages.push(usage),
    onCheckpoint: (draft: CheckpointDraft) => checkpoints.push(draft),
    onUsage: () => undefined,
  };
};

describe("mock provider session behaviour", () => {
  it("reports occupancy that grows every turn", async () => {
    const sink = listener();
    const provider = createMockProvider({ contextWindowTokens: 1_000, tokensPerTurn: 100 });
    await provider.start(implementInvocation(), sink);
    const used = sink.usages.map(({ usedTokens }) => usedTokens);
    // Discriminating on more than two samples: a merely-large final value would also pass a
    // buggy implementation that jumps straight to the ceiling on turn one.
    expect(used.length).toBeGreaterThan(2);
    used.reduce((previous, current) => {
      expect(current).toBeGreaterThan(previous);
      return current;
    });
    // The mock's occupancy formula is exact and deterministic, not an approximation of
    // something it cannot fully see -- ACTUAL is the honest label, not PROVIDER_ESTIMATE.
    expect(sink.usages.every(({ quality }) => quality === "ACTUAL")).toBe(true);
  });

  it("publishes a checkpoint on the configured cadence", async () => {
    const sink = listener();
    // Ten turns exactly: occupancy reaches the window on turn 10 and the session hits the wall there.
    const provider = createMockProvider({
      contextWindowTokens: 1_000,
      tokensPerTurn: 100,
      checkpointEvery: 2,
    });
    await provider.start(implementInvocation(), sink);
    expect(sink.usages).toHaveLength(10);
    // Which turns published is what makes this a claim about the cadence. `length > 0` alone held
    // at every cadence this mock can be configured with, one included -- so it said nothing about
    // the option whose name the test carries.
    expect(sink.checkpoints.map(({ summary }) => summary)).toEqual([
      "Deterministic mock checkpoint after turn 2.",
      "Deterministic mock checkpoint after turn 4.",
      "Deterministic mock checkpoint after turn 6.",
      "Deterministic mock checkpoint after turn 8.",
      "Deterministic mock checkpoint after turn 10.",
    ]);
  });

  it("ends with HANDED_OFF after a handoff request", async () => {
    const sink = listener();
    const provider = createMockProvider({ tokensPerTurn: 100, checkpointEvery: 1 });
    const running = provider.start(implementInvocation(), sink);
    await provider.requestHandoff("session-1");
    await expect(running).resolves.toMatchObject({ type: "HANDED_OFF" });
  });

  it("keeps running to a different terminal outcome when configured to ignore the handoff request", async () => {
    // Needed for the deadline check in Task 11: without a disobedient mock there is nothing to
    // exercise the overdue-request branch against. Asserting a different terminal outcome type
    // than the obedient case (HANDED_OFF above) is what actually proves the request was
    // ignored, rather than merely honoured late.
    const sink = listener();
    const provider = createMockProvider({ ignoreHandoffRequest: true, hitTheWallAfterTurns: 5 });
    const running = provider.start(implementInvocation(), sink);
    await provider.requestHandoff("session-1");
    await expect(running).resolves.toMatchObject({ type: "CONTEXT_EXHAUSTED" });
  });

  it("ends with CONTEXT_EXHAUSTED when it hits the wall", async () => {
    const sink = listener();
    const provider = createMockProvider({ hitTheWallAfterTurns: 2, checkpointEvery: 10 });
    await expect(provider.start(implementInvocation(), sink)).resolves.toMatchObject({
      type: "CONTEXT_EXHAUSTED",
    });
    // The wall arrived before the first checkpoint cadence -- the session is unproductive per
    // spec §6.5.
    expect(sink.checkpoints).toHaveLength(0);
  });

  it("emits a checkpoint that fails validation when asked to", async () => {
    // Feeds the "checkpoint arrived invalid" branch of spec §7.
    const sink = listener();
    const provider = createMockProvider({ emitInvalidCheckpoint: true, checkpointEvery: 1 });
    await provider.start(implementInvocation(), sink);
    expect(sink.checkpoints.length).toBeGreaterThan(0);
    expect(() => checkpointDraftSchema.parse(sink.checkpoints[0])).toThrow();
  });

  it("keeps the default-constructed provider behaving exactly as before", async () => {
    // Options must be opt-in: an untouched createMockProvider() must not switch into
    // session-behaviour mode. It still resolves synchronously with the M6 script and never
    // touches the listener.
    const sink = listener();
    const provider = createMockProvider();
    await expect(provider.start(implementInvocation(), sink)).resolves.toMatchObject({
      type: "BUDGET_LIMIT_REACHED",
    });
    expect(sink.usages).toHaveLength(0);
    expect(sink.checkpoints).toHaveLength(0);
  });

  it("declares legacy capabilities on a default-constructed provider", () => {
    // The default instance's capability shape is otherwise only exercised transitively through
    // daemon integration tests -- asserted here directly, in the package that owns it, so it
    // cannot drift while the M6 flow (which assumes eventStream: false) depends on it. Parsed
    // through the schema, not just compared field by field, so the two capability refines
    // (checkpointOnRequest/contextWindowReporting each imply eventStream) are actually exercised.
    const capabilities = providerCapabilitiesSchema.parse(createMockProvider().capabilities());
    expect(capabilities).toMatchObject({
      eventStream: false,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens: 128_000,
    });
  });

  it("declares streaming capabilities when session behaviour is configured", () => {
    // This is the one judgment call whose correctness a downstream task (Task 11) depends on:
    // a mis-wired boolean here would throw the first time Task 11 calls .capabilities() on a
    // configured mock, since providerCapabilitiesSchema's refines reject
    // checkpointOnRequest/contextWindowReporting without eventStream. Parsed through the schema
    // for the same reason as the default case above.
    const capabilities = providerCapabilitiesSchema.parse(
      createMockProvider({ contextWindowTokens: 64_000 }).capabilities(),
    );
    expect(capabilities).toMatchObject({
      eventStream: true,
      contextWindowReporting: true,
      checkpointOnRequest: true,
      contextWindowTokens: 64_000,
    });
  });

  it("stops an aborted session instead of running on after Loomrail has given up on it", async () => {
    // Spec §7's hard cut. `requestHandoff` is a request the agent may keep ignoring, so without a
    // working abort the caller stops waiting while the run keeps going -- two live sessions on one
    // StageAttempt, and one of them still billing. `ignoreHandoffRequest` here makes the wind-down
    // request useless on purpose, so only the abort can end this run.
    const provider = createMockProvider({
      contextWindowTokens: 200_000,
      tokensPerTurn: 1,
      checkpointEvery: 1_000_000,
      ignoreHandoffRequest: true,
    });
    const sink = listener();
    const run = provider.start(implementInvocation(), sink);

    await provider.requestHandoff("session-1");
    const turnsBeforeAbort = sink.usages.length;
    await provider.abortSession("session-1");

    await expect(run).resolves.toMatchObject({ type: "CONTEXT_EXHAUSTED" });
    // Far short of the 200,000 turns this window would otherwise take to fill: a broken abort
    // fails this assertion on the count rather than passing quietly.
    expect(sink.usages.length).toBeLessThan(turnsBeforeAbort + 10);
  });

  it("rejects a pack it considers too large before running any turn", async () => {
    // Spec §7's mis-estimated-pack branch. A typed rejection, so the caller can tell "your pack is
    // too big" apart from a transient failure instead of guessing from an error message.
    const provider = createMockProvider({ rejectPacksLongerThan: 5 });
    const sink = listener();

    await expect(provider.start(implementInvocation(), sink)).rejects.toBeInstanceOf(
      ProviderPackTooLargeError,
    );
    expect(sink.usages).toHaveLength(0);
  });
});
