import type {
  AcceptancePackage,
  AcceptanceRequestedEvent,
  AcceptanceResolvedEvent,
  AnswerHumanRequestCommand,
  ApplyProviderOutcomeCommand,
  ApproveBudgetOverrideCommand,
  BudgetOverrideApprovedEvent,
  BudgetPolicy,
  BudgetThresholdReachedEvent,
  CancelPipelineCommand,
  Decision,
  EvidenceArtifact,
  EvidenceArtifactRecordedEvent,
  HumanRequest,
  HumanRequestAnswer,
  HumanRequestResolvedEvent,
  MarkWorkflowDispatchStartedCommand,
  PausePipelineCommand,
  PipelineCancelledEvent,
  PipelineCompletedEvent,
  PipelinePausedEvent,
  PipelineResumedEvent,
  PipelineRun,
  PipelineStartedEvent,
  RecoveryReport,
  RecoveryReportCreatedEvent,
  ResolveAcceptanceCommand,
  ResumePipelineCommand,
  StageAttempt,
  StageAttemptChangedEvent,
  StartMockPipelineCommand,
  UsageRecord,
  UsageRecordedEvent,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { nextWorkflowStage, validateWorkflowTemplate } from "@loomrail/workflow-engine";

import { isSessionPauseFailureCode } from "./session-pause.js";

export type WorkflowDomainErrorCode =
  | "WORKFLOW_NOT_READY"
  | "WORKFLOW_ALREADY_ACTIVE"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_DISPATCH_NOT_FOUND"
  | "WORKFLOW_DISPATCH_ALREADY_COMPLETED"
  | "WORKFLOW_STAGE_MISMATCH"
  | "WORKFLOW_VERSION_CONFLICT"
  | "WORKFLOW_CONTROL_NOT_ALLOWED"
  | "BUDGET_POLICY_NOT_FOUND"
  | "BUDGET_LIMIT_NOT_REACHED"
  | "BUDGET_OVERRIDE_REQUIRED"
  | "BUDGET_OVERRIDE_INVALID"
  | "HUMAN_REQUEST_NOT_FOUND"
  | "HUMAN_REQUEST_ALREADY_RESOLVED"
  | "HUMAN_REQUEST_INVALID_ANSWER"
  | "ACCEPTANCE_NOT_FOUND"
  | "ACCEPTANCE_NOT_READY"
  | "ACCEPTANCE_ALREADY_RESOLVED"
  | "PROVIDER_SESSION_MISMATCH"
  | "SESSION_END_REASON_NOT_HANDLED";

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
  budgetPolicy: BudgetPolicy;
  dispatch: WorkflowDispatch;
  events: EventIntent<PipelineStartedEvent>[];
};

export type MarkDispatchStartedDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  events: EventIntent<StageAttemptChangedEvent>[];
};

export type ApplyProviderOutcomeDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  request: HumanRequest | null;
  nextStageAttempt: StageAttempt | null;
  nextDispatch: WorkflowDispatch | null;
  usageRecords: UsageRecord[];
  artifacts: EvidenceArtifact[];
  acceptancePackage: AcceptancePackage | null;
  events: (
    | EventIntent<StageAttemptChangedEvent>
    | EventIntent<import("@loomrail/contracts").HumanRequestOpenedEvent>
    | EventIntent<UsageRecordedEvent>
    | EventIntent<BudgetThresholdReachedEvent>
    | EventIntent<PipelinePausedEvent>
    | EventIntent<EvidenceArtifactRecordedEvent>
    | EventIntent<AcceptanceRequestedEvent>
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

export type PipelineControlDecision = {
  action: "PAUSE" | "RESUME" | "CANCEL";
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  previousDispatch: WorkflowDispatch | null;
  dispatch: WorkflowDispatch | null;
  events: (
    EventIntent<PipelinePausedEvent> | EventIntent<PipelineResumedEvent> | EventIntent<PipelineCancelledEvent>
  )[];
};

export type BudgetOverrideDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  previousStageAttempt: StageAttempt;
  stageAttempt: StageAttempt;
  budgetPolicy: BudgetPolicy;
  dispatch: WorkflowDispatch;
  events: EventIntent<BudgetOverrideApprovedEvent>[];
};

export type RecoveryDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  report: RecoveryReport;
  events: EventIntent<RecoveryReportCreatedEvent>[];
};

export type AcceptanceResolutionDecision = {
  action: ResolveAcceptanceCommand["payload"]["action"];
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  acceptancePackage: AcceptancePackage;
  request: HumanRequest;
  decision: Decision;
  events: (
    | EventIntent<HumanRequestResolvedEvent>
    | EventIntent<AcceptanceResolvedEvent>
    | EventIntent<PipelineCompletedEvent>
  )[];
};

