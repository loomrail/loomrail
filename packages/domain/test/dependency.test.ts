import type {
  SetWorkItemDependenciesCommand,
  WorkItem,
  WorkItemDependency,
  WorkItemState,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { decideSetWorkItemDependencies } from "../src/index.js";

const timestamp = "2026-09-09T09:00:00.000Z";

const item = (
  id: string,
  options: { projectId?: string; state?: WorkItemState; version?: number } = {},
): WorkItem => ({
  schemaVersion: 1,
  id,
  projectId: options.projectId ?? "project-1",
  parentId: null,
  type: "TASK",
  title: id,
  description: "",
  state: options.state ?? "BACKLOG",
  currentStage: null,
  priority: "MEDIUM",
  risk: "MEDIUM",
  acceptanceCriteria: ["done"],
  version: options.version ?? 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const edge = (blockerWorkItemId: string, blockedWorkItemId: string): WorkItemDependency => ({
  schemaVersion: 1,
  projectId: "project-1",
  kind: "BLOCKS",
  blockerWorkItemId,
  blockedWorkItemId,
  createdAt: timestamp,
});

const command = (
  blockerWorkItemIds: readonly string[],
  options: { actor?: "HUMAN" | "SYSTEM"; expectedVersion?: number; workItemId?: string } = {},
): SetWorkItemDependenciesCommand => ({
  schemaVersion: 1,
  commandId: "set-dependencies-1",
  correlationId: "correlation-1",
  actor: { type: options.actor ?? "HUMAN", id: "local-owner" },
  type: "SET_WORK_ITEM_DEPENDENCIES",
  payload: {
    workItemId: options.workItemId ?? "c",
    expectedVersion: options.expectedVersion ?? 1,
    blockerWorkItemIds: [...blockerWorkItemIds],
  },
});

describe("WorkItem dependency decisions", () => {
  it("atomically replaces incoming blockers in canonical order and retains unchanged edge time", () => {
    const decision = decideSetWorkItemDependencies(command(["b", "a"]), {
      now: "2026-09-09T10:00:00.000Z",
      target: item("c"),
      projectWorkItems: [item("c"), item("a"), item("b"), item("old")],
      dependencies: [edge("a", "c"), edge("old", "c")],
      hasActiveWorkflow: false,
    });

    expect(decision.blockedWorkItem).toMatchObject({ id: "c", version: 2 });
    expect(decision.dependencies).toEqual([
      edge("a", "c"),
      { ...edge("b", "c"), createdAt: "2026-09-09T10:00:00.000Z" },
    ]);
    expect(decision.addedBlockerWorkItemIds).toEqual(["b"]);
    expect(decision.removedBlockerWorkItemIds).toEqual(["old"]);
    expect(decision.event).toMatchObject({
      type: "WORK_ITEM_DEPENDENCIES_SET",
      data: {
        blockedWorkItemId: "c",
        blockerWorkItemIds: ["a", "b"],
        previousBlockerWorkItemIds: ["a", "old"],
        workItemVersion: 2,
      },
    });
  });

  const forbidden: readonly {
    name: string;
    expectedCode: string;
    command: SetWorkItemDependenciesCommand;
    context: Parameters<typeof decideSetWorkItemDependencies>[1];
  }[] = [
    {
      name: "a non-human actor",
      expectedCode: "DEPENDENCY_ACTOR_FORBIDDEN",
      command: command(["a"], { actor: "SYSTEM" }),
      context: {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [item("a"), item("c")],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "a stale target",
      expectedCode: "DEPENDENCY_VERSION_CONFLICT",
      command: command(["a"], { expectedVersion: 1 }),
      context: {
        now: timestamp,
        target: item("c", { version: 2 }),
        projectWorkItems: [item("a"), item("c", { version: 2 })],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "duplicate blockers",
      expectedCode: "DEPENDENCY_DUPLICATE",
      command: command(["a", "a"]),
      context: {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [item("a"), item("c")],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "an oversized incoming blocker set",
      expectedCode: "DEPENDENCY_GRAPH_LIMIT",
      command: command(Array.from({ length: 51 }, (_, index) => `blocker-${index.toString()}`)),
      context: {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [
          item("c"),
          ...Array.from({ length: 51 }, (_, index) => item(`blocker-${index.toString()}`)),
        ],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "a self edge",
      expectedCode: "DEPENDENCY_SELF_REFERENCE",
      command: command(["c"]),
      context: {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [item("c")],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "a missing blocker",
      expectedCode: "DEPENDENCY_WORK_ITEM_NOT_FOUND",
      command: command(["missing"]),
      context: {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [item("c")],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "a foreign blocker",
      expectedCode: "DEPENDENCY_PROJECT_MISMATCH",
      command: command(["foreign"]),
      context: {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [item("c"), item("foreign", { projectId: "project-2" })],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "a direct cycle",
      expectedCode: "DEPENDENCY_CYCLE",
      command: command(["a"], { workItemId: "b" }),
      context: {
        now: timestamp,
        target: item("b"),
        projectWorkItems: [item("a"), item("b")],
        dependencies: [edge("b", "a")],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "a transitive cycle",
      expectedCode: "DEPENDENCY_CYCLE",
      command: command(["a"], { workItemId: "c" }),
      context: {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [item("a"), item("b"), item("c")],
        dependencies: [edge("c", "b"), edge("b", "a")],
        hasActiveWorkflow: false,
      },
    },
    {
      name: "an active target",
      expectedCode: "DEPENDENCY_TARGET_ACTIVE",
      command: command(["a"]),
      context: {
        now: timestamp,
        target: item("c", { state: "IN_PROGRESS" }),
        projectWorkItems: [item("a"), item("c", { state: "IN_PROGRESS" })],
        dependencies: [],
        hasActiveWorkflow: true,
      },
    },
    {
      name: "a terminal target",
      expectedCode: "DEPENDENCY_TARGET_TERMINAL",
      command: command(["a"]),
      context: {
        now: timestamp,
        target: item("c", { state: "DONE" }),
        projectWorkItems: [item("a"), item("c", { state: "DONE" })],
        dependencies: [],
        hasActiveWorkflow: false,
      },
    },
  ];

  for (const testCase of forbidden) {
    it(`rejects ${testCase.name} with a typed error`, () => {
      expect(() => decideSetWorkItemDependencies(testCase.command, testCase.context)).toThrow(
        expect.objectContaining({ code: testCase.expectedCode }),
      );
    });
  }

  it("refuses an unchanged set instead of inventing an audit event", () => {
    expect(() =>
      decideSetWorkItemDependencies(command(["a"]), {
        now: timestamp,
        target: item("c"),
        projectWorkItems: [item("a"), item("c")],
        dependencies: [edge("a", "c")],
        hasActiveWorkflow: false,
      }),
    ).toThrow(expect.objectContaining({ code: "DEPENDENCY_NO_CHANGES" }));
  });
});
