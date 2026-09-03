import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export const RUN_STORAGE_SEGMENT = /^run-[0-9a-f]{32}$/;

export const isSameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export type ManagedDirectory = {
  path: string;
  canonicalPath: string;
  metadata: Stats;
};

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

/**
 * Reads one directory without accepting a symlink or an identity swap between metadata reads.
 * `expectedCanonicalPath` binds a child to the already-verified canonical parent.
 */
export const inspectManagedDirectory = async (
  path: string,
  expectedCanonicalPath?: string,
): Promise<ManagedDirectory> => {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Browser QA managed storage contains a non-directory or symbolic link");
  }
  const canonicalPath = await realpath(path);
  const after = await lstat(path);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !isSameFile(before, after) ||
    (expectedCanonicalPath !== undefined && canonicalPath !== expectedCanonicalPath)
  ) {
    throw new Error("Browser QA managed storage changed or escaped its canonical parent");
  }
  return { path, canonicalPath, metadata: after };
};

export const managedDirectoryStillMatches = async (directory: ManagedDirectory): Promise<boolean> => {
  try {
    const current = await inspectManagedDirectory(directory.path, directory.canonicalPath);
    return isSameFile(current.metadata, directory.metadata);
  } catch {
    return false;
  }
};

export const ensureManagedArtifactRoot = async (artifactsDirectory: string): Promise<ManagedDirectory> => {
  await mkdir(artifactsDirectory, { recursive: true });
  return inspectManagedDirectory(artifactsDirectory);
};

export const inspectManagedArtifactRoot = (artifactsDirectory: string): Promise<ManagedDirectory> =>
  inspectManagedDirectory(artifactsDirectory);

export const ensureManagedChildDirectory = async (
  parent: ManagedDirectory,
  child: string,
): Promise<ManagedDirectory> => {
  if (!(await managedDirectoryStillMatches(parent))) {
    throw new Error("Browser QA managed parent changed before creating a child");
  }
  const path = join(parent.path, child);
  try {
    await mkdir(path);
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const directory = await inspectManagedDirectory(path, join(parent.canonicalPath, child));
  if (!(await managedDirectoryStillMatches(parent))) {
    throw new Error("Browser QA managed parent changed while creating a child");
  }
  return directory;
};

export const inspectManagedChildDirectory = async (
  parent: ManagedDirectory,
  child: string,
): Promise<ManagedDirectory> => {
  if (!(await managedDirectoryStillMatches(parent))) {
    throw new Error("Browser QA managed parent changed before reading a child");
  }
  const directory = await inspectManagedDirectory(
    join(parent.path, child),
    join(parent.canonicalPath, child),
  );
  if (!(await managedDirectoryStillMatches(parent))) {
    throw new Error("Browser QA managed parent changed while reading a child");
  }
  return directory;
};
