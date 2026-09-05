import type {
  AcceptancePackage,
  AcceptanceRequestedEvent,
  AcceptanceResolvedEvent,
  AnswerHumanRequestCommand,
  ApplyProviderOutcomeCommand,
  AgentRun,
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
  HumanRequestDraft,
  HumanRequestResolvedEvent,
  MarkWorkflowDispatchStartedCommand,
  PausePipelineCommand,
  PipelineCancelledEvent,
  PipelineCompletedEvent,
  PipelinePausedEvent,
  PipelineResumedEvent,
  PipelineRun,
  ProviderSession,
  ProviderUsage,
  ProviderUsageReport,
  QACorrectionRun,
  QADefect,
  QAEvidenceBundle,
  QARetestPlan,
  QARun,
  PipelineStartedEvent,
  RecoveryReport,
  RecoveryReportCreatedEvent,
  ResolveAcceptanceCommand,
  ReviewFinding,
  ReviewFindingRecordedEvent,
  ReviewFindingResolvedEvent,
  ReviewLoopExhaustedEvent,
  ReviewReport,
  ReviewReportRecordedEvent,
  ResumePipelineCommand,
  StageAttempt,
  StageAttemptChangedEvent,
  StartMockPipelineCommand,
  UsageRecord,
  UsageRecordedEvent,
  VerificationCheck,
  VerificationPlan,
  VerificationPlanPublication,
  VerificationRun,
  WorkflowStage,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import { MAX_TOTAL_REVIEW_ROUNDS } from "@loomrail/contracts";
import { nextWorkflowStage, validateWorkflowTemplate } from "@loomrail/workflow-engine";

import { isSessionPauseFailureCode } from "./session-pause.js";
import { bindAcceptanceCriteria } from "./acceptance.js";
import { decideReviewLoop, ReviewLoopError } from "./review.js";
import { assertQACorrectionAcceptanceLineage } from "./qa-correction.js";
import { projectVerificationAcceptanceGate } from "./verification.js";

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
  | "REVIEW_REPORT_REQUIRED"
  | "REVIEW_RUN_MISMATCH"
  | "REVIEW_TREE_STALE"
  | "QA_MEASUREMENT_REQUIRED"
  | "PROJECT_VERIFICATION_REQUIRED"
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

// These failures say the provider's terminal object cannot be reconciled with the deterministic
// workflow evidence. They differ from command/version/not-found failures: the caller itself is
// valid, so retrying the same state-store command cannot succeed and must not leave the live
// ProviderSession authoritative. Kept in the domain so persistence does not invent which workflow
// errors are provider-output failures.
export const providerOutcomeRejectionCodes = [
  "WORKFLOW_STAGE_MISMATCH",
  "ACCEPTANCE_NOT_READY",
  "REVIEW_REPORT_REQUIRED",
  "REVIEW_RUN_MISMATCH",
  "REVIEW_TREE_STALE",
  "QA_MEASUREMENT_REQUIRED",
  "PROJECT_VERIFICATION_REQUIRED",
] as const satisfies readonly WorkflowDomainErrorCode[];

export type ProviderOutcomeRejectionCode = (typeof providerOutcomeRejectionCodes)[number];

export const isProviderOutcomeRejectionError = (
  error: unknown,
): error is WorkflowDomainError & { readonly code: ProviderOutcomeRejectionCode } =>
  error instanceof WorkflowDomainError &&
  (providerOutcomeRejectionCodes as readonly WorkflowDomainErrorCode[]).includes(error.code);

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
  reviewReport?: ReviewReport | undefined;
  reviewFindings?: ReviewFinding[] | undefined;
  resolvedReviewFindings?: ReviewFinding[] | undefined;
  acceptancePackage: AcceptancePackage | null;
  events: (
    | EventIntent<StageAttemptChangedEvent>
    | EventIntent<import("@loomrail/contracts").HumanRequestOpenedEvent>
    | EventIntent<UsageRecordedEvent>
    | EventIntent<BudgetThresholdReachedEvent>
    | EventIntent<PipelinePausedEvent>
    | EventIntent<EvidenceArtifactRecordedEvent>
    | EventIntent<ReviewReportRecordedEvent>
    | EventIntent<ReviewFindingRecordedEvent>
    | EventIntent<ReviewFindingResolvedEvent>
    | EventIntent<ReviewLoopExhaustedEvent>
    | EventIntent<AcceptanceRequestedEvent>
    | EventIntent<PipelineCompletedEvent>
  )[];
};

export type RecordProviderUsageDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  report: ProviderUsageReport;
  usageRecord: UsageRecord | null;
  cumulativeAmount: number;
  hardPaused: boolean;
  events: (
    | EventIntent<UsageRecordedEvent>
    | EventIntent<BudgetThresholdReachedEvent>
    | EventIntent<StageAttemptChangedEvent>
    | EventIntent<PipelinePausedEvent>
  )[];
};

export type ApplyProviderOutcomeWithUsageDecision = ApplyProviderOutcomeDecision & {
  usageReport: ProviderUsageReport;
  cumulativeAmount: number;
  hardPaused: boolean;
};

export type RecordProviderUsageContext = {
  now: string;
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  dispatch: WorkflowDispatch;
  providerSession: ProviderSession;
  agentRun: AgentRun;
  budgetPolicy: BudgetPolicy | null;
  existingUsageRecords: readonly UsageRecord[];
  existingAgentUsageTotal: number;
  usage: ProviderUsage;
  reportId: string;
  usageRecordId: string | null;
  usageDigest: string;
};

export type AnswerHumanRequestDecision = {
  workItem: WorkItem;
  run: PipelineRun;
  stageAttempt: StageAttempt;
  request: HumanRequest;
  decision: Decision;
  dispatch: WorkflowDispatch | null;
  nextStageAttempt: StageAttempt | null;
  events: (
    | EventIntent<HumanRequestResolvedEvent>
    | EventIntent<StageAttemptChangedEvent>
    | EventIntent<PipelineCancelledEvent>
  )[];
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

/**
 * StageAttempt statuses nothing in Loomrail ever moves out of.
 *
 * The distinction this draws is "will this attempt ever run again", and it is asked of a resource
 * an attempt HOLDS -- today the workspace lease (spec D6: one writer at a time). A lease is given
 * back by the attempt that took it, in the `finally` of its own session loop, so an attempt that
 * has already reached its end and still holds one will never give it back: no command moves a
 * SUCCEEDED, FAILED, CANCELLED, INTERRUPTED or STALE attempt anywhere, and nothing resumes one.
 *
 * The statuses left OUT are as deliberate as the ones in. WAITING_HUMAN, SOFT_PAUSED and
 * HARD_PAUSED are attempts that have stopped but are expected back -- an owner answers the
 * question, or approves the budget, and the same attempt continues in the same worktree.
 * PENDING/QUEUED/RUNNING/RECOVERING have obviously not finished. Treating any of those as dead
 * would take the workspace away from an attempt still entitled to write in it.
 */
const terminalStageAttemptStatuses = new Set<StageAttempt["status"]>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
  "STALE",
]);

