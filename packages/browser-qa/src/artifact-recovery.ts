import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  qaAttachmentRefSchema,
  qaFinalizedAttachmentSchema,
  type QAAttachmentRef,
  type QAFinalizedAttachment,
} from "@loomrail/contracts";
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

export type BrowserQAArtifactOpenErrorCode =
  "ATTACHMENT_INVALID" | "STORAGE_LAYOUT_INVALID" | "ATTACHMENT_UNAVAILABLE" | "EVIDENCE_MISMATCH";

export class BrowserQAArtifactOpenError extends Error {
  readonly code: BrowserQAArtifactOpenErrorCode;

  constructor(code: BrowserQAArtifactOpenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserQAArtifactOpenError";
    this.code = code;
  }
}

const isSameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;

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

/** Opens the already-verified descriptor; callers stream from this handle without exposing a path. */
export const openVerifiedBrowserQAArtifact = async (input: {
  artifactsDirectory: string;
  attachment: QAAttachmentRef;
}): Promise<FileHandle> => {
  const parsedAttachment = qaAttachmentRefSchema.safeParse(input.attachment);
  if (!parsedAttachment.success) {
    throw new BrowserQAArtifactOpenError("ATTACHMENT_INVALID", "Browser QA attachment metadata is invalid");
  }
  const attachment = parsedAttachment.data;
  const segments = attachment.storageKey.split("/");
  const runStorageSegment = segments[0];
  const filename = segments[1];
  if (
    segments.length !== 2 ||
    runStorageSegment === undefined ||
    filename === undefined ||
    !RUN_STORAGE_SEGMENT.test(runStorageSegment)
  ) {
    throw new BrowserQAArtifactOpenError(
      "STORAGE_LAYOUT_INVALID",
      "Browser QA attachment storage key is outside the managed layout",
    );
  }
  try {
    const qaDirectory = join(input.artifactsDirectory, "qa");
    const runDirectory = join(qaDirectory, runStorageSegment);
    const [canonicalQADirectory, canonicalRunDirectory, directoryMetadata] = await Promise.all([
      realpath(qaDirectory),
      realpath(runDirectory),
      lstat(runDirectory),
    ]);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      canonicalRunDirectory !== join(canonicalQADirectory, runStorageSegment)
    ) {
      throw new BrowserQAArtifactOpenError(
        "STORAGE_LAYOUT_INVALID",
        "Browser QA attachment directory is not a managed directory",
      );
    }

    const path = join(runDirectory, filename);
    const pathMetadata = await lstat(path);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new BrowserQAArtifactOpenError(
        "ATTACHMENT_UNAVAILABLE",
        "Browser QA attachment is not a regular file",
      );
    }
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(path, flags);
    try {
      const [metadata, directoryAfterOpen, pathAfterOpen] = await Promise.all([
        handle.stat(),
        lstat(runDirectory),
        lstat(path),
      ]);
      if (
        !directoryAfterOpen.isDirectory() ||
        directoryAfterOpen.isSymbolicLink() ||
        !isSameFile(directoryMetadata, directoryAfterOpen) ||
        !pathAfterOpen.isFile() ||
        pathAfterOpen.isSymbolicLink() ||
        !isSameFile(pathMetadata, pathAfterOpen) ||
        !isSameFile(pathAfterOpen, metadata)
      ) {
        throw new BrowserQAArtifactOpenError(
          "ATTACHMENT_UNAVAILABLE",
          "Browser QA attachment changed while it was opened",
        );
      }
      if (!metadata.isFile() || metadata.size !== attachment.byteSize) {
        throw new BrowserQAArtifactOpenError(
          "EVIDENCE_MISMATCH",
          "Browser QA attachment size does not match its durable evidence",
        );
      }
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
      if (`sha256:${hash.digest("hex")}` !== attachment.contentHash) {
        throw new BrowserQAArtifactOpenError(
          "EVIDENCE_MISMATCH",
          "Browser QA attachment hash does not match its durable evidence",
        );
      }
      return handle;
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof BrowserQAArtifactOpenError) throw error;
    throw new BrowserQAArtifactOpenError(
      "ATTACHMENT_UNAVAILABLE",
      "Browser QA attachment could not be opened safely",
      { cause: error },
    );
  }
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
