import type {
  AnswerHumanRequestCommand,
  HumanRequest,
  PipelineRun,
  StageAttempt,
  StartMockPipelineCommand,
  WorkItem,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { decideAnswerHumanRequest, decideStartMockPipeline, WorkflowDomainError } from "../src/index.js";

const timestamp = "2026-08-24T10:00:00.000Z";
const contextPack: StartMockPipelineCommand["payload"]["template"]["stages"][number]["contextPack"] = {
  schemaVersion: 1,
  sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
};
const template: StartMockPipelineCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "DISCOVERY", ordinal: 0, contextPack },
    { stage: "PLAN", ordinal: 1, contextPack },
    { stage: "IMPLEMENT", ordinal: 2, contextPack },
  ],
};
const workItem = (state: WorkItem["state"]): WorkItem => ({
  schemaVersion: 1,
  id: "work-item-1",
  projectId: "project-1",
  parentId: null,
  type: "TASK",
  title: "Run the workflow",
  description: "",
  state,
  currentStage: state === "BLOCKED" ? "DISCOVERY" : null,
  priority: "MEDIUM",
  risk: "LOW",
  acceptanceCriteria: [],
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
});

describe("mock workflow decisions", () => {
  it("starts only a ready leaf and creates the first durable dispatch", () => {
    const command: StartMockPipelineCommand = {
      schemaVersion: 1,
      commandId: "start-1",
      correlationId: "correlation-start-1",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: "work-item-1",
        expectedVersion: 2,
        template,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    };
    const started = decideStartMockPipeline(command, {
      now: timestamp,
      workItem: workItem("READY"),
      activeRun: null,
      hasChildren: false,
      ids: {
        pipelineRunId: "run-1",
        stageAttemptId: "attempt-1",
        budgetPolicyId: "budget-1",
        dispatchId: "dispatch-1",
      },
    });
    expect(started).toMatchObject({
      workItem: { state: "IN_PROGRESS", currentStage: "DISCOVERY" },
      stageAttempt: { status: "QUEUED" },
      dispatch: { mode: "START", status: "PENDING" },
    });
    expect(() =>
      decideStartMockPipeline(command, {
        now: timestamp,
        workItem: workItem("BACKLOG"),
        activeRun: null,
        hasChildren: false,
        ids: {
          pipelineRunId: "run-2",
          stageAttemptId: "attempt-2",
          budgetPolicyId: "budget-2",
          dispatchId: "dispatch-2",
        },
      }),
    ).toThrow(WorkflowDomainError);
  });

  it("records one valid decision and creates a resume dispatch", () => {
    const run: PipelineRun = {
      schemaVersion: 1,
      id: "run-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      workflowTemplateId: template.id,
      workflowVersion: 1,
      status: "WAITING_HUMAN",
      currentStageAttemptId: "attempt-1",
      version: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };
    const stageAttempt: StageAttempt = {
      schemaVersion: 1,
      id: "attempt-1",
      pipelineRunId: run.id,
      projectId: "project-1",
      workItemId: "work-item-1",
      stage: "DISCOVERY",
      attempt: 1,
      status: "WAITING_HUMAN",
      version: 2,
      startedAt: timestamp,
      finishedAt: null,
      failureCode: null,
      unproductiveSessions: 0,
      packShareBackoffs: 0,
    };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: "request-1",
      projectId: "project-1",
      workItemId: "work-item-1",
      stageAttemptId: stageAttempt.id,
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Choose depth",
      context: "Discovery needs a direction.",
      recommendation: "Focused",
      options: [
        {
          id: "focused-pass",
          label: "Focused",
          consequence: "Proceed with a bounded pass.",
          recommended: true,
        },
      ],
      allowOther: true,
      status: "OPEN",
      version: 1,
      createdAt: timestamp,
      resolvedAt: null,
    };
    const command = (optionId: string): AnswerHumanRequestCommand => ({
      schemaVersion: 1,
      commandId: `answer-${optionId}`,
      correlationId: `correlation-${optionId}`,
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ANSWER_HUMAN_REQUEST",
      payload: {
        humanRequestId: request.id,
        expectedVersion: 1,
        answer: { type: "OPTION", optionIds: [optionId] },
      },
    });
    const answered = decideAnswerHumanRequest(command("focused-pass"), {
      now: timestamp,
      workItem: workItem("BLOCKED"),
      run,
      stageAttempt,
      request,
      decisionId: "decision-1",
      dispatchId: "dispatch-2",
    });
    expect(answered).toMatchObject({
      request: { status: "RESOLVED", version: 2 },
      stageAttempt: { status: "QUEUED" },
      run: { status: "RUNNING" },
      dispatch: { mode: "RESUME", status: "PENDING" },
    });
    expect(() =>
      decideAnswerHumanRequest(command("unknown-option"), {
        now: timestamp,
        workItem: workItem("BLOCKED"),
        run,
        stageAttempt,
        request,
        decisionId: "decision-2",
        dispatchId: "dispatch-3",
      }),
    ).toThrow(expect.objectContaining({ code: "HUMAN_REQUEST_INVALID_ANSWER" }));
  });
});
