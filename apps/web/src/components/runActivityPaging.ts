import type { AgentRunActivityPage, WorkItem, WorkflowSnapshot } from "@loomrail/contracts";

// Plain function values, not components -- kept out of RunActivitySection.tsx itself (a component
// file react-refresh expects to export only components), the same reason isWorkItemTimelineEvent
// lives in its own module rather than WorkbenchPage.tsx.
//
// `omittedCount` is a task-level count: it comes from one aggregate over every one of the WorkItem's
// runs' counters rows, unaffected by which page was asked for, so the freshest page's value is the
// current one and RunActivitySection reads it off the last loaded page.
//
// `gap` and `degraded` are warnings, and the rule for a warning is different: it must not un-announce
// itself, so both are read across every page loaded so far.
//
// `gap` is purely per-page, and since fix round 2 on Task 2 it has two triggers -- the page's cursor
// named a position no longer held, or a source came back at its read-ahead cap and the page still
// ended with no next cursor. Neither can fire on a first page.
//
// `degraded` is mostly a task-level fact (the same aggregate, and nothing ever clears the stored
// flag), but the route ORs two per-PAGE facts into it as well: a run whose stage would not resolve,
// and audited rows for a run with no live provider. Both need a data shape production cannot produce
// going forward -- a foreign-key orphan, or a MOCK run that somehow owns audited calls -- which is
// why this was read off the last page alone until fix round 1 on Task 5. Rare is not impossible, and
// reading only the last loaded page let a warning raised on page two disappear when page three came
// back clean: the same silent hole `anyPageHasGap` already existed to prevent for its sibling flag,
// left standing in the sibling itself.
export const anyPageHasGap = (pages: readonly AgentRunActivityPage[]): boolean =>
  pages.some((page) => page.gap);

export const anyPageIsDegraded = (pages: readonly AgentRunActivityPage[]): boolean =>
  pages.some((page) => page.degraded);

// Fix round 1 on Task 3 (review round 1 on the predecessor branch made this the accepted shape
// first): a WorkItem that has never started its workflow carries no diagnostic value in an empty
// Run Activity card, so the section renders nothing at all for it -- the same call
// `AttemptSessionsPanel` in WorkbenchPage.tsx makes for its own "no sessions yet" case
// (`if (sessions.length === 0) return null;`).
//
// TWO signals, because `currentStage` alone is not the one this gate needs. It is set the moment
// START_WORKFLOW runs and survives every later stage transition and a budget pause -- which is why
// it replaced the AgentRun-resolution chain that flickered while a task was merely paused. But it
// is NOT "never cleared again", as an earlier comment here claimed: three owner-facing CANCEL
// decisions put it back to `null` on a task that provably has history --
// `packages/domain/src/qa-correction.ts` (decideQACorrectionGate's CANCEL),
// `packages/domain/src/verification-correction.ts` (both correction gates' CANCEL). All three fire
// late in a pipeline, so on `currentStage` alone the whole account of what the agents did vanished
// the moment the owner cancelled -- the same narrative disappearance spec 128 exists to close,
// reintroduced on a different axis.
//
// `state === "CANCELLED"` is not a usable stand-in either: `decideMove`
// (packages/domain/src/index.ts) allows BACKLOG -> CANCELLED directly, so a task cancelled before it
// ever ran reaches CANCELLED with no history at all.
//
// The second signal is therefore the workflow snapshot's own `run`. A `pipeline_runs` row exists for
// a WorkItem if and only if START_WORKFLOW has run for it at least once (`decideStartPipeline`
// creates it; nothing in packages/persistence-sqlite ever deletes from `pipeline_runs`), and
// `readWorkflowSnapshot` returns `run: null` precisely when the WorkItem has none. It is the direct
// answer to "did this task ever run", where `currentStage` only ever answered "is it somewhere in a
// pipeline right now". `currentStage` stays first because it needs no query at all and settles the
// overwhelmingly common cases; `snapshot === undefined` (still loading) is treated as "not yet
// known", so the section appears once the answer arrives rather than flashing an empty card at a
// task that never ran.
export const hasStartedWorkflow = (
  item: Pick<WorkItem, "currentStage">,
  workflow: Pick<WorkflowSnapshot, "run"> | undefined,
): boolean => item.currentStage !== null || (workflow !== undefined && workflow.run !== null);
