import type { WorkItem } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  isBoardDirection,
  isBoardOrdering,
  isBoardScope,
  orderWorkItems,
  scopeShows,
  scopeStates,
} from "./boardView";

const workItem = (overrides: Partial<WorkItem> & Pick<WorkItem, "id">): WorkItem => ({
  schemaVersion: 1,
  projectId: "project-1",
  parentId: null,
  type: "TASK",
  title: "Task",
  description: "",
  state: "READY",
  currentStage: null,
  priority: "MEDIUM",
  risk: "MEDIUM",
  acceptanceCriteria: [],
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const ids = (items: readonly WorkItem[]): readonly string[] => items.map((item) => item.id);

describe("board ordering", () => {
  it("puts the most urgent work first when ordering by priority", () => {
    const items = [
      workItem({ id: "low", priority: "LOW" }),
      workItem({ id: "urgent", priority: "URGENT" }),
      workItem({ id: "medium", priority: "MEDIUM" }),
      workItem({ id: "high", priority: "HIGH" }),
    ];

    expect(ids(orderWorkItems(items, { direction: "desc", ordering: "priority" }))).toEqual([
      "urgent",
      "high",
      "medium",
      "low",
    ]);
    expect(ids(orderWorkItems(items, { direction: "asc", ordering: "priority" }))).toEqual([
      "low",
      "medium",
      "high",
      "urgent",
    ]);
  });

  it("orders by creation and update time", () => {
    const items = [
      workItem({ id: "old", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" }),
      workItem({ id: "new", createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" }),
    ];

    expect(ids(orderWorkItems(items, { direction: "desc", ordering: "created" }))).toEqual(["new", "old"]);
    expect(ids(orderWorkItems(items, { direction: "desc", ordering: "updated" }))).toEqual(["old", "new"]);
  });

  it("orders by title", () => {
    const items = [workItem({ id: "b", title: "Beta" }), workItem({ id: "a", title: "Alpha" })];

    expect(ids(orderWorkItems(items, { direction: "asc", ordering: "title" }))).toEqual(["a", "b"]);
  });

  it("breaks ties deterministically instead of leaving render order to input order", () => {
    const left = [workItem({ id: "aaa" }), workItem({ id: "bbb" })];
    const right = [workItem({ id: "bbb" }), workItem({ id: "aaa" })];
    const view = { direction: "desc", ordering: "priority" } as const;

    expect(ids(orderWorkItems(left, view))).toEqual(ids(orderWorkItems(right, view)));
  });

  it("does not mutate the source collection", () => {
    const items = [workItem({ id: "low", priority: "LOW" }), workItem({ id: "urgent", priority: "URGENT" })];

    orderWorkItems(items, { direction: "desc", ordering: "priority" });

    expect(ids(items)).toEqual(["low", "urgent"]);
  });

  it("rejects view values that did not come from the product", () => {
    expect(isBoardOrdering("priority")).toBe(true);
    expect(isBoardOrdering("assignee")).toBe(false);
    expect(isBoardDirection("asc")).toBe(true);
    expect(isBoardDirection("sideways")).toBe(false);
  });
});

describe("board scope", () => {
  it("hides finished work from the active board", () => {
    expect(scopeShows("active", "IN_PROGRESS")).toBe(true);
    expect(scopeShows("active", "DONE")).toBe(false);
    expect(scopeShows("active", "CANCELLED")).toBe(false);
  });

  it("narrows the backlog scope to unstarted work", () => {
    expect(scopeStates.backlog).toEqual(["BACKLOG"]);
    expect(scopeShows("backlog", "READY")).toBe(false);
  });

  it("keeps finished work reachable through the all scope", () => {
    // Without this scope a completed task would leave the product with nowhere to be seen.
    expect(scopeShows("all", "DONE")).toBe(true);
    expect(scopeShows("all", "CANCELLED")).toBe(true);
    for (const state of scopeStates.active) {
      expect(scopeShows("all", state)).toBe(true);
    }
  });

  it("rejects a scope that did not come from the product", () => {
    expect(isBoardScope("all")).toBe(true);
    expect(isBoardScope("archived")).toBe(false);
  });
});
