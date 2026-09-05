import type {
  Actor,
  AdoptVerificationPlanCommand,
  CompleteVerificationPlanPublicationCommand,
  DisableVerificationPlanCommand,
  FailVerificationPlanPublicationCommand,
  PipelineRun,
  Project,
  RetryVerificationRunCommand,
  RetryVerificationPlanPublicationCommand,
  StartVerificationRunCommand,
  VerificationPlan,
  VerificationPlanPublication,
  VerificationCheck,
  VerificationCheckObservation,
  VerificationEvidence,
  VerificationFailure,
  VerificationRun,
  VerificationRunStaleReason,
  WorkItem,
  WorkItemWorkspace,
} from "@loomrail/contracts";
import {
  verificationCheckSchema,
  verificationEvidenceSchema,
  verificationFailureSchema,
  verificationRunSchema,
} from "@loomrail/contracts";

export type VerificationDomainErrorCode =
  | "OWNER_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ACTIVE"
  | "PROJECT_VERSION_CONFLICT"
  | "PROPOSAL_PROJECT_MISMATCH"
  | "PROPOSAL_HASH_MISMATCH"
  | "PROPOSAL_EMPTY"
  | "PROPOSAL_TARGET_BLOCKED"
  | "CURRENT_PLAN_PROJECT_MISMATCH"
  | "SYSTEM_REQUIRED"
  | "PUBLICATION_NOT_FOUND"
  | "PUBLICATION_VERSION_CONFLICT"
  | "PUBLICATION_PLAN_MISMATCH"
  | "PUBLICATION_STATUS_INVALID"
  | "LATEST_PLAN_REQUIRED"
  | "RUN_VERSION_CONFLICT"
  | "RUN_STATUS_INVALID"
  | "CHECK_VERSION_CONFLICT"
  | "CHECK_STATUS_INVALID"
  | "CHECK_RUN_MISMATCH"
  | "CHECK_SEQUENCE_INVALID"
  | "RUN_CURRENT_CHECK_MISMATCH"
  | "WORK_ITEM_NOT_FOUND"
  | "WORK_ITEM_VERSION_CONFLICT"
  | "PIPELINE_RUN_REQUIRED"
  | "WORKSPACE_UNAVAILABLE"
  | "PLAN_UNAVAILABLE"
  | "PLAN_VERSION_CONFLICT"
  | "RETRY_RUN_INVALID"
  | "FAILURE_SOURCE_INVALID";

export class VerificationDomainError extends Error {
  readonly code: VerificationDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: VerificationDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "VerificationDomainError";
    this.code = code;
    this.details = details;
  }
}

export type VerificationPlanAdoptedIntent = {
  type: "VERIFICATION_PLAN_ADOPTED";
  data: {
    plan: VerificationPlan;
    publication: VerificationPlanPublication;
    previousPlanRevision: number | null;
  };
};

export type VerificationPlanDisabledIntent = {
  type: "VERIFICATION_PLAN_DISABLED";
  data: {
    plan: VerificationPlan;
    publication: VerificationPlanPublication;
    previousPlanRevision: number;
  };
};

export type VerificationPlanPublicationIntent = {
  type:
    | "VERIFICATION_PLAN_PUBLICATION_APPLIED"
    | "VERIFICATION_PLAN_PUBLICATION_FAILED"
    | "VERIFICATION_PLAN_PUBLICATION_RETRIED";
  data: {
    plan: VerificationPlan;
    publication: VerificationPlanPublication;
  };
};

