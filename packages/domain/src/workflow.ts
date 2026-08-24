import type {
  AnswerHumanRequestCommand,
  ApplyMockProviderOutcomeCommand,
  Decision,
  HumanRequest,
  HumanRequestAnswer,
  HumanRequestResolvedEvent,
  PipelineCompletedEvent,
  PipelineRun,
  PipelineStartedEvent,
  StageAttempt,
  StageAttemptChangedEvent,
  StartMockPipelineCommand,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { nextWorkflowStage, validateWorkflowTemplate } from "@loomrail/workflow-engine";

export type WorkflowDomainErrorCode =
  | "WORKFLOW_NOT_READY"
  | "WORKFLOW_ALREADY_ACTIVE"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_DISPATCH_NOT_FOUND"
  | "WORKFLOW_DISPATCH_ALREADY_COMPLETED"
  | "WORKFLOW_STAGE_MISMATCH"
  | "WORKFLOW_VERSION_CONFLICT"
  | "HUMAN_REQUEST_NOT_FOUND"
  | "HUMAN_REQUEST_ALREADY_RESOLVED"
  | "HUMAN_REQUEST_INVALID_ANSWER";

export class WorkflowDomainError extends Error {
  readonly code: WorkflowDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: WorkflowDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "WorkflowDomainError";
    this.code = code;
    this.details = details;
  }
}

type EventIntent<T extends { data: unknown; type: string }> = Pick<T, "data" | "type">;

export type StartWorkflowDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  events: EventIntent<PipelineStartedEvent>[];
};

export type ApplyProviderOutcomeDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  request: HumanRequest | null;
  nextStageAttempt: StageAttempt | null;
  nextDispatch: WorkflowDispatch | null;
  events: (
    | EventIntent<StageAttemptChangedEvent>
    | EventIntent<import("@loomrail/contracts").HumanRequestOpenedEvent>
    | EventIntent<PipelineCompletedEvent>
  )[];
};

export type AnswerHumanRequestDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
  decision: Decision;
  dispatch: WorkflowDispatch;
  events: EventIntent<HumanRequestResolvedEvent>[];
};

export type WorkflowIds = {
  pipelineRunId: string;
  stageAttemptId: string;
  dispatchId: string;
};

const verifyWorkItemVersion = (workItem: WorkItem, expectedVersion: number): void => {
  if (workItem.version !== expectedVersion) {
    throw new WorkflowDomainError(
      "WORKFLOW_VERSION_CONFLICT",
      "The WorkItem changed after the workflow action was loaded",
      { expectedVersion, actualVersion: workItem.version },
    );
  }
};

export const decideStartMockPipeline = (
  command: StartMockPipelineCommand,
  context: {
    now: string;
    workItem: WorkItem;
    hasChildren: boolean;
    activeRun: PipelineRun | null;
    ids: WorkflowIds;
  },
): StartWorkflowDecision => {
  const template = validateWorkflowTemplate(command.payload.template);
  verifyWorkItemVersion(context.workItem, command.payload.expectedVersion);
  if (context.workItem.state !== "READY" || context.hasChildren) {
    throw new WorkflowDomainError(
      "WORKFLOW_NOT_READY",
      "Only a leaf WorkItem in Ready can start a workflow",
      { state: context.workItem.state },
    );
  }
  if (context.activeRun && ["RUNNING", "WAITING_HUMAN"].includes(context.activeRun.status)) {
    throw new WorkflowDomainError("WORKFLOW_ALREADY_ACTIVE", "The WorkItem already has an active workflow");
  }

  const firstStage = template.stages[0]?.stage;
  if (!firstStage) {
    throw new WorkflowDomainError("WORKFLOW_STAGE_MISMATCH", "The workflow has no executable stage");
  }

  const workItem: WorkItem = {
    ...context.workItem,
    state: "IN_PROGRESS",
    currentStage: firstStage,
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  const stageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: context.ids.stageAttemptId,
    pipelineRunId: context.ids.pipelineRunId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    stage: firstStage,
    attempt: 1,
    status: "QUEUED",
    version: 1,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
  };
  const run: PipelineRun = {
    schemaVersion: 1,
    id: context.ids.pipelineRunId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    workflowTemplateId: template.id,
    workflowVersion: template.version,
    status: "RUNNING",
    currentStageAttemptId: stageAttempt.id,
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
    finishedAt: null,
  };
  const dispatch: WorkflowDispatch = {
    schemaVersion: 1,
    id: context.ids.dispatchId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    stageAttemptId: stageAttempt.id,
    mode: "START",
    status: "PENDING",
    createdAt: context.now,
    completedAt: null,
  };

  return {
    workItem,
    run,
    stageAttempt,
    dispatch,
    events: [{ type: "PIPELINE_STARTED", data: { run, stageAttempt } }],
  };
};

