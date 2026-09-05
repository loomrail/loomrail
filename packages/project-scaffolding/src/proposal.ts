import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

import { inspectRepository } from "@loomrail/workspace";

import { digestContent, renderScaffoldRecipe, type RenderedScaffoldFile } from "./recipe.js";
import { scaffoldGitEnvironment } from "./git-environment.js";
import {
  ProjectScaffoldingError,
  scaffoldRecipeIds,
  type ScaffoldFileManifest,
  type ScaffoldProposal,
  type ScaffoldRecipeId,
} from "./types.js";

const TARGET_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/u;
const WINDOWS_RESERVED_NAME = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return false;
    throw error;
  }
};

const parseRecipeId = (value: string): ScaffoldRecipeId => {
  const recipeId = scaffoldRecipeIds.find((candidate) => candidate === value);
  if (recipeId === undefined) {
    throw new ProjectScaffoldingError("RECIPE_UNAVAILABLE", "The selected scaffold recipe is unavailable");
  }
  return recipeId;
};

export type PreparedScaffoldProposal = {
  files: readonly RenderedScaffoldFile[];
  proposal: ScaffoldProposal;
};

export const renderPreparedProjectScaffold = (input: {
  recipeId: ScaffoldRecipeId;
  targetPath: string;
}): PreparedScaffoldProposal => {
  const projectName = basename(input.targetPath);
  const rendered = renderScaffoldRecipe(input.recipeId, {
    packageName: projectName,
    projectName,
  });
  const manifests: readonly ScaffoldFileManifest[] = Object.freeze(
    rendered.files.map((file) =>
      Object.freeze({
        bytes: Buffer.byteLength(file.content, "utf8"),
        contentDigest: digestContent(file.content),
        path: file.path,
      }),
    ),
  );
  const digestPayload = {
    files: manifests,
    packageName: projectName,
    projectName,
    recipeId: input.recipeId,
    recipeVersion: rendered.version,
    schemaVersion: 1,
    systemFiles: Object.freeze([".loomrail/scaffold.json"] as const),
    targetPath: input.targetPath,
  } as const;
  const proposalDigest = createHash("sha256").update(JSON.stringify(digestPayload), "utf8").digest("hex");

  return {
    files: rendered.files,
    proposal: Object.freeze({ ...digestPayload, proposalDigest }),
  };
};

export const prepareProjectScaffold = async (input: {
  recipeId: string;
  targetPath: string;
}): Promise<PreparedScaffoldProposal> => {
  const rawTargetPath = input.targetPath.trim();
  if (rawTargetPath.length === 0 || rawTargetPath.length > 1_024 || !isAbsolute(rawTargetPath)) {
    throw new ProjectScaffoldingError("INVALID_TARGET_PATH", "Choose an absolute path for the new project");
  }

  const requestedTarget = resolve(rawTargetPath);
  if (requestedTarget === parse(requestedTarget).root) {
    throw new ProjectScaffoldingError(
      "INVALID_TARGET_PATH",
      "The filesystem root cannot be a project target",
    );
  }
  const projectName = basename(requestedTarget);
  if (
    !TARGET_NAME.test(projectName) ||
    WINDOWS_RESERVED_NAME.test(projectName) ||
    projectName.endsWith(".")
  ) {
    throw new ProjectScaffoldingError(
      "TARGET_NAME_UNSUPPORTED",
      "Use 1–80 lowercase letters, digits, dots, hyphens or underscores for the new directory name",
    );
  }

  const requestedParent = dirname(requestedTarget);
  let canonicalParent: string;
  try {
    // `stat`, not `lstat`: a parent that is a symlink to a directory (macOS `/tmp`, a linked
    // `~/projects`) is a valid location, and the very next line canonicalises it anyway.
    const parentStat = await stat(requestedParent);
    if (!parentStat.isDirectory()) {
      throw new ProjectScaffoldingError(
        "TARGET_PARENT_UNAVAILABLE",
        "The parent path must be an existing directory",
      );
    }
    canonicalParent = await realpath(requestedParent);
  } catch (error: unknown) {
    if (error instanceof ProjectScaffoldingError) throw error;
    throw new ProjectScaffoldingError(
      "TARGET_PARENT_UNAVAILABLE",
      "The parent path must be an existing accessible directory",
      error,
    );
  }

  const targetPath = join(canonicalParent, projectName);
  if (await pathExists(targetPath)) {
    throw new ProjectScaffoldingError("TARGET_EXISTS", "The new project directory already exists");
  }
  const parentRepository = await inspectRepository(canonicalParent, {
    env: scaffoldGitEnvironment(targetPath),
  });
  if (parentRepository !== null) {
    throw new ProjectScaffoldingError(
      "TARGET_INSIDE_REPOSITORY",
      "Choose a location outside an existing Git repository",
    );
  }

  const recipeId = parseRecipeId(input.recipeId);
  return renderPreparedProjectScaffold({ recipeId, targetPath });
};

export const proposeProjectScaffold = async (input: {
  recipeId: string;
  targetPath: string;
}): Promise<ScaffoldProposal> => (await prepareProjectScaffold(input)).proposal;