export const stageAttemptIsTerminal = (status: StageAttempt["status"]): boolean =>
  terminalStageAttemptStatuses.has(status);

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

/**
 * Closes out a dispatch that will never be answered.
 *
 * A PENDING dispatch is a standing instruction to the daemon's drain: pick this stage up and run
 * it. Whenever a decision stops the stage without producing a provider outcome -- a pause, a
 * cancellation -- the instruction has to be withdrawn in the same transaction, or the drain finds a
 * pending dispatch whose StageAttempt is no longer runnable and fails on it every cycle.
 */
export const pendingDispatchFailed = (
  dispatch: WorkflowDispatch | null,
  now: string,
): WorkflowDispatch | null => {
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

/**
 * `WORKSPACE_NOT_PROVISIONED` is never produced by `decideDispatchStage` itself -- the gate below
 * is unchanged by milestone E1 (spec D11): it still only ever refuses on `canStart` and
 * `declaredStages`, both properties of the provider. Whether a workspace can be cut is a property
 * of the *repository* instead (mid-rebase, not a repository at all -- spec D5), decided separately
 * by `decideProvisionWorkspace` in `./workspace.js`, on data `decideDispatchStage` is never given.
 *
 * The variant lives here anyway so a caller that runs both checks (Task 9's session loop: inspect
 * the repository, then gate, then dispatch) can hold either refusal as the same
 * `DispatchStageDecision` shape instead of inventing a second, parallel type for what is, from the
 * dispatcher's point of view, the same kind of outcome: a stage that did not start, and a
 * `HumanRequestDraft` explaining why. Keeping it a separate variant from `STAGE_NOT_SERVED` -- not
 * folded into it -- matters because the fix differs: "install the CLI" or "reassign the stage" for
 * `STAGE_NOT_SERVED`, versus "repair the repository" here.
 */
export type DispatchStageDecision =
  | { type: "DISPATCH" }
  | { type: "STAGE_NOT_SERVED"; request: HumanRequestDraft }
  | { type: "WORKSPACE_NOT_PROVISIONED"; request: HumanRequestDraft };

/**
 * Gates a stage against the adapter about to run it (milestone A2).
 *
 * Two separate reasons can make an adapter wrong for a stage, and they are checked in order
 * because they are different claims. `canStart: false` means the adapter is not ready for a new
 * session -- its CLI may be missing, incompatible, unauthenticated, or otherwise unavailable --
 * so it cannot run *any* stage, not just this one. Before milestone E1, a live
 * adapter that *can* start still runs its CLI in an empty temporary directory with no filesystem
 * access, so it cannot serve a stage it does not declare (see the comment on `stages` in
 * `@loomrail/provider-core`'s `ProviderCapabilities`) -- most notably IMPLEMENT, which needs
 * something to change. Without this gate the dispatcher would hand the stage to the adapter
 * anyway -- either to a process that fails to spawn, or to one that returns prose for a stage it
 * never touched, and the stage would look done with no work behind it. Both are knowable in
 * advance, from data the adapter already declared, without ever starting a session.
 *
 * Takes the stage name, the provider's identity, whether it can start at all, and its declared
 * stages as plain data rather than a `ProviderCapabilities` object: this decision only ever needs
 * those four values, and importing the whole adapter contract to get them would give the domain a
 * dependency it does not need -- one more thing this package would have to be reasoned about, and
 * rebuilt, alongside. The caller in `session-loop.ts` already holds the capabilities object; that
 * is the layer that legitimately knows what an adapter contract looks like.
 *
 * The refusal has to be visible, not just prevented: a gate that silently declines is a stage that
 * never runs and nobody notices. So a refusal returns a HumanRequestDraft, the same shape
 * `decideApplyProviderOutcome`'s NEEDS_HUMAN branch already uses to turn a blocking provider
 * outcome into an owner-facing question -- the caller completes the pending dispatch through that
 * same APPLY_PROVIDER_OUTCOME command, which is how the id and timestamps this pure function does
 * not have get attached and how the request reaches the owner. Each branch's request names the
 * actual reason: "something could not run" is not actionable, "CODEX is not ready for new
 * sessions" and "CODEX cannot serve IMPLEMENT" each are, and they call for different fixes.
 */
export const decideDispatchStage = (context: {
  stage: WorkflowStage;
  provider: string;
  declaredStages: readonly WorkflowStage[];
  canStart: boolean;
}): DispatchStageDecision => {
  if (!context.canStart) {
    return {
      type: "STAGE_NOT_SERVED",
      request: {
        // Same FREE_TEXT/allowOther convention as the "stage not declared" branch below -- see
        // its own comment for why: the right fix is out-of-band (repair readiness, or reassign),
        // not a choice Loomrail can enumerate.
        kind: "FREE_TEXT",
        blocking: true,
        title: `${context.provider} is not ready for new sessions`,
        context: `The ${context.provider} adapter is not currently admitted to start a session for the ${context.stage} stage -- or any other stage. Its CLI may be missing, incompatible, or unauthenticated. Loomrail refused to dispatch rather than starting a session that could only fail.`,
        recommendation:
          "Review this provider in Settings, resolve its exact compatibility or authentication status, or reassign this stage to a ready adapter.",
        options: [],
        allowOther: true,
      },
    };
  }
  if (context.declaredStages.includes(context.stage)) {
    return { type: "DISPATCH" };
  }
  const declaredStages = context.declaredStages.join(", ");
  return {
    type: "STAGE_NOT_SERVED",
    request: {
      // FREE_TEXT with `allowOther`, no enumerable options: same convention as the session loop's
      // other pause requests (packages/domain/src/session.ts's `pauseWording`) for a question whose
      // right answer is out-of-band -- reassign the workflow template or add a capable adapter, not
      // a choice Loomrail can list.
      kind: "FREE_TEXT",
      blocking: true,
      title: `${context.provider} cannot serve ${context.stage}`,
      context: `The ${context.provider} adapter declares only these stages: ${declaredStages}. Dispatching the ${context.stage} stage to it would return prose with no work behind it, so Loomrail refused to start a session.`,
      recommendation:
        "Reassign this stage to an adapter that declares it, or change the workflow template so this stage is not routed to this provider.",
      options: [],
      allowOther: true,
    },
  };
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
    correctionRunId: null,
    verificationCorrectionRunId: null,
    stage: firstStage,
    attempt: 1,
    status: "QUEUED",
    version: 1,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
    unproductiveSessions: 0,
    packShareBackoffs: 0,
    // A stage that has not run has no tree to name yet (contracts' `resultTree`).
    resultTree: null,
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
    modelTierOverride: command.payload.budget.modelTierOverride ?? null,
    agentRunMaxEstimatedTokensOverride: command.payload.budget.agentRunMaxEstimatedTokensOverride ?? null,
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

/**
 * Applies one adapter's final cumulative usage report to the deterministic workflow budget.
 *
 * The caller owns IDs and the digest, while this module owns every association and transition:
 * the report can only belong to the running ProviderSession/AgentRun/current StageAttempt tuple,
 * and reaching either the pipeline cap or the AgentRun's immutable effective cap hard-pauses the
 * workflow before another session can start. A zero-token report is still durable provenance but
 * deliberately creates no UsageRecord because that append-only ledger only accepts positive
 * amounts.
 */
export const decideRecordProviderUsage = (
  context: RecordProviderUsageContext,
): RecordProviderUsageDecision => {
  const { workItem, run, stageAttempt, dispatch, providerSession, agentRun, budgetPolicy, usage } = context;
  requireCurrentStage(run, stageAttempt);
  if (
    workItem.id !== stageAttempt.workItemId ||
    run.workItemId !== workItem.id ||
    dispatch.pipelineRunId !== run.id ||
    dispatch.stageAttemptId !== stageAttempt.id ||
    providerSession.stageAttemptId !== stageAttempt.id ||
    providerSession.agentRunId !== agentRun.id ||
    agentRun.stageAttemptId !== stageAttempt.id ||
    agentRun.pipelineRunId !== run.id
  ) {
    throw new WorkflowDomainError(
      "PROVIDER_SESSION_MISMATCH",
      "The provider usage report does not match the active workflow execution",
    );
  }
  if (
    !(
      (stageAttempt.status === "RUNNING" && run.status === "RUNNING" && dispatch.status === "PENDING") ||
      (stageAttempt.status === "SOFT_PAUSED" && run.status === "SOFT_PAUSED" && dispatch.status === "FAILED")
    ) ||
    providerSession.status !== "RUNNING" ||
    agentRun.status !== "RUNNING"
  ) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Provider usage can only be recorded for the active running execution",
    );
  }
  if (agentRun.policySnapshot === null) {
    throw new WorkflowDomainError(
      "PROVIDER_SESSION_MISMATCH",
      "The active AgentRun has no immutable policy snapshot",
    );
  }
  if (!budgetPolicy) {
    throw new WorkflowDomainError("BUDGET_POLICY_NOT_FOUND", "The active BudgetPolicy does not exist");
  }
  if (
    budgetPolicy.id !== agentRun.policySnapshot.budget.pipelinePolicyId ||
    budgetPolicy.revision !== agentRun.policySnapshot.budget.pipelinePolicyRevision
  ) {
    throw new WorkflowDomainError(
      "PROVIDER_SESSION_MISMATCH",
      "The active BudgetPolicy does not match the AgentRun policy snapshot",
    );
  }

  const totalTokens = usage.inputTokens + usage.outputTokens;
  if ((totalTokens === 0) !== (context.usageRecordId === null)) {
    throw new WorkflowDomainError(
      "WORKFLOW_NOT_FOUND",
      "A positive provider usage report requires one durable UsageRecord ID",
    );
  }
  const report: ProviderUsageReport = {
    schemaVersion: 1,
    id: context.reportId,
    projectId: workItem.projectId,
    workItemId: workItem.id,
    pipelineRunId: run.id,
    stageAttemptId: stageAttempt.id,
    agentRunId: agentRun.id,
    providerSessionId: providerSession.id,
    usageRecordId: context.usageRecordId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? null,
    totalTokens,
    costUsd: usage.costUsd ?? null,
    quality: usage.quality,
    usageDigest: context.usageDigest,
    recordedAt: context.now,
  };

  const previousAmount = context.existingUsageRecords.reduce((total, record) => total + record.amount, 0);
  const cumulativeAmount = previousAmount + totalTokens;
  const usageRecord: UsageRecord | null =
    totalTokens === 0 || context.usageRecordId === null
      ? null
      : {
          schemaVersion: 1,
          id: context.usageRecordId,
          projectId: workItem.projectId,
          workItemId: workItem.id,
          pipelineRunId: run.id,
          stageAttemptId: stageAttempt.id,
          budgetPolicyId: budgetPolicy.id,
          kind: "ESTIMATED_TOKENS",
          amount: totalTokens,
          quality: usage.quality,
          recordedAt: context.now,
        };
  const events: RecordProviderUsageDecision["events"] = [];
  if (usageRecord !== null) {
    events.push({ type: "USAGE_RECORDED", data: { usageRecord, cumulativeAmount } });
    const thresholds = [...new Set([...budgetPolicy.warningThresholds, 1])].sort(
      (left, right) => left - right,
    );
    for (const threshold of thresholds) {
      const thresholdAmount = budgetPolicy.maxEstimatedTokens * threshold;
      if (previousAmount < thresholdAmount && cumulativeAmount >= thresholdAmount) {
        events.push({
          type: "BUDGET_THRESHOLD_REACHED",
          data: { budgetPolicy, threshold, cumulativeAmount },
        });
      }
    }
  }

  const agentCumulativeAmount = context.existingAgentUsageTotal + totalTokens;
  const hardPaused =
    cumulativeAmount >= budgetPolicy.maxEstimatedTokens ||
    agentCumulativeAmount >= agentRun.policySnapshot.budget.maxEstimatedTokens;
  if (!hardPaused) {
    return {
      workItem,
      run,
      stageAttempt,
      dispatch,
      report,
      usageRecord,
      cumulativeAmount,
      hardPaused,
      events,
    };
  }

  const pausedAttempt: StageAttempt = {
    ...stageAttempt,
    status: "HARD_PAUSED",
    failureCode: null,
    version: stageAttempt.version + 1,
  };
  const pausedRun: PipelineRun = {
    ...run,
    status: "HARD_PAUSED",
    version: run.version + 1,
    updatedAt: context.now,
  };
  const blockedWorkItem: WorkItem = {
    ...workItem,
    state: "BLOCKED",
    currentStage: pausedAttempt.stage,
    version: workItem.version + 1,
    updatedAt: context.now,
  };
  events.push(
    {
      type: "STAGE_ATTEMPT_CHANGED",
      data: { run: pausedRun, stageAttempt: pausedAttempt, previousStatus: stageAttempt.status },
    },
    {
      type: "PIPELINE_PAUSED",
      data: {
        run: pausedRun,
        stageAttempt: pausedAttempt,
        kind: "HARD",
        reason: "The active provider token budget was exhausted.",
      },
    },
  );
  return {
    workItem: blockedWorkItem,
    run: pausedRun,
    stageAttempt: pausedAttempt,
    // Soft Pause already withdrew the pending dispatch. A terminal usage report from the allowed
    // in-flight turn may still strengthen that pause to HARD, but it must not try to complete the
    // already-failed dispatch a second time.
    dispatch: dispatch.status === "FAILED" ? dispatch : completeDispatch(dispatch, context.now),
    report,
    usageRecord,
    cumulativeAmount,
    hardPaused,
    events,
  };
};