export type WorkflowIds = {
  pipelineRunId: string;
  stageAttemptId: string;
  budgetPolicyId: string;
  dispatchId: string;
};

const activeRunStatuses = new Set<PipelineRun["status"]>([
  "RUNNING",
  "WAITING_HUMAN",
  "SOFT_PAUSED",
  "HARD_PAUSED",
  "INTERRUPTED",
]);

const verifyWorkItemVersion = (workItem: WorkItem, expectedVersion: number): void => {
  if (workItem.version !== expectedVersion) {
    throw new WorkflowDomainError(
      "WORKFLOW_VERSION_CONFLICT",
      "The WorkItem changed after the workflow action was loaded",
      { expectedVersion, actualVersion: workItem.version },
    );
  }
};

const verifyRunVersion = (run: PipelineRun, pipelineRunId: string, expectedVersion: number): void => {
  if (run.id !== pipelineRunId) {
    throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The PipelineRun does not exist");
  }
  if (run.version !== expectedVersion) {
    throw new WorkflowDomainError(
      "WORKFLOW_VERSION_CONFLICT",
      "The PipelineRun changed after the workflow action was loaded",
      { expectedVersion, actualVersion: run.version },
    );
  }
};

const requireCurrentStage = (run: PipelineRun, stageAttempt: StageAttempt): void => {
  if (run.currentStageAttemptId !== stageAttempt.id || run.id !== stageAttempt.pipelineRunId) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The StageAttempt is not the current stage of this PipelineRun",
    );
  }
};

const pendingDispatchFailed = (dispatch: WorkflowDispatch | null, now: string): WorkflowDispatch | null => {
  if (dispatch?.status !== "PENDING") return dispatch;
  return { ...dispatch, status: "FAILED", completedAt: now };
};

const createDispatch = (
  id: string,
  workItem: WorkItem,
  run: PipelineRun,
  stageAttempt: StageAttempt,
  mode: WorkflowDispatch["mode"],
  now: string,
): WorkflowDispatch => ({
  schemaVersion: 1,
  id,
  projectId: workItem.projectId,
  workItemId: workItem.id,
  pipelineRunId: run.id,
  stageAttemptId: stageAttempt.id,
  mode,
  status: "PENDING",
  createdAt: now,
  completedAt: null,
});

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
  if (context.activeRun && activeRunStatuses.has(context.activeRun.status)) {
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
    unproductiveSessions: 0,
    packShareBackoffs: 0,
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
  const budgetPolicy: BudgetPolicy = {
    schemaVersion: 1,
    id: context.ids.budgetPolicyId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    revision: 1,
    maxEstimatedTokens: command.payload.budget.maxEstimatedTokens,
    warningThresholds: [...command.payload.budget.warningThresholds],
    createdBy: command.actor,
    createdAt: context.now,
  };
  const dispatch = createDispatch(context.ids.dispatchId, workItem, run, stageAttempt, "START", context.now);

  return {
    workItem,
    run,
    stageAttempt,
    budgetPolicy,
    dispatch,
    events: [{ type: "PIPELINE_STARTED", data: { run, stageAttempt, budgetPolicy } }],
  };
};

