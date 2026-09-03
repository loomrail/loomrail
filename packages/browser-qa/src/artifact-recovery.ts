import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  qaAttachmentRefSchema,
  qaFinalizedAttachmentSchema,
  type QAAttachmentRef,
  type QAFinalizedAttachment,
} from "@loomrail/contracts";
import { z } from "zod";

import {
  ensureManagedArtifactRoot,
  ensureManagedChildDirectory,
  inspectManagedArtifactRoot,
  inspectManagedChildDirectory,
  isSameFile,
  managedDirectoryStillMatches,
  RUN_STORAGE_SEGMENT,
  type ManagedDirectory,
} from "./artifact-layout.js";

export const BROWSER_QA_RECOVERY_MARKER = ".loomrail-pending.json";
const MAX_RECOVERY_MARKER_BYTES = 128 * 1_024;
const MAX_RECOVERY_DIRECTORY_ENTRIES = 10_000;

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

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

export class BrowserQAArtifactRecoveryError extends Error {
  readonly code = "RECOVERY_SCAN_FAILED";

  constructor(cause: unknown) {
    super("Browser QA artifact recovery could not inspect the managed storage safely.", { cause });
    this.name = "BrowserQAArtifactRecoveryError";
  }
}

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

const readBoundedMarker = async (path: string): Promise<BrowserQARecoveryMarker> => {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECOVERY_MARKER_BYTES) {
    throw new Error("Browser QA recovery marker is not a bounded regular file");
  }
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !isSameFile(before, after) ||
      !isSameFile(after, opened)
    ) {
      throw new Error("Browser QA recovery marker changed while it was opened");
    }
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
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedSize) return false;
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(path, flags);
    try {
      const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
      if (
        !opened.isFile() ||
        !after.isFile() ||
        after.isSymbolicLink() ||
        !isSameFile(before, after) ||
        !isSameFile(after, opened)
      ) {
        return false;
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
  artifactsRoot: ManagedDirectory,
  qaRoot: ManagedDirectory,
  runDirectory: ManagedDirectory,
  runStorageSegment: string,
): Promise<void> => {
  const quarantineRoot = await ensureManagedChildDirectory(artifactsRoot, ".quarantine");
  const orphanRoot = await ensureManagedChildDirectory(quarantineRoot, "orphaned");
  if (
    !(await managedDirectoryStillMatches(artifactsRoot)) ||
    !(await managedDirectoryStillMatches(qaRoot)) ||
    !(await managedDirectoryStillMatches(runDirectory)) ||
    !(await managedDirectoryStillMatches(orphanRoot))
  ) {
    throw new Error("Browser QA managed storage changed before quarantine");
  }
  const orphanName = `${runStorageSegment}-${randomUUID()}`;
  await rename(runDirectory.path, join(orphanRoot.path, orphanName));
  const moved = await inspectManagedChildDirectory(orphanRoot, orphanName);
  if (!isSameFile(moved.metadata, runDirectory.metadata)) {
    throw new Error("Browser QA quarantine moved a different directory");
  }
};

const readBoundedDirectoryEntries = async (path: string): Promise<Dirent[]> => {
  const entries: Dirent[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (entries.length >= MAX_RECOVERY_DIRECTORY_ENTRIES) {
      throw new Error("Browser QA recovery directory exceeds its entry limit");
    }
    entries.push(entry);
  }
  return entries;
};

const inspectQuarantineRun = async (input: {
  artifactsDirectory: string;
  quarantineDirectory: string;
  runStorageSegment: string;
}): Promise<{
  artifactsRoot: ManagedDirectory;
  quarantineRoot: ManagedDirectory;
  runDirectory: ManagedDirectory;
}> => {
  if (!RUN_STORAGE_SEGMENT.test(input.runStorageSegment)) {
    throw new Error("Browser QA run storage segment is invalid");
  }
  const artifactsRoot = await ensureManagedArtifactRoot(input.artifactsDirectory);
  const quarantineRoot = await ensureManagedChildDirectory(artifactsRoot, ".quarantine");
  const runName = basename(input.quarantineDirectory);
  if (
    dirname(input.quarantineDirectory) !== quarantineRoot.path ||
    !runName.startsWith(`${input.runStorageSegment}-`)
  ) {
    throw new Error("Browser QA quarantine run is outside the managed quarantine root");
  }
  const runDirectory = await inspectManagedChildDirectory(quarantineRoot, runName);
  return { artifactsRoot, quarantineRoot, runDirectory };
};

export const createBrowserQAQuarantineDirectory = async (input: {
  artifactsDirectory: string;
  runStorageSegment: string;
}): Promise<string> => {
  if (!RUN_STORAGE_SEGMENT.test(input.runStorageSegment)) {
    throw new Error("Browser QA run storage segment is invalid");
  }
  const artifactsRoot = await ensureManagedArtifactRoot(input.artifactsDirectory);
  const quarantineRoot = await ensureManagedChildDirectory(artifactsRoot, ".quarantine");
  const path = await mkdtemp(join(quarantineRoot.path, `${input.runStorageSegment}-`));
  const runDirectory = await inspectManagedChildDirectory(quarantineRoot, basename(path));
  if (
    !(await managedDirectoryStillMatches(artifactsRoot)) ||
    !(await managedDirectoryStillMatches(runDirectory))
  ) {
    throw new Error("Browser QA quarantine storage changed during setup");
  }
  return path;
};

export const disposeBrowserQAQuarantineDirectory = async (input: {
  artifactsDirectory: string;
  quarantineDirectory: string;
  runStorageSegment: string;
}): Promise<void> => {
  const { artifactsRoot, quarantineRoot, runDirectory } = await inspectQuarantineRun(input);
  if (
    !(await managedDirectoryStillMatches(artifactsRoot)) ||
    !(await managedDirectoryStillMatches(quarantineRoot)) ||
    !(await managedDirectoryStillMatches(runDirectory))
  ) {
    throw new Error("Browser QA quarantine storage changed before disposal");
  }
  await rm(runDirectory.path, { recursive: true, force: false });
};

export const stageBrowserQAArtifacts = async (input: {
  artifactsDirectory: string;
  quarantineDirectory: string;
  runStorageSegment: string;
  qaRunId: string;
  attachments: readonly QAFinalizedAttachment[];
}): Promise<void> => {
  const { artifactsRoot, quarantineRoot, runDirectory } = await inspectQuarantineRun(input);
  const marker = recoveryMarkerSchema.parse({
    schemaVersion: 1,
    qaRunId: input.qaRunId,
    attachments: input.attachments,
  });
  const prefix = `${input.runStorageSegment}/`;
  if (marker.attachments.some(({ ref }) => !ref.storageKey.startsWith(prefix))) {
    throw new Error("Browser QA attachment points outside its quarantined run");
  }
  const markerPath = join(runDirectory.path, BROWSER_QA_RECOVERY_MARKER);
  await writeFile(markerPath, JSON.stringify(marker), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await readBoundedMarker(markerPath);
  const finalRoot = await ensureManagedChildDirectory(artifactsRoot, "qa");
  if (
    !(await managedDirectoryStillMatches(artifactsRoot)) ||
    !(await managedDirectoryStillMatches(quarantineRoot)) ||
    !(await managedDirectoryStillMatches(runDirectory)) ||
    !(await managedDirectoryStillMatches(finalRoot))
  ) {
    throw new Error("Browser QA managed storage changed before finalization");
  }
  await rename(runDirectory.path, join(finalRoot.path, input.runStorageSegment));
  const finalizedRun = await inspectManagedChildDirectory(finalRoot, input.runStorageSegment);
  if (!isSameFile(finalizedRun.metadata, runDirectory.metadata)) {
    throw new Error("Browser QA finalization moved a different directory");
  }
};

export const confirmBrowserQAArtifacts = async (input: {
  artifactsDirectory: string;
  runStorageSegment: string;
}): Promise<void> => {
  if (!RUN_STORAGE_SEGMENT.test(input.runStorageSegment)) {
    throw new Error("Browser QA run storage segment is invalid");
  }
  const artifactsRoot = await inspectManagedArtifactRoot(input.artifactsDirectory);
  const qaRoot = await inspectManagedChildDirectory(artifactsRoot, "qa");
  const runDirectory = await inspectManagedChildDirectory(qaRoot, input.runStorageSegment);
  const markerPath = join(runDirectory.path, BROWSER_QA_RECOVERY_MARKER);
  const markerBefore = await lstat(markerPath);
  if (!markerBefore.isFile() || markerBefore.isSymbolicLink()) {
    throw new Error("Browser QA recovery marker is not a regular file");
  }
  await readBoundedMarker(markerPath);
  const markerAfter = await lstat(markerPath);
  if (
    !markerAfter.isFile() ||
    markerAfter.isSymbolicLink() ||
    !isSameFile(markerBefore, markerAfter) ||
    !(await managedDirectoryStillMatches(artifactsRoot)) ||
    !(await managedDirectoryStillMatches(qaRoot)) ||
    !(await managedDirectoryStillMatches(runDirectory))
  ) {
    throw new Error("Browser QA confirmation target changed before mutation");
  }
  await unlink(markerPath);
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
    let artifactsRoot: ManagedDirectory;
    let qaDirectory: ManagedDirectory;
    let runDirectory: ManagedDirectory;
    try {
      artifactsRoot = await inspectManagedArtifactRoot(input.artifactsDirectory);
      qaDirectory = await inspectManagedChildDirectory(artifactsRoot, "qa");
      runDirectory = await inspectManagedChildDirectory(qaDirectory, runStorageSegment);
    } catch (error: unknown) {
      throw new BrowserQAArtifactOpenError(
        "STORAGE_LAYOUT_INVALID",
        "Browser QA attachment directory is not a managed directory",
        { cause: error },
      );
    }

    const path = join(runDirectory.path, filename);
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
      const [metadata, pathAfterOpen] = await Promise.all([handle.stat(), lstat(path)]);
      if (
        !(await managedDirectoryStillMatches(artifactsRoot)) ||
        !(await managedDirectoryStillMatches(qaDirectory)) ||
        !(await managedDirectoryStillMatches(runDirectory)) ||
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
  let artifactsRoot: ManagedDirectory;
  let finalRoot: ManagedDirectory;
  let entries: Dirent[];
  try {
    artifactsRoot = await inspectManagedArtifactRoot(input.artifactsDirectory);
    finalRoot = await inspectManagedChildDirectory(artifactsRoot, "qa");
    entries = await readBoundedDirectoryEntries(finalRoot.path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      try {
        const rootMetadata = await lstat(input.artifactsDirectory);
        if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw error;
        const qaPath = join(input.artifactsDirectory, "qa");
        try {
          await lstat(qaPath);
        } catch (qaError: unknown) {
          if (hasCode(qaError, "ENOENT")) return [];
          throw qaError;
        }
      } catch (artifactsError: unknown) {
        if (hasCode(artifactsError, "ENOENT")) return [];
        throw new BrowserQAArtifactRecoveryError(artifactsError);
      }
    }
    throw new BrowserQAArtifactRecoveryError(error);
  }

  const recoveries: BrowserQAArtifactRecovery[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_STORAGE_SEGMENT.test(entry.name)) continue;
    let directory: ManagedDirectory;
    try {
      directory = await inspectManagedChildDirectory(finalRoot, entry.name);
    } catch {
      continue;
    }
    const managedRootsStillMatch = (): Promise<boolean> =>
      Promise.all([
        managedDirectoryStillMatches(artifactsRoot),
        managedDirectoryStillMatches(finalRoot),
        managedDirectoryStillMatches(directory),
      ]).then((matches) => matches.every(Boolean));
    const markerPath = join(directory.path, BROWSER_QA_RECOVERY_MARKER);
    let marker: BrowserQARecoveryMarker;
    try {
      marker = await readBoundedMarker(markerPath);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) continue;
      try {
        if (!(await managedRootsStillMatch())) {
          recoveries.push({ qaRunId: null, runStorageSegment: entry.name, action: "LEFT_PENDING" });
          continue;
        }
        await quarantine(artifactsRoot, finalRoot, directory, entry.name);
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

    if (committed && (await markerFilesMatch(directory.path, entry.name, marker))) {
      try {
        if (!(await managedRootsStillMatch())) {
          recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "LEFT_PENDING" });
          continue;
        }
        await unlink(markerPath);
        recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "CONFIRMED" });
      } catch {
        recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "LEFT_PENDING" });
      }
      continue;
    }

    try {
      if (!(await managedRootsStillMatch())) {
        recoveries.push({ qaRunId: marker.qaRunId, runStorageSegment: entry.name, action: "LEFT_PENDING" });
        continue;
      }
      await quarantine(artifactsRoot, finalRoot, directory, entry.name);
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