export const decideVerificationPlanAdoption = (
  command: AdoptVerificationPlanCommand,
  context: {
    now: string;
    newPlanId: string;
    newPublicationId: string;
    contentHash: string;
    observedProposalHash: string;
    project: Project | undefined;
    currentPlan?: VerificationPlan;
  },
): {
  project: Project;
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanAdoptedIntent;
} => {
  if (command.actor.type !== "HUMAN") {
    throw new VerificationDomainError("OWNER_REQUIRED", "Only the owner can adopt a verification plan");
  }
  const currentProject = context.project;
  if (currentProject === undefined) {
    throw new VerificationDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (currentProject.status !== "ACTIVE") {
    throw new VerificationDomainError(
      "PROJECT_NOT_ACTIVE",
      "Only an active Project can adopt a verification plan",
    );
  }
  if (currentProject.version !== command.payload.expectedProjectVersion) {
    throw new VerificationDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after the verification preview was loaded",
      {
        expectedVersion: command.payload.expectedProjectVersion,
        actualVersion: currentProject.version,
      },
    );
  }
  const proposal = command.payload.proposal;
  if (command.payload.projectId !== currentProject.id || proposal.projectId !== currentProject.id) {
    throw new VerificationDomainError(
      "PROPOSAL_PROJECT_MISMATCH",
      "The verification preview belongs to a different Project",
    );
  }
  if (proposal.proposalHash !== context.observedProposalHash) {
    throw new VerificationDomainError(
      "PROPOSAL_HASH_MISMATCH",
      "The verification preview content does not match its proposal hash",
    );
  }
  if (proposal.recipes.length === 0) {
    throw new VerificationDomainError(
      "PROPOSAL_EMPTY",
      "A warning-only verification preview cannot be adopted",
    );
  }
  if (proposal.target.state === "BLOCKED") {
    throw new VerificationDomainError(
      "PROPOSAL_TARGET_BLOCKED",
      "The verification plan target must be resolved before adoption",
    );
  }
  if (context.currentPlan !== undefined && context.currentPlan.projectId !== currentProject.id) {
    throw new VerificationDomainError(
      "CURRENT_PLAN_PROJECT_MISMATCH",
      "The current verification plan belongs to a different Project",
    );
  }

  const previousPlanRevision = context.currentPlan?.revision ?? null;
  const plan: VerificationPlan = {
    schemaVersion: 1,
    id: context.newPlanId,
    projectId: currentProject.id,
    revision: (previousPlanRevision ?? 0) + 1,
    status: "ACTIVE",
    recipes: proposal.recipes,
    sourceProposalHash: proposal.proposalHash,
    contentHash: context.contentHash,
    createdAt: context.now,
  };
  const project: Project = {
    ...currentProject,
    version: currentProject.version + 1,
    updatedAt: context.now,
  };
  const publication: VerificationPlanPublication = {
    schemaVersion: 1,
    id: context.newPublicationId,
    projectId: currentProject.id,
    planId: plan.id,
    targetPath: ".loomrail/verification-plan.json",
    expectedTargetDigest: proposal.target.state === "PRESENT" ? proposal.target.digest : null,
    contentHash: plan.contentHash,
    status: "PENDING",
    attempts: 0,
    lastErrorCode: null,
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
    appliedAt: null,
  };

  return {
    project,
    plan,
    publication,
    event: {
      type: "VERIFICATION_PLAN_ADOPTED",
      data: { plan, publication, previousPlanRevision },
    },
  };
};

export const decideVerificationPlanDisable = (
  command: DisableVerificationPlanCommand,
  context: {
    now: string;
    newPlanId: string;
    newPublicationId: string;
    contentHash: string;
    project: Project | undefined;
    currentPlan: VerificationPlan | undefined;
  },
): {
  project: Project;
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanDisabledIntent;
} => {
  if (command.actor.type !== "HUMAN") {
    throw new VerificationDomainError("OWNER_REQUIRED", "Only the owner can disable a verification plan");
  }
  const currentProject = context.project;
  if (currentProject === undefined) {
    throw new VerificationDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (currentProject.status !== "ACTIVE") {
    throw new VerificationDomainError(
      "PROJECT_NOT_ACTIVE",
      "Only an active Project can disable a verification plan",
    );
  }
  if (currentProject.version !== command.payload.expectedProjectVersion) {
    throw new VerificationDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after the verification plan was loaded",
      {
        expectedVersion: command.payload.expectedProjectVersion,
        actualVersion: currentProject.version,
      },
    );
  }
  const currentPlan = context.currentPlan;
  if (currentPlan?.projectId !== currentProject.id) {
    throw new VerificationDomainError("PLAN_UNAVAILABLE", "The Project has no current verification plan");
  }
  if (
    currentPlan.status !== "ACTIVE" ||
    currentPlan.revision !== command.payload.expectedPlanRevision ||
    currentPlan.contentHash !== command.payload.expectedPlanContentHash
  ) {
    throw new VerificationDomainError(
      "PLAN_VERSION_CONFLICT",
      "The verification plan changed before it could be disabled",
    );
  }

  const plan: VerificationPlan = {
    ...currentPlan,
    id: context.newPlanId,
    revision: currentPlan.revision + 1,
    status: "DISABLED",
    contentHash: context.contentHash,
    createdAt: context.now,
  };
  const project: Project = {
    ...currentProject,
    version: currentProject.version + 1,
    updatedAt: context.now,
  };
  const publication: VerificationPlanPublication = {
    schemaVersion: 1,
    id: context.newPublicationId,
    projectId: currentProject.id,
    planId: plan.id,
    targetPath: ".loomrail/verification-plan.json",
    expectedTargetDigest: command.payload.expectedTargetDigest,
    contentHash: plan.contentHash,
    status: "PENDING",
    attempts: 0,
    lastErrorCode: null,
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
    appliedAt: null,
  };
  return {
    project,
    plan,
    publication,
    event: {
      type: "VERIFICATION_PLAN_DISABLED",
      data: { plan, publication, previousPlanRevision: currentPlan.revision },
    },
  };
};