export const decideMarkWorkflowDispatchStarted = (
  command: MarkWorkflowDispatchStartedCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    dispatch: WorkflowDispatch;
  },
): MarkDispatchStartedDecision => {
  if (
    context.dispatch.id !== command.payload.dispatchId ||
    context.dispatch.pipelineRunId !== context.run.id ||
    context.dispatch.stageAttemptId !== context.stageAttempt.id
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The dispatch does not match the current workflow stage",
    );
  }
  requireCurrentStage(context.run, context.stageAttempt);
  if (
    context.dispatch.status !== "PENDING" ||
    !["QUEUED", "RECOVERING"].includes(context.stageAttempt.status)
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Only a pending dispatch for a queued stage can start",
      { status: context.stageAttempt.status },
    );
  }
  const previousStatus = context.stageAttempt.status;
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "RUNNING",
    version: context.stageAttempt.version + 1,
    startedAt: context.stageAttempt.startedAt ?? context.now,
  };
  return {
    workItem: context.workItem,
    run: context.run,
    stageAttempt,
    dispatch: context.dispatch,
    events: [{ type: "STAGE_ATTEMPT_CHANGED", data: { run: context.run, stageAttempt, previousStatus } }],
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

const budgetOutcome = (
  command: ApplyProviderOutcomeCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    dispatch: WorkflowDispatch;
    budgetPolicy: BudgetPolicy | null;
    existingUsageRecords: readonly UsageRecord[];
    usageRecordIds: readonly string[];
  },
): ApplyProviderOutcomeDecision => {
  if (command.payload.outcome.type !== "BUDGET_LIMIT_REACHED") {
    throw new WorkflowDomainError("BUDGET_LIMIT_NOT_REACHED", "The provider outcome is not a budget result");
  }
  const outcome = command.payload.outcome;
  if (!context.budgetPolicy) {
    throw new WorkflowDomainError("BUDGET_POLICY_NOT_FOUND", "The active BudgetPolicy does not exist");
  }
  if (context.stageAttempt.stage !== "IMPLEMENT") {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The bounded mock budget is only consumed during Implement",
    );
  }
  if (context.usageRecordIds.length !== outcome.usageIncrements.length) {
    throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "Durable UsageRecord IDs were not supplied");
  }

  const budgetPolicy = context.budgetPolicy;
  let cumulativeAmount = context.existingUsageRecords.reduce((total, record) => total + record.amount, 0);
  const usageRecords: UsageRecord[] = [];
  const events: ApplyProviderOutcomeDecision["events"] = [];
  const reachedThresholds = new Set<number>();
  const thresholds = [...new Set([...budgetPolicy.warningThresholds, 1])].sort((left, right) => left - right);

  outcome.usageIncrements.forEach((amount, index) => {
    const usageRecordId = context.usageRecordIds.at(index);
    if (!usageRecordId) {
      throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "Durable UsageRecord ID was not supplied");
    }
    const previousAmount = cumulativeAmount;
    cumulativeAmount += amount;
    const usageRecord: UsageRecord = {
      schemaVersion: 1,
      id: usageRecordId,
      projectId: context.workItem.projectId,
      workItemId: context.workItem.id,
      pipelineRunId: context.run.id,
      stageAttemptId: context.stageAttempt.id,
      budgetPolicyId: budgetPolicy.id,
      kind: "ESTIMATED_TOKENS",
      amount,
      quality: outcome.quality,
      recordedAt: context.now,
    };
    usageRecords.push(usageRecord);
    events.push({ type: "USAGE_RECORDED", data: { usageRecord, cumulativeAmount } });
    for (const threshold of thresholds) {
      const thresholdAmount = budgetPolicy.maxEstimatedTokens * threshold;
      if (
        !reachedThresholds.has(threshold) &&
        previousAmount < thresholdAmount &&
        cumulativeAmount >= thresholdAmount
      ) {
        reachedThresholds.add(threshold);
        events.push({
          type: "BUDGET_THRESHOLD_REACHED",
          data: { budgetPolicy, threshold, cumulativeAmount },
        });
      }
    }
  });

  if (cumulativeAmount < budgetPolicy.maxEstimatedTokens) {
    throw new WorkflowDomainError(
      "BUDGET_LIMIT_NOT_REACHED",
      "A hard pause requires usage to reach the active budget limit",
      { cumulativeAmount, maxEstimatedTokens: budgetPolicy.maxEstimatedTokens },
    );
  }

  const previousStatus = context.stageAttempt.status;
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "HARD_PAUSED",
    version: context.stageAttempt.version + 1,
  };
  const run: PipelineRun = {
    ...context.run,
    status: "HARD_PAUSED",
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
  events.push(
    { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt, previousStatus } },
    {
      type: "PIPELINE_PAUSED",
      data: { run, stageAttempt, kind: "HARD", reason: "The active estimated-token budget was exhausted." },
    },
  );

  return {
    workItem,
    run,
    stageAttempt,
    dispatch: completeDispatch(context.dispatch, context.now),
    request: null,
    nextStageAttempt: null,
    nextDispatch: null,
    usageRecords,
    artifacts: [],
    acceptancePackage: null,
    events,
  };
};

