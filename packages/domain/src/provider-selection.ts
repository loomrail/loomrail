import type {
  Project,
  ProjectProviderSelection,
  ProviderPreference,
  SetProjectProviderPreferenceCommand,
} from "@loomrail/contracts";

export type ProviderSelectionDomainErrorCode =
  "PROJECT_NOT_FOUND" | "PROJECT_NOT_ACTIVE" | "PROJECT_VERSION_CONFLICT" | "PROVIDER_PREFERENCE_UNCHANGED";

export class ProviderSelectionDomainError extends Error {
  readonly code: ProviderSelectionDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: ProviderSelectionDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ProviderSelectionDomainError";
    this.code = code;
    this.details = details;
  }
}

export type ProjectProviderPreferenceChangedIntent = {
  type: "PROJECT_PROVIDER_PREFERENCE_CHANGED";
  data: {
    selection: ProjectProviderSelection;
    previousPreference: ProviderPreference;
  };
};

export const decideProjectProviderPreference = (
  command: SetProjectProviderPreferenceCommand,
  context: { now: string; project?: Project },
): {
  project: Project;
  selection: ProjectProviderSelection;
  event: ProjectProviderPreferenceChangedIntent;
} => {
  const current = context.project;
  if (!current) {
    throw new ProviderSelectionDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
  }
  if (current.status !== "ACTIVE") {
    throw new ProviderSelectionDomainError(
      "PROJECT_NOT_ACTIVE",
      "Only an active Project can change its provider preference",
    );
  }
  if (current.version !== command.payload.expectedProjectVersion) {
    throw new ProviderSelectionDomainError(
      "PROJECT_VERSION_CONFLICT",
      "The Project changed after provider settings were loaded",
      {
        expectedVersion: command.payload.expectedProjectVersion,
        actualVersion: current.version,
      },
    );
  }
  if (current.providerPreference === command.payload.preference) {
    throw new ProviderSelectionDomainError(
      "PROVIDER_PREFERENCE_UNCHANGED",
      "The provider preference is already selected",
    );
  }

  const project: Project = {
    ...current,
    providerPreference: command.payload.preference,
    version: current.version + 1,
    updatedAt: context.now,
  };
  const selection: ProjectProviderSelection = {
    schemaVersion: 1,
    projectId: project.id,
    preference: project.providerPreference,
    projectVersion: project.version,
    updatedAt: project.updatedAt,
  };
  return {
    project,
    selection,
    event: {
      type: "PROJECT_PROVIDER_PREFERENCE_CHANGED",
      data: { selection, previousPreference: current.providerPreference },
    },
  };
};