const requirePublication = (
  publication: VerificationPlanPublication | undefined,
  plan: VerificationPlan | undefined,
  expectedVersion: number,
): { publication: VerificationPlanPublication; plan: VerificationPlan } => {
  if (publication === undefined) {
    throw new VerificationDomainError("PUBLICATION_NOT_FOUND", "The verification publication does not exist");
  }
  if (publication.version !== expectedVersion) {
    throw new VerificationDomainError(
      "PUBLICATION_VERSION_CONFLICT",
      "The verification publication changed after it was loaded",
      { expectedVersion, actualVersion: publication.version },
    );
  }
  if (
    plan?.id !== publication.planId ||
    publication.projectId !== plan.projectId ||
    publication.contentHash !== plan.contentHash
  ) {
    throw new VerificationDomainError(
      "PUBLICATION_PLAN_MISMATCH",
      "The verification publication does not match its immutable Plan",
    );
  }
  return { publication, plan };
};

export const decideVerificationPlanPublicationCompleted = (
  command: CompleteVerificationPlanPublicationCommand,
  context: {
    now: string;
    plan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
  },
): {
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanPublicationIntent;
} => {
  if (command.actor.type !== "SYSTEM") {
    throw new VerificationDomainError("SYSTEM_REQUIRED", "Only the publisher can complete publication");
  }
  const current = requirePublication(context.publication, context.plan, command.payload.expectedVersion);
  if (current.publication.status !== "PENDING") {
    throw new VerificationDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a pending verification publication can complete",
    );
  }
  const publication: VerificationPlanPublication = {
    ...current.publication,
    status: "APPLIED",
    attempts: current.publication.attempts + 1,
    lastErrorCode: null,
    version: current.publication.version + 1,
    updatedAt: context.now,
    appliedAt: context.now,
  };
  return {
    plan: current.plan,
    publication,
    event: { type: "VERIFICATION_PLAN_PUBLICATION_APPLIED", data: { plan: current.plan, publication } },
  };
};

export const decideVerificationPlanPublicationFailed = (
  command: FailVerificationPlanPublicationCommand,
  context: {
    now: string;
    plan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
  },
): {
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanPublicationIntent;
} => {
  if (command.actor.type !== "SYSTEM") {
    throw new VerificationDomainError("SYSTEM_REQUIRED", "Only the publisher can fail publication");
  }
  const current = requirePublication(context.publication, context.plan, command.payload.expectedVersion);
  if (current.publication.status !== "PENDING") {
    throw new VerificationDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a pending verification publication can fail",
    );
  }
  const publication: VerificationPlanPublication = {
    ...current.publication,
    status: "FAILED",
    attempts: current.publication.attempts + 1,
    lastErrorCode: command.payload.errorCode,
    version: current.publication.version + 1,
    updatedAt: context.now,
    appliedAt: null,
  };
  return {
    plan: current.plan,
    publication,
    event: { type: "VERIFICATION_PLAN_PUBLICATION_FAILED", data: { plan: current.plan, publication } },
  };
};

export const decideVerificationPlanPublicationRetry = (
  command: RetryVerificationPlanPublicationCommand,
  context: {
    now: string;
    latestPlanRevision: number;
    plan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
  },
): {
  plan: VerificationPlan;
  publication: VerificationPlanPublication;
  event: VerificationPlanPublicationIntent;
} => {
  if (command.actor.type !== "HUMAN") {
    throw new VerificationDomainError("OWNER_REQUIRED", "Only the owner can retry publication");
  }
  const current = requirePublication(context.publication, context.plan, command.payload.expectedVersion);
  if (current.publication.projectId !== command.payload.projectId) {
    throw new VerificationDomainError(
      "PUBLICATION_PLAN_MISMATCH",
      "The verification publication belongs to a different Project",
    );
  }
  if (current.plan.revision !== context.latestPlanRevision) {
    throw new VerificationDomainError(
      "LATEST_PLAN_REQUIRED",
      "Only the latest verification Plan publication can be retried",
    );
  }
  if (current.publication.status !== "FAILED") {
    throw new VerificationDomainError(
      "PUBLICATION_STATUS_INVALID",
      "Only a failed verification publication can be retried",
    );
  }
  const publication: VerificationPlanPublication = {
    ...current.publication,
    status: "PENDING",
    lastErrorCode: null,
    version: current.publication.version + 1,
    updatedAt: context.now,
    appliedAt: null,
  };
  return {
    plan: current.plan,
    publication,
    event: { type: "VERIFICATION_PLAN_PUBLICATION_RETRIED", data: { plan: current.plan, publication } },
  };
};

const requireRunner = (actor: Actor): void => {
  if (actor.type !== "SYSTEM") {
    throw new VerificationDomainError(
      "SYSTEM_REQUIRED",
      "Only the daemon verification runner can record measured Check state",
    );
  }
};

export type VerificationRunReservedIntent = {
  type: "VERIFICATION_RUN_RESERVED";
  data: { run: VerificationRun; checks: VerificationCheck[] };
};

