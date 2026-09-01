import type {
  CompleteProjectScaffoldCommand,
  FailProjectScaffoldCommand,
  Project,
  RequestProjectScaffoldCommand,
  RetryProjectScaffoldCommand,
  ScaffoldOperation,
} from "@loomrail/contracts";

export type ScaffoldDomainErrorCode =
  | "PROJECT_ALREADY_EXISTS"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_STATUS_INVALID"
  | "SCAFFOLD_OPERATION_NOT_FOUND"
  | "SCAFFOLD_OPERATION_PROJECT_MISMATCH"
  | "SCAFFOLD_OPERATION_STATUS_INVALID"
  | "SCAFFOLD_OPERATION_VERSION_CONFLICT";

export class ScaffoldDomainError extends Error {
  readonly code: ScaffoldDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: ScaffoldDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ScaffoldDomainError";
    this.code = code;
    this.details = details;
  }
}

export type ScaffoldRequestedIntent = {
  type: "PROJECT_SCAFFOLD_REQUESTED";
  data: { operation: ScaffoldOperation };
};

export type ScaffoldCompletedIntent = {
  type: "PROJECT_SCAFFOLD_COMPLETED";
  data: { operation: ScaffoldOperation };
};

export type ScaffoldFailedIntent = {
  type: "PROJECT_SCAFFOLD_FAILED";
  data: { operation: ScaffoldOperation };
};

const requireOperation = (
  operation: ScaffoldOperation | undefined,
  expectedVersion: number,
): ScaffoldOperation => {
  if (operation === undefined) {
    throw new ScaffoldDomainError("SCAFFOLD_OPERATION_NOT_FOUND", "The scaffold operation does not exist");
  }
  if (operation.version !== expectedVersion) {
    throw new ScaffoldDomainError(
      "SCAFFOLD_OPERATION_VERSION_CONFLICT",
      "The scaffold operation changed after it was loaded",
      { expectedVersion, actualVersion: operation.version },
    );
  }
  return operation;
};

const requireProvisioningProject = (project: Project | undefined, operation: ScaffoldOperation): Project => {
  if (project === undefined) {
    throw new ScaffoldDomainError("PROJECT_NOT_FOUND", "The provisioning Project does not exist");
  }
  if (project.id !== operation.projectId || project.repositoryPath !== operation.proposal.targetPath) {
    throw new ScaffoldDomainError(
      "SCAFFOLD_OPERATION_PROJECT_MISMATCH",
      "The scaffold operation does not match its provisioning Project",
    );
  }
  if (project.status !== "PROVISIONING") {
    throw new ScaffoldDomainError(
      "PROJECT_STATUS_INVALID",
      "Only a provisioning Project can change through a scaffold operation",
    );
  }
  return project;
};

export const decideProjectScaffoldRequested = (
  command: RequestProjectScaffoldCommand,
  context: {
    now: string;
    newOperationId: string;
    newProjectId: string;
    existingProject?: Project;
  },
): { project: Project; operation: ScaffoldOperation; event: ScaffoldRequestedIntent } => {
  if (context.existingProject !== undefined) {
    throw new ScaffoldDomainError("PROJECT_ALREADY_EXISTS", "A Project already owns this scaffold target");
  }
  const project: Project = {
    schemaVersion: 1,
    id: context.newProjectId,
    workspaceId: "workspace-local",
    fixtureId: null,
    name: command.payload.proposal.projectName,
    repositoryPath: command.payload.proposal.targetPath,
    providerPreference: "AUTO",
    status: "PROVISIONING",
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
  };
  const operation: ScaffoldOperation = {
    schemaVersion: 1,
    id: context.newOperationId,
    projectId: project.id,
    proposal: command.payload.proposal,
    status: "PENDING",
    attempts: 0,
    lastErrorCode: null,
    version: 1,
    createdAt: context.now,
    updatedAt: context.now,
    completedAt: null,
  };
  return {
    project,
    operation,
    event: { type: "PROJECT_SCAFFOLD_REQUESTED", data: { operation } },
  };
};

export const decideProjectScaffoldCompleted = (
  command: CompleteProjectScaffoldCommand,
  context: { now: string; operation?: ScaffoldOperation; project?: Project },
): { project: Project; operation: ScaffoldOperation; event: ScaffoldCompletedIntent } => {
  const current = requireOperation(context.operation, command.payload.expectedVersion);
  if (current.status !== "PENDING") {
    throw new ScaffoldDomainError(
      "SCAFFOLD_OPERATION_STATUS_INVALID",
      "Only a pending scaffold operation can complete",
    );
  }
  const currentProject = requireProvisioningProject(context.project, current);
  const operation: ScaffoldOperation = {
    ...current,
    status: "COMPLETED",
    attempts: current.attempts + 1,
    lastErrorCode: null,
    version: current.version + 1,
    updatedAt: context.now,
    completedAt: context.now,
  };
  const project: Project = {
    ...currentProject,
    status: "ACTIVE",
    version: currentProject.version + 1,
    updatedAt: context.now,
  };
  return {
    project,
    operation,
    event: { type: "PROJECT_SCAFFOLD_COMPLETED", data: { operation } },
  };
};

export const decideProjectScaffoldFailed = (
  command: FailProjectScaffoldCommand,
  context: { now: string; operation?: ScaffoldOperation; project?: Project },
): { operation: ScaffoldOperation; event: ScaffoldFailedIntent } => {
  const current = requireOperation(context.operation, command.payload.expectedVersion);
  if (current.status !== "PENDING") {
    throw new ScaffoldDomainError(
      "SCAFFOLD_OPERATION_STATUS_INVALID",
      "Only a pending scaffold operation can fail",
    );
  }
  requireProvisioningProject(context.project, current);
  const operation: ScaffoldOperation = {
    ...current,
    status: "FAILED",
    attempts: current.attempts + 1,
    lastErrorCode: command.payload.errorCode,
    version: current.version + 1,
    updatedAt: context.now,
  };
  return {
    operation,
    event: { type: "PROJECT_SCAFFOLD_FAILED", data: { operation } },
  };
};

export const decideProjectScaffoldRetry = (
  command: RetryProjectScaffoldCommand,
  context: { now: string; operation?: ScaffoldOperation; project?: Project },
): { operation: ScaffoldOperation; event: ScaffoldRequestedIntent } => {
  const current = requireOperation(context.operation, command.payload.expectedVersion);
  if (current.status !== "FAILED") {
    throw new ScaffoldDomainError(
      "SCAFFOLD_OPERATION_STATUS_INVALID",
      "Only a failed scaffold operation can be retried",
    );
  }
  requireProvisioningProject(context.project, current);
  const operation: ScaffoldOperation = {
    ...current,
    status: "PENDING",
    lastErrorCode: null,
    version: current.version + 1,
    updatedAt: context.now,
  };
  return {
    operation,
    event: { type: "PROJECT_SCAFFOLD_REQUESTED", data: { operation } },
  };
};
