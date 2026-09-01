export const scaffoldRecipeIds = ["typescript-node"] as const;

export type ScaffoldRecipeId = (typeof scaffoldRecipeIds)[number];

export type ScaffoldFileManifest = {
  bytes: number;
  contentDigest: string;
  path: string;
};

export type ScaffoldProposal = {
  files: readonly ScaffoldFileManifest[];
  packageName: string;
  projectName: string;
  proposalDigest: string;
  recipeId: ScaffoldRecipeId;
  recipeVersion: number;
  schemaVersion: 1;
  systemFiles: readonly [".loomrail/scaffold.json"];
  targetPath: string;
};

export type ScaffoldPublication = {
  operationId: string;
  proposalDigest: string;
  repositoryPath: string;
  status: "PUBLISHED";
};

export type ProjectScaffoldingErrorCode =
  | "FILE_CONFLICT"
  | "GIT_INIT_FAILED"
  | "INVALID_OPERATION_ID"
  | "INVALID_TARGET_PATH"
  | "MARKER_MISMATCH"
  | "PROPOSAL_CHANGED"
  | "RECIPE_UNAVAILABLE"
  | "REPOSITORY_INVALID"
  | "TARGET_EXISTS"
  | "TARGET_INSIDE_REPOSITORY"
  | "TARGET_NAME_UNSUPPORTED"
  | "TARGET_PARENT_UNAVAILABLE";

export class ProjectScaffoldingError extends Error {
  readonly code: ProjectScaffoldingErrorCode;

  constructor(code: ProjectScaffoldingErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectScaffoldingError";
    this.code = code;
  }
}