export const decideApplyProviderOutcome = (
  command: ApplyProviderOutcomeCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    dispatch: WorkflowDispatch;
    budgetPolicy: BudgetPolicy | null;
    existingUsageRecords: readonly UsageRecord[];
    usageRecordIds: readonly string[];
    existingArtifacts?: readonly EvidenceArtifact[];
    artifactIds?: readonly string[];
    humanRequestId?: string;
    acceptancePackageId?: string;
    nextStageAttemptId?: string;
    nextDispatchId?: string;
  },
): ApplyProviderOutcomeDecision => {
  const template = validateWorkflowTemplate(command.payload.template);
  if (
    context.dispatch.id !== command.payload.dispatchId ||
    context.dispatch.pipelineRunId !== context.run.id ||
    context.dispatch.stageAttemptId !== context.stageAttempt.id
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The provider outcome does not match the current workflow stage",
    );
  }
  requireCurrentStage(context.run, context.stageAttempt);
  if (context.stageAttempt.status !== "RUNNING") {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "Only a running stage can accept a provider outcome",
      { status: context.stageAttempt.status },
    );
  }

  if (command.payload.outcome.type === "BUDGET_LIMIT_REACHED") {
    return budgetOutcome(command, context);
  }

  const dispatch = completeDispatch(context.dispatch, context.now);
  const previousStatus = context.stageAttempt.status;
  if (command.payload.outcome.type === "NEEDS_HUMAN") {
    if (!context.humanRequestId) {
      throw new WorkflowDomainError("HUMAN_REQUEST_NOT_FOUND", "A HumanRequest ID was not supplied");
    }
    const stageAttempt: StageAttempt = {
      ...context.stageAttempt,
      status: "WAITING_HUMAN",
      version: context.stageAttempt.version + 1,
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
      usageRecords: [],
      artifacts: [],
      acceptancePackage: null,
      events: [
        { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt, previousStatus } },
        { type: "HUMAN_REQUEST_OPENED", data: { request } },
      ],
    };
  }

  if (command.payload.outcome.type === "READY_FOR_ACCEPTANCE") {
    const acceptanceOutcome = command.payload.outcome;
    if (context.stageAttempt.stage !== "ACCEPTANCE") {
      throw new WorkflowDomainError(
        "WORKFLOW_STAGE_MISMATCH",
        "Only the Acceptance stage can request owner acceptance",
      );
    }
    if (!context.humanRequestId || !context.acceptancePackageId) {
      throw new WorkflowDomainError("ACCEPTANCE_NOT_FOUND", "Durable acceptance IDs were not supplied");
    }
    const reviewArtifact = context.existingArtifacts?.find(({ kind }) => kind === "REVIEW_REPORT");
    const qaArtifact = context.existingArtifacts?.find(({ kind }) => kind === "QA_REPORT");
    if (!reviewArtifact || !qaArtifact) {
      throw new WorkflowDomainError(
        "ACCEPTANCE_NOT_READY",
        "Owner acceptance requires both Review and QA evidence",
      );
    }
    const stageAttempt: StageAttempt = {
      ...context.stageAttempt,
      status: "WAITING_HUMAN",
      version: context.stageAttempt.version + 1,
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
      currentStage: "ACCEPTANCE",
      version: context.workItem.version + 1,
      updatedAt: context.now,
    };
    const request: HumanRequest = {
      schemaVersion: 1,
      id: context.humanRequestId,
      projectId: workItem.projectId,
      workItemId: workItem.id,
      stageAttemptId: stageAttempt.id,
      kind: "SINGLE_CHOICE",
      blocking: true,
      title: "Review the acceptance package",
      context: "Only the owner can accept, return, or reject this completed mock delivery.",
      recommendation: "Accept when the criterion matrix and synthetic evidence are sufficient.",
      options: [
        {
          id: "accept",
          label: "Accept",
          consequence: "Record owner acceptance and move the WorkItem to Done.",
          recommended: true,
        },
        {
          id: "return-to-work",
          label: "Return to work",
          consequence: "Close this run without acceptance and keep the WorkItem blocked.",
          recommended: false,
        },
        {
          id: "reject",
          label: "Reject",
          consequence: "Reject this package and keep the WorkItem blocked.",
          recommended: false,
        },
      ],
      allowOther: false,
      status: "OPEN",
      version: 1,
      createdAt: context.now,
      resolvedAt: null,
    };
    const artifactIds = [reviewArtifact.id, qaArtifact.id];
    const acceptancePackage: AcceptancePackage = {
      schemaVersion: 1,
      id: context.acceptancePackageId,
      projectId: workItem.projectId,
      workItemId: workItem.id,
      pipelineRunId: run.id,
      stageAttemptId: stageAttempt.id,
      humanRequestId: request.id,
      status: "PENDING",
      criteria: workItem.acceptanceCriteria.map((criterion, index) => ({
        criterion,
        implementation: "The deterministic mock implementation completed under the approved budget policy.",
        reviewArtifactId: reviewArtifact.id,
        qaArtifactId: qaArtifact.id,
        verification:
          acceptanceOutcome.verifyInstructions.at(index) ??
          acceptanceOutcome.verifyInstructions[0] ??
          "Run the deterministic verification suite.",
        knownRisk: null,
      })),
      artifactIds,
      releaseNote: acceptanceOutcome.releaseNote,
      verifyInstructions: [...acceptanceOutcome.verifyInstructions],
      version: 1,
      createdAt: context.now,
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
    };
    return {
      workItem,
      run,
      stageAttempt,
      dispatch,
      request,
      nextStageAttempt: null,
      nextDispatch: null,
      usageRecords: [],
      artifacts: [],
      acceptancePackage,
      events: [
        { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt, previousStatus } },
        { type: "HUMAN_REQUEST_OPENED", data: { request } },
        { type: "ACCEPTANCE_REQUESTED", data: { acceptancePackage, request, run, stageAttempt } },
      ],
    };
  }

  // HANDED_OFF and CONTEXT_EXHAUSTED are session-level results (spec §5.2, §6.3): a session
  // wound down before the stage itself finished. They belong to the session loop (spec §6),
  // not to this stage-level decision -- this is the boundary between the two, stated rather
  // than left to fall through the COMPLETED-shaped code below by accident.
  if (command.payload.outcome.type !== "COMPLETED") {
    throw new WorkflowDomainError("WORKFLOW_STAGE_MISMATCH", "A session-level outcome is not a stage result");
  }

  const artifactDrafts = command.payload.outcome.artifacts ?? [];
  const expectedArtifactKind =
    context.stageAttempt.stage === "REVIEW"
      ? "REVIEW_REPORT"
      : context.stageAttempt.stage === "QA"
        ? "QA_REPORT"
        : null;
  if (
    expectedArtifactKind &&
    (artifactDrafts.length !== 1 || artifactDrafts[0]?.kind !== expectedArtifactKind)
  ) {
    throw new WorkflowDomainError(
      "ACCEPTANCE_NOT_READY",
      `${context.stageAttempt.stage} must produce its typed evidence artifact`,
    );
  }
  if (!expectedArtifactKind && artifactDrafts.length > 0) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "Only Review and QA stages can produce acceptance evidence",
    );
  }
  const artifactIds = context.artifactIds ?? [];
  if (artifactIds.length !== artifactDrafts.length) {
    throw new WorkflowDomainError("ACCEPTANCE_NOT_FOUND", "Durable EvidenceArtifact IDs were not supplied");
  }
  const artifacts = artifactDrafts.map((draft, index): EvidenceArtifact => {
    const id = artifactIds.at(index);
    if (!id || (context.stageAttempt.stage !== "REVIEW" && context.stageAttempt.stage !== "QA")) {
      throw new WorkflowDomainError("ACCEPTANCE_NOT_FOUND", "Durable EvidenceArtifact ID was not supplied");
    }
    return {
      schemaVersion: 1,
      id,
      projectId: context.workItem.projectId,
      workItemId: context.workItem.id,
      pipelineRunId: context.run.id,
      stageAttemptId: context.stageAttempt.id,
      stage: context.stageAttempt.stage,
      status: "PASSED",
      provider: "MOCK",
      createdAt: context.now,
      ...draft,
    };
  });
  const artifactEvents: ApplyProviderOutcomeDecision["events"] = artifacts.map((artifact) => ({
    type: "EVIDENCE_ARTIFACT_RECORDED",
    data: { artifact },
  }));

  const completedStage: StageAttempt = {
    ...context.stageAttempt,
    status: "SUCCEEDED",
    version: context.stageAttempt.version + 1,
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
      usageRecords: [],
      artifacts,
      acceptancePackage: null,
      events: [
        ...artifactEvents,
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
    unproductiveSessions: 0,
    packShareBackoffs: 0,
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
  const nextDispatch = createDispatch(
    context.nextDispatchId,
    workItem,
    run,
    nextStageAttempt,
    "START",
    context.now,
  );
  return {
    workItem,
    run,
    stageAttempt: completedStage,
    dispatch,
    request: null,
    nextStageAttempt,
    nextDispatch,
    usageRecords: [],
    artifacts,
    acceptancePackage: null,
    events: [
      ...artifactEvents,
      { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt: completedStage, previousStatus } },
    ],
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
  // A stage waits on its owner in two shapes. The ordinary one is WAITING_HUMAN: the provider asked
  // a question mid-stage. The second is a HARD pause opened by the session loop (spec §6.5, §D8,
  // §7), which the spec requires to be a pause *and* a question -- and a question the owner cannot
  // answer is not one. Such a pause is recognised by its failure code (see session-pause.ts); a
  // budget hard pause carries none and still requires a budget override, which is the only thing
  // that actually addresses it.
  const pausedBySessionLoop =
    context.run.status === "HARD_PAUSED" &&
    context.stageAttempt.status === "HARD_PAUSED" &&
    isSessionPauseFailureCode(context.stageAttempt.failureCode);
  const waitingOnHuman =
    context.run.status === "WAITING_HUMAN" && context.stageAttempt.status === "WAITING_HUMAN";
  if (
    (!waitingOnHuman && !pausedBySessionLoop) ||
    context.run.currentStageAttemptId !== context.stageAttempt.id ||
    context.request.stageAttemptId !== context.stageAttempt.id
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "The HumanRequest is not attached to the current waiting workflow stage",
    );
  }
  if (context.stageAttempt.stage === "ACCEPTANCE") {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Final acceptance must be accepted, returned, or rejected through its AcceptancePackage",
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
    // Cleared, so the attempt does not carry the reason for a pause it has just left. The counters
    // are deliberately not reset: §6.5's guard exists precisely so that answering the question does
    // not buy an unbounded number of fresh unproductive sessions.
    failureCode: null,
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
  const dispatch = createDispatch(context.dispatchId, workItem, run, stageAttempt, "RESUME", context.now);

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

export const decidePausePipeline = (
  command: PausePipelineCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    pendingDispatch: WorkflowDispatch | null;
  },
): PipelineControlDecision => {
  verifyRunVersion(context.run, command.payload.pipelineRunId, command.payload.expectedVersion);
  requireCurrentStage(context.run, context.stageAttempt);
  if (
    context.run.status !== "RUNNING" ||
    !["QUEUED", "RUNNING", "RECOVERING"].includes(context.stageAttempt.status)
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Only an executing pipeline can be paused",
      { status: context.run.status },
    );
  }
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "SOFT_PAUSED",
    version: context.stageAttempt.version + 1,
  };
  const run: PipelineRun = {
    ...context.run,
    status: "SOFT_PAUSED",
    version: context.run.version + 1,
    updatedAt: context.now,
  };
  const workItem: WorkItem = {
    ...context.workItem,
    state: "BLOCKED",
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  return {
    action: "PAUSE",
    workItem,
    run,
    stageAttempt,
    previousDispatch: pendingDispatchFailed(context.pendingDispatch, context.now),
    dispatch: null,
    events: [
      {
        type: "PIPELINE_PAUSED",
        data: { run, stageAttempt, kind: "SOFT", reason: "Execution was paused by the operator." },
      },
    ],
  };
};

