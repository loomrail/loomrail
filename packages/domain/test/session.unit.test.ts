import type {
  HumanRequest,
  PipelineRun,
  ProviderSession,
  StageAttempt,
  WorkflowDispatch,
  WorkItem,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideAnswerHumanRequest,
  decideApproveBudgetOverride,
  decideContextWindowReported,
  decideSessionEnded,
  decideStageAttemptHardPause,
  WorkflowDomainError,
} from "../src/index.js";

const now = "2026-08-25T18:00:00.000Z";

const runningSession = (overrides: Partial<ProviderSession> = {}): ProviderSession => ({
  schemaVersion: 1,
  id: "session-1",
  agentRunId: null,
  stageAttemptId: "attempt-1",
  ordinal: 1,
  status: "RUNNING",
  endReason: null,
  handoffRequestedAt: null,
  startedAt: "2026-08-25T17:00:00.000Z",
  endedAt: null,
  version: 1,
  pid: null,
  ...overrides,
});

const attemptWith = (overrides: Partial<StageAttempt> = {}): StageAttempt => ({
  schemaVersion: 1,
  id: "attempt-1",
  pipelineRunId: "run-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  correctionRunId: null,
  stage: "IMPLEMENT",
  attempt: 1,
  status: "RUNNING",
  version: 1,
  startedAt: "2026-08-25T16:00:00.000Z",
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  packShareBackoffs: 0,
  resultTree: null,
  ...overrides,
});

