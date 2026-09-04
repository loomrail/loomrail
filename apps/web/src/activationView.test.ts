import { describe, expect, it } from "vitest";
import type {
  ListedProject,
  ProjectProviderSelectionResponse,
  WorkItem,
  WorkflowSnapshot,
} from "@loomrail/contracts";
import { guidedActivationContract } from "@loomrail/contracts";

import {
  isGuidedActivationTask,
  projectGuidedActivation,
  selectGuidedActivationTask,
} from "./activationView";

const workItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  schemaVersion: 1,
  id: "guided-task-1",
  projectId: "project-1",
  parentId: null,
  ...guidedActivationContract.task,
  state: "BACKLOG",
  currentStage: null,
  version: 1,
  createdAt: "2026-09-04T18:00:00.000Z",
  updatedAt: "2026-09-04T18:00:00.000Z",
  ...overrides,
});

const project = {
  schemaVersion: 1,
  id: "project-1",
  workspaceId: "workspace-1",
  fixtureId: "web-app-a",
  name: "Web App A",
  repositoryPath: "/tmp/web-app-a",
  repositoryStatus: "READY",
  providerPreference: "MOCK",
  status: "ACTIVE",
  version: 2,
  createdAt: "2026-09-04T17:00:00.000Z",
  updatedAt: "2026-09-04T17:00:00.000Z",
} satisfies ListedProject;

const selection = {
  selection: { preference: "MOCK" },
} as ProjectProviderSelectionResponse;

describe("guided activation projection", () => {
  it("matches only the complete canonical recipe and prefers an explicit durable task", () => {
    const older = workItem({ id: "older" });
    const newer = workItem({ id: "newer", createdAt: "2026-09-04T19:00:00.000Z" });
    const drifted = workItem({ id: "drifted", title: "Similar but not canonical" });

    expect(isGuidedActivationTask(drifted)).toBe(false);
    expect(selectGuidedActivationTask([older, newer, drifted])?.id).toBe("newer");
    expect(selectGuidedActivationTask([older, newer], "older")?.id).toBe("older");
  });

  it("does not use a cancelled or stale requested task as progress", () => {
    expect(selectGuidedActivationTask([workItem({ state: "CANCELLED" })], "guided-task-1")).toBeNull();
    expect(selectGuidedActivationTask([workItem()], "unknown-task")?.id).toBe("guided-task-1");
  });

  it("derives each owner action from durable project, task, and workflow state", () => {
    expect(projectGuidedActivation(null, null, null, null).current).toBe("WORKSPACE");
    expect(projectGuidedActivation(project, null, null, null).current).toBe("PROVIDER");
    expect(projectGuidedActivation(project, selection, null, null).current).toBe("TASK");
    expect(projectGuidedActivation(project, selection, workItem(), null).current).toBe("READY");
    expect(projectGuidedActivation(project, selection, workItem({ state: "READY" }), null).current).toBe(
      "RUN",
    );
  });

  it("requires the durable acceptance package to report completion", () => {
    const atStage = (stage: "DISCOVERY" | "REVIEW" | "QA"): WorkflowSnapshot =>
      ({
        run: { status: "RUNNING", currentStageAttemptId: `attempt-${stage}` },
        stageAttempts: [{ id: `attempt-${stage}`, stage }],
        acceptancePackage: null,
      }) as WorkflowSnapshot;
    const pending = {
      run: { status: "WAITING_HUMAN" },
      stageAttempts: [],
      acceptancePackage: { status: "PENDING" },
    } as unknown as WorkflowSnapshot;
    const accepted = {
      run: { status: "SUCCEEDED" },
      stageAttempts: [],
      acceptancePackage: { status: "ACCEPTED" },
    } as unknown as WorkflowSnapshot;
    const readyTask = workItem({ state: "IN_PROGRESS" });

    expect(projectGuidedActivation(project, selection, readyTask, atStage("DISCOVERY")).current).toBe(
      "REQUEST",
    );
    expect(projectGuidedActivation(project, selection, readyTask, atStage("REVIEW")).current).toBe("REVIEW");
    expect(projectGuidedActivation(project, selection, readyTask, atStage("QA")).current).toBe("QA");
    expect(projectGuidedActivation(project, selection, readyTask, pending).current).toBe("ACCEPTANCE");
    expect(projectGuidedActivation(project, selection, readyTask, accepted).current).toBe("COMPLETE");
    for (const status of ["RETURNED", "REJECTED"] as const) {
      const resolved = {
        run: { status: "FAILED" },
        stageAttempts: [],
        acceptancePackage: { status },
      } as unknown as WorkflowSnapshot;
      expect(projectGuidedActivation(project, selection, readyTask, resolved).current).toBe("COMPLETE");
    }
  });
});
