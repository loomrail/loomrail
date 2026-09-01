import { mkdir, lstat, open, readFile, readdir, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { inspectRepository, runGit } from "@loomrail/workspace";

import { digestContent, type RenderedScaffoldFile } from "./recipe.js";
import { scaffoldGitEnvironment } from "./git-environment.js";
import { prepareProjectScaffold, renderPreparedProjectScaffold } from "./proposal.js";
import { ProjectScaffoldingError, type ScaffoldProposal, type ScaffoldPublication } from "./types.js";

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const MARKER_DIRECTORY = ".loomrail";
const MARKER_PATH = `${MARKER_DIRECTORY}/scaffold.json`;

type ScaffoldMarker = {
  operationId: string;
  proposalDigest: string;
  recipeId: string;
  recipeVersion: number;
  schemaVersion: 1;
};

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;

const lstatOrNull = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

const markerContent = (marker: ScaffoldMarker): string => `${JSON.stringify(marker, null, 2)}\n`;

const parseExactMarker = (value: string): ScaffoldMarker | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  const expectedKeys = ["operationId", "proposalDigest", "recipeId", "recipeVersion", "schemaVersion"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    return null;
  const record = parsed as Record<string, unknown>;
  const schemaVersion = record["schemaVersion"];
  const operationId = record["operationId"];
  const proposalDigest = record["proposalDigest"];
  const recipeId = record["recipeId"];
  const recipeVersion = record["recipeVersion"];
  if (
    schemaVersion !== 1 ||
    typeof operationId !== "string" ||
    typeof proposalDigest !== "string" ||
    typeof recipeId !== "string" ||
    typeof recipeVersion !== "number" ||
    !Number.isSafeInteger(recipeVersion)
  ) {
    return null;
  }
  return { schemaVersion, operationId, proposalDigest, recipeId, recipeVersion };
};

const ensureDirectory = async (path: string): Promise<void> => {
  const existing = await lstatOrNull(path);
  if (existing === null) {
    try {
      await mkdir(path, { mode: 0o700 });
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new ProjectScaffoldingError("FILE_CONFLICT", "A scaffold directory conflicts with another file");
  }
};

const assertInsideTarget = (targetPath: string, path: string): void => {
  const child = relative(targetPath, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || resolve(path) !== path) {
    throw new ProjectScaffoldingError("FILE_CONFLICT", "A scaffold path escaped the project target");
  }
};

const writeCreateNew = async (path: string, content: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle?.close();
  }
};

const verifyOrCreateFile = async (targetPath: string, file: RenderedScaffoldFile): Promise<void> => {
  const destination = join(targetPath, ...file.path.split("/"));
  assertInsideTarget(targetPath, destination);

  const relativeParent = dirname(file.path);
  if (relativeParent !== ".") {
    let current = targetPath;
    for (const segment of relativeParent.split("/")) {
      current = join(current, segment);
      assertInsideTarget(targetPath, current);
      await ensureDirectory(current);
    }
  }

  const existing = await lstatOrNull(destination);
  if (existing !== null) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new ProjectScaffoldingError("FILE_CONFLICT", "A scaffold file conflicts with another path");
    }
    const content = await readFile(destination, "utf8");
    if (digestContent(content) !== digestContent(file.content)) {
      throw new ProjectScaffoldingError("FILE_CONFLICT", "A scaffold file changed during publication");
    }
    return;
  }

  try {
    await writeCreateNew(destination, file.content);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") {
      throw new ProjectScaffoldingError("FILE_CONFLICT", "A scaffold file was created concurrently", error);
    }
    throw error;
  }
};

const readMarker = async (targetPath: string): Promise<ScaffoldMarker | null> => {
  const path = join(targetPath, MARKER_PATH);
  const stat = await lstatOrNull(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  return parseExactMarker(await readFile(path, "utf8"));
};

const markersEqual = (left: ScaffoldMarker | null, right: ScaffoldMarker): boolean =>
  left !== null &&
  left.operationId === right.operationId &&
  left.proposalDigest === right.proposalDigest &&
  left.recipeId === right.recipeId &&
  left.recipeVersion === right.recipeVersion;

const assertKnownTree = async (targetPath: string, files: readonly RenderedScaffoldFile[]): Promise<void> => {
  const knownFiles = new Set<string>([MARKER_PATH, ...files.map((file) => file.path)]);
  const knownDirectories = new Set<string>([MARKER_DIRECTORY]);
  for (const file of files) {
    const segments = file.path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      knownDirectories.add(current);
    }
  }

  const visit = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directoryPath);
    for (const name of entries.sort()) {
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const path = join(directoryPath, name);
      assertInsideTarget(targetPath, path);
      const stat = await lstat(path);
      if (relativePath === ".git") {
        if (relativeDirectory !== "" || !stat.isDirectory() || stat.isSymbolicLink()) {
          throw new ProjectScaffoldingError("FILE_CONFLICT", "The scaffold Git directory is invalid");
        }
        continue;
      }
      if (knownFiles.has(relativePath)) {
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new ProjectScaffoldingError("FILE_CONFLICT", "A scaffold file has an invalid type");
        }
        continue;
      }
      if (knownDirectories.has(relativePath)) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new ProjectScaffoldingError("FILE_CONFLICT", "A scaffold directory has an invalid type");
        }
        await visit(path, relativePath);
        continue;
      }
      throw new ProjectScaffoldingError("FILE_CONFLICT", "The scaffold target contains an unknown path");
    }
  };

  await visit(targetPath, "");
};

