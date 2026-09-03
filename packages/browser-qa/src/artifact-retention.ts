import { constants, type Stats } from "node:fs";
import { lstat, open, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { qaAttachmentRefSchema, type QAAttachmentRef } from "@loomrail/contracts";

import {
  inspectManagedArtifactRoot,
  inspectManagedChildDirectory,
  isSameFile,
  managedDirectoryStillMatches,
  RUN_STORAGE_SEGMENT,
  type ManagedDirectory,
} from "./artifact-layout.js";
import { BROWSER_QA_RECOVERY_MARKER } from "./artifact-recovery.js";

export type BrowserQARetentionAction =
  "DELETED" | "ALREADY_ABSENT" | "SKIPPED_PENDING" | "SKIPPED_UNSAFE" | "FAILED";

export type BrowserQARetentionResult = {
  attachmentId: string;
  storageKey: string;
  action: BrowserQARetentionAction;
};

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const markerIsAbsent = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
};

/**
 * Applies SD-004 only to exact attachment paths selected from durable state.
 *
 * It never recursively removes a directory, follows a symlink, or touches an unlisted entry. An
 * empty managed run directory is removed with `rmdir`; an unknown sibling therefore preserves the
 * directory and itself.
 */
export const deleteExpiredBrowserQAArtifacts = async (input: {
  artifactsDirectory: string;
  attachments: readonly QAAttachmentRef[];
}): Promise<BrowserQARetentionResult[]> => {
  const results: BrowserQARetentionResult[] = [];
  for (const value of input.attachments) {
    const parsed = qaAttachmentRefSchema.safeParse(value);
    const attachmentId = parsed.success ? parsed.data.id : "invalid-attachment";
    const storageKey = parsed.success ? parsed.data.storageKey : "invalid-storage-key";
    const segments = storageKey.split("/");
    const runStorageSegment = segments[0];
    const filename = segments[1];
    if (
      !parsed.success ||
      segments.length !== 2 ||
      runStorageSegment === undefined ||
      filename === undefined ||
      !RUN_STORAGE_SEGMENT.test(runStorageSegment)
    ) {
      results.push({ attachmentId, storageKey, action: "SKIPPED_UNSAFE" });
      continue;
    }

    let artifactsRoot: ManagedDirectory;
    let qaDirectory: ManagedDirectory;
    let runDirectory: ManagedDirectory;
    try {
      artifactsRoot = await inspectManagedArtifactRoot(input.artifactsDirectory);
      qaDirectory = await inspectManagedChildDirectory(artifactsRoot, "qa");
      runDirectory = await inspectManagedChildDirectory(qaDirectory, runStorageSegment);
    } catch (error: unknown) {
      results.push({
        attachmentId,
        storageKey,
        action: hasCode(error, "ENOENT") ? "ALREADY_ABSENT" : "SKIPPED_UNSAFE",
      });
      continue;
    }

    const managedRootsStillMatch = (): Promise<boolean> =>
      Promise.all([
        managedDirectoryStillMatches(artifactsRoot),
        managedDirectoryStillMatches(qaDirectory),
        managedDirectoryStillMatches(runDirectory),
      ]).then((matches) => matches.every(Boolean));
    const markerPath = join(runDirectory.path, BROWSER_QA_RECOVERY_MARKER);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (!(await markerIsAbsent(markerPath))) {
        results.push({ attachmentId, storageKey, action: "SKIPPED_PENDING" });
        continue;
      }

      const path = join(runDirectory.path, filename);
      let pathMetadata: Stats;
      try {
        pathMetadata = await lstat(path);
      } catch (error: unknown) {
        if (hasCode(error, "ENOENT")) {
          results.push({ attachmentId, storageKey, action: "ALREADY_ABSENT" });
          continue;
        }
        throw error;
      }
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
        results.push({ attachmentId, storageKey, action: "SKIPPED_UNSAFE" });
        continue;
      }

      const flags =
        process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
      handle = await open(path, flags);
      const openedMetadata = await handle.stat();
      const pathAfterOpen = await lstat(path);
      if (
        !openedMetadata.isFile() ||
        !pathAfterOpen.isFile() ||
        pathAfterOpen.isSymbolicLink() ||
        !isSameFile(pathMetadata, pathAfterOpen) ||
        !isSameFile(pathAfterOpen, openedMetadata) ||
        !(await managedRootsStillMatch())
      ) {
        results.push({ attachmentId, storageKey, action: "SKIPPED_UNSAFE" });
        continue;
      }

      if (process.platform === "win32") {
        await handle.close();
        handle = undefined;
        const finalMetadata = await lstat(path);
        if (
          !finalMetadata.isFile() ||
          finalMetadata.isSymbolicLink() ||
          !isSameFile(pathMetadata, finalMetadata)
        ) {
          results.push({ attachmentId, storageKey, action: "SKIPPED_UNSAFE" });
          continue;
        }
      }
      if (!(await managedRootsStillMatch())) {
        results.push({ attachmentId, storageKey, action: "SKIPPED_UNSAFE" });
        continue;
      }
      if (!(await markerIsAbsent(markerPath))) {
        results.push({ attachmentId, storageKey, action: "SKIPPED_PENDING" });
        continue;
      }
      await unlink(path);
      results.push({ attachmentId, storageKey, action: "DELETED" });
      if (await managedRootsStillMatch()) {
        await rmdir(runDirectory.path).catch(() => undefined);
      }
    } catch (error: unknown) {
      results.push({
        attachmentId,
        storageKey,
        action: hasCode(error, "ENOENT") ? "ALREADY_ABSENT" : "FAILED",
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return results;
};
