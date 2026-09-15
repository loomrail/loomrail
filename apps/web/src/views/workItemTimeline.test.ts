import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@loomrail/contracts";

import { isWorkItemTimelineEvent, shouldKeepPagingForLifecycleEvent } from "./workItemTimeline";

// Task 9: WORKSPACE_TOOL_CALL_CHANGED now renders exclusively in Run Activity
// (components/RunActivitySection.tsx). Showing the same daemon-audited action here too -- in a
// second vocabulary, with no way to tell it is the same thing -- is exactly the duplication the
// task's own brief calls out. This is a plain, non-rendering unit test of the filtering predicate
// WorkbenchPage.tsx's Activity timeline uses to exclude it -- WorkbenchPage itself is a very large
// component with no existing render harness, and the fact under test ("this one event type is
// excluded, every other type is kept") needs none of it.

const workItemCreatedEvent: DomainEvent = {
  schemaVersion: 1,
  sequence: 1,
  id: "event-created",
  type: "WORK_ITEM_CREATED",
  aggregateType: "WORK_ITEM",
  aggregateId: "work-item-1",
  projectId: "project-1",
  actor: { type: "HUMAN", id: "local-owner" },
  occurredAt: "2026-09-14T10:00:00.000Z",
  correlationId: "correlation-created",
  data: {
    workItem: {
      schemaVersion: 1,
      id: "work-item-1",
      projectId: "project-1",
      parentId: null,
      type: "TASK",
      title: "Add checkout retry",
      description: "",
      state: "BACKLOG",
      priority: "MEDIUM",
      risk: "MEDIUM",
      acceptanceCriteria: ["The result is measured"],
      currentStage: null,
      createdAt: "2026-09-14T10:00:00.000Z",
      updatedAt: "2026-09-14T10:00:00.000Z",
      version: 1,
    },
  },
};

const workspaceToolCallChangedEvent: DomainEvent = {
  schemaVersion: 1,
  sequence: 2,
  id: "event-tool-call",
  type: "WORKSPACE_TOOL_CALL_CHANGED",
  aggregateType: "WORK_ITEM",
  aggregateId: "work-item-1",
  projectId: "project-1",
  actor: { type: "SYSTEM", id: "workspace-executor" },
  occurredAt: "2026-09-14T10:00:05.000Z",
  correlationId: "correlation-tool-call",
  data: {
    call: {
      schemaVersion: 1,
      id: "workspace-tool-call-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      stageAttemptId: "stage-attempt-1",
      agentRunId: "agent-run-1",
      providerSessionId: "provider-session-1",
      providerCallKey: "a".repeat(64),
      operation: "READ_FILE",
      target: "src/index.ts",
      policyDigest: "b".repeat(64),
      inputDigest: "c".repeat(64),
      status: "SUCCEEDED",
      failureCode: null,
      outputDigest: "d".repeat(64),
      outputBytes: 128,
      exitCode: null,
      startedAt: "2026-09-14T10:00:05.000Z",
      finishedAt: "2026-09-14T10:00:06.000Z",
    },
  },
};

describe("isWorkItemTimelineEvent", () => {
  it("excludes WORKSPACE_TOOL_CALL_CHANGED -- that action now lives only in Run Activity", () => {
    expect(isWorkItemTimelineEvent(workspaceToolCallChangedEvent)).toBe(false);
  });

  it("keeps every other WorkItem lifecycle event", () => {
    expect(isWorkItemTimelineEvent(workItemCreatedEvent)).toBe(true);
  });

  it("filters a mixed page down to just the lifecycle events, in order", () => {
    const page = [workItemCreatedEvent, workspaceToolCallChangedEvent];

    expect(page.filter(isWorkItemTimelineEvent)).toEqual([workItemCreatedEvent]);
  });
});

// Fix round 1: the newest 30 raw events for a busy WorkItem can legitimately be entirely
// WORKSPACE_TOOL_CALL_CHANGED (each tool call appends two), which used to leave the filtered page
// empty -- "No activity yet" rendered right beside the section's own "Show more" button, with real
// lifecycle history one page back. `TaskActivitySection` (WorkbenchPage.tsx) now auto-pages past
// exactly that state; this is the boolean rule driving it, tested directly.
describe("shouldKeepPagingForLifecycleEvent", () => {
  it("keeps paging when the loaded page filtered down to nothing but more raw pages exist", () => {
    expect(
      shouldKeepPagingForLifecycleEvent({
        hasLoadedFirstPage: true,
        hasNextPage: true,
        lifecycleEventsLoaded: 0,
      }),
    ).toBe(true);
  });

  it("stops once a lifecycle event has been found", () => {
    expect(
      shouldKeepPagingForLifecycleEvent({
        hasLoadedFirstPage: true,
        hasNextPage: true,
        lifecycleEventsLoaded: 1,
      }),
    ).toBe(false);
  });

  it("stops once the feed is exhausted, even with nothing filtered in yet", () => {
    expect(
      shouldKeepPagingForLifecycleEvent({
        hasLoadedFirstPage: true,
        hasNextPage: false,
        lifecycleEventsLoaded: 0,
      }),
    ).toBe(false);
  });

  it("never fires before the first page has loaded -- zero loaded is not yet a filtered-empty page", () => {
    expect(
      shouldKeepPagingForLifecycleEvent({
        hasLoadedFirstPage: false,
        hasNextPage: true,
        lifecycleEventsLoaded: 0,
      }),
    ).toBe(false);
  });
});
