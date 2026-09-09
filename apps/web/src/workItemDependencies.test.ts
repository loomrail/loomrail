import { describe, expect, it } from "vitest";
import type { WorkItem, WorkItemDependency } from "@loomrail/contracts";

import { deriveWorkItemDependencyView } from "./workItemDependencies";

const workItem = (id: string, state: WorkItem["state"], parentId: string | null = null): WorkItem => ({
  schemaVersion: 1,
  id,
  projectId: "project-1",
  parentId,
  type: "TASK",
  title: id,
  description: "",
  state,
  priority: "MEDIUM",
  risk: "MEDIUM",
  acceptanceCriteria: ["done"],
  currentStage: null,
  createdAt: `2026-01-01T00:00:0${id.at(-1) ?? "0"}.000Z`,
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
});

const dependency = (blockerWorkItemId: string, blockedWorkItemId: string): WorkItemDependency => ({
  schemaVersion: 1,
  projectId: "project-1",
  kind: "BLOCKS",
  blockerWorkItemId,
  blockedWorkItemId,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("deriveWorkItemDependencyView", () => {
  it("keeps hierarchy separate from execution dependencies", () => {
    const epic = workItem("epic-1", "BACKLOG");
    const child = workItem("task-1", "READY", epic.id);
    const downstream = workItem("task-2", "READY", epic.id);

    expect(
      deriveWorkItemDependencyView(epic, [epic, child, downstream], [dependency(child.id, downstream.id)]),
    ).toMatchObject({
      parent: null,
      children: [child, downstream],
      blockers: [],
      blockedWorkItems: [],
    });
  });

  it("treats only Done blockers as satisfied", () => {
    const target = workItem("task-3", "READY");
    const done = workItem("task-1", "DONE");
    const cancelled = workItem("task-2", "CANCELLED");
    const view = deriveWorkItemDependencyView(
      target,
      [target, done, cancelled],
      [dependency(done.id, target.id), dependency(cancelled.id, target.id)],
    );

    expect(view.blockers.map(({ id }) => id)).toEqual([done.id, cancelled.id]);
    expect(view.unsatisfiedBlockers.map(({ id }) => id)).toEqual([cancelled.id]);
  });
});
