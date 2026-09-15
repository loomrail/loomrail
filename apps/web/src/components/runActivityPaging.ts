import type { AgentRunActivityPage, WorkItem } from "@loomrail/contracts";

// Plain function values, not components -- kept out of RunActivitySection.tsx itself (a component
// file react-refresh expects to export only components), the same reason isWorkItemTimelineEvent
// lives in its own module rather than WorkbenchPage.tsx.
//
// `degraded` and `omittedCount` are task-level facts: both come from one aggregate over every one of
// the WorkItem's runs' counters rows, unaffected by which page was asked for, so the freshest page's
// value is the current one. (The route ORs one more thing into `degraded` that IS per-page -- a run
// whose stage would not resolve, or audited rows for a run with no live provider -- but both need a
// data shape production cannot produce going forward: a foreign-key orphan, or a MOCK run that
// somehow owns audited calls.) `gap`, unlike those two, is genuinely per-PAGE, and since fix round 2
// on Task 2 it has two triggers: the page's cursor named a position no longer held, or a source
// returned its whole read-ahead and the page still ended with no next cursor. Neither can fire on a
// first page, and a later page tripping neither does not unsay an earlier one that did. Reading only
// the last loaded page's `gap` would make an announced gap vanish the moment the owner loads one
// more page: exactly the silent hole this flag exists to prevent.
export const anyPageHasGap = (pages: readonly AgentRunActivityPage[]): boolean =>
  pages.some((page) => page.gap);

// Fix round 1 on Task 3 (review round 1 on the predecessor branch made this the accepted shape
// first): a WorkItem that has never started its workflow carries no diagnostic value in an empty
// Run Activity card, so the section renders nothing at all for it -- the same call
// `AttemptSessionsPanel` in WorkbenchPage.tsx makes for its own "no sessions yet" case
// (`if (sessions.length === 0) return null;`).
//
// `currentStage` is the signal, not a resolved AgentRun id: it is `null` only before START_WORKFLOW
// ever runs (packages/domain/src/index.ts) and stays set through every later stage transition AND
// through a budget pause (packages/domain/src/workflow.ts sets `currentStage: stageAttempt.stage`
// on both the transition and the pause path) -- so unlike the AgentRun-id resolution chain this
// gate used to depend on, it cannot flicker back to "unknown" while the task is merely paused
// between attempts, and needs no extra query to read.
export const hasStartedWorkflow = (item: Pick<WorkItem, "currentStage">): boolean =>
  item.currentStage !== null;