export type ApplyProviderOutcomeContext = {
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
  review?:
    | {
        authorAgentRun: AgentRun;
        reviewerAgentRun: AgentRun;
        currentTree: string;
        round: number;
        openFindings: readonly ReviewFinding[];
        reportId: string;
        findingIds: readonly string[];
        loopOptionIds: readonly [string, string];
      }
    | undefined;
  reviewRequired?: boolean | undefined;
  measuredQA?:
    | {
        qaRun: QARun;
        evidence: QAEvidenceBundle;
        currentTree: string;
      }
    | undefined;
  projectVerification?:
    | {
        projectId: string;
        workItemId: string;
        pipelineRunId: string;
        currentPlan: VerificationPlan | undefined;
        publication: VerificationPlanPublication | undefined;
        latestRun: VerificationRun | undefined;
        checks: readonly VerificationCheck[];
        currentTree: string;
      }
    | undefined;
  qaCorrectionHistory?:
    | {
        correctionRuns: readonly QACorrectionRun[];
        retestPlans: readonly QARetestPlan[];
        qaRuns: readonly QARun[];
        evidenceBundles: readonly QAEvidenceBundle[];
        defects: readonly QADefect[];
      }
    | undefined;
  qaRunRequired?: boolean | undefined;
  qaRunCompletion?: QARun | undefined;
  humanRequestId?: string;
  acceptancePackageId?: string;
  nextStageAttemptId?: string;
  nextDispatchId?: string;
};

