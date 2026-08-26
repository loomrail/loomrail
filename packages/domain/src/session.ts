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
  WorkItem,
} from "@loomrail/contracts";

import { WorkflowDomainError } from "./workflow.js";

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
// ProviderSessionEndReason: COMPLETED and the two continuation reasons are handled here,
// INTERRUPTED and CANCELLED are explicitly rejected because they are already handled by the
// existing recovery/cancel decisions (decideRecoverInterruptedWorkflow, decideCancelPipeline) --
// this function is never the one that ends a session for those reasons.
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

    case "INTERRUPTED":
    case "CANCELLED":
      throw new WorkflowDomainError(
        "SESSION_END_REASON_NOT_HANDLED",
        "This end reason is handled by the existing recovery and cancellation decisions, not decideSessionEnded",
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
  | { type: "PROVIDER_REJECTED_PACK"; sessionOrdinal: number };

export type StageAttemptPauseDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
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
  // For NO_PROGRESS this is `decideSessionEnded`'s already-decided attempt, which carries the new
  // unproductive-session count and is already HARD_PAUSED; the pause below is idempotent so the
  // same function serves the reasons that arrive with an untouched attempt.
  stageAttempt: StageAttempt;
  previousStatus: StageAttempt["status"];
  humanRequestId: string;
  reason: StageAttemptPauseReason;
}): StageAttemptPauseDecision => {
  const wording = pauseWording(context.reason);
  const stageAttempt: StageAttempt =
    context.stageAttempt.status === "HARD_PAUSED"
      ? context.stageAttempt
      : { ...context.stageAttempt, status: "HARD_PAUSED", version: context.stageAttempt.version + 1 };
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
    // FREE_TEXT with no options: the owner's real answer is an action on the run (resume, cancel,
    // split the WorkItem), not a choice Loomrail can enumerate. A blocking request keeps the
    // stalled attempt visible in the owner's inbox instead of leaving a silently paused pipeline.
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

  return { workItem, run, stageAttempt, request, events };
};
