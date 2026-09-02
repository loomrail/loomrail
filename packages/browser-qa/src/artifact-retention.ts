import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { qaAttachmentRefSchema, type QAAttachmentRef } from "@loomrail/contracts";

import { BROWSER_QA_RECOVERY_MARKER } from "./artifact-recovery.js";

const RUN_STORAGE_SEGMENT = /^run-[0-9a-f]{32}$/;

export type BrowserQARetentionAction =
  "DELETED" | "ALREADY_ABSENT" | "SKIPPED_PENDING" | "SKIPPED_UNSAFE" | "FAILED";

export type BrowserQARetentionResult = {
  attachmentId: string;
  storageKey: string;
  action: BrowserQARetentionAction;
};

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const isSameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;

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

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const qaDirectory = join(input.artifactsDirectory, "qa");
      const runDirectory = join(qaDirectory, runStorageSegment);
      const [
        canonicalArtifactsDirectory,
        canonicalQADirectory,
        canonicalRunDirectory,
        qaMetadata,
        runMetadata,
      ] = await Promise.all([
        realpath(input.artifactsDirectory),
        realpath(qaDirectory),
        realpath(runDirectory),
        lstat(qaDirectory),
        lstat(runDirectory),
      ]);
      if (
        !qaMetadata.isDirectory() ||
        qaMetadata.isSymbolicLink() ||
        canonicalQADirectory !== join(canonicalArtifactsDirectory, "qa") ||
        !runMetadata.isDirectory() ||
        runMetadata.isSymbolicLink() ||
        canonicalRunDirectory !== join(canonicalQADirectory, runStorageSegment)
      ) {
        results.push({ attachmentId, storageKey, action: "SKIPPED_UNSAFE" });
        continue;
      }
      if (!(await markerIsAbsent(join(runDirectory, BROWSER_QA_RECOVERY_MARKER)))) {
        results.push({ attachmentId, storageKey, action: "SKIPPED_PENDING" });
        continue;
      }

      const path = join(runDirectory, filename);
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
        !isSameFile(pathAfterOpen, openedMetadata)
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
      await unlink(path);
      results.push({ attachmentId, storageKey, action: "DELETED" });
      await rmdir(runDirectory).catch(() => undefined);
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
