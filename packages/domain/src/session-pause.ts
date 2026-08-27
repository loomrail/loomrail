/**
 * The `StageAttempt.failureCode` values that mark a HARD pause as caused by the session loop
 * rather than by the token budget.
 *
 * The distinction is load-bearing, not bookkeeping. A budget hard pause is escaped by approving a
 * bigger budget, and nothing else. The session loop's pauses (spec §6.5, §D8, §7) have nothing to
 * do with tokens, so buying more of them would supersede the attempt without addressing the
 * question the owner was asked -- orphaning that question as permanently open. The code is what
 * lets `decideAnswerHumanRequest` accept an answer to it and lift the pause, and what lets
 * `decideApproveBudgetOverride` refuse to pretend a bigger budget is the answer.
 *
 * The list itself is defined in `@loomrail/contracts` (see `sessionPauseFailureCodes` there), not
 * here, because the Task Cockpit needs the same answer to "is this a session pause" and apps/web
 * depends on @loomrail/contracts and @loomrail/ui only, never on @loomrail/domain. Re-exported here
 * so the decisions in `workflow.ts` (which imports from this module, not from `session.ts`, to
 * avoid a cycle between the two) don't have to reach past the domain package's own boundary.
 */
export {
  sessionPauseFailureCodes,
  isSessionPauseFailureCode,
  type SessionPauseFailureCode,
} from "@loomrail/contracts";
