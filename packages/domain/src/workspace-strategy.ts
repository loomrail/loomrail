import type {
  Project,
  ProjectWorkspaceStrategySelection,
  SetProjectWorkspaceStrategyCommand,
  WorkspaceStrategy,
} from "@loomrail/contracts";

export type WorkspaceStrategyDomainErrorCode =
  "PROJECT_NOT_FOUND" | "PROJECT_NOT_ACTIVE" | "PROJECT_VERSION_CONFLICT" | "WORKSPACE_STRATEGY_UNCHANGED";

export class WorkspaceStrategyDomainError extends Error {
  readonly code: WorkspaceStrategyDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: WorkspaceStrategyDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "WorkspaceStrategyDomainError";
    this.code = code;
    this.details = details;
  }
}

export type ProjectWorkspaceStrategyChangedIntent = {
  type: "PROJECT_WORKSPACE_STRATEGY_CHANGED";
  data: {
    selection: ProjectWorkspaceStrategySelection;
    previousStrategy: WorkspaceStrategy;
  };
};

export const decideProjectWorkspaceStrategy = (
  command: SetProjectWorkspaceStrategyCommand,
  context: { now: string; project?: Project; currentStrategy: WorkspaceStrategy },
): {
  project: Project;
  selection: ProjectWorkspaceStrategySelection;
  event: ProjectWorkspaceStrategyChangedIntent;
} => {
  const current = context.project;
  if (!current) {
    throw new WorkspaceStrategyDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (current.status !== "ACTIVE") {
    throw new WorkspaceStrategyDomainError(
      "PROJECT_NOT_ACTIVE",
      "Only an active Project can change its workspace strategy",
    );
  }
  if (current.version !== command.payload.expectedProjectVersion) {
    throw new WorkspaceStrategyDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after workspace settings were loaded",
      {
        expectedVersion: command.payload.expectedProjectVersion,
        actualVersion: current.version,
      },
    );
  }
  if (context.currentStrategy === command.payload.strategy) {
    throw new WorkspaceStrategyDomainError(
      "WORKSPACE_STRATEGY_UNCHANGED",
      "The workspace strategy is already selected",
    );
  }

  const project: Project = {
    ...current,
    version: current.version + 1,
    updatedAt: context.now,
  };
  const selection: ProjectWorkspaceStrategySelection = {
    schemaVersion: 1,
    projectId: project.id,
    strategy: command.payload.strategy,
    projectVersion: project.version,
    updatedAt: project.updatedAt,
  };
  return {
    project,
    selection,
    event: {
      type: "PROJECT_WORKSPACE_STRATEGY_CHANGED",
      data: { selection, previousStrategy: context.currentStrategy },
    },
  };
};
