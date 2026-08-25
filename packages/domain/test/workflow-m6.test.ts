import type {
  AnswerHumanRequestCommand,
  ApplyProviderOutcomeCommand,
  EvidenceArtifact,
  PipelineRun,
  ResolveAcceptanceCommand,
  StageAttempt,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  decideAnswerHumanRequest,
  decideApplyProviderOutcome,
  decideCancelPipeline,
  decideResolveAcceptance,
} from "../src/index.js";

const now = "2026-08-24T14:00:00.000Z";
const contextPack: ApplyProviderOutcomeCommand["payload"]["template"]["stages"][number]["contextPack"] = {
  schemaVersion: 1,
  sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
};
const template: ApplyProviderOutcomeCommand["payload"]["template"] = {
  schemaVersion: 1,
  id: "mock-delivery-v1",
  version: 1,
  name: "Mock delivery",
  stages: [
    { stage: "REVIEW", ordinal: 0, contextPack },
    { stage: "QA", ordinal: 1, contextPack },
    { stage: "ACCEPTANCE", ordinal: 2, contextPack },
  ],
};
const workItem: WorkItem = {
  schemaVersion: 1,
  id: "work-item-1",
  projectId: "project-1",
  parentId: null,
  type: "TASK",
  title: "Ship M6",
  description: "Synthetic acceptance fixture",
  state: "IN_PROGRESS",
  currentStage: "REVIEW",
  priority: "HIGH",
  risk: "LOW",
  acceptanceCriteria: ["The owner can inspect durable Review and QA evidence."],
  version: 7,
  createdAt: now,
  updatedAt: now,
};
const run: PipelineRun = {
  schemaVersion: 1,
  id: "run-1",
  projectId: workItem.projectId,
  workItemId: workItem.id,
  workflowTemplateId: template.id,
  workflowVersion: template.version,
  status: "RUNNING",
  currentStageAttemptId: "attempt-review",
  version: 6,
  createdAt: now,
  updatedAt: now,
  finishedAt: null,
};
const stageAttempt = (stage: StageAttempt["stage"], id: string): StageAttempt => ({
  schemaVersion: 1,
  id,
  pipelineRunId: run.id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  stage,
  attempt: 1,
  status: "RUNNING",
  version: 2,
  startedAt: now,
  finishedAt: null,
  failureCode: null,
});
const dispatch = (attempt: StageAttempt): WorkflowDispatch => ({
  schemaVersion: 1,
  id: `dispatch-${attempt.stage.toLowerCase()}`,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: attempt.id,
  mode: "START",
  status: "PENDING",
  createdAt: now,
  completedAt: null,
});
const artifact = (
  kind: EvidenceArtifact["kind"],
  stage: EvidenceArtifact["stage"],
  id: string,
): EvidenceArtifact => ({
  schemaVersion: 1,
  id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: `attempt-${stage.toLowerCase()}`,
  stage,
  kind,
  status: "PASSED",
  provider: "MOCK",
  title: `${stage} report`,
  summary: `${stage} checks passed.`,
  checks: ["Synthetic check passed."],
  createdAt: now,
});

