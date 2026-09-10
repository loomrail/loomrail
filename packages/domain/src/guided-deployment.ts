import type {
  Actor,
  AdoptDeploymentPlanCommand,
  ApproveDeploymentCommand,
  Deployment,
  DeploymentApproval,
  DeploymentPlan,
  LaunchRelease,
  LaunchReleaseFreshness,
  Project,
  ReconcileDeploymentCommand,
  RecordDeploymentDispatchCommand,
  RecordDeploymentObservationCommand,
  StartDeploymentCommand,
} from "@loomrail/contracts";

export type GuidedDeploymentDomainErrorCode =
  | "OWNER_REQUIRED"
  | "RUNNER_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ACTIVE"
  | "PROJECT_VERSION_CONFLICT"
  | "RELEASE_NOT_FOUND"
  | "RELEASE_CONTENT_MISMATCH"
  | "RELEASE_STALE"
  | "RELEASE_GATES_BLOCKED"
  | "ENVIRONMENT_UNSUPPORTED"
  | "DEPLOYMENT_NOT_FOUND"
  | "DEPLOYMENT_VERSION_CONFLICT"
  | "APPROVAL_DIGEST_MISMATCH"
  | "APPROVAL_NOT_FOUND"
  | "PLAN_NOT_FOUND"
  | "PLAN_IDENTITY_MISMATCH"
  | "RUN_IDENTITY_MISMATCH"
  | "INVALID_TRANSITION";

export class GuidedDeploymentDomainError extends Error {
  readonly code: GuidedDeploymentDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: GuidedDeploymentDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "GuidedDeploymentDomainError";
    this.code = code;
    this.details = details;
  }
}

export type DeploymentPlanAdoptedIntent = {
  type: "DEPLOYMENT_PLAN_ADOPTED";
  data: { plan: DeploymentPlan; deployment: Deployment };
};
export type DeploymentChangedIntent = {
  type: "DEPLOYMENT_CHANGED";
  data: { deployment: Deployment };
};

const requireOwner = (actor: Actor): void => {
  if (actor.type !== "HUMAN") {
    throw new GuidedDeploymentDomainError(
      "OWNER_REQUIRED",
      "Only the owner can adopt or approve a Deployment",
    );
  }
};

const requireRunner = (actor: Actor): void => {
  if (actor.type !== "SYSTEM" || (actor.id !== "deployment-runner" && actor.id !== "local-daemon")) {
    throw new GuidedDeploymentDomainError(
      "RUNNER_REQUIRED",
      "Only the trusted deployment runner can change an attempted Deployment",
    );
  }
};

