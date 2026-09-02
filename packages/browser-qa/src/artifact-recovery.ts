import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { qaFinalizedAttachmentSchema, type QAFinalizedAttachment } from "@loomrail/contracts";
import { z } from "zod";

export const BROWSER_QA_RECOVERY_MARKER = ".loomrail-pending.json";
const MAX_RECOVERY_MARKER_BYTES = 128 * 1_024;
const RUN_STORAGE_SEGMENT = /^run-[0-9a-f]{32}$/;

const recoveryMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    qaRunId: z.string().trim().min(1).max(200),
    attachments: z.array(qaFinalizedAttachmentSchema).max(50),
  })
  .strict();

export type BrowserQARecoveryMarker = z.infer<typeof recoveryMarkerSchema>;

export type BrowserQAArtifactRecovery = {
  qaRunId: string | null;
  runStorageSegment: string;
  action: "CONFIRMED" | "QUARANTINED_ORPHAN" | "QUARANTINED_INVALID" | "LEFT_PENDING";
};

const readBoundedMarker = async (path: string): Promise<BrowserQARecoveryMarker> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECOVERY_MARKER_BYTES) {
    throw new Error("Browser QA recovery marker is not a bounded regular file");
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_RECOVERY_MARKER_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_RECOVERY_MARKER_BYTES) {
      throw new Error("Browser QA recovery marker exceeds its size limit");
    }
    return recoveryMarkerSchema.parse(JSON.parse(buffer.subarray(0, offset).toString("utf8")));
  } finally {
    await handle.close();
  }
};

const fileMatches = async (path: string, expectedHash: string, expectedSize: number): Promise<boolean> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedSize) return false;
    const handle = await open(path, "r");
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1_024);
      let position = 0;
      let bytesRead = buffer.length;
      while (bytesRead > 0) {
        ({ bytesRead } = await handle.read(buffer, 0, buffer.length, position));
        if (bytesRead > 0) {
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
      }
      return `sha256:${hash.digest("hex")}` === expectedHash;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

const markerFilesMatch = async (
  directory: string,
  runStorageSegment: string,
  marker: BrowserQARecoveryMarker,
): Promise<boolean> =>
  (
    await Promise.all(
      marker.attachments.map(({ ref }) => {
        const prefix = `${runStorageSegment}/`;
        if (!ref.storageKey.startsWith(prefix)) return Promise.resolve(false);
        return fileMatches(
          join(directory, ref.storageKey.slice(prefix.length)),
          ref.contentHash,
          ref.byteSize,
        );
      }),
    )
  ).every(Boolean);

const quarantine = async (
  artifactsDirectory: string,
  qaDirectory: string,
  runStorageSegment: string,
): Promise<void> => {
  const orphanRoot = join(artifactsDirectory, ".quarantine", "orphaned");
  await mkdir(orphanRoot, { recursive: true });
  await rename(qaDirectory, join(orphanRoot, `${runStorageSegment}-${randomUUID()}`));
};

export const stageBrowserQAArtifacts = async (input: {
  artifactsDirectory: string;
  quarantineDirectory: string;
  runStorageSegment: string;
  qaRunId: string;
  attachments: readonly QAFinalizedAttachment[];
}): Promise<void> => {
  const marker = recoveryMarkerSchema.parse({
    schemaVersion: 1,
    qaRunId: input.qaRunId,
    attachments: input.attachments,
  });
  await writeFile(join(input.quarantineDirectory, BROWSER_QA_RECOVERY_MARKER), JSON.stringify(marker), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const finalRoot = join(input.artifactsDirectory, "qa");
  await mkdir(finalRoot, { recursive: true });
  await rename(input.quarantineDirectory, join(finalRoot, input.runStorageSegment));
};

export const confirmBrowserQAArtifacts = async (input: {
  artifactsDirectory: string;
  runStorageSegment: string;
}): Promise<void> => {
  await unlink(join(input.artifactsDirectory, "qa", input.runStorageSegment, BROWSER_QA_RECOVERY_MARKER));
};

/**
 * Reconciles only marker-bound directories. A directory without the marker was already confirmed;
 * unknown files and directories are never deleted or adopted.
 */
export const recoverBrowserQAArtifacts = async (input: {
  artifactsDirectory: string;
  isCommitted: (marker: BrowserQARecoveryMarker) => boolean;
}): Promise<BrowserQAArtifactRecovery[]> => {
  const finalRoot = join(input.artifactsDirectory, "qa");
  let entries;
  try {
    entries = await readdir(finalRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const recoveries: BrowserQAArtifactRecovery[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_STORAGE_SEGMENT.test(entry.name)) continue;
    const directory = join(finalRoot, entry.name);
    const markerPath = join(directory, BROWSER_QA_RECOVERY_MARKER);
    let marker: BrowserQARecoveryMarker;
    try {
      marker = await readBoundedMarker(markerPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      try {
        await quarantine(input.artifactsDirectory, directory, entry.name);
        recoveries.push({ qaRunId: null, runStorageSegment: entry.name, action: "QUARANTINED_INVALID" });
      } catch {
        recoveries.push({ qaRunId: null, runStorageSegment: entry.name, action: "LEFT_PENDING" });
      }
      continue;
    }

    let committed: boolean;
    try {
      committed = input.isCommitted(marker);
    } catch {
      recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "LEFT_PENDING" });
      continue;
    }

    if (committed && (await markerFilesMatch(directory, entry.name, marker))) {
      try {
        await unlink(markerPath);
        recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "CONFIRMED" });
      } catch {
        recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "LEFT_PENDING" });
      }
      continue;
    }

    try {
      await quarantine(input.artifactsDirectory, directory, entry.name);
      recoveries.push({
        qaRunId: marker.qaRunId,
        runStorageSegment: entry.name,
        action: committed ? "QUARANTINED_INVALID" : "QUARANTINED_ORPHAN",
      });
    } catch {
      recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "LEFT_PENDING" });
    }
  }
  return recoveries;
};