export const decideResumePipeline = (
  command: ResumePipelineCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    dispatchId: string;
  },
): PipelineControlDecision => {
  verifyRunVersion(context.run, command.payload.pipelineRunId, command.payload.expectedVersion);
  requireCurrentStage(context.run, context.stageAttempt);
  if (context.run.status === "HARD_PAUSED" || context.stageAttempt.status === "HARD_PAUSED") {
    throw new WorkflowDomainError(
      "BUDGET_OVERRIDE_REQUIRED",
      "A hard-paused pipeline requires a new BudgetPolicy revision",
    );
  }
  if (
    !["SOFT_PAUSED", "INTERRUPTED"].includes(context.run.status) ||
    !["SOFT_PAUSED", "INTERRUPTED"].includes(context.stageAttempt.status)
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Only a soft-paused or interrupted pipeline can be resumed",
      { status: context.run.status },
    );
  }
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "QUEUED",
    version: context.stageAttempt.version + 1,
    failureCode: null,
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
  const dispatch = createDispatch(context.dispatchId, workItem, run, stageAttempt, "RESUME", context.now);
  return {
    action: "RESUME",
    workItem,
    run,
    stageAttempt,
    previousDispatch: null,
    dispatch,
    events: [{ type: "PIPELINE_RESUMED", data: { run, stageAttempt } }],
  };
};

