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
 * It lives in its own module because both of those decisions are in `workflow.ts` while the pause
 * that stamps the code is in `session.ts`; putting it in either would make the two import each
 * other.
 */
export const sessionPauseFailureCodes = [
  "NO_PROGRESS",
  "CONTEXT_FLOOR_EXCEEDED",
  "PROVIDER_REJECTED_PACK",
  "PROVIDER_START_FAILED",
] as const;

export type SessionPauseFailureCode = (typeof sessionPauseFailureCodes)[number];

export const isSessionPauseFailureCode = (code: string | null): code is SessionPauseFailureCode =>
  code !== null && (sessionPauseFailureCodes as readonly string[]).includes(code);
