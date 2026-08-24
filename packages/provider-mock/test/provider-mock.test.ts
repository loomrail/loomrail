import type { ProviderInvocation } from "@loomrail/provider-core";
import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/index.js";

const invocation = (stage: "DISCOVERY" | "PLAN"): ProviderInvocation => ({
  decision: null,
  dispatch: {
    schemaVersion: 1,
    id: "dispatch-1",
    projectId: "project-1",
    workItemId: "work-item-1",
    pipelineRunId: "run-1",
    stageAttemptId: "attempt-1",
    mode: "START",
    status: "PENDING",
    createdAt: "2026-08-24T10:00:00.000Z",
    completedAt: null,
  },
  stageAttempt: {
    schemaVersion: 1,
    id: "attempt-1",
    pipelineRunId: "run-1",
    projectId: "project-1",
    workItemId: "work-item-1",
    stage,
    attempt: 1,
    status: "QUEUED",
    version: 1,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
  },
  workItem: {
    schemaVersion: 1,
    id: "work-item-1",
    projectId: "project-1",
    parentId: null,
    type: "TASK",
    title: "Mock delivery",
    description: "",
    state: "IN_PROGRESS",
    currentStage: stage,
    priority: "MEDIUM",
    risk: "LOW",
    acceptanceCriteria: [],
    version: 2,
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  },
});

describe("mock provider scenario A", () => {
  it("opens a recommended single-choice request during discovery", async () => {
    const result = await createMockProvider().start(invocation("DISCOVERY"));
    expect(result).toMatchObject({
      type: "NEEDS_HUMAN",
      request: { kind: "SINGLE_CHOICE", allowOther: true, blocking: true },
    });
  });

  it("completes planning without another human request", async () => {
    await expect(createMockProvider().start(invocation("PLAN"))).resolves.toMatchObject({
      type: "COMPLETED",
    });
  });
});
