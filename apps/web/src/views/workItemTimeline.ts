import type { DomainEvent } from "@loomrail/contracts";

// WORKSPACE_TOOL_CALL_CHANGED now renders exclusively in Run Activity
// (components/RunActivitySection.tsx), not in the WorkItem-lifecycle Activity timeline
// (WorkbenchPage.tsx's TaskActivitySection): the same audited action shown in both places, in two
// different vocabularies, would leave the owner unable to tell it is one action.
//
// A plain function value, not a component -- kept out of WorkbenchPage.tsx itself (a component
// file react-refresh expects to export only components) so it can be unit tested on its own
// without pulling in that very large module's render tree.
export type WorkItemTimelineEvent = Exclude<DomainEvent, { type: "WORKSPACE_TOOL_CALL_CHANGED" }>;

export const isWorkItemTimelineEvent = (event: DomainEvent): event is WorkItemTimelineEvent =>
  event.type !== "WORKSPACE_TOOL_CALL_CHANGED";

/**
 * Whether `TaskActivitySection` should keep paging the raw (unfiltered) Events feed forward on its
 * own, before showing anything, rather than let the owner see an empty list.
 *
 * The events feed is read newest-first, 30 raw rows per page, and one workspace tool call appends
 * TWO WORKSPACE_TOOL_CALL_CHANGED events (start, finish) -- both now excluded by
 * `isWorkItemTimelineEvent`. During and right after a busy run the newest 30 raw events for an item
 * can legitimately be *entirely* tool calls, which would otherwise leave the filtered page empty
 * while real lifecycle history still exists one page back: "No activity yet" rendered beside the
 * section's own "Show more" button.
 *
 * `hasLoadedFirstPage` gates this on purpose: before the first page has even arrived,
 * `lifecycleEventsLoaded === 0` is simply "nothing has loaded yet", not "the loaded page was all
 * tool calls" -- conflating the two would auto-page before the ordinary first render had a chance
 * to. This always terminates once it does start: WORK_ITEM_CREATED is every WorkItem's first Event
 * and is never filtered out, so the walk back through history cannot run past it.
 */
export const shouldKeepPagingForLifecycleEvent = (input: {
  hasLoadedFirstPage: boolean;
  lifecycleEventsLoaded: number;
  hasNextPage: boolean;
}): boolean => input.hasLoadedFirstPage && input.lifecycleEventsLoaded === 0 && input.hasNextPage;
