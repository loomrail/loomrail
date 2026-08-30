import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";

import type { ConstitutionPublicationErrorCode } from "@loomrail/contracts";
import { inspectRepository } from "@loomrail/workspace";

const TARGET_DIRECTORY = ".loomrail";
const TARGET_FILENAME = "constitution.md";
const MAX_TARGET_BYTES = 512 * 1024;

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const samePath = (left: string, right: string): boolean => {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

export class ConstitutionPublicationError extends Error {
  readonly code: ConstitutionPublicationErrorCode;

  constructor(code: ConstitutionPublicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConstitutionPublicationError";
    this.code = code;
  }
}

const currentTargetDigest = async (targetPath: string): Promise<string | null> => {
  try {
    const metadata = await lstat(targetPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ConstitutionPublicationError(
        "CONSTITUTION_TARGET_OUTSIDE_REPOSITORY",
        "The Constitution target is not a regular repository file",
      );
    }
    if (metadata.size > MAX_TARGET_BYTES) {
      throw new ConstitutionPublicationError(
        "CONSTITUTION_TARGET_UNREADABLE",
        "The existing Constitution exceeds the bounded comparison size",
      );
    }
    return digest(await readFile(targetPath));
  } catch (error: unknown) {
    if (error instanceof ConstitutionPublicationError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new ConstitutionPublicationError(
      "CONSTITUTION_TARGET_UNREADABLE",
      "The Constitution target could not be read safely",
      { cause: error },
    );
  }
};

export const publishProjectConstitution = async (input: {
  repositoryPath: string;
  expectedTargetDigest: string | null;
  renderedMarkdown: string;
  contentDigest: string;
}): Promise<void> => {
  if (digest(input.renderedMarkdown) !== input.contentDigest) {
    throw new ConstitutionPublicationError(
      "CONSTITUTION_WRITE_FAILED",
      "The approved Constitution content does not match its recorded digest",
    );
  }
  const [canonicalInput, repository] = await Promise.all([
    realpath(input.repositoryPath).catch(() => null),
    inspectRepository(input.repositoryPath),
  ]);
  if (canonicalInput === null || repository === null || !samePath(repository.topLevel, canonicalInput)) {
    throw new ConstitutionPublicationError(
      "REPOSITORY_UNAVAILABLE",
      "The Project repository is no longer available at its registered top-level path",
    );
  }

  const directoryPath = join(repository.topLevel, TARGET_DIRECTORY);
  const targetPath = join(directoryPath, TARGET_FILENAME);
  try {
    const directory = await lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new ConstitutionPublicationError(
        "CONSTITUTION_TARGET_OUTSIDE_REPOSITORY",
        "The .loomrail target is not a regular directory inside the repository",
      );
    }
  } catch (error: unknown) {
    if (error instanceof ConstitutionPublicationError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(directoryPath, { recursive: false });
    } else {
      throw new ConstitutionPublicationError(
        "CONSTITUTION_TARGET_UNREADABLE",
        "The .loomrail target directory could not be inspected",
        { cause: error },
      );
    }
  }

  const currentDigest = await currentTargetDigest(targetPath);
  // Crash recovery: the file may already have landed before the completion command committed.
  if (currentDigest === input.contentDigest) return;
  if (currentDigest !== input.expectedTargetDigest) {
    throw new ConstitutionPublicationError(
      "CONSTITUTION_TARGET_CHANGED",
      "The Constitution file changed after the proposal was reviewed",
    );
  }

  const temporaryPath = join(directoryPath, `.constitution-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, input.renderedMarkdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new ConstitutionPublicationError(
      "CONSTITUTION_WRITE_FAILED",
      "The approved Constitution could not be written atomically",
      { cause: error },
    );
  }
};