const requireProject = (project: Project | undefined, projectId: string): Project => {
  if (project?.id !== projectId) {
    throw new GuidedDeploymentDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (project.status !== "ACTIVE") {
    throw new GuidedDeploymentDomainError("PROJECT_NOT_ACTIVE", "Guided deployment needs an active Project");
  }
  return project;
};

const requireDeployment = (deployment: Deployment | undefined, deploymentId: string): Deployment => {
  if (deployment?.id !== deploymentId) {
    throw new GuidedDeploymentDomainError("DEPLOYMENT_NOT_FOUND", "The Deployment does not exist");
  }
  return deployment;
};

const requireVersion = (deployment: Deployment, expectedVersion: number): void => {
  if (deployment.version !== expectedVersion) {
    throw new GuidedDeploymentDomainError(
      "DEPLOYMENT_VERSION_CONFLICT",
      "The Deployment changed after it was loaded",
      { expectedVersion, actualVersion: deployment.version },
    );
  }
};

export const decideAdoptDeploymentPlan = (
  command: AdoptDeploymentPlanCommand,
  context: {
    now: string;
    newPlanId: string;
    newDeploymentId: string;
    planContentHash: string;
    approvalDigest: string;
    project: Project | undefined;
    release: LaunchRelease | undefined;
    releaseFreshness?: LaunchReleaseFreshness;
  },
): {
  project: Project;
  plan: DeploymentPlan;
  deployment: Deployment;
  event: DeploymentPlanAdoptedIntent;
} => {
  requireOwner(command.actor);
  const project = requireProject(context.project, command.payload.projectId);
  if (project.version !== command.payload.expectedProjectVersion) {
    throw new GuidedDeploymentDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after the deployment preview was loaded",
      { expectedVersion: command.payload.expectedProjectVersion, actualVersion: project.version },
    );
  }
  const release = context.release;
  if (release?.id !== command.payload.releaseId || release.projectId !== project.id) {
    throw new GuidedDeploymentDomainError("RELEASE_NOT_FOUND", "The Release does not exist in this Project");
  }
  if (release.contentHash !== command.payload.expectedReleaseContentHash) {
    throw new GuidedDeploymentDomainError(
      "RELEASE_CONTENT_MISMATCH",
      "The Release changed after the deployment preview was loaded",
    );
  }
  const releaseFreshness = context.releaseFreshness ?? command.payload.releaseFreshness;
  if (releaseFreshness.status !== "CURRENT") {
    throw new GuidedDeploymentDomainError("RELEASE_STALE", "The Release evidence is no longer current");
  }
  const blockedGates = release.gates.filter(({ required, status }) => required && status !== "PASSED");
  if (blockedGates.length > 0) {
    throw new GuidedDeploymentDomainError(
      "RELEASE_GATES_BLOCKED",
      "Every required Release gate must pass before deployment",
      { blockedGateCount: blockedGates.length },
    );
  }
  if (release.environment.kind !== "PREVIEW") {
    throw new GuidedDeploymentDomainError(
      "ENVIRONMENT_UNSUPPORTED",
      "L4a supports PREVIEW deployment only; production remains blocked",
    );
  }

  const plan: DeploymentPlan = {
    schemaVersion: 1,
    id: context.newPlanId,
    projectId: project.id,
    revision: 1,
    releaseId: release.id,
    releaseContentHash: release.contentHash,
    environmentId: release.environment.id,
    environmentContentHash: release.environment.contentHash,
    target: { ...command.payload.target },
    contentHash: context.planContentHash,
    createdAt: context.now,
  };
  const deployment: Deployment = {
    schemaVersion: 1,
    id: context.newDeploymentId,
    projectId: project.id,
    planId: plan.id,
    planRevision: plan.revision,
    planContentHash: plan.contentHash,
    releaseId: release.id,
    releaseContentHash: release.contentHash,
    environmentId: release.environment.id,
    environmentContentHash: release.environment.contentHash,
    intent: "STANDARD",
    approvalDigest: context.approvalDigest,
    status: "PENDING_APPROVAL",
    approvalId: null,
    remoteRunId: null,
    remoteRunUrl: null,
    failureCode: null,
    createdAt: context.now,
    approvedAt: null,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    version: 1,
  };
  const changedProject: Project = {
    ...project,
    version: project.version + 1,
    updatedAt: context.now,
  };
  return {
    project: changedProject,
    plan,
    deployment,
    event: { type: "DEPLOYMENT_PLAN_ADOPTED", data: { plan, deployment } },
  };
};

export const decideApproveDeployment = (
  command: ApproveDeploymentCommand,
  context: { now: string; newApprovalId: string; deployment: Deployment | undefined },
): { deployment: Deployment; approval: DeploymentApproval; event: DeploymentChangedIntent } => {
  requireOwner(command.actor);
  const current = requireDeployment(context.deployment, command.payload.deploymentId);
  requireVersion(current, command.payload.expectedVersion);
  if (current.status !== "PENDING_APPROVAL") {
    throw new GuidedDeploymentDomainError("INVALID_TRANSITION", "Only a pending Deployment can be approved", {
      status: current.status,
    });
  }
  if (current.approvalDigest !== command.payload.approvalDigest) {
    throw new GuidedDeploymentDomainError(
      "APPROVAL_DIGEST_MISMATCH",
      "The deployment preview changed before approval",
    );
  }
  const approval: DeploymentApproval = {
    schemaVersion: 1,
    id: context.newApprovalId,
    projectId: current.projectId,
    deploymentId: current.id,
    approvalDigest: current.approvalDigest,
    actorId: command.actor.id,
    createdAt: context.now,
  };
  const deployment: Deployment = {
    ...current,
    status: "APPROVED",
    approvalId: approval.id,
    approvedAt: context.now,
    version: current.version + 1,
  };
  return { deployment, approval, event: { type: "DEPLOYMENT_CHANGED", data: { deployment } } };
};

export const decideStartDeployment = (
  command: StartDeploymentCommand,
  context: {
    now: string;
    deployment: Deployment | undefined;
    approval: DeploymentApproval | undefined;
  },
): { deployment: Deployment; event: DeploymentChangedIntent } => {
  requireRunner(command.actor);
  const current = requireDeployment(context.deployment, command.payload.deploymentId);
  requireVersion(current, command.payload.expectedVersion);
  if (current.status !== "APPROVED") {
    throw new GuidedDeploymentDomainError("INVALID_TRANSITION", "Only an approved Deployment can start", {
      status: current.status,
    });
  }
  if (
    context.approval?.id !== current.approvalId ||
    context.approval.deploymentId !== current.id ||
    context.approval.approvalDigest !== current.approvalDigest
  ) {
    throw new GuidedDeploymentDomainError("APPROVAL_NOT_FOUND", "The exact Deployment Approval is missing");
  }
  const deployment: Deployment = {
    ...current,
    status: "RUNNING",
    startedAt: context.now,
    version: current.version + 1,
  };
  return { deployment, event: { type: "DEPLOYMENT_CHANGED", data: { deployment } } };
};