export const decideCancelPipeline = (
  command: CancelPipelineCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    pendingDispatch: WorkflowDispatch | null;
    acceptancePending?: boolean;
  },
): PipelineControlDecision => {
  verifyRunVersion(context.run, command.payload.pipelineRunId, command.payload.expectedVersion);
  requireCurrentStage(context.run, context.stageAttempt);
  if (context.acceptancePending) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "A pending AcceptancePackage must be accepted, returned, or rejected explicitly",
    );
  }
  if (!activeRunStatuses.has(context.run.status)) {
    throw new WorkflowDomainError("WORKFLOW_CONTROL_NOT_ALLOWED", "A terminal pipeline cannot be cancelled", {
      status: context.run.status,
    });
  }
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "CANCELLED",
    version: context.stageAttempt.version + 1,
    finishedAt: context.now,
  };
  const run: PipelineRun = {
    ...context.run,
    status: "CANCELLED",
    version: context.run.version + 1,
    updatedAt: context.now,
    finishedAt: context.now,
  };
  const workItem: WorkItem = {
    ...context.workItem,
    state: "CANCELLED",
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  return {
    action: "CANCEL",
    workItem,
    run,
    stageAttempt,
    previousDispatch: pendingDispatchFailed(context.pendingDispatch, context.now),
    dispatch: null,
    events: [{ type: "PIPELINE_CANCELLED", data: { run, stageAttempt } }],
  };
};