const completeDispatch = (dispatch: WorkflowDispatch, now: string): WorkflowDispatch => {
  if (dispatch.status !== "PENDING") {
    throw new WorkflowDomainError(
      "WORKFLOW_DISPATCH_ALREADY_COMPLETED",
      "The workflow dispatch has already been applied",
      { status: dispatch.status },
    );
  }
  return { ...dispatch, status: "COMPLETED", completedAt: now };
};

export const decideApplyMockProviderOutcome = (
  command: ApplyMockProviderOutcomeCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    dispatch: WorkflowDispatch;
    humanRequestId?: string;
    nextStageAttemptId?: string;
    nextDispatchId?: string;
  },
): ApplyProviderOutcomeDecision => {
  const template = validateWorkflowTemplate(command.payload.template);
  if (
    context.dispatch.id !== command.payload.dispatchId ||
    context.dispatch.pipelineRunId !== context.run.id ||
    context.dispatch.stageAttemptId !== context.stageAttempt.id ||
    context.run.currentStageAttemptId !== context.stageAttempt.id
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The provider outcome does not match the current workflow stage",
    );
  }

  const dispatch = completeDispatch(context.dispatch, context.now);
  const previousStatus = context.stageAttempt.status;
  if (!["QUEUED", "RUNNING"].includes(previousStatus)) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "Only a queued or running stage can accept a provider outcome",
      { status: previousStatus },
    );
  }

  if (command.payload.outcome.type === "NEEDS_HUMAN") {
    if (!context.humanRequestId) {
      throw new WorkflowDomainError("HUMAN_REQUEST_NOT_FOUND", "A HumanRequest ID was not supplied");
    }
    const stageAttempt: StageAttempt = {
      ...context.stageAttempt,
      status: "WAITING_HUMAN",
      version: context.stageAttempt.version + 1,
      startedAt: context.stageAttempt.startedAt ?? context.now,
    };
    const run: PipelineRun = {
      ...context.run,
      status: "WAITING_HUMAN",
      version: context.run.version + 1,
      updatedAt: context.now,
    };
    const workItem: WorkItem = {
      ...context.workItem,
      state: "BLOCKED",
      currentStage: stageAttempt.stage,
      version: context.workItem.version + 1,
      updatedAt: context.now,
    };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: context.humanRequestId,
      projectId: workItem.projectId,
      workItemId: workItem.id,
      stageAttemptId: stageAttempt.id,
      ...command.payload.outcome.request,
      status: "OPEN",
      version: 1,
      createdAt: context.now,
      resolvedAt: null,
    };
    return {
      workItem,
      run,
      stageAttempt,
      dispatch,
      request,
      nextStageAttempt: null,
      nextDispatch: null,
      events: [
        { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt, previousStatus } },
        { type: "HUMAN_REQUEST_OPENED", data: { request } },
      ],
    };
  }

  const completedStage: StageAttempt = {
    ...context.stageAttempt,
    status: "SUCCEEDED",
    version: context.stageAttempt.version + 1,
    startedAt: context.stageAttempt.startedAt ?? context.now,
    finishedAt: context.now,
  };
  const nextStage = nextWorkflowStage(template, completedStage.stage);
  if (nextStage === null) {
    const run: PipelineRun = {
      ...context.run,
      status: "SUCCEEDED",
      version: context.run.version + 1,
      updatedAt: context.now,
      finishedAt: context.now,
    };
    return {
      workItem: context.workItem,
      run,
      stageAttempt: completedStage,
      dispatch,
      request: null,
      nextStageAttempt: null,
      nextDispatch: null,
      events: [
        { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt: completedStage, previousStatus } },
        { type: "PIPELINE_COMPLETED", data: { run, stageAttempt: completedStage } },
      ],
    };
  }

  if (!context.nextStageAttemptId || !context.nextDispatchId) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The next workflow stage requires durable attempt and dispatch IDs",
    );
  }
  const nextStageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: context.nextStageAttemptId,
    pipelineRunId: context.run.id,
    projectId: context.workItem.projectId,
    workItemId: context.workItem.id,
    stage: nextStage,
    attempt: 1,
    status: "QUEUED",
    version: 1,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
  };
  const run: PipelineRun = {
    ...context.run,
    status: "RUNNING",
    currentStageAttemptId: nextStageAttempt.id,
    version: context.run.version + 1,
    updatedAt: context.now,
  };
  const workItem: WorkItem = {
    ...context.workItem,
    state: "IN_PROGRESS",
    currentStage: nextStage,
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  const nextDispatch: WorkflowDispatch = {
    schemaVersion: 1,
    id: context.nextDispatchId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    stageAttemptId: nextStageAttempt.id,
    mode: "START",
    status: "PENDING",
    createdAt: context.now,
    completedAt: null,
  };
  return {
    workItem,
    run,
    stageAttempt: completedStage,
    dispatch,
    request: null,
    nextStageAttempt,
    nextDispatch,
    events: [{ type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt: completedStage, previousStatus } }],
  };
};