export const decideRecordDeploymentDispatch = (
  command: RecordDeploymentDispatchCommand,
  context: { now: string; deployment: Deployment | undefined; plan?: DeploymentPlan },
): { deployment: Deployment; event: DeploymentChangedIntent } => {
  requireRunner(command.actor);
  const current = requireDeployment(context.deployment, command.payload.deploymentId);
  requireVersion(current, command.payload.expectedVersion);
  if (current.status !== "RUNNING" || current.remoteRunId !== null) {
    throw new GuidedDeploymentDomainError(
      "INVALID_TRANSITION",
      "Only an unidentified running Deployment can record dispatch",
      { status: current.status },
    );
  }
  const outcome = command.payload.outcome;
  if (outcome.type === "UNKNOWN" || outcome.type === "REFUSED") {
    const deployment: Deployment = {
      ...current,
      status: outcome.type === "REFUSED" ? "FAILED" : "UNKNOWN",
      failureCode: outcome.type === "REFUSED" ? "PRECONDITION_CHANGED" : "DISPATCH_OUTCOME_UNKNOWN",
      completedAt: outcome.type === "REFUSED" ? context.now : null,
      observedAt: context.now,
      version: current.version + 1,
    };
    return { deployment, event: { type: "DEPLOYMENT_CHANGED", data: { deployment } } };
  }
  const plan = context.plan;
  if (
    plan?.id !== current.planId ||
    plan.contentHash !== current.planContentHash ||
    outcome.runUrl !==
      `https://github.com/${plan.target.repositorySlug}/actions/runs/${outcome.runId.toString()}`
  ) {
    throw new GuidedDeploymentDomainError(
      "PLAN_IDENTITY_MISMATCH",
      "The dispatched GitHub run does not match the approved Plan",
    );
  }
  const deployment: Deployment = {
    ...current,
    remoteRunId: outcome.runId,
    remoteRunUrl: outcome.runUrl,
    observedAt: context.now,
    version: current.version + 1,
  };
  return { deployment, event: { type: "DEPLOYMENT_CHANGED", data: { deployment } } };
};

export const decideRecordDeploymentObservation = (
  command: RecordDeploymentObservationCommand,
  context: { now: string; deployment: Deployment | undefined },
): { deployment: Deployment; event: DeploymentChangedIntent } => {
  requireRunner(command.actor);
  const current = requireDeployment(context.deployment, command.payload.deploymentId);
  requireVersion(current, command.payload.expectedVersion);
  if ((current.status !== "RUNNING" && current.status !== "UNKNOWN") || current.remoteRunId === null) {
    throw new GuidedDeploymentDomainError(
      "INVALID_TRANSITION",
      "Only an identified running or unknown Deployment can be observed",
      { status: current.status },
    );
  }
  if (current.remoteRunId !== command.payload.observedRunId) {
    throw new GuidedDeploymentDomainError("RUN_IDENTITY_MISMATCH", "The observed GitHub run id changed");
  }
  const outcome = command.payload.outcome;
  const status = outcome.type === "RUNNING" ? "RUNNING" : outcome.type;
  const deployment: Deployment = {
    ...current,
    status,
    failureCode:
      outcome.type === "FAILED"
        ? outcome.failureCode
        : outcome.type === "UNKNOWN"
          ? "OBSERVATION_INVALID"
          : null,
    completedAt: outcome.type === "SUCCEEDED" || outcome.type === "FAILED" ? context.now : null,
    observedAt: context.now,
    version: current.version + 1,
  };
  return { deployment, event: { type: "DEPLOYMENT_CHANGED", data: { deployment } } };
};

export const decideReconcileDeployment = (
  command: ReconcileDeploymentCommand,
  context: { now: string; deployment: Deployment | undefined },
): { deployment: Deployment; event: DeploymentChangedIntent } => {
  requireRunner(command.actor);
  const current = requireDeployment(context.deployment, command.payload.deploymentId);
  requireVersion(current, command.payload.expectedVersion);
  if (current.status !== "RUNNING") {
    throw new GuidedDeploymentDomainError(
      "INVALID_TRANSITION",
      "Only a running Deployment is interrupted by startup reconciliation",
      { status: current.status },
    );
  }
  const deployment: Deployment = {
    ...current,
    status: "UNKNOWN",
    failureCode: "DAEMON_RESTARTED",
    observedAt: context.now,
    version: current.version + 1,
  };
  return { deployment, event: { type: "DEPLOYMENT_CHANGED", data: { deployment } } };
};