export const decideApproveBudgetOverride = (
  command: ApproveBudgetOverrideCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    currentBudgetPolicy: BudgetPolicy;
    cumulativeUsage: number;
    ids: { budgetPolicyId: string; stageAttemptId: string; dispatchId: string };
  },
): BudgetOverrideDecision => {
  verifyRunVersion(context.run, command.payload.pipelineRunId, command.payload.expectedVersion);
  requireCurrentStage(context.run, context.stageAttempt);
  if (context.run.status !== "HARD_PAUSED" || context.stageAttempt.status !== "HARD_PAUSED") {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "A BudgetPolicy override is only available for a hard-paused pipeline",
    );
  }
  // Not every hard pause is a budget pause. The session loop's pauses (spec §6.5, §D8, §7) carry a
  // failure code, and a bigger token budget addresses none of them: it would supersede the attempt
  // with a fresh one, silently orphaning the question the owner was asked and, for a context floor
  // that still does not fit, walking straight back into the same pause. Those are answered through
  // their HumanRequest instead.
  if (isSessionPauseFailureCode(context.stageAttempt.failureCode)) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "This stage is paused by its provider sessions, not by the budget; answer its open request instead",
      { failureCode: context.stageAttempt.failureCode },
    );
  }
  if (
    command.payload.maxEstimatedTokens <= context.currentBudgetPolicy.maxEstimatedTokens ||
    command.payload.maxEstimatedTokens <= context.cumulativeUsage
  ) {
    throw new WorkflowDomainError(
      "BUDGET_OVERRIDE_INVALID",
      "The new budget must exceed both the previous limit and recorded usage",
      {
        previousLimit: context.currentBudgetPolicy.maxEstimatedTokens,
        cumulativeUsage: context.cumulativeUsage,
      },
    );
  }
  const budgetPolicy: BudgetPolicy = {
    ...context.currentBudgetPolicy,
    id: context.ids.budgetPolicyId,
    revision: context.currentBudgetPolicy.revision + 1,
    maxEstimatedTokens: command.payload.maxEstimatedTokens,
    createdBy: command.actor,
    createdAt: context.now,
  };
  const stageAttempt: StageAttempt = {
    schemaVersion: 1,
    id: context.ids.stageAttemptId,
    pipelineRunId: context.run.id,
    projectId: context.workItem.projectId,
    workItemId: context.workItem.id,
    stage: context.stageAttempt.stage,
    attempt: context.stageAttempt.attempt + 1,
    unproductiveSessions: 0,
    packShareBackoffs: 0,
    status: "QUEUED",
    version: 1,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
  };
  const run: PipelineRun = {
    ...context.run,
    status: "RUNNING",
    currentStageAttemptId: stageAttempt.id,
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
  const dispatch = createDispatch(context.ids.dispatchId, workItem, run, stageAttempt, "START", context.now);
  return {
    workItem,
    run,
    previousStageAttempt: context.stageAttempt,
    stageAttempt,
    budgetPolicy,
    dispatch,
    events: [
      {
        type: "BUDGET_OVERRIDE_APPROVED",
        data: {
          run,
          previousStageAttempt: context.stageAttempt,
          stageAttempt,
          budgetPolicy,
        },
      },
    ],
  };
};

export const decideRecoverInterruptedWorkflow = (context: {
  now: string;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  recoveryReportId: string;
}): RecoveryDecision => {
  requireCurrentStage(context.run, context.stageAttempt);
  if (
    context.run.status !== "RUNNING" ||
    context.stageAttempt.status !== "RUNNING" ||
    context.dispatch.status !== "PENDING"
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Only an orphaned running dispatch can be reconciled",
    );
  }
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: "INTERRUPTED",
    version: context.stageAttempt.version + 1,
    failureCode: "DAEMON_RESTART",
  };
  const run: PipelineRun = {
    ...context.run,
    status: "INTERRUPTED",
    version: context.run.version + 1,
    updatedAt: context.now,
  };
  const workItem: WorkItem = {
    ...context.workItem,
    state: "BLOCKED",
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  const dispatch: WorkflowDispatch = {
    ...context.dispatch,
    status: "FAILED",
    completedAt: context.now,
  };
  const report: RecoveryReport = {
    schemaVersion: 1,
    id: context.recoveryReportId,
    projectId: context.workItem.projectId,
    workItemId: context.workItem.id,
    pipelineRunId: context.run.id,
    stageAttemptId: context.stageAttempt.id,
    previousStatus: "RUNNING",
    recoveredStatus: "INTERRUPTED",
    reason: "DAEMON_RESTART",
    createdAt: context.now,
  };
  return {
    workItem,
    run,
    stageAttempt,
    dispatch,
    report,
    events: [{ type: "RECOVERY_REPORT_CREATED", data: { report, run, stageAttempt } }],
  };
};