const validateAnswer = (request: HumanRequest, answer: HumanRequestAnswer): void => {
  if (answer.type === "OTHER") {
    if (!request.allowOther) {
      throw new WorkflowDomainError(
        "HUMAN_REQUEST_INVALID_ANSWER",
        "This HumanRequest does not accept a custom answer",
      );
    }
    return;
  }

  const optionIds = new Set(request.options.map(({ id }) => id));
  const uniqueAnswers = new Set(answer.optionIds);
  if (uniqueAnswers.size !== answer.optionIds.length || answer.optionIds.some((id) => !optionIds.has(id))) {
    throw new WorkflowDomainError(
      "HUMAN_REQUEST_INVALID_ANSWER",
      "The answer contains an option that is not part of this HumanRequest",
    );
  }
  if (request.kind === "SINGLE_CHOICE" && answer.optionIds.length !== 1) {
    throw new WorkflowDomainError(
      "HUMAN_REQUEST_INVALID_ANSWER",
      "A single-choice HumanRequest requires exactly one option",
    );
  }
};

export const decideAnswerHumanRequest = (
  command: AnswerHumanRequestCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    request: HumanRequest;
    decisionId: string;
    dispatchId: string;
  },
): AnswerHumanRequestDecision => {
  if (context.request.id !== command.payload.humanRequestId) {
    throw new WorkflowDomainError("HUMAN_REQUEST_NOT_FOUND", "The HumanRequest does not exist");
  }
  if (context.request.version !== command.payload.expectedVersion) {
    throw new WorkflowDomainError(
      "WORKFLOW_VERSION_CONFLICT",
      "The HumanRequest changed after it was loaded",
      { expectedVersion: command.payload.expectedVersion, actualVersion: context.request.version },
    );
  }
  if (context.request.status !== "OPEN") {
    throw new WorkflowDomainError(
      "HUMAN_REQUEST_ALREADY_RESOLVED",
      "The HumanRequest has already been resolved",
      { status: context.request.status },
    );
  }
  if (
    context.run.status !== "WAITING_HUMAN" ||
    context.stageAttempt.status !== "WAITING_HUMAN" ||
    context.run.currentStageAttemptId !== context.stageAttempt.id ||
    context.request.stageAttemptId !== context.stageAttempt.id
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The HumanRequest is not attached to the current waiting workflow stage",
    );
  }
  validateAnswer(context.request, command.payload.answer);

  const request: HumanRequest = {
    ...context.request,
    status: "RESOLVED",
    version: context.request.version + 1,
    resolvedAt: context.now,
  };
  const decision: Decision = {
    schemaVersion: 1,
    id: context.decisionId,
    projectId: request.projectId,
    workItemId: request.workItemId,
    humanRequestId: request.id,
    answer: command.payload.answer,
    actor: command.actor,
    reason: null,
    createdAt: context.now,
  };
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "QUEUED",
    version: context.stageAttempt.version + 1,
  };
  const run: PipelineRun = {
    ...context.run,
    status: "RUNNING",
    version: context.run.version + 1,
    updatedAt: context.now,
  };
  const workItem: WorkItem = {
    ...context.workItem,
    state: "IN_PROGRESS",
    currentStage: stageAttempt.stage,
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  const dispatch: WorkflowDispatch = {
    schemaVersion: 1,
    id: context.dispatchId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    stageAttemptId: stageAttempt.id,
    mode: "RESUME",
    status: "PENDING",
    createdAt: context.now,
    completedAt: null,
  };

  return {
    workItem,
    run,
    stageAttempt,
    request,
    decision,
    dispatch,
    events: [{ type: "HUMAN_REQUEST_RESOLVED", data: { request, decision } }],
  };
};
