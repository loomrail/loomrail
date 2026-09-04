import type {
  ContextFloorExceededEvent,
  ContextHandoffRequestedEvent,
  ContextWindowUsage,
  HumanRequest,
  HumanRequestOpenedEvent,
  PipelinePausedEvent,
  PipelineRun,
  ProviderSession,
  ProviderSessionEndReason,
  StageAttempt,
  StageAttemptChangedEvent,
  WorkflowDispatch,
  WorkItem,
} from "@loomrail/contracts";

import { pendingDispatchFailed, WorkflowDomainError } from "./workflow.js";

// Same shape as the EventIntent<T> helper in workflow.ts (Pick<T, "data" | "type">): the
// persistence layer stamps sequence/id/aggregateId/actor/occurredAt/correlationId onto the intent
// when it writes the event, so the domain layer never has to invent them.
type EventIntent<T extends { data: unknown; type: string }> = Pick<T, "data" | "type">;

export type ContextWindowReportedDecision =
  | { type: "NO_ACTION" }
  | { type: "REQUEST_HANDOFF"; session: ProviderSession; event: EventIntent<ContextHandoffRequestedEvent> };

export type SessionEndedDecision =
  | { type: "START_NEXT_SESSION"; nextOrdinal: number; attempt: StageAttempt }
  | { type: "HARD_PAUSE"; reason: "NO_PROGRESS"; attempt: StageAttempt }
  | { type: "STAGE_FINISHED" };

const requireMatchingAttempt = (session: ProviderSession, attempt: StageAttempt): void => {
  if (session.stageAttemptId !== attempt.id) {
    throw new WorkflowDomainError(
      "PROVIDER_SESSION_MISMATCH",
      "The ProviderSession does not belong to this StageAttempt",
      { sessionStageAttemptId: session.stageAttemptId, attemptId: attempt.id },
    );
  }
};

// Spec §6.2: window occupancy is reported throughout the session; the first report that reaches
// handoffThreshold marks the session as winding down and asks the provider to wrap up.
// `handoffRequestedAt` already set on the session is what makes this idempotent -- a later report
// (including one that races the session's own end, per §6.2's note on the race between
// onContextWindow and end-of-session) must not request a second time, and must be a safe no-op
// for a session that has already ended.
export const decideContextWindowReported = (context: {
  session: ProviderSession;
  usage: ContextWindowUsage;
  handoffThreshold: number;
  now: string;
}): ContextWindowReportedDecision => {
  if (context.session.status !== "RUNNING" || context.session.handoffRequestedAt !== null) {
    return { type: "NO_ACTION" };
  }

  const occupancy = context.usage.usedTokens / context.usage.windowTokens;
  if (occupancy < context.handoffThreshold) {
    return { type: "NO_ACTION" };
  }

  const session: ProviderSession = {
    ...context.session,
    handoffRequestedAt: context.now,
    version: context.session.version + 1,
  };

  return {
    type: "REQUEST_HANDOFF",
    session,
    event: { type: "CONTEXT_HANDOFF_REQUESTED", data: { session, usage: context.usage } },
  };
};

// Spec §6.3 + §6.5. `endReason` decides what happens next; `checkpointsPublished` decides whether
// this session counted as progress toward the loop guard. The switch is exhaustive over
// ProviderSessionEndReason: COMPLETED finishes the stage, the two continuation reasons and a
// loop-driven INTERRUPTED continue the attempt, and CANCELLED is refused because
// decideCancelPipeline owns it.
export const decideSessionEnded = (context: {
  session: ProviderSession;
  attempt: StageAttempt;
  endReason: ProviderSessionEndReason;
  checkpointsPublished: number;
  now: string;
}): SessionEndedDecision => {
  requireMatchingAttempt(context.session, context.attempt);

  switch (context.endReason) {
    case "COMPLETED":
      return { type: "STAGE_FINISHED" };

    // INTERRUPTED reaches this decision from exactly one place: the session loop cutting a session
    // whose checkpoint write failed (spec §6.2). Recovery after a daemon restart never does --
    // reconciliation writes the session's end itself, without this decision -- so counting it here
    // cannot punish an attempt for the process dying. §6.2 is explicit that a failed checkpoint
    // write "leaves the session unproductive, i.e. falls under §6.5, rather than dissolving in the
    // log", which is precisely this branch. CANCELLED stays refused: cancelling is not a session
    // outcome at all, and decideCancelPipeline owns the whole run.
    case "INTERRUPTED":
    case "HANDOFF":
    case "CONTEXT_EXHAUSTED": {
      const productive = context.checkpointsPublished > 0;
      const unproductiveSessions = productive ? 0 : context.attempt.unproductiveSessions + 1;

      // Two unproductive sessions in a row: the pack keeps getting reassembled and the agent
      // keeps winding down before doing anything. Force a hard pause rather than repeat forever.
      if (unproductiveSessions >= 2) {
        return {
          type: "HARD_PAUSE",
          reason: "NO_PROGRESS",
          attempt: {
            ...context.attempt,
            status: "HARD_PAUSED",
            unproductiveSessions,
            version: context.attempt.version + 1,
          },
        };
      }

      return {
        type: "START_NEXT_SESSION",
        nextOrdinal: context.session.ordinal + 1,
        attempt: {
          ...context.attempt,
          unproductiveSessions,
          version: context.attempt.version + 1,
        },
      };
    }

    case "CANCELLED":
      throw new WorkflowDomainError(
        "SESSION_END_REASON_NOT_HANDLED",
        "Cancellation is handled by decideCancelPipeline, not decideSessionEnded",
        { endReason: context.endReason },
      );
  }
};