export type VerificationRunEventIntent =
  | VerificationRunReservedIntent
  | {
      type: "VERIFICATION_CHECK_STARTED" | "VERIFICATION_CHECK_COMPLETED";
      data: { run: VerificationRun; check: VerificationCheck };
    }
  | {
      type: "VERIFICATION_RUN_INTERRUPTED";
      data: { run: VerificationRun; interruptedCheck: VerificationCheck | null };
    }
  | VerificationFailureRecordedIntent;

export const VERIFICATION_WORKFLOW_ACTOR_ID = "verification-workflow";

export const decideVerificationRunReservation = (
  command: StartVerificationRunCommand | RetryVerificationRunCommand,
  context: {
    now: string;
    newRunId: string;
    newCheckIds: readonly string[];
    ordinal: number;
    project: Project | undefined;
    workItem: WorkItem | undefined;
    pipelineRun: PipelineRun | undefined;
    workspace: WorkItemWorkspace | undefined;
    plan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
    retryOfRun?: VerificationRun;
    verificationCorrectionRunId?: string | null;
  },
): { run: VerificationRun; checks: VerificationCheck[]; event: VerificationRunReservedIntent } => {
  const automatedWorkflowStart =
    command.type === "START_VERIFICATION_RUN" &&
    command.actor.type === "SYSTEM" &&
    command.actor.id === VERIFICATION_WORKFLOW_ACTOR_ID &&
    context.workItem?.currentStage === "QA";
  if (command.actor.type !== "HUMAN" && !automatedWorkflowStart) {
    throw new VerificationDomainError("OWNER_REQUIRED", "Only the owner can start verification");
  }
  const workItem = context.workItem;
  if (workItem === undefined) {
    throw new VerificationDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
  }
  if (workItem.version !== command.payload.expectedWorkItemVersion) {
    throw new VerificationDomainError(
      "WORK_ITEM_VERSION_CONFLICT",
      "The WorkItem changed after verification was requested",
      { expectedVersion: command.payload.expectedWorkItemVersion, actualVersion: workItem.version },
    );
  }
  const project = context.project;
  if (project?.id !== workItem.projectId || project.status !== "ACTIVE") {
    throw new VerificationDomainError("PROJECT_NOT_ACTIVE", "Verification needs an active Project");
  }
  const pipelineRun = context.pipelineRun;
  if (
    pipelineRun?.projectId !== project.id ||
    pipelineRun.workItemId !== workItem.id ||
    ["SUCCEEDED", "FAILED", "CANCELLED"].includes(pipelineRun.status)
  ) {
    throw new VerificationDomainError(
      "PIPELINE_RUN_REQUIRED",
      "Verification needs the WorkItem's active PipelineRun",
    );
  }
  const workspace = context.workspace;
  if (
    workspace?.projectId !== project.id ||
    workspace.workItemId !== workItem.id ||
    workspace.status !== "READY" ||
    workspace.leaseHolder !== null
  ) {
    throw new VerificationDomainError(
      "WORKSPACE_UNAVAILABLE",
      "Verification needs a READY workspace without a live writer",
    );
  }
  const plan = context.plan;
  const publication = context.publication;
  if (
    plan?.projectId !== project.id ||
    plan.status !== "ACTIVE" ||
    publication?.planId !== plan.id ||
    publication.projectId !== project.id ||
    publication.status !== "APPLIED"
  ) {
    throw new VerificationDomainError(
      "PLAN_UNAVAILABLE",
      "Verification needs the active owner-approved published Plan",
    );
  }
  if (
    plan.revision !== command.payload.expectedPlanRevision ||
    plan.contentHash !== command.payload.expectedPlanContentHash
  ) {
    throw new VerificationDomainError(
      "PLAN_VERSION_CONFLICT",
      "The verification Plan changed after it was loaded",
    );
  }
  const retryOfRun = command.type === "RETRY_VERIFICATION_RUN" ? context.retryOfRun : undefined;
  if (
    command.type === "RETRY_VERIFICATION_RUN" &&
    (retryOfRun?.id !== command.payload.retryOfRunId ||
      retryOfRun.version !== command.payload.expectedRetryOfRunVersion ||
      retryOfRun.workItemId !== workItem.id ||
      retryOfRun.status === "QUEUED" ||
      retryOfRun.status === "RUNNING")
  ) {
    throw new VerificationDomainError("RETRY_RUN_INVALID", "Only a terminal Run can be retried");
  }
  if (context.newCheckIds.length !== plan.recipes.length) {
    throw new VerificationDomainError(
      "CHECK_RUN_MISMATCH",
      "Every recorded recipe needs exactly one verification Check identity",
    );
  }

  const run: VerificationRun = {
    schemaVersion: 1,
    id: context.newRunId,
    projectId: project.id,
    workItemId: workItem.id,
    pipelineRunId: pipelineRun.id,
    workspaceId: workspace.id,
    planId: plan.id,
    planRevision: plan.revision,
    planContentHash: plan.contentHash,
    implementationTree: command.payload.implementationTree,
    ordinal: context.ordinal,
    retryOfRunId: retryOfRun?.id ?? null,
    verificationCorrectionRunId: context.verificationCorrectionRunId ?? null,
    platform: command.payload.platform,
    status: "QUEUED",
    currentCheckId: null,
    terminalReason: null,
    startedAt: null,
    completedAt: null,
    createdAt: context.now,
    version: 1,
  };
  const checks = plan.recipes.map((recipe, index): VerificationCheck => ({
    schemaVersion: 1,
    id: context.newCheckIds[index] ?? "",
    projectId: project.id,
    workItemId: workItem.id,
    runId: run.id,
    recipeId: recipe.id,
    ordinal: index + 1,
    required: recipe.required,
    status: "QUEUED",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    errorCode: null,
    output: null,
    version: 1,
  }));
  return { run, checks, event: { type: "VERIFICATION_RUN_RESERVED", data: { run, checks } } };
};