export const decideResolveAcceptance = (
  command: ResolveAcceptanceCommand,
  context: {
    now: string;
    workItem: WorkItem;
    run: PipelineRun;
    stageAttempt: StageAttempt;
    acceptancePackage: AcceptancePackage;
    request: HumanRequest;
    decisionId: string;
  },
): AcceptanceResolutionDecision => {
  if (command.actor.type !== "HUMAN") {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Only a human owner can resolve final acceptance",
    );
  }
  verifyRunVersion(context.run, context.run.id, command.payload.expectedRunVersion);
  requireCurrentStage(context.run, context.stageAttempt);
  if (
    context.acceptancePackage.id !== command.payload.acceptancePackageId ||
    context.acceptancePackage.pipelineRunId !== context.run.id
  ) {
    throw new WorkflowDomainError("ACCEPTANCE_NOT_FOUND", "The AcceptancePackage does not exist");
  }
  if (context.acceptancePackage.version !== command.payload.expectedVersion) {
    throw new WorkflowDomainError(
      "WORKFLOW_VERSION_CONFLICT",
      "The AcceptancePackage changed after it was loaded",
      { expectedVersion: command.payload.expectedVersion, actualVersion: context.acceptancePackage.version },
    );
  }
  if (
    context.acceptancePackage.status !== "PENDING" ||
    context.request.status !== "OPEN" ||
    context.request.id !== context.acceptancePackage.humanRequestId ||
    context.run.status !== "WAITING_HUMAN" ||
    context.stageAttempt.status !== "WAITING_HUMAN" ||
    context.stageAttempt.stage !== "ACCEPTANCE"
  ) {
    throw new WorkflowDomainError(
      "ACCEPTANCE_ALREADY_RESOLVED",
      "This AcceptancePackage is no longer awaiting an owner decision",
    );
  }

  const resolvedStatus =
    command.payload.action === "ACCEPT"
      ? "ACCEPTED"
      : command.payload.action === "RETURN_TO_WORK"
        ? "RETURNED"
        : "REJECTED";
  const terminalRunStatus = command.payload.action === "ACCEPT" ? "SUCCEEDED" : "FAILED";
  const optionId =
    command.payload.action === "ACCEPT"
      ? "accept"
      : command.payload.action === "RETURN_TO_WORK"
        ? "return-to-work"
        : "reject";
  const request: HumanRequest = {
    ...context.request,
    status: "RESOLVED",
    version: context.request.version + 1,
    resolvedAt: context.now,
  };
  const decision: Decision = {
    schemaVersion: 1,
    id: context.decisionId,
    projectId: context.workItem.projectId,
    workItemId: context.workItem.id,
    humanRequestId: request.id,
    answer: { type: "OPTION", optionIds: [optionId] },
    actor: command.actor,
    reason: command.payload.reason,
    createdAt: context.now,
  };
  const acceptancePackage: AcceptancePackage = {
    ...context.acceptancePackage,
    status: resolvedStatus,
    version: context.acceptancePackage.version + 1,
    resolvedAt: context.now,
    resolvedBy: command.actor,
    resolutionReason: command.payload.reason,
  };
  const stageAttempt: StageAttempt = {
    ...context.stageAttempt,
    status: command.payload.action === "ACCEPT" ? "SUCCEEDED" : "FAILED",
    version: context.stageAttempt.version + 1,
    finishedAt: context.now,
    failureCode:
      command.payload.action === "ACCEPT"
        ? null
        : command.payload.action === "RETURN_TO_WORK"
          ? "ACCEPTANCE_RETURNED"
          : "ACCEPTANCE_REJECTED",
  };
  const run: PipelineRun = {
    ...context.run,
    status: terminalRunStatus,
    version: context.run.version + 1,
    updatedAt: context.now,
    finishedAt: context.now,
  };
  const workItem: WorkItem = {
    ...context.workItem,
    state: command.payload.action === "ACCEPT" ? "DONE" : "BLOCKED",
    currentStage: "ACCEPTANCE",
    version: context.workItem.version + 1,
    updatedAt: context.now,
  };
  const events: AcceptanceResolutionDecision["events"] = [
    { type: "HUMAN_REQUEST_RESOLVED", data: { request, decision } },
    {
      type: "ACCEPTANCE_RESOLVED",
      data: { action: command.payload.action, acceptancePackage, request, decision, run, stageAttempt },
    },
  ];
  if (command.payload.action === "ACCEPT") {
    events.push({ type: "PIPELINE_COMPLETED", data: { run, stageAttempt } });
  }
  return {
    action: command.payload.action,
    workItem,
    run,
    stageAttempt,
    acceptancePackage,
    request,
    decision,
    events,
  };
};