// Spec §6.5 and §D8/§7 pair a HARD pause with a question to the owner. `decideSessionEnded` above
// cannot build that question: its signature sees a ProviderSession and a StageAttempt, not the
// WorkItem, the PipelineRun or a durable id for a HumanRequest. That pairing is decided here, in
// one place for all three ways an attempt stops making progress -- a pause with no question is a
// pipeline that stopped without telling its owner anything.
export type StageAttemptPauseReason =
  | { type: "NO_PROGRESS" }
  | {
      type: "CONTEXT_FLOOR_EXCEEDED";
      sessionOrdinal: number;
      requiredBytes: number;
      budgetBytes: number;
      budgetTokens: number;
    }
  | { type: "PROVIDER_REJECTED_PACK"; sessionOrdinal: number }
  | { type: "PROVIDER_START_FAILED"; sessionOrdinal: number }
  | { type: "PROVIDER_OUTCOME_REJECTED"; sessionOrdinal: number; errorCode: string }
  | { type: "SESSION_LIMIT_REACHED"; sessionOrdinal: number; maxSessions: number };

export type StageAttemptPauseDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
  // The attempt's pending dispatch, failed. A hard pause stops the stage without producing a
  // provider outcome, so nothing else would ever close that dispatch out, and the daemon's drain
  // would keep finding a standing instruction to run a StageAttempt that is no longer runnable.
  // Null when the attempt had no pending dispatch.
  dispatch: WorkflowDispatch | null;
  events: (
    | EventIntent<ContextFloorExceededEvent>
    | EventIntent<StageAttemptChangedEvent>
    | EventIntent<PipelinePausedEvent>
    | EventIntent<HumanRequestOpenedEvent>
  )[];
};

type PauseWording = { title: string; context: string; recommendation: string; pauseReason: string };

const pauseWording = (reason: StageAttemptPauseReason): PauseWording => {
  switch (reason.type) {
    case "NO_PROGRESS":
      return {
        title: "Two provider sessions in a row published no checkpoint",
        context:
          "The context pack was reassembled and handed to the provider twice, and neither session recorded any progress. Continuing would keep spending the budget on the same starting point.",
        recommendation:
          "Check whether this stage is too large for one attempt, then resume it or cancel the run.",
        pauseReason: "Two consecutive provider sessions published no checkpoint.",
      };
    case "CONTEXT_FLOOR_EXCEEDED":
      return {
        title: "The required context does not fit the provider's window",
        context: `The sections this stage marks required need ${reason.requiredBytes.toString()} bytes, and the pack budget for this provider is ${reason.budgetBytes.toString()}. Trimming a required section would hand the agent an input Loomrail knows is incomplete.`,
        recommendation:
          "Split this WorkItem into smaller ones, or run this stage on a provider with a larger context window.",
        pauseReason: "The required context sections do not fit the pack budget.",
      };
    case "PROVIDER_START_FAILED":
      return {
        title: "The provider could not run this stage",
        context:
          "Starting the provider session failed for a reason that is not the size of the context pack, and the retry failed too. Loomrail has nothing left to adjust on its own.",
        recommendation:
          "Check that the provider is reachable and configured, then resume this stage or cancel the run.",
        pauseReason: "The provider session failed to start.",
      };
    case "PROVIDER_OUTCOME_REJECTED":
      return {
        title: "The provider returned an invalid stage result",
        context: `The provider finished its turn, but Loomrail rejected the result because it conflicts with the deterministic workflow state (${reason.errorCode}). The session and its usage were closed safely; the stage did not advance.`,
        recommendation:
          "Review the recorded workflow evidence, then answer this request to retry the stage or cancel the run.",
        pauseReason: `The provider outcome was rejected by workflow validation (${reason.errorCode}).`,
      };
    case "SESSION_LIMIT_REACHED":
      return {
        title: "This stage ran out of provider sessions before it finished",
        context: `The provider handed this stage off ${reason.maxSessions.toString()} times without ever completing it. Each session published progress, so nothing here looks broken -- the stage is simply larger than one attempt can carry.`,
        recommendation:
          "Split this WorkItem into smaller ones, or resume the stage to give the attempt another run of sessions.",
        pauseReason: `The stage attempt reached its limit of ${reason.maxSessions.toString()} provider sessions.`,
      };
    case "PROVIDER_REJECTED_PACK":
      return {
        title: "The provider rejected the assembled context pack twice",
        context:
          "Loomrail estimated the pack as fitting, the provider disagreed, and the one automatic retry with a smaller pack share was also rejected. Shrinking the share further without knowing why would be guessing.",
        recommendation:
          "Check the provider's own limits for this stage before resuming, or run the stage on another provider.",
        pauseReason: "The provider rejected the assembled context pack after one automatic retry.",
      };
  }
};