const requireRunAndCheckVersions = (input: {
  run: VerificationRun;
  check: VerificationCheck;
  expectedRunVersion: number;
  expectedCheckVersion: number;
}): void => {
  if (input.run.version !== input.expectedRunVersion) {
    throw new VerificationDomainError(
      "RUN_VERSION_CONFLICT",
      "The verification Run changed after it was loaded",
      { expectedVersion: input.expectedRunVersion, actualVersion: input.run.version },
    );
  }
  if (input.check.version !== input.expectedCheckVersion) {
    throw new VerificationDomainError(
      "CHECK_VERSION_CONFLICT",
      "The verification Check changed after it was loaded",
      { expectedVersion: input.expectedCheckVersion, actualVersion: input.check.version },
    );
  }
  if (
    input.check.runId !== input.run.id ||
    input.check.projectId !== input.run.projectId ||
    input.check.workItemId !== input.run.workItemId
  ) {
    throw new VerificationDomainError(
      "CHECK_RUN_MISMATCH",
      "The verification Check belongs to a different Run",
    );
  }
};

const orderedChecks = (run: VerificationRun, checks: readonly VerificationCheck[]): VerificationCheck[] => {
  if (
    checks.length === 0 ||
    checks.some(
      (check) =>
        check.runId !== run.id || check.projectId !== run.projectId || check.workItemId !== run.workItemId,
    ) ||
    new Set(checks.map((check) => check.ordinal)).size !== checks.length
  ) {
    throw new VerificationDomainError(
      "CHECK_RUN_MISMATCH",
      "The verification Check set does not belong to one Run",
    );
  }
  return [...checks].sort((left, right) => left.ordinal - right.ordinal);
};

export const decideVerificationCheckStart = (input: {
  actor: Actor;
  run: VerificationRun;
  check: VerificationCheck;
  checks: readonly VerificationCheck[];
  expectedRunVersion: number;
  expectedCheckVersion: number;
  now: string;
}): { run: VerificationRun; check: VerificationCheck } => {
  requireRunner(input.actor);
  requireRunAndCheckVersions(input);
  if (input.run.status !== "QUEUED" && input.run.status !== "RUNNING") {
    throw new VerificationDomainError(
      "RUN_STATUS_INVALID",
      "Only a queued or running verification Run can start its next Check",
    );
  }
  if (input.run.currentCheckId !== null) {
    throw new VerificationDomainError(
      "RUN_CURRENT_CHECK_MISMATCH",
      "A verification Run can have only one current Check",
    );
  }
  if (input.check.status !== "QUEUED") {
    throw new VerificationDomainError("CHECK_STATUS_INVALID", "Only a queued verification Check can start");
  }
  const next = orderedChecks(input.run, input.checks).find((check) => check.status === "QUEUED");
  if (next?.id !== input.check.id) {
    throw new VerificationDomainError(
      "CHECK_SEQUENCE_INVALID",
      "Verification Checks must start in their recorded order",
    );
  }

  return {
    run: {
      ...input.run,
      status: "RUNNING",
      currentCheckId: input.check.id,
      startedAt: input.run.startedAt ?? input.now,
      version: input.run.version + 1,
    },
    check: {
      ...input.check,
      status: "RUNNING",
      startedAt: input.now,
      version: input.check.version + 1,
    },
  };
};

export type VerificationCheckCompletionNext = "START_NEXT_CHECK" | "TERMINAL";