export const decideApplyProviderOutcome = (
  command: ApplyProviderOutcomeCommand,
  context: ApplyProviderOutcomeContext,
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
  if (context.stageAttempt.stage === "QA" && context.qaRunRequired === true) {
    const qaRun = context.qaRunCompletion;
    if (
      qaRun === undefined ||
      qaRun.status === "RUNNING" ||
      qaRun.projectId !== context.workItem.projectId ||
      qaRun.workItemId !== context.workItem.id ||
      qaRun.pipelineRunId !== context.run.id ||
      qaRun.stageAttemptId !== context.stageAttempt.id
    ) {
      throw new WorkflowDomainError(
        "QA_MEASUREMENT_REQUIRED",
        "A scheduled Browser QA stage can finish only from its daemon-measured QARun",
      );
    }
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
      failureCode: command.payload.outcome.reason ?? null,
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
    if (acceptanceOutcome.criteria === undefined) {
      throw new WorkflowDomainError(
        "ACCEPTANCE_NOT_READY",
        "Owner acceptance requires criterion-bound Review and QA claims",
      );
    }
    const measuredQA = context.measuredQA;
    const qaArtifact =
      measuredQA === undefined
        ? undefined
        : context.existingArtifacts?.find(
            (artifact) =>
              artifact.kind === "QA_REPORT" &&
              artifact.qaRunId === measuredQA.qaRun.id &&
              artifact.qaEvidenceBundleId === measuredQA.evidence.id &&
              artifact.testedTree === measuredQA.currentTree,
          );
    const reviewArtifact =
      qaArtifact === undefined
        ? undefined
        : context.existingArtifacts?.find(
            (artifact) =>
              artifact.kind === "REVIEW_REPORT" &&
              artifact.correctionRunId === qaArtifact.correctionRunId &&
              (qaArtifact.correctionRunId === null
                ? artifact.testedTree === undefined || artifact.testedTree === qaArtifact.testedTree
                : artifact.reviewReportId !== undefined && artifact.testedTree === qaArtifact.testedTree),
          );
    if (!reviewArtifact || !qaArtifact) {
      throw new WorkflowDomainError(
        "ACCEPTANCE_NOT_READY",
        "Owner acceptance requires both Review and QA evidence",
      );
    }
    const measuredQAMatchesArtifact =
      measuredQA === undefined
        ? false
        : measuredQA.qaRun.id === qaArtifact.qaRunId &&
          measuredQA.evidence.id === qaArtifact.qaEvidenceBundleId &&
          measuredQA.qaRun.status === "PASSED" &&
          measuredQA.evidence.verdict === "PASSED" &&
          measuredQA.qaRun.testedTree === qaArtifact.testedTree &&
          measuredQA.evidence.testedTree === qaArtifact.testedTree &&
          measuredQA.currentTree === qaArtifact.testedTree &&
          measuredQA.qaRun.pipelineRunId === context.run.id &&
          measuredQA.evidence.pipelineRunId === context.run.id &&
          measuredQA.qaRun.workItemId === context.workItem.id &&
          measuredQA.evidence.workItemId === context.workItem.id &&
          measuredQA.evidence.qaRunId === measuredQA.qaRun.id &&
          measuredQA.evidence.stageAttemptId === qaArtifact.stageAttemptId &&
          qaArtifact.correctionRunId ===
            (measuredQA.qaRun.scope.type === "RETEST" ? measuredQA.qaRun.scope.correctionRunId : null);
    if (
      qaArtifact.qaRunId === undefined ||
      qaArtifact.qaEvidenceBundleId === undefined ||
      qaArtifact.testedTree === undefined ||
      !measuredQAMatchesArtifact
    ) {
      throw new WorkflowDomainError(
        "ACCEPTANCE_NOT_READY",
        "Owner acceptance requires current daemon-measured browser QA evidence",
      );
    }
    if (qaArtifact.correctionRunId !== null) {
      if (measuredQA === undefined || context.qaCorrectionHistory === undefined) {
        throw new WorkflowDomainError(
          "ACCEPTANCE_NOT_READY",
          "Corrected acceptance requires its complete QA correction history",
        );
      }
      assertQACorrectionAcceptanceLineage({
        passingQARun: measuredQA.qaRun,
        passingEvidence: measuredQA.evidence,
        currentTree: measuredQA.currentTree,
        ...context.qaCorrectionHistory,
      });
    }
    const projectVerification =
      context.projectVerification === undefined
        ? ({ status: "NOT_CONFIGURED", evidence: null, blocker: null } as const)
        : projectVerificationAcceptanceGate(context.projectVerification);
    if (projectVerification.status === "BLOCKED") {
      throw new WorkflowDomainError(
        "PROJECT_VERIFICATION_REQUIRED",
        "Owner acceptance requires a current passing Project verification Run",
        { blocker: projectVerification.blocker },
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
      context: "Only the owner can accept, return, or reject this completed delivery.",
      recommendation: "Accept when the criterion matrix and recorded evidence are sufficient.",
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
    const boundCriteria = bindAcceptanceCriteria({
      acceptanceCriteria: workItem.acceptanceCriteria,
      claims: acceptanceOutcome.criteria,
      reviewArtifact,
      qaArtifact,
      ...(projectVerification.evidence === null
        ? {}
        : { verificationEvidence: projectVerification.evidence }),
    });
    if (boundCriteria.type === "INVALID") {
      throw new WorkflowDomainError("ACCEPTANCE_NOT_READY", boundCriteria.reason);
    }
    const acceptancePackage: AcceptancePackage = {
      schemaVersion: 1,
      id: context.acceptancePackageId,
      projectId: workItem.projectId,
      workItemId: workItem.id,
      pipelineRunId: run.id,
      stageAttemptId: stageAttempt.id,
      humanRequestId: request.id,
      status: "PENDING",
      criteria: [...boundCriteria.criteria],
      verificationEvidence: projectVerification.evidence,
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

  if (context.stageAttempt.stage === "ACCEPTANCE") {
    throw new WorkflowDomainError(
      "ACCEPTANCE_NOT_READY",
      "Acceptance must produce a package for the owner; ordinary completion cannot finish the run",
    );
  }

  // HANDED_OFF and CONTEXT_EXHAUSTED are session-level results (spec §5.2, §6.3): a session
  // wound down before the stage itself finished. They belong to the session loop (spec §6),
  // not to this stage-level decision -- this is the boundary between the two, stated rather
  // than left to fall through the COMPLETED-shaped code below by accident.
  if (command.payload.outcome.type !== "COMPLETED") {
    throw new WorkflowDomainError("WORKFLOW_STAGE_MISMATCH", "A session-level outcome is not a stage result");
  }

  let reviewReport: ReviewReport | undefined;
  let reviewFindings: ReviewFinding[] | undefined;
  let resolvedReviewFindings: ReviewFinding[] | undefined;
  let reviewEvents: ApplyProviderOutcomeDecision["events"] = [];
  const reviewReportDraft = command.payload.outcome.reviewReport;
  const reviewRequired = context.reviewRequired === true || context.review !== undefined;
  if (context.stageAttempt.stage === "REVIEW" && reviewRequired && reviewReportDraft === undefined) {
    throw new WorkflowDomainError(
      "REVIEW_REPORT_REQUIRED",
      "Review must produce one structured report before the workflow can advance",
    );
  }
  if (context.stageAttempt.stage !== "REVIEW" && reviewReportDraft !== undefined) {
    throw new WorkflowDomainError(
      "WORKFLOW_STAGE_MISMATCH",
      "Only the Review stage can produce a structured review report",
    );
  }
  if (reviewReportDraft !== undefined) {
    const review = context.review;
    if (review === undefined || command.payload.resultTree === null) {
      throw new WorkflowDomainError(
        "REVIEW_REPORT_REQUIRED",
        "A structured review requires durable author, reviewer, and tree context",
      );
    }
    if (
      review.authorAgentRun.id === review.reviewerAgentRun.id ||
      review.authorAgentRun.profile.role !== "DEVELOPER" ||
      review.reviewerAgentRun.profile.role !== "CODE_REVIEWER" ||
      review.authorAgentRun.pipelineRunId !== context.run.id ||
      review.reviewerAgentRun.pipelineRunId !== context.run.id ||
      review.reviewerAgentRun.stageAttemptId !== context.stageAttempt.id ||
      review.reviewerAgentRun.status !== "RUNNING"
    ) {
      throw new WorkflowDomainError(
        "REVIEW_RUN_MISMATCH",
        "The durable author and reviewer AgentRuns do not prove an independent review",
      );
    }
    let loop;
    try {
      loop = decideReviewLoop({
        round: review.round,
        reviewedTree: command.payload.resultTree,
        currentTree: review.currentTree,
        report: reviewReportDraft,
        openFindingIds: review.openFindings.map(({ id }) => id),
      });
    } catch (error: unknown) {
      if (error instanceof ReviewLoopError && error.code === "STALE_REVIEW_TREE") {
        throw new WorkflowDomainError("REVIEW_TREE_STALE", error.message, error.details);
      }
      throw error;
    }
    if (review.findingIds.length !== loop.newFindings.length) {
      throw new WorkflowDomainError(
        "REVIEW_REPORT_REQUIRED",
        "Durable Finding IDs do not match the structured review report",
      );
    }
    reviewFindings = loop.newFindings.map((finding, index) => {
      const id = review.findingIds[index];
      if (id === undefined) {
        throw new WorkflowDomainError("REVIEW_REPORT_REQUIRED", "A durable Finding ID was not supplied");
      }
      return {
        schemaVersion: 1,
        id,
        projectId: context.workItem.projectId,
        workItemId: context.workItem.id,
        pipelineRunId: context.run.id,
        stageAttemptId: context.stageAttempt.id,
        correctionRunId: context.stageAttempt.correctionRunId,
        verificationCorrectionRunId: context.stageAttempt.verificationCorrectionRunId ?? null,
        reviewArtifactId: review.reportId,
        reviewedTree: review.currentTree,
        ordinal: index + 1,
        status: "OPEN",
        resolutionReason: null,
        resolvedBy: null,
        createdAt: context.now,
        resolvedAt: null,
        version: 1,
        ...finding,
      } satisfies ReviewFinding;
    });
    reviewReport = {
      schemaVersion: 1,
      id: review.reportId,
      projectId: context.workItem.projectId,
      workItemId: context.workItem.id,
      pipelineRunId: context.run.id,
      stageAttemptId: context.stageAttempt.id,
      correctionRunId: context.stageAttempt.correctionRunId,
      verificationCorrectionRunId: context.stageAttempt.verificationCorrectionRunId ?? null,
      authorAgentRunId: review.authorAgentRun.id,
      reviewerAgentRunId: review.reviewerAgentRun.id,
      providerRelation:
        review.authorAgentRun.provider === review.reviewerAgentRun.provider
          ? "SAME_PROVIDER"
          : "CROSS_PROVIDER",
      reviewedTree: review.currentTree,
      round: review.round,
      title: reviewReportDraft.title,
      summary: reviewReportDraft.summary,
      checks: reviewReportDraft.checks,
      verdict: reviewReportDraft.verdict,
      findingIds: reviewFindings.map(({ id }) => id),
      createdAt: context.now,
    };
    resolvedReviewFindings = loop.resolveFindingIds.map((id) => {
      const finding = review.openFindings.find((candidate) => candidate.id === id);
      if (finding?.status !== "OPEN") {
        throw new WorkflowDomainError(
          "REVIEW_RUN_MISMATCH",
          "A passing re-review can resolve only an open finding from the same PipelineRun",
        );
      }
      return {
        ...finding,
        status: "RESOLVED",
        resolutionReason: "A later independent review passed the current implementation tree.",
        resolvedBy: { type: "SYSTEM", id: "local-daemon" },
        resolvedAt: context.now,
        version: finding.version + 1,
      } satisfies ReviewFinding;
    });
    reviewEvents = [
      { type: "REVIEW_REPORT_RECORDED", data: { report: reviewReport } },
      ...reviewFindings.map((finding): EventIntent<ReviewFindingRecordedEvent> => ({
        type: "REVIEW_FINDING_RECORDED",
        data: { finding },
      })),
      ...resolvedReviewFindings.map((finding): EventIntent<ReviewFindingResolvedEvent> => ({
        type: "REVIEW_FINDING_RESOLVED",
        data: { finding },
      })),
    ];

    if (loop.action !== "ADVANCE_TO_QA") {
      if (loop.action === "QUEUE_FIX") {
        if (!context.nextStageAttemptId || !context.nextDispatchId) {
          throw new WorkflowDomainError(
            "WORKFLOW_STAGE_MISMATCH",
            "The review fix round requires durable attempt and dispatch IDs",
          );
        }
        const completedStage: StageAttempt = {
          ...context.stageAttempt,
          status: "SUCCEEDED",
          version: context.stageAttempt.version + 1,
          finishedAt: context.now,
          resultTree: command.payload.resultTree,
        };
        const nextStageAttempt: StageAttempt = {
          schemaVersion: 1,
          id: context.nextStageAttemptId,
          pipelineRunId: context.run.id,
          projectId: context.workItem.projectId,
          workItemId: context.workItem.id,
          correctionRunId: context.stageAttempt.correctionRunId,
          verificationCorrectionRunId: context.stageAttempt.verificationCorrectionRunId ?? null,
          stage: "IMPLEMENT",
          attempt: context.stageAttempt.attempt + 1,
          status: "QUEUED",
          version: 1,
          startedAt: null,
          finishedAt: null,
          failureCode: null,
          unproductiveSessions: 0,
          packShareBackoffs: 0,
          resultTree: null,
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
          currentStage: "IMPLEMENT",
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
          artifacts: [],
          reviewReport,
          reviewFindings,
          resolvedReviewFindings,
          acceptancePackage: null,
          events: [
            ...reviewEvents,
            { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt: completedStage, previousStatus } },
          ],
        };
      }

      if (!context.humanRequestId) {
        throw new WorkflowDomainError(
          "HUMAN_REQUEST_NOT_FOUND",
          "The exhausted review loop requires a durable HumanRequest ID",
        );
      }
      const stageAttempt: StageAttempt = {
        ...context.stageAttempt,
        status: "WAITING_HUMAN",
        version: context.stageAttempt.version + 1,
        failureCode: loop.failureCode,
        resultTree: command.payload.resultTree,
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
        currentStage: "REVIEW",
        version: context.workItem.version + 1,
        updatedAt: context.now,
      };
      const [retryId, cancelId] = review.loopOptionIds;
      const retryAvailable = review.round < MAX_TOTAL_REVIEW_ROUNDS;
      const request: HumanRequest = {
        schemaVersion: 1,
        id: context.humanRequestId,
        projectId: workItem.projectId,
        workItemId: workItem.id,
        stageAttemptId: stageAttempt.id,
        kind: "SINGLE_CHOICE",
        blocking: true,
        title: "Review loop needs a decision",
        context:
          review.round === 2
            ? "Two automatic fix and review rounds still left open findings."
            : "The owner-authorized review round still left open findings.",
        recommendation: retryAvailable
          ? "Inspect the findings before authorizing the single additional bounded round."
          : "Inspect the remaining findings and cancel this run when no further automatic work is appropriate.",
        options: [
          ...(retryAvailable
            ? [
                {
                  id: retryId,
                  label: "Authorize one final fix round",
                  consequence: "Creates the only owner-authorized implementation and review round.",
                  recommended: true,
                },
              ]
            : []),
          {
            id: cancelId,
            label: "Cancel the work",
            consequence: "Stops this PipelineRun without accepting the implementation.",
            recommended: false,
          },
        ],
        allowOther: false,
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
        reviewReport,
        reviewFindings,
        resolvedReviewFindings,
        acceptancePackage: null,
        events: [
          ...reviewEvents,
          { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt, previousStatus } },
          { type: "HUMAN_REQUEST_OPENED", data: { request } },
          { type: "REVIEW_LOOP_EXHAUSTED", data: { report: reviewReport, run, stageAttempt, request } },
        ],
      };
    }
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
    const measuredQA = draft.kind === "QA_REPORT" ? context.measuredQA : undefined;
    if (draft.kind === "QA_REPORT" && measuredQA !== undefined) {
      if (
        measuredQA.qaRun.status !== "PASSED" ||
        measuredQA.evidence.verdict !== "PASSED" ||
        measuredQA.qaRun.id !== measuredQA.evidence.qaRunId ||
        measuredQA.qaRun.testedTree !== measuredQA.evidence.testedTree ||
        measuredQA.currentTree !== measuredQA.qaRun.testedTree ||
        measuredQA.qaRun.stageAttemptId !== context.stageAttempt.id ||
        measuredQA.evidence.stageAttemptId !== context.stageAttempt.id
      ) {
        throw new WorkflowDomainError(
          "ACCEPTANCE_NOT_READY",
          "A QA evidence artifact requires a current passed browser QA bundle",
        );
      }
    }
    return {
      schemaVersion: 1,
      id,
      projectId: context.workItem.projectId,
      workItemId: context.workItem.id,
      pipelineRunId: context.run.id,
      stageAttemptId: context.stageAttempt.id,
      correctionRunId: context.stageAttempt.correctionRunId,
      verificationCorrectionRunId: context.stageAttempt.verificationCorrectionRunId ?? null,
      stage: context.stageAttempt.stage,
      status: "PASSED",
      provider: command.payload.provider ?? "MOCK",
      createdAt: context.now,
      ...draft,
      ...(draft.kind === "REVIEW_REPORT" && reviewReport !== undefined
        ? {
            reviewReportId: reviewReport.id,
            testedTree: reviewReport.reviewedTree,
          }
        : measuredQA === undefined
          ? {}
          : {
              qaRunId: measuredQA.qaRun.id,
              qaEvidenceBundleId: measuredQA.evidence.id,
              testedTree: measuredQA.qaRun.testedTree,
            }),
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
    // The one place the stage-end tree label is stored, and it is stored in the same transaction
    // that ends the stage (spec §6.5): a stage recorded as succeeded and a label recorded for it
    // either both land or neither does, so no crash can leave a succeeded stage whose label was
    // measured and lost. The other branches of this function do not set it -- WAITING_HUMAN parks a
    // stage rather than ending it, and a session-level outcome is not a stage result at all.
    resultTree: command.payload.resultTree,
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
      reviewReport,
      reviewFindings,
      resolvedReviewFindings,
      acceptancePackage: null,
      events: [
        ...reviewEvents,
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
    correctionRunId: completedStage.correctionRunId,
    verificationCorrectionRunId: completedStage.verificationCorrectionRunId ?? null,
    stage: nextStage,
    attempt: completedStage.stage === "IMPLEMENT" && nextStage === "REVIEW" ? completedStage.attempt : 1,
    status: "QUEUED",
    version: 1,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
    unproductiveSessions: 0,
    packShareBackoffs: 0,
    // A stage that has not run has no tree to name yet (contracts' `resultTree`).
    resultTree: null,
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
    reviewReport,
    reviewFindings,
    resolvedReviewFindings,
    acceptancePackage: null,
    events: [
      ...reviewEvents,
      ...artifactEvents,
      { type: "STAGE_ATTEMPT_CHANGED", data: { run, stageAttempt: completedStage, previousStatus } },
    ],
  };
};

/**
 * Applies a stage-level terminal outcome and the ProviderSession's final cumulative usage as one
 * deterministic decision. A terminal result has already stopped the current AgentRun, so a cap
 * crossing must not erase that result or turn the completed stage into a retry. When the outcome
 * would continue immediately, the newly queued stage is parked before its dispatch can run.
 */
export const decideApplyProviderOutcomeWithUsage = (
  command: ApplyProviderOutcomeCommand,
  context: ApplyProviderOutcomeContext & RecordProviderUsageContext,
): ApplyProviderOutcomeWithUsageDecision => {
  const usage = decideRecordProviderUsage(context);
  const outcome = decideApplyProviderOutcome(command, context);
  const usageEvents = usage.events.filter(
    (event) => event.type === "USAGE_RECORDED" || event.type === "BUDGET_THRESHOLD_REACHED",
  );
  const usageRecords = [...outcome.usageRecords, ...(usage.usageRecord === null ? [] : [usage.usageRecord])];
  const base = {
    ...outcome,
    usageRecords,
    usageReport: usage.report,
    cumulativeAmount: usage.cumulativeAmount,
    hardPaused: outcome.run.status === "HARD_PAUSED",
    events: [...usageEvents, ...outcome.events],
  } satisfies ApplyProviderOutcomeWithUsageDecision;

  if (!usage.hardPaused || outcome.nextStageAttempt === null || outcome.nextDispatch === null) {
    return base;
  }

  const nextStageAttempt: StageAttempt = {
    ...outcome.nextStageAttempt,
    status: "HARD_PAUSED",
  };
  const run: PipelineRun = {
    ...outcome.run,
    status: "HARD_PAUSED",
    updatedAt: context.now,
  };
  const workItem: WorkItem = {
    ...outcome.workItem,
    state: "BLOCKED",
    currentStage: nextStageAttempt.stage,
    updatedAt: context.now,
  };
  const nextDispatch = pendingDispatchFailed(outcome.nextDispatch, context.now);
  const eventsBeforePause: ApplyProviderOutcomeDecision["events"] = base.events.map((event) =>
    event.type === "STAGE_ATTEMPT_CHANGED" ? { ...event, data: { ...event.data, run } } : event,
  );
  return {
    ...base,
    workItem,
    run,
    nextStageAttempt,
    nextDispatch,
    hardPaused: true,
    events: [
      ...eventsBeforePause,
      {
        type: "STAGE_ATTEMPT_CHANGED",
        data: { run, stageAttempt: nextStageAttempt, previousStatus: outcome.nextStageAttempt.status },
      },
      {
        type: "PIPELINE_PAUSED",
        data: {
          run,
          stageAttempt: nextStageAttempt,
          kind: "HARD",
          reason: "The terminal provider usage exhausted the active budget before the next stage.",
        },
      },
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
    nextStageAttemptId?: string;
    reviewRound?: number;
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
  // Once an AcceptancePackage exists, its dedicated owner transition remains the only way to
  // finish Acceptance. A session-loop hard pause happens before any package exists, though, and
  // deliberately opens this request as the safe retry path. Keeping the blanket stage check here
  // made that recovery question impossible to answer.
  if (context.stageAttempt.stage === "ACCEPTANCE" && !pausedBySessionLoop) {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "Final acceptance must be accepted, returned, or rejected through its AcceptancePackage",
    );
  }
  if (context.stageAttempt.failureCode === "QA_CORRECTION_EXHAUSTED") {
    throw new WorkflowDomainError(
      "WORKFLOW_CONTROL_NOT_ALLOWED",
      "An exhausted QA correction requires its dedicated bounded owner transition",
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

  const resolvingReviewLoop =
    context.stageAttempt.stage === "REVIEW" && context.stageAttempt.failureCode === "REVIEW_LOOP_EXHAUSTED";
  if (resolvingReviewLoop) {
    if (command.actor.type !== "HUMAN" || command.payload.answer.type !== "OPTION") {
      throw new WorkflowDomainError(
        "WORKFLOW_CONTROL_NOT_ALLOWED",
        "Only the owner can resolve an exhausted review loop",
      );
    }
    if (
      context.reviewRound === undefined ||
      !Number.isInteger(context.reviewRound) ||
      context.reviewRound < 1 ||
      context.reviewRound > MAX_TOTAL_REVIEW_ROUNDS
    ) {
      throw new WorkflowDomainError(
        "REVIEW_RUN_MISMATCH",
        "The exhausted review loop has no valid durable review round",
      );
    }
    const selectedOptionId = command.payload.answer.optionIds[0];
    const retryAvailable = context.reviewRound < MAX_TOTAL_REVIEW_ROUNDS;
    const retryOptionId = retryAvailable ? context.request.options[0]?.id : undefined;
    const cancelOptionId = context.request.options.at(-1)?.id;
    if (retryAvailable && selectedOptionId === retryOptionId) {
      if (context.nextStageAttemptId === undefined) {
        throw new WorkflowDomainError(
          "WORKFLOW_STAGE_MISMATCH",
          "The owner-authorized fix round requires a durable StageAttempt ID",
        );
      }
      const stageAttempt: StageAttempt = {
        ...context.stageAttempt,
        status: "SUCCEEDED",
        failureCode: null,
        version: context.stageAttempt.version + 1,
        finishedAt: context.now,
      };
      const nextStageAttempt: StageAttempt = {
        schemaVersion: 1,
        id: context.nextStageAttemptId,
        pipelineRunId: context.run.id,
        projectId: context.workItem.projectId,
        workItemId: context.workItem.id,
        correctionRunId: context.stageAttempt.correctionRunId,
        verificationCorrectionRunId: context.stageAttempt.verificationCorrectionRunId ?? null,
        stage: "IMPLEMENT",
        attempt: context.stageAttempt.attempt + 1,
        status: "QUEUED",
        version: 1,
        startedAt: null,
        finishedAt: null,
        failureCode: null,
        unproductiveSessions: 0,
        packShareBackoffs: 0,
        resultTree: null,
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
        currentStage: "IMPLEMENT",
        version: context.workItem.version + 1,
        updatedAt: context.now,
      };
      const dispatch = createDispatch(
        context.dispatchId,
        workItem,
        run,
        nextStageAttempt,
        "START",
        context.now,
      );
      return {
        workItem,
        run,
        stageAttempt,
        request,
        decision,
        dispatch,
        nextStageAttempt,
        events: [
          { type: "HUMAN_REQUEST_RESOLVED", data: { request, decision } },
          {
            type: "STAGE_ATTEMPT_CHANGED",
            data: { run, stageAttempt, previousStatus: context.stageAttempt.status },
          },
        ],
      };
    }
    if (selectedOptionId !== cancelOptionId) {
      throw new WorkflowDomainError(
        "HUMAN_REQUEST_INVALID_ANSWER",
        "The exhausted review loop received an unsupported owner action",
      );
    }
    const stageAttempt: StageAttempt = {
      ...context.stageAttempt,
      status: "CANCELLED",
      failureCode: "REVIEW_LOOP_EXHAUSTED",
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
      workItem,
      run,
      stageAttempt,
      request,
      decision,
      dispatch: null,
      nextStageAttempt: null,
      events: [
        { type: "HUMAN_REQUEST_RESOLVED", data: { request, decision } },
        { type: "PIPELINE_CANCELLED", data: { run, stageAttempt } },
      ],
    };
  }
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
    nextStageAttempt: null,
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
    currentAgentRunMaxEstimatedTokens: number | null;
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
  const pipelineLimitRaised =
    command.payload.maxEstimatedTokens > context.currentBudgetPolicy.maxEstimatedTokens;
  const requestedAgentRunLimit = command.payload.agentRunMaxEstimatedTokensOverride;
  const currentAgentRunLimit = Math.max(
    context.currentAgentRunMaxEstimatedTokens ?? 0,
    context.currentBudgetPolicy.agentRunMaxEstimatedTokensOverride ?? 0,
  );
  const agentRunLimitRaised =
    requestedAgentRunLimit !== undefined &&
    requestedAgentRunLimit !== null &&
    requestedAgentRunLimit > currentAgentRunLimit;
  if (
    command.payload.maxEstimatedTokens < context.currentBudgetPolicy.maxEstimatedTokens ||
    command.payload.maxEstimatedTokens <= context.cumulativeUsage ||
    (!pipelineLimitRaised && !agentRunLimitRaised)
  ) {
    throw new WorkflowDomainError(
      "BUDGET_OVERRIDE_INVALID",
      "The new cost policy must preserve the pipeline cap, exceed recorded usage, and raise an exhausted limit",
      {
        previousLimit: context.currentBudgetPolicy.maxEstimatedTokens,
        cumulativeUsage: context.cumulativeUsage,
        currentAgentRunLimit,
      },
    );
  }
  const budgetPolicy: BudgetPolicy = {
    ...context.currentBudgetPolicy,
    id: context.ids.budgetPolicyId,
    revision: context.currentBudgetPolicy.revision + 1,
    maxEstimatedTokens: command.payload.maxEstimatedTokens,
    modelTierOverride:
      command.payload.modelTierOverride === undefined
        ? (context.currentBudgetPolicy.modelTierOverride ?? null)
        : command.payload.modelTierOverride,
    agentRunMaxEstimatedTokensOverride:
      command.payload.agentRunMaxEstimatedTokensOverride === undefined
        ? (context.currentBudgetPolicy.agentRunMaxEstimatedTokensOverride ?? null)
        : command.payload.agentRunMaxEstimatedTokensOverride,
    createdBy: command.actor,
    createdAt: context.now,
  };
  // A cap crossed by the previous stage's terminal report parks the *next* attempt before it ever
  // starts. Resuming that row is not a retry: no provider saw it and no work can be attributed to
  // it yet. A pause on an attempt that did start still creates a fresh attempt, preserving the
  // existing history and measurement boundary.
  const parkedBeforeStart = context.stageAttempt.startedAt === null;
  const stageAttempt: StageAttempt = parkedBeforeStart
    ? {
        ...context.stageAttempt,
        status: "QUEUED",
        failureCode: null,
        version: context.stageAttempt.version + 1,
      }
    : {
        schemaVersion: 1,
        id: context.ids.stageAttemptId,
        pipelineRunId: context.run.id,
        projectId: context.workItem.projectId,
        workItemId: context.workItem.id,
        correctionRunId: context.stageAttempt.correctionRunId,
        verificationCorrectionRunId: context.stageAttempt.verificationCorrectionRunId ?? null,
        stage: context.stageAttempt.stage,
        attempt: context.stageAttempt.attempt + 1,
        unproductiveSessions: 0,
        packShareBackoffs: 0,
        status: "QUEUED",
        version: 1,
        startedAt: null,
        finishedAt: null,
        failureCode: null,
        // A retry starts its own measurement; it does not inherit the tree the previous attempt
        // ended on, which belongs to that attempt.
        resultTree: null,
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