export const decideStageAttemptHardPause = (context: {
  now: string;
  workItem: WorkItem;
  run: PipelineRun;
  // The StageAttempt as it stands in storage, never one another decision has already transitioned:
  // this function performs the whole transition and bumps the version exactly once, so handing it a
  // pre-bumped attempt would write a version the stored row cannot match. For NO_PROGRESS the
  // caller folds `decideSessionEnded`'s new unproductive-session count into the stored attempt and
  // passes that.
  stageAttempt: StageAttempt;
  previousStatus: StageAttempt["status"];
  // The attempt's pending dispatch, if it still has one. Withdrawn below, in this same decision, so
  // that pausing and un-queueing the stage cannot come apart.
  pendingDispatch: WorkflowDispatch | null;
  humanRequestId: string;
  reason: StageAttemptPauseReason;
}): StageAttemptPauseDecision => {
  const wording = pauseWording(context.reason);
  // The failure code is what makes this pause answerable later: see sessionPauseFailureCodes.
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "HARD_PAUSED",
    failureCode: context.reason.type,
    version: context.stageAttempt.version + 1,
  };
  const run: PipelineRun = {
    ...context.run,
    status: "HARD_PAUSED",
    version: context.run.version + 1,
    updatedAt: context.now,
  };
  const workItem: WorkItem = {
    ...context.workItem,
    state: "BLOCKED",
    currentStage: stageAttempt.stage,
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  const request: HumanRequest = {
    schemaVersion: 1,
    id: context.humanRequestId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    stageAttemptId: stageAttempt.id,
    // FREE_TEXT with `allowOther`: the owner's answer is prose, not a choice Loomrail can
    // enumerate, and answering it is what lifts the pause and queues the stage again (see
    // decideAnswerHumanRequest's session-pause branch). The answer is recorded as a Decision, so
    // the next session's pack carries what the owner said about the stall -- which is the point of
    // asking rather than merely pausing.
    kind: "FREE_TEXT",
    blocking: true,
    title: wording.title,
    context: wording.context,
    recommendation: wording.recommendation,
    options: [],
    allowOther: true,
    status: "OPEN",
    version: 1,
    createdAt: context.now,
    resolvedAt: null,
  };

  const events: StageAttemptPauseDecision["events"] = [];
  if (context.reason.type === "CONTEXT_FLOOR_EXCEEDED") {
    events.push({
      type: "CONTEXT_FLOOR_EXCEEDED",
      data: {
        run,
        stageAttempt,
        sessionOrdinal: context.reason.sessionOrdinal,
        requiredBytes: context.reason.requiredBytes,
        budgetBytes: context.reason.budgetBytes,
        budgetTokens: context.reason.budgetTokens,
      },
    });
  }
  events.push(
    { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt, previousStatus: context.previousStatus } },
    { type: "PIPELINE_PAUSED", data: { run, stageAttempt, kind: "HARD", reason: wording.pauseReason } },
    { type: "HUMAN_REQUEST_OPENED", data: { request } },
  );

  return {
    workItem,
    run,
    stageAttempt,
    request,
    dispatch: pendingDispatchFailed(context.pendingDispatch, context.now),
    events,
  };
};
