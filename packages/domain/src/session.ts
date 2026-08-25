import type {
  ContextHandoffRequestedEvent,
  ContextWindowUsage,
  ProviderSession,
  ProviderSessionEndReason,
  StageAttempt,
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