export const decideVerificationCheckCompletion = (input: {
  actor: Actor;
  run: VerificationRun;
  check: VerificationCheck;
  checks: readonly VerificationCheck[];
  expectedRunVersion: number;
  expectedCheckVersion: number;
  observation: VerificationCheckObservation;
}): { run: VerificationRun; check: VerificationCheck; next: VerificationCheckCompletionNext } => {
  requireRunner(input.actor);
  requireRunAndCheckVersions(input);
  if (input.run.status !== "RUNNING") {
    throw new VerificationDomainError(
      "RUN_STATUS_INVALID",
      "Only a running verification Run can complete a Check",
    );
  }
  if (input.run.currentCheckId !== input.check.id) {
    throw new VerificationDomainError(
      "RUN_CURRENT_CHECK_MISMATCH",
      "Only the current verification Check can complete",
    );
  }
  if (input.check.status !== "RUNNING" || input.check.startedAt === null) {
    throw new VerificationDomainError(
      "CHECK_STATUS_INVALID",
      "Only a running verification Check can complete",
    );
  }

  const check: VerificationCheck = {
    ...input.check,
    status: input.observation.status,
    completedAt: input.observation.completedAt,
    durationMs: input.observation.durationMs,
    exitCode: input.observation.exitCode,
    signal: input.observation.signal,
    errorCode: input.observation.status === "ERROR" ? input.observation.errorCode : null,
    output: input.observation.output,
    version: input.check.version + 1,
  };
  const checks = orderedChecks(
    input.run,
    input.checks.map((candidate) => (candidate.id === check.id ? check : candidate)),
  );

  const terminal = (
    status: "PASSED" | "FAILED" | "ERROR" | "INTERRUPTED",
    terminalReason: VerificationRun["terminalReason"],
  ): { run: VerificationRun; check: VerificationCheck; next: VerificationCheckCompletionNext } => ({
    check,
    next: "TERMINAL",
    run: {
      ...input.run,
      status,
      currentCheckId: null,
      terminalReason,
      completedAt: input.observation.completedAt,
      version: input.run.version + 1,
    },
  });

  if (check.required && check.status === "FAILED") {
    return terminal("FAILED", "REQUIRED_CHECK_FAILED");
  }
  if (check.required && check.status === "ERROR") {
    return terminal("ERROR", "REQUIRED_CHECK_ERROR");
  }
  if (input.observation.status === "INTERRUPTED") {
    return terminal("INTERRUPTED", input.observation.reason);
  }
  if (checks.some((candidate) => candidate.status === "QUEUED")) {
    return {
      check,
      next: "START_NEXT_CHECK",
      run: {
        ...input.run,
        currentCheckId: null,
        version: input.run.version + 1,
      },
    };
  }
  if (checks.some((candidate) => candidate.required && candidate.status !== "PASSED")) {
    throw new VerificationDomainError(
      "RUN_STATUS_INVALID",
      "A verification Run cannot pass with non-passing required Checks",
    );
  }
  return terminal("PASSED", "ALL_REQUIRED_PASSED");
};

export const decideVerificationRunInterruption = (input: {
  actor: Actor;
  run: VerificationRun;
  checks: readonly VerificationCheck[];
  expectedRunVersion: number;
  reason: "OWNER_CANCELLED" | "DAEMON_RESTART";
  now: string;
}): { run: VerificationRun; checks: VerificationCheck[] } => {
  if (input.reason === "OWNER_CANCELLED") {
    if (input.actor.type !== "HUMAN") {
      throw new VerificationDomainError("OWNER_REQUIRED", "Only the owner can cancel verification");
    }
  } else {
    requireRunner(input.actor);
  }
  if (input.run.version !== input.expectedRunVersion) {
    throw new VerificationDomainError("RUN_VERSION_CONFLICT", "The verification Run version changed", {
      expectedVersion: input.expectedRunVersion,
      actualVersion: input.run.version,
    });
  }
  if (input.run.status !== "QUEUED" && input.run.status !== "RUNNING") {
    throw new VerificationDomainError(
      "RUN_STATUS_INVALID",
      "Only a queued or running verification Run can be interrupted",
    );
  }
  const checks = orderedChecks(input.run, input.checks).map((check) => {
    if (check.id !== input.run.currentCheckId) return check;
    if (check.status !== "RUNNING" || check.startedAt === null) {
      throw new VerificationDomainError(
        "CHECK_STATUS_INVALID",
        "The current verification Check must be running",
      );
    }
    return {
      ...check,
      status: "INTERRUPTED" as const,
      completedAt: input.now,
      durationMs: Math.max(0, Date.parse(input.now) - Date.parse(check.startedAt)),
      exitCode: null,
      signal: null,
      errorCode: null,
      output: null,
      version: check.version + 1,
    };
  });

  return {
    run: {
      ...input.run,
      status: "INTERRUPTED",
      currentCheckId: null,
      terminalReason: input.reason,
      completedAt: input.now,
      version: input.run.version + 1,
    },
    checks,
  };
};

export type VerificationFailureRecordedIntent = {
  type: "VERIFICATION_FAILURE_RECORDED";
  data: { failure: VerificationFailure };
};

