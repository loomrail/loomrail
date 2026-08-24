import type { MoveWorkItemCommand, WorkItem, WorkItemState } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { decideWorkItemCommand, WorkItemDomainError } from "../src/index.js";

const timestamp = "2026-08-22T18:00:00.000Z";

const workItem = (state: WorkItemState, version = 1): WorkItem => ({
  schemaVersion: 1,
  id: "work-item-1",
  projectId: "project-1",
  parentId: null,
  type: "TASK",
  title: "Build the state module",
  description: "",
  state,
  currentStage: null,
  priority: "MEDIUM",
  risk: "MEDIUM",
  acceptanceCriteria: ["State persists"],
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const moveCommand = (from: WorkItemState, to: WorkItemState): MoveWorkItemCommand => ({
  schemaVersion: 1,
  commandId: `move-${from}-${to}`,
  correlationId: `correlation-${from}-${to}`,
  actor: { type: "HUMAN", id: "local-owner" },
  type: "MOVE_WORK_ITEM",
  payload: { workItemId: "work-item-1", expectedVersion: 1, targetState: to },
});

describe("WorkItem decisions", () => {
  const allowed = new Set([
    "BACKLOG:READY",
    "BACKLOG:CANCELLED",
    "READY:BACKLOG",
    "READY:IN_PROGRESS",
    "READY:BLOCKED",
    "READY:CANCELLED",
    "IN_PROGRESS:READY",
    "IN_PROGRESS:BLOCKED",
    "IN_PROGRESS:CANCELLED",
    "BLOCKED:READY",
    "BLOCKED:IN_PROGRESS",
    "BLOCKED:CANCELLED",
  ]);
  const states: WorkItemState[] = ["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];

  for (const from of states) {
    for (const to of states) {
      const transition = `${from}:${to}`;
      it(`${allowed.has(transition) ? "allows" : "rejects"} ${transition}`, () => {
        const decide = (): WorkItemState =>
          decideWorkItemCommand(moveCommand(from, to), {
            current: workItem(from),
            hasChildren: false,
            now: timestamp,
          }).workItem.state;

        if (allowed.has(transition)) {
          expect(decide()).toBe(to);
        } else {
          expect(decide).toThrow(WorkItemDomainError);
        }
      });
    }
  }

  it("requires an exact expected version", () => {
    expect(() =>
      decideWorkItemCommand(moveCommand("READY", "BLOCKED"), {
        current: workItem("READY", 2),
        now: timestamp,
      }),
    ).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
  });

  it("keeps parent WorkItems out of execution", () => {
    expect(() =>
      decideWorkItemCommand(moveCommand("READY", "IN_PROGRESS"), {
        current: workItem("READY"),
        hasChildren: true,
        now: timestamp,
      }),
    ).toThrow(expect.objectContaining({ code: "WORK_ITEM_HAS_CHILDREN" }));
  });

  it("creates a normalized backlog WorkItem", () => {
    const decision = decideWorkItemCommand(
      {
        schemaVersion: 1,
        commandId: "create-1",
        correlationId: "correlation-create-1",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CREATE_WORK_ITEM",
        payload: {
          projectId: "project-1",
          parentId: null,
          type: "TASK",
          title: "First task",
          description: "",
          priority: "HIGH",
          risk: "LOW",
          acceptanceCriteria: ["It is persisted"],
        },
      },
      { now: timestamp, newWorkItemId: "work-item-2" },
    );

    expect(decision.workItem).toMatchObject({
      id: "work-item-2",
      state: "BACKLOG",
      version: 1,
    });
    expect(decision.event.type).toBe("WORK_ITEM_CREATED");
  });

  it("rejects adding a child to an in-progress parent", () => {
    expect(() =>
      decideWorkItemCommand(
        {
          schemaVersion: 1,
          commandId: "create-child",
          correlationId: "correlation-create-child",
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CREATE_WORK_ITEM",
          payload: {
            projectId: "project-1",
            parentId: "work-item-1",
            type: "SUBTASK",
            title: "Child task",
            description: "",
            priority: "MEDIUM",
            risk: "LOW",
            acceptanceCriteria: [],
          },
        },
        {
          now: timestamp,
          newWorkItemId: "work-item-2",
          parent: workItem("IN_PROGRESS"),
        },
      ),
    ).toThrow(expect.objectContaining({ code: "PARENT_IN_PROGRESS" }));
  });

  it("rejects an update that changes nothing", () => {
    expect(() =>
      decideWorkItemCommand(
        {
          schemaVersion: 1,
          commandId: "update-1",
          correlationId: "correlation-update-1",
          actor: { type: "HUMAN", id: "local-owner" },
          type: "UPDATE_WORK_ITEM",
          payload: {
            workItemId: "work-item-1",
            expectedVersion: 1,
            patch: { title: "Build the state module" },
          },
        },
        { current: workItem("BACKLOG"), now: timestamp },
      ),
    ).toThrow(expect.objectContaining({ code: "NO_CHANGES" }));
  });
});
