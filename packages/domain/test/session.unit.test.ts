import type { ProviderSession, StageAttempt } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { decideContextWindowReported, decideSessionEnded, WorkflowDomainError } from "../src/index.js";

const now = "2026-08-25T18:00:00.000Z";

const runningSession = (overrides: Partial<ProviderSession> = {}): ProviderSession => ({
  schemaVersion: 1,
  id: "session-1",
  stageAttemptId: "attempt-1",
  ordinal: 1,
  status: "RUNNING",
  endReason: null,
  handoffRequestedAt: null,
  startedAt: "2026-08-25T17:00:00.000Z",
  endedAt: null,
  version: 1,
  ...overrides,
});

const attemptWith = (overrides: Partial<StageAttempt> = {}): StageAttempt => ({
  schemaVersion: 1,
  id: "attempt-1",
  pipelineRunId: "run-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  stage: "IMPLEMENT",
  attempt: 1,
  status: "RUNNING",
  version: 1,
  startedAt: "2026-08-25T16:00:00.000Z",
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  ...overrides,
});

describe("provider session decisions", () => {
  describe("decideContextWindowReported", () => {
    it("requests a handoff the first time the threshold is crossed", () => {
      const decision = decideContextWindowReported({
        session: runningSession({ handoffRequestedAt: null }),
        usage: { usedTokens: 80, windowTokens: 100, quality: "ACTUAL" },
        handoffThreshold: 0.75,
        now,
      });
      expect(decision.type).toBe("REQUEST_HANDOFF");
      if (decision.type !== "REQUEST_HANDOFF") throw new Error("expected a handoff request");
      expect(decision.session.handoffRequestedAt).toBe(now);
      expect(decision.event).toMatchObject({ type: "CONTEXT_HANDOFF_REQUESTED" });
    });

    it("does not request a handoff twice", () => {
      const decision = decideContextWindowReported({
        session: runningSession({ handoffRequestedAt: "2026-08-25T17:59:00.000Z" }),
        usage: { usedTokens: 90, windowTokens: 100, quality: "ACTUAL" },
        handoffThreshold: 0.75,
        now,
      });
      expect(decision.type).toBe("NO_ACTION");
    });

    it("does not request a handoff below the threshold", () => {
      // Companion to the crossing test above: proves the threshold is a real boundary, not a
      // decision that fires regardless of occupancy.
      const decision = decideContextWindowReported({
        session: runningSession({ handoffRequestedAt: null }),
        usage: { usedTokens: 74, windowTokens: 100, quality: "ACTUAL" },
        handoffThreshold: 0.75,
        now,
      });
      expect(decision.type).toBe("NO_ACTION");
    });

    it("treats occupancy exactly at the threshold as crossed", () => {
      // The boundary must resolve the same way on every run: >= threshold counts as crossed, so
      // occupancy landing exactly on the threshold still requests a handoff rather than waiting
      // for the next report to push it over.
      const decision = decideContextWindowReported({
        session: runningSession({ handoffRequestedAt: null }),
        usage: { usedTokens: 75, windowTokens: 100, quality: "ACTUAL" },
        handoffThreshold: 0.75,
        now,
      });
      expect(decision.type).toBe("REQUEST_HANDOFF");
    });

    it("does not request a handoff for a session that has already ended", () => {
      // requestHandoff races the end of the session (spec 6.2): a threshold report that lands
      // after the session already ended must be a safe no-op, not a stale mutation.
      const decision = decideContextWindowReported({
        session: runningSession({ status: "ENDED", endReason: "COMPLETED", endedAt: now }),
        usage: { usedTokens: 95, windowTokens: 100, quality: "ACTUAL" },
        handoffThreshold: 0.75,
        now,
      });
      expect(decision.type).toBe("NO_ACTION");
    });
  });

  describe("decideSessionEnded", () => {
    it("finishes the stage on COMPLETED", () => {
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 1 }),
        attempt: attemptWith(),
        endReason: "COMPLETED",
        checkpointsPublished: 1,
        now,
      });
      expect(decision).toMatchObject({ type: "STAGE_FINISHED" });
    });

    it("starts the next session after a handoff", () => {
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 1 }),
        attempt: attemptWith({ unproductiveSessions: 0 }),
        endReason: "HANDOFF",
        checkpointsPublished: 2,
        now,
      });
      expect(decision).toMatchObject({ type: "START_NEXT_SESSION", nextOrdinal: 2 });
    });

    it("starts the next session after context exhaustion", () => {
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 4 }),
        attempt: attemptWith({ unproductiveSessions: 0 }),
        endReason: "CONTEXT_EXHAUSTED",
        checkpointsPublished: 1,
        now,
      });
      expect(decision).toMatchObject({ type: "START_NEXT_SESSION", nextOrdinal: 5 });
    });

    it("resets the unproductive counter when a session published a checkpoint", () => {
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 2 }),
        attempt: attemptWith({ unproductiveSessions: 1 }),
        endReason: "HANDOFF",
        checkpointsPublished: 1,
        now,
      });
      if (decision.type !== "START_NEXT_SESSION") throw new Error("expected a next session");
      expect(decision.attempt.unproductiveSessions).toBe(0);
    });

    it("counts a single unproductive session without pausing", () => {
      // Companion to the hard-pause test below: proves the guard needs two CONSECUTIVE
      // unproductive sessions, not merely one, before it fires.
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 2 }),
        attempt: attemptWith({ unproductiveSessions: 0 }),
        endReason: "HANDOFF",
        checkpointsPublished: 0,
        now,
      });
      expect(decision.type).toBe("START_NEXT_SESSION");
      if (decision.type !== "START_NEXT_SESSION") throw new Error("expected a next session");
      expect(decision.attempt.unproductiveSessions).toBe(1);
    });

    it("hard-pauses after two consecutive sessions produced nothing", () => {
      // Otherwise Loomrail endlessly reassembles the same pack and burns budget while looking
      // like it is working.
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 3 }),
        attempt: attemptWith({ unproductiveSessions: 1 }),
        endReason: "CONTEXT_EXHAUSTED",
        checkpointsPublished: 0,
        now,
      });
      expect(decision).toMatchObject({ type: "HARD_PAUSE", reason: "NO_PROGRESS" });
    });

    it("does not hard-pause when a productive session sits between two unproductive ones", () => {
      // Distinguishes "counts consecutive" from "counts total": two unproductive sessions with a
      // productive one in between must not trip the guard. This models session 3 in a run where
      // session 1 was unproductive, session 2 published a checkpoint (resetting the counter to
      // zero), and session 3 is again unproductive -- only the first of a fresh streak.
      const afterProductiveSession = decideSessionEnded({
        session: runningSession({ ordinal: 2 }),
        attempt: attemptWith({ unproductiveSessions: 1 }),
        endReason: "HANDOFF",
        checkpointsPublished: 1,
        now,
      });
      if (afterProductiveSession.type !== "START_NEXT_SESSION") {
        throw new Error("expected a next session");
      }
      expect(afterProductiveSession.attempt.unproductiveSessions).toBe(0);

      const afterNextUnproductiveSession = decideSessionEnded({
        session: runningSession({ ordinal: 3 }),
        attempt: afterProductiveSession.attempt,
        endReason: "HANDOFF",
        checkpointsPublished: 0,
        now,
      });
      expect(afterNextUnproductiveSession.type).toBe("START_NEXT_SESSION");
    });

    it("rejects an end reason handled by existing pause/cancel/recovery decisions", () => {
      expect(() =>
        decideSessionEnded({
          session: runningSession({ ordinal: 1 }),
          attempt: attemptWith(),
          endReason: "CANCELLED",
          checkpointsPublished: 0,
          now,
        }),
      ).toThrow(WorkflowDomainError);
    });
  });
});