export const publishProjectScaffold = async (input: {
  operationId: string;
  proposal: ScaffoldProposal;
}): Promise<ScaffoldPublication> => {
  if (!OPERATION_ID.test(input.operationId)) {
    throw new ProjectScaffoldingError("INVALID_OPERATION_ID", "The scaffold operation id is invalid");
  }

  let prepared;
  try {
    prepared = await prepareProjectScaffold({
      recipeId: input.proposal.recipeId,
      targetPath: input.proposal.targetPath,
    });
  } catch (error: unknown) {
    // An exact operation may legitimately be resuming after it already claimed the target. That
    // case is settled below by its marker; every other proposal error still fails closed.
    if (!(error instanceof ProjectScaffoldingError) || error.code !== "TARGET_EXISTS") throw error;
    prepared = null;
  }

  if (prepared !== null && prepared.proposal.proposalDigest !== input.proposal.proposalDigest) {
    throw new ProjectScaffoldingError("PROPOSAL_CHANGED", "The scaffold proposal changed before publication");
  }

  const expectedMarker: ScaffoldMarker = {
    schemaVersion: 1,
    operationId: input.operationId,
    proposalDigest: input.proposal.proposalDigest,
    recipeId: input.proposal.recipeId,
    recipeVersion: input.proposal.recipeVersion,
  };
  const targetPath = input.proposal.targetPath;
  try {
    if ((await realpath(dirname(targetPath))) !== dirname(targetPath)) {
      throw new ProjectScaffoldingError(
        "TARGET_PARENT_UNAVAILABLE",
        "The canonical project parent changed before publication",
      );
    }
  } catch (error: unknown) {
    if (error instanceof ProjectScaffoldingError) throw error;
    throw new ProjectScaffoldingError(
      "TARGET_PARENT_UNAVAILABLE",
      "The project parent is no longer available",
      error,
    );
  }
  const existingTarget = await lstatOrNull(targetPath);

  let files: readonly RenderedScaffoldFile[];
  if (existingTarget === null) {
    if (prepared === null) {
      throw new ProjectScaffoldingError("PROPOSAL_CHANGED", "The scaffold proposal cannot be reconstructed");
    }
    try {
      await mkdir(targetPath, { mode: 0o700 });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        throw new ProjectScaffoldingError(
          "TARGET_EXISTS",
          "The project target was created concurrently",
          error,
        );
      }
      throw error;
    }
    await ensureDirectory(join(targetPath, MARKER_DIRECTORY));
    await writeCreateNew(join(targetPath, MARKER_PATH), markerContent(expectedMarker));
    files = prepared.files;
  } else {
    if (!existingTarget.isDirectory() || existingTarget.isSymbolicLink()) {
      throw new ProjectScaffoldingError(
        "TARGET_EXISTS",
        "The project target now exists and is not a directory",
      );
    }
    const existingMarker = await readMarker(targetPath);
    if (!markersEqual(existingMarker, expectedMarker)) {
      throw new ProjectScaffoldingError(
        "MARKER_MISMATCH",
        "The existing project target belongs to another operation",
      );
    }
    const reconstructed = renderPreparedProjectScaffold({
      recipeId: input.proposal.recipeId,
      targetPath,
    });
    if (reconstructed.proposal.proposalDigest !== input.proposal.proposalDigest) {
      throw new ProjectScaffoldingError("PROPOSAL_CHANGED", "The scaffold proposal changed");
    }
    files = reconstructed.files;
  }

  for (const file of files) await verifyOrCreateFile(targetPath, file);

  await assertKnownTree(targetPath, files);
  const gitEnvironment = scaffoldGitEnvironment(targetPath);

  const repositoryBeforeInit = await inspectRepository(targetPath, { env: gitEnvironment });
  if (repositoryBeforeInit === null) {
    const git = await runGit(["-c", "init.templateDir=", "init", "--initial-branch=main"], {
      cwd: targetPath,
      env: gitEnvironment,
    });
    if (git.exitCode !== 0) {
      throw new ProjectScaffoldingError("GIT_INIT_FAILED", "Git could not initialize the new project");
    }
  }

  const repository = await inspectRepository(targetPath, { env: gitEnvironment });
  const canonicalTarget = await realpath(targetPath);
  if (repository === null || (await realpath(repository.topLevel)) !== canonicalTarget) {
    throw new ProjectScaffoldingError(
      "REPOSITORY_INVALID",
      "The published target is not its own Git repository",
    );
  }
  for (const file of files) await verifyOrCreateFile(targetPath, file);
  await assertKnownTree(targetPath, files);
  if (!markersEqual(await readMarker(targetPath), expectedMarker)) {
    throw new ProjectScaffoldingError("MARKER_MISMATCH", "The scaffold marker changed during publication");
  }

  return {
    operationId: input.operationId,
    proposalDigest: input.proposal.proposalDigest,
    repositoryPath: canonicalTarget,
    status: "PUBLISHED",
  };
};
