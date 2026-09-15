import type { AgentRunActivityPage, WorkItem } from "@loomrail/contracts";

// Plain function values, not components -- kept out of RunActivitySection.tsx itself (a component
// file react-refresh expects to export only components), the same reason isWorkItemTimelineEvent
// lives in its own module rather than WorkbenchPage.tsx.
//
// `degraded` and `omittedCount` are run-level facts: every page's read of them comes from the same
// whole-buffer query (apps/daemon/src/agent-run-activity.ts), so the freshest page's value is the
// current one. `gap`, unlike those two, is per-PAGE -- true only on the one page whose cursor
// landed on pruned data, false on the first page and on every page fetched after it. Reading only
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