/** Converts a terminal non-pass into the separate immutable identity used by correction workflow. */
export const deriveVerificationFailure = (input: {
  failureId: string;
  run: VerificationRun;
  checks: readonly VerificationCheck[];
  now: string;
}): { failure: VerificationFailure; event: VerificationFailureRecordedIntent } => {
  const run = verificationRunSchema.parse(input.run);
  const checks = input.checks.map((check) => verificationCheckSchema.parse(check));
  if (run.status !== "FAILED" && run.status !== "ERROR" && run.status !== "INTERRUPTED") {
    throw new VerificationDomainError(
      "RUN_STATUS_INVALID",
      "Only a terminal non-passing verification Run can create a failure",
    );
  }
  const ordered = orderedChecks(run, checks);
  const sourceCheck =
    run.status === "FAILED"
      ? ordered.find(({ required, status }) => required && status === "FAILED")
      : run.status === "ERROR"
        ? ordered.find(({ required, status }) => required && status === "ERROR")
        : ordered.find(({ status }) => status === "INTERRUPTED");
  if (run.status !== "INTERRUPTED" && sourceCheck === undefined) {
    throw new VerificationDomainError(
      "FAILURE_SOURCE_INVALID",
      "A verification failure needs the required measured Check that ended its Run",
    );
  }
  const reason =
    run.status === "FAILED"
      ? "REQUIRED_CHECK_FAILED"
      : run.status === "ERROR"
        ? "REQUIRED_CHECK_ERROR"
        : "RUN_INTERRUPTED";
  const failure = verificationFailureSchema.parse({
    schemaVersion: 1,
    id: input.failureId,
    projectId: run.projectId,
    workItemId: run.workItemId,
    pipelineRunId: run.pipelineRunId,
    verificationRunId: run.id,
    verificationCheckId: sourceCheck?.id ?? null,
    planId: run.planId,
    planRevision: run.planRevision,
    planContentHash: run.planContentHash,
    implementationTree: run.implementationTree,
    reason,
    staleReasons: [],
    createdAt: input.now,
  });
  return {
    failure,
    event: { type: "VERIFICATION_FAILURE_RECORDED", data: { failure } },
  };
};

export const projectVerificationRunFreshness = (
  run: VerificationRun,
  context: {
    currentPlan: VerificationPlan | undefined;
    publication: VerificationPlanPublication | undefined;
    currentTree: string;
  },
): { freshness: "CURRENT" | "STALE"; staleReasons: VerificationRunStaleReason[] } => {
  const staleReasons: VerificationRunStaleReason[] = [];
  if (context.currentPlan?.status !== "ACTIVE") {
    staleReasons.push("PLAN_UNAVAILABLE");
  } else if (
    context.currentPlan.id !== run.planId ||
    context.currentPlan.revision !== run.planRevision ||
    context.currentPlan.contentHash !== run.planContentHash
  ) {
    staleReasons.push("PLAN_REPLACED");
  }
  if (
    context.publication?.status !== "APPLIED" ||
    context.publication.planId !== context.currentPlan?.id ||
    context.publication.contentHash !== context.currentPlan.contentHash
  ) {
    staleReasons.push("PLAN_UNPUBLISHED");
  }
  if (context.currentTree !== run.implementationTree) staleReasons.push("TREE_CHANGED");
  return {
    freshness: staleReasons.length === 0 ? "CURRENT" : "STALE",
    staleReasons,
  };
};

/**
 * Records that a previously passing Run no longer carries current authority without rewriting its
 * measured terminal outcome. The failure keeps the old Plan/tree coordinates and only adds the
 * independently derived reasons why that evidence cannot cross the current gate.
 */
export const deriveStaleVerificationFailure = (input: {
  failureId: string;
  run: VerificationRun;
  currentPlan: VerificationPlan | undefined;
  publication: VerificationPlanPublication | undefined;
  currentTree: string;
  now: string;
}): { failure: VerificationFailure; event: VerificationFailureRecordedIntent } => {
  const run = verificationRunSchema.parse(input.run);
  if (run.status !== "PASSED") {
    throw new VerificationDomainError(
      "RUN_STATUS_INVALID",
      "Only a previously passing verification Run can become stale",
    );
  }
  const freshness = projectVerificationRunFreshness(run, {
    currentPlan: input.currentPlan,
    publication: input.publication,
    currentTree: input.currentTree,
  });
  if (freshness.freshness !== "STALE") {
    throw new VerificationDomainError(
      "FAILURE_SOURCE_INVALID",
      "Current verification evidence cannot create a stale failure",
    );
  }
  const failure = verificationFailureSchema.parse({
    schemaVersion: 1,
    id: input.failureId,
    projectId: run.projectId,
    workItemId: run.workItemId,
    pipelineRunId: run.pipelineRunId,
    verificationRunId: run.id,
    verificationCheckId: null,
    planId: run.planId,
    planRevision: run.planRevision,
    planContentHash: run.planContentHash,
    implementationTree: run.implementationTree,
    reason: "STALE",
    staleReasons: freshness.staleReasons,
    createdAt: input.now,
  });
  return {
    failure,
    event: { type: "VERIFICATION_FAILURE_RECORDED", data: { failure } },
  };
};