describe("M6 acceptance decisions", () => {
  it("requires and records the typed Review artifact before advancing", () => {
    const attempt = stageAttempt("REVIEW", "attempt-review");
    const command: ApplyProviderOutcomeCommand = {
      schemaVersion: 1,
      commandId: "complete-review",
      correlationId: "correlation-complete-review",
      actor: { type: "SYSTEM", id: "mock-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: "dispatch-review",
        template,
        outcome: { type: "COMPLETED", summary: "Review complete." },
      },
    };
    const context = {
      now,
      workItem,
      run,
      stageAttempt: attempt,
      dispatch: dispatch(attempt),
      budgetPolicy: null,
      existingUsageRecords: [],
      usageRecordIds: [],
      nextStageAttemptId: "attempt-qa",
      nextDispatchId: "dispatch-qa",
    };
    expect(() => decideApplyProviderOutcome(command, context)).toThrow(
      expect.objectContaining({ code: "ACCEPTANCE_NOT_READY" }),
    );

    command.payload.outcome = {
      type: "COMPLETED",
      summary: "Review complete.",
      artifacts: [
        {
          kind: "REVIEW_REPORT",
          title: "Review report",
          summary: "The bounded review passed.",
          checks: ["Contracts and state transitions passed."],
        },
      ],
    };
    const decision = decideApplyProviderOutcome(command, {
      ...context,
      artifactIds: ["artifact-review"],
    });
    expect(decision).toMatchObject({
      artifacts: [{ id: "artifact-review", kind: "REVIEW_REPORT", status: "PASSED" }],
      nextStageAttempt: { stage: "QA" },
    });
  });

  it("creates a blocking package and only human acceptance can finish the WorkItem", () => {
    const attempt = stageAttempt("ACCEPTANCE", "attempt-acceptance");
    const acceptanceRun: PipelineRun = {
      ...run,
      currentStageAttemptId: attempt.id,
      version: 9,
    };
    const acceptanceWorkItem: WorkItem = {
      ...workItem,
      currentStage: "ACCEPTANCE",
      version: 10,
    };
    const ready = decideApplyProviderOutcome(
      {
        schemaVersion: 1,
        commandId: "request-acceptance",
        correlationId: "correlation-request-acceptance",
        actor: { type: "SYSTEM", id: "mock-provider" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: "dispatch-acceptance",
          template,
          outcome: {
            type: "READY_FOR_ACCEPTANCE",
            releaseNote: "Review and QA evidence are ready.",
            verifyInstructions: ["Run pnpm verify."],
          },
        },
      },
      {
        now,
        workItem: acceptanceWorkItem,
        run: acceptanceRun,
        stageAttempt: attempt,
        dispatch: dispatch(attempt),
        budgetPolicy: null,
        existingUsageRecords: [],
        usageRecordIds: [],
        existingArtifacts: [
          artifact("REVIEW_REPORT", "REVIEW", "artifact-review"),
          artifact("QA_REPORT", "QA", "artifact-qa"),
        ],
        humanRequestId: "request-acceptance",
        acceptancePackageId: "package-1",
      },
    );
    expect(ready).toMatchObject({
      run: { status: "WAITING_HUMAN" },
      workItem: { state: "BLOCKED" },
      request: { blocking: true, status: "OPEN" },
      acceptancePackage: { status: "PENDING", artifactIds: ["artifact-review", "artifact-qa"] },
    });
    const acceptancePackage = ready.acceptancePackage;
    const request = ready.request;
    if (!acceptancePackage || !request) throw new Error("Expected a pending acceptance decision");
    const resolveCommand = (
      actorType: "HUMAN" | "SYSTEM",
      action: ResolveAcceptanceCommand["payload"]["action"] = "ACCEPT",
    ): ResolveAcceptanceCommand => ({
      schemaVersion: 1,
      commandId: `${action.toLowerCase()}-${actorType.toLowerCase()}`,
      correlationId: `correlation-${action.toLowerCase()}-${actorType.toLowerCase()}`,
      actor: { type: actorType, id: actorType === "HUMAN" ? "local-owner" : "automation" },
      type: "RESOLVE_ACCEPTANCE",
      payload: {
        acceptancePackageId: acceptancePackage.id,
        expectedVersion: acceptancePackage.version,
        expectedRunVersion: ready.run.version,
        action,
        reason: "Evidence accepted.",
      },
    });
    const context = {
      now,
      workItem: ready.workItem,
      run: ready.run,
      stageAttempt: ready.stageAttempt,
      acceptancePackage,
      request,
      decisionId: "decision-acceptance",
    };
    const genericAnswer: AnswerHumanRequestCommand = {
      schemaVersion: 1,
      commandId: "answer-acceptance-as-generic-request",
      correlationId: "correlation-answer-acceptance-as-generic-request",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "ANSWER_HUMAN_REQUEST",
      payload: {
        humanRequestId: request.id,
        expectedVersion: request.version,
        answer: { type: "OPTION", optionIds: ["accept"] },
      },
    };
    expect(() =>
      decideAnswerHumanRequest(genericAnswer, {
        now,
        workItem: ready.workItem,
        run: ready.run,
        stageAttempt: ready.stageAttempt,
        request,
        decisionId: "decision-generic-acceptance",
        dispatchId: "dispatch-generic-acceptance",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }));
    expect(() =>
      decideCancelPipeline(
        {
          schemaVersion: 1,
          commandId: "cancel-pending-acceptance",
          correlationId: "correlation-cancel-pending-acceptance",
          actor: { type: "HUMAN", id: "local-owner" },
          type: "CANCEL_PIPELINE",
          payload: { pipelineRunId: ready.run.id, expectedVersion: ready.run.version },
        },
        {
          now,
          workItem: ready.workItem,
          run: ready.run,
          stageAttempt: ready.stageAttempt,
          pendingDispatch: null,
          acceptancePending: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }));
    expect(() => decideResolveAcceptance(resolveCommand("SYSTEM"), context)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_CONTROL_NOT_ALLOWED" }),
    );
    for (const [action, status] of [
      ["RETURN_TO_WORK", "RETURNED"],
      ["REJECT", "REJECTED"],
    ] as const) {
      const closed = decideResolveAcceptance(resolveCommand("HUMAN", action), {
        ...context,
        decisionId: `decision-${action.toLowerCase()}`,
      });
      expect(closed).toMatchObject({
        workItem: { state: "BLOCKED" },
        run: { status: "FAILED" },
        stageAttempt: { status: "FAILED" },
        acceptancePackage: { status },
      });
      expect(closed.events.map(({ type }) => type).includes("PIPELINE_COMPLETED")).toBe(false);
    }
    const accepted = decideResolveAcceptance(resolveCommand("HUMAN"), context);
    expect(accepted).toMatchObject({
      workItem: { state: "DONE" },
      run: { status: "SUCCEEDED" },
      stageAttempt: { status: "SUCCEEDED" },
      acceptancePackage: { status: "ACCEPTED", version: 2 },
      request: { status: "RESOLVED" },
    });
    expect(accepted.events.map(({ type }) => type)).toEqual([
      "HUMAN_REQUEST_RESOLVED",
      "ACCEPTANCE_RESOLVED",
      "PIPELINE_COMPLETED",
    ]);
  });
});