const runWith = (overrides: Partial<PipelineRun> = {}): PipelineRun => ({
  schemaVersion: 1,
  id: "run-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  workflowTemplateId: "mock-delivery-v1",
  workflowVersion: 3,
  status: "RUNNING",
  currentStageAttemptId: "attempt-1",
  version: 1,
  createdAt: "2026-08-25T16:00:00.000Z",
  updatedAt: "2026-08-25T16:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

const workItemFixture: WorkItem = {
  schemaVersion: 1,
  id: "work-item-1",
  projectId: "project-1",
  parentId: null,
  type: "TASK",
  title: "Carry a stage attempt across provider sessions",
  description: "Synthetic fixture work",
  state: "IN_PROGRESS",
  currentStage: "IMPLEMENT",
  priority: "MEDIUM",
  risk: "LOW",
  acceptanceCriteria: ["State is durable"],
  version: 1,
  createdAt: "2026-08-25T15:00:00.000Z",
  updatedAt: "2026-08-25T15:00:00.000Z",
};

const pendingDispatchFixture: WorkflowDispatch = {
  schemaVersion: 1,
  id: "dispatch-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "run-1",
  stageAttemptId: "attempt-1",
  mode: "START",
  status: "PENDING",
  createdAt: "2026-08-25T16:00:00.000Z",
  completedAt: null,
};

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

    it("counts a session cut by a failed checkpoint write as unproductive", () => {
      // Spec §6.2: a checkpoint the agent believes it published but Loomrail could not persist ends
      // the session INTERRUPTED and "leaves it unproductive, i.e. falls under §6.5, rather than
      // dissolving in the log". If this returned STAGE_FINISHED or threw, the attempt would sit
      // RUNNING with a consumed dispatch and nobody would ever be told.
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 1 }),
        attempt: attemptWith({ unproductiveSessions: 0 }),
        endReason: "INTERRUPTED",
        checkpointsPublished: 0,
        now,
      });
      expect(decision).toMatchObject({ type: "START_NEXT_SESSION", nextOrdinal: 2 });
      if (decision.type !== "START_NEXT_SESSION") throw new Error("expected a next session");
      expect(decision.attempt.unproductiveSessions).toBe(1);
    });

    it("hard-pauses after a second failed checkpoint write in a row", () => {
      const decision = decideSessionEnded({
        session: runningSession({ ordinal: 2 }),
        attempt: attemptWith({ unproductiveSessions: 1 }),
        endReason: "INTERRUPTED",
        checkpointsPublished: 0,
        now,
      });
      expect(decision).toMatchObject({ type: "HARD_PAUSE", reason: "NO_PROGRESS" });
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

  describe("decideStageAttemptHardPause", () => {
    const pause = (reason: Parameters<typeof decideStageAttemptHardPause>[0]["reason"]) =>
      decideStageAttemptHardPause({
        now,
        workItem: workItemFixture,
        run: runWith(),
        stageAttempt: attemptWith(),
        previousStatus: "RUNNING",
        pendingDispatch: pendingDispatchFixture,
        humanRequestId: "human-request-1",
        reason,
      });

    it("withdraws the attempt's pending dispatch so the daemon's drain has nothing to trip over", () => {
      // A PENDING dispatch is a standing instruction to run this stage. A hard pause produces no
      // provider outcome, so nothing else would ever close it out, and the drain would keep finding
      // an instruction to run a StageAttempt that is no longer runnable.
      const decision = pause({ type: "NO_PROGRESS" });
      expect(decision.dispatch).toMatchObject({ id: "dispatch-1", status: "FAILED" });
    });

    it("marks the pause with a failure code that says it was not the budget", () => {
      // The code is the only thing distinguishing this pause from a budget one, and both the
      // answer path and the budget-override refusal key on it. Without it the owner would be told
      // to buy more tokens to escape a pause that has nothing to do with tokens.
      const decision = pause({ type: "NO_PROGRESS" });
      expect(decision.stageAttempt.status).toBe("HARD_PAUSED");
      expect(decision.stageAttempt.failureCode).toBe("NO_PROGRESS");
      expect(decision.request.blocking).toBe(true);
      expect(decision.request.allowOther).toBe(true);
      expect(decision.events.map(({ type }) => type)).toEqual([
        "STAGE_ATTEMPT_CHANGED",
        "PIPELINE_PAUSED",
        "HUMAN_REQUEST_OPENED",
      ]);
    });

    it("asks a different question when the provider failed to start than when it rejected the pack", () => {
      // Spec §6.3 keeps provider failures out of §7's size-rejection branch: answering a transient
      // error with a question about context size sends the owner after the wrong thing.
      const rejected = pause({ type: "PROVIDER_REJECTED_PACK", sessionOrdinal: 2 });
      const failed = pause({ type: "PROVIDER_START_FAILED", sessionOrdinal: 2 });
      expect(failed.stageAttempt.failureCode).toBe("PROVIDER_START_FAILED");
      expect(failed.request.title).not.toBe(rejected.request.title);
      expect(rejected.request.title).toMatch(/context pack/);
    });

    it("records the byte figures on the floor-exceeded event", () => {
      const decision = pause({
        type: "CONTEXT_FLOOR_EXCEEDED",
        sessionOrdinal: 1,
        requiredBytes: 900,
        budgetBytes: 400,
        budgetTokens: 100,
      });
      expect(decision.events[0]).toMatchObject({
        type: "CONTEXT_FLOOR_EXCEEDED",
        data: { requiredBytes: 900, budgetBytes: 400, budgetTokens: 100 },
      });
    });
  });

  describe("getting the owner out of a session hard pause", () => {
    const pausedAttempt = attemptWith({
      status: "HARD_PAUSED",
      failureCode: "NO_PROGRESS",
      unproductiveSessions: 2,
      version: 2,
    });
    const pausedRun = runWith({ status: "HARD_PAUSED", version: 2 });
    const openRequest: HumanRequest = {
      schemaVersion: 1,
      id: "human-request-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      stageAttemptId: "attempt-1",
      kind: "FREE_TEXT",
      blocking: true,
      title: "Two provider sessions in a row published no checkpoint",
      context: "Neither session recorded any progress.",
      recommendation: "Check whether this stage is too large for one attempt.",
      options: [],
      allowOther: true,
      status: "OPEN",
      version: 1,
      createdAt: now,
      resolvedAt: null,
    };

    it("lets the owner answer the question and puts the stage back to work", () => {
      // The property the pause exists for. Every other exit from HARD_PAUSED is closed to it:
      // resume demands a budget override, and the override supersedes the attempt while leaving
      // this request orphaned and open forever. Answering it is the way out.
      const decision = decideAnswerHumanRequest(
        {
          schemaVersion: 1,
          commandId: "command-answer",
          correlationId: "correlation-answer",
          actor: { type: "HUMAN", id: "local-owner" },
          type: "ANSWER_HUMAN_REQUEST",
          payload: {
            humanRequestId: "human-request-1",
            expectedVersion: 1,
            answer: { type: "OTHER", text: "Split out the migration first, then retry." },
          },
        },
        {
          now,
          workItem: workItemFixture,
          run: pausedRun,
          stageAttempt: pausedAttempt,
          request: openRequest,
          decisionId: "decision-1",
          dispatchId: "dispatch-2",
        },
      );
      expect(decision.request.status).toBe("RESOLVED");
      expect(decision.run.status).toBe("RUNNING");
      expect(decision.stageAttempt.status).toBe("QUEUED");
      // Cleared, so the attempt no longer advertises a pause it has left...
      expect(decision.stageAttempt.failureCode).toBeNull();
      // ...but the guard is not reset: answering must not buy an unbounded run of fresh
      // unproductive sessions.
      expect(decision.stageAttempt.unproductiveSessions).toBe(2);
      expect(decision.dispatch).toMatchObject({ mode: "RESUME" });
      expect(decision.decision.answer).toMatchObject({ type: "OTHER" });
    });

    it("lets the owner retry a rejected provider outcome during Acceptance", () => {
      const decision = decideAnswerHumanRequest(
        {
          schemaVersion: 1,
          commandId: "command-answer-acceptance",
          correlationId: "correlation-answer-acceptance",
          actor: { type: "HUMAN", id: "local-owner" },
          type: "ANSWER_HUMAN_REQUEST",
          payload: {
            humanRequestId: "human-request-1",
            expectedVersion: 1,
            answer: { type: "OTHER", text: "Retry against the authoritative evidence." },
          },
        },
        {
          now,
          workItem: { ...workItemFixture, currentStage: "ACCEPTANCE" },
          run: pausedRun,
          stageAttempt: attemptWith({
            stage: "ACCEPTANCE",
            status: "HARD_PAUSED",
            failureCode: "PROVIDER_OUTCOME_REJECTED",
            version: 2,
          }),
          request: openRequest,
          decisionId: "decision-acceptance",
          dispatchId: "dispatch-acceptance",
        },
      );

      expect(decision.request.status).toBe("RESOLVED");
      expect(decision.run.status).toBe("RUNNING");
      expect(decision.stageAttempt).toMatchObject({
        stage: "ACCEPTANCE",
        status: "QUEUED",
        failureCode: null,
      });
      expect(decision.dispatch).toMatchObject({ mode: "RESUME" });
    });

    it("still refuses an answer to a budget hard pause", () => {
      // A budget pause carries no session failure code, and a prose answer does not buy tokens.
      expect(() =>
        decideAnswerHumanRequest(
          {
            schemaVersion: 1,
            commandId: "command-answer",
            correlationId: "correlation-answer",
            actor: { type: "HUMAN", id: "local-owner" },
            type: "ANSWER_HUMAN_REQUEST",
            payload: {
              humanRequestId: "human-request-1",
              expectedVersion: 1,
              answer: { type: "OTHER", text: "Carry on." },
            },
          },
          {
            now,
            workItem: workItemFixture,
            run: pausedRun,
            stageAttempt: attemptWith({ status: "HARD_PAUSED", failureCode: null, version: 2 }),
            request: openRequest,
            decisionId: "decision-1",
            dispatchId: "dispatch-2",
          },
        ),
      ).toThrow(WorkflowDomainError);
    });

    it("refuses a budget override for a pause the budget did not cause", () => {
      // Otherwise the owner buys tokens they do not need, the attempt is superseded, and the open
      // blocking request is stranded on an attempt that is no longer current -- unanswerable by
      // anything, forever.
      expect(() =>
        decideApproveBudgetOverride(
          {
            schemaVersion: 1,
            commandId: "command-override",
            correlationId: "correlation-override",
            actor: { type: "HUMAN", id: "local-owner" },
            type: "APPROVE_BUDGET_OVERRIDE",
            payload: { pipelineRunId: "run-1", expectedVersion: 2, maxEstimatedTokens: 200 },
          },
          {
            now,
            workItem: workItemFixture,
            run: pausedRun,
            stageAttempt: pausedAttempt,
            currentBudgetPolicy: {
              schemaVersion: 1,
              id: "budget-1",
              projectId: "project-1",
              workItemId: "work-item-1",
              pipelineRunId: "run-1",
              revision: 1,
              maxEstimatedTokens: 100,
              warningThresholds: [0.5],
              createdBy: { type: "HUMAN", id: "local-owner" },
              createdAt: now,
            },
            cumulativeUsage: 0,
            currentAgentRunMaxEstimatedTokens: 80,
            ids: {
              budgetPolicyId: "budget-2",
              stageAttemptId: "attempt-2",
              dispatchId: "dispatch-2",
            },
          },
        ),
      ).toThrow(WorkflowDomainError);
    });
  });
});