export type ProjectVerificationAcceptanceBlocker =
  | "PLAN_UNPUBLISHED"
  | "RUN_MISSING"
  | "RUN_QUEUED"
  | "RUN_RUNNING"
  | "RUN_FAILED"
  | "RUN_ERROR"
  | "RUN_INTERRUPTED"
  | "STALE"
  | "LINEAGE_MISMATCH"
  | "EVIDENCE_INVALID";

export type ProjectVerificationAcceptanceGate =
  | { status: "NOT_CONFIGURED"; evidence: null; blocker: null }
  | { status: "READY"; evidence: VerificationEvidence; blocker: null }
  | { status: "BLOCKED"; evidence: null; blocker: ProjectVerificationAcceptanceBlocker };

/**
 * Selects the only Project verification evidence that may cross into Acceptance.
 *
 * A missing/disabled Plan preserves legacy Project behavior. Once the owner activates a Plan,
 * the gate fails closed: the latest Run must belong to this exact delivery, match the published
 * Plan and current tree, and independently prove every required recipe passed. Optional failures
 * remain visible in the evidence but cannot turn a required pass into a block.
 */
export const projectVerificationAcceptanceGate = (input: {
  projectId: string;
  workItemId: string;
  pipelineRunId: string;
  currentPlan: VerificationPlan | undefined;
  publication: VerificationPlanPublication | undefined;
  latestRun: VerificationRun | undefined;
  checks: readonly VerificationCheck[];
  currentTree: string;
}): ProjectVerificationAcceptanceGate => {
  const plan = input.currentPlan;
  if (plan?.status !== "ACTIVE") {
    return { status: "NOT_CONFIGURED", evidence: null, blocker: null };
  }
  if (
    input.publication?.status !== "APPLIED" ||
    input.publication.projectId !== input.projectId ||
    input.publication.planId !== plan.id ||
    input.publication.contentHash !== plan.contentHash
  ) {
    return { status: "BLOCKED", evidence: null, blocker: "PLAN_UNPUBLISHED" };
  }

  const run = input.latestRun;
  if (run === undefined) {
    return { status: "BLOCKED", evidence: null, blocker: "RUN_MISSING" };
  }
  if (
    plan.projectId !== input.projectId ||
    run.projectId !== input.projectId ||
    run.workItemId !== input.workItemId ||
    run.pipelineRunId !== input.pipelineRunId
  ) {
    return { status: "BLOCKED", evidence: null, blocker: "LINEAGE_MISMATCH" };
  }
  const freshness = projectVerificationRunFreshness(run, {
    currentPlan: plan,
    publication: input.publication,
    currentTree: input.currentTree,
  });
  if (freshness.freshness === "STALE") {
    return { status: "BLOCKED", evidence: null, blocker: "STALE" };
  }
  if (run.status !== "PASSED") {
    return { status: "BLOCKED", evidence: null, blocker: `RUN_${run.status}` };
  }

  const orderedChecks = [...input.checks].sort((left, right) => left.ordinal - right.ordinal);
  const exactChecks =
    orderedChecks.length === plan.recipes.length &&
    orderedChecks.every((check, index) => {
      const recipe = plan.recipes[index];
      return (
        recipe !== undefined &&
        check.projectId === input.projectId &&
        check.workItemId === input.workItemId &&
        check.runId === run.id &&
        check.recipeId === recipe.id &&
        check.required === recipe.required &&
        check.ordinal === index + 1 &&
        check.status !== "QUEUED" &&
        check.status !== "RUNNING"
      );
    });
  if (!exactChecks || orderedChecks.some((check) => check.required && check.status !== "PASSED")) {
    return { status: "BLOCKED", evidence: null, blocker: "EVIDENCE_INVALID" };
  }
  if (run.completedAt === null) {
    return { status: "BLOCKED", evidence: null, blocker: "EVIDENCE_INVALID" };
  }

  return {
    status: "READY",
    blocker: null,
    evidence: verificationEvidenceSchema.parse({
      schemaVersion: 1,
      projectId: input.projectId,
      workItemId: input.workItemId,
      pipelineRunId: input.pipelineRunId,
      verificationRunId: run.id,
      planId: plan.id,
      planRevision: plan.revision,
      planContentHash: plan.contentHash,
      implementationTree: run.implementationTree,
      platform: run.platform,
      requiredCheckIds: orderedChecks.filter(({ required }) => required).map(({ id }) => id),
      optionalFailedCheckIds: orderedChecks
        .filter(({ required, status }) => !required && status !== "PASSED")
        .map(({ id }) => id),
      completedAt: run.completedAt,
    }),
  };
};
