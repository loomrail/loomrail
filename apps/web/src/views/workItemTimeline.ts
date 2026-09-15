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
