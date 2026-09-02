import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

export const LOCAL_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const LOCAL_LOG_ROTATION_MS = 24 * 60 * 60 * 1_000;
export const LOCAL_LOG_MAINTENANCE_MS = 60 * 60 * 1_000;
export const LOCAL_LOG_SEGMENT_BYTES = 2 * 1_024 * 1_024;
export const LOCAL_LOG_TOTAL_BYTES = 16 * 1_024 * 1_024;
export const LOCAL_LOG_LINE_BYTES = 16 * 1_024;

const rawLineBytes = 4 * LOCAL_LOG_LINE_BYTES;
const maxOwnedSegments = 4_096;
const lockFilename = ".writer.lock";
const segmentFilenamePattern = /^daemon-\d{17}-\d{1,10}-[a-f0-9]{16}-\d{4}\.ndjson$/;
const lockTokenPattern = /^[a-f0-9]{32}$/;

export type LocalLogErrorCode =
  "LOG_DIRECTORY_INVALID" | "LOG_FILE_INVALID" | "LOG_IO_FAILED" | "LOG_LOCK_INVALID" | "LOG_WRITER_ACTIVE";

export class LocalLogError extends Error {
  readonly code: LocalLogErrorCode;

  constructor(code: LocalLogErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalLogError";
    this.code = code;
  }
}

export type LocalLogLimits = {
  retentionMs: number;
  rotationMs: number;
  maintenanceMs: number;
  segmentBytes: number;
  totalBytes: number;
  lineBytes: number;
};

export type LocalLogOptions = {
  now?: () => Date;
  processId?: number;
  writerId?: string;
  isProcessAlive?: (processId: number) => boolean;
  limits?: Partial<LocalLogLimits>;
};

type OwnedSegment = {
  name: string;
  path: string;
  size: number;
  modifiedAtMs: number;
};

export type LocalLogCleanup = {
  expiredFiles: number;
  capacityFiles: number;
  deletedBytes: number;
};

export type LocalLogExport = {
  ndjson: string;
  files: number;
  entries: number;
  bytes: number;
};

export type LocalLogDeletion = {
  files: number;
  bytes: number;
};

export type LocalLogWriter = {
  stream: Writable;
  initialCleanup: LocalLogCleanup;
  failed: Promise<LocalLogError>;
  maintain: () => Promise<LocalLogCleanup>;
  close: () => Promise<void>;
};

const safeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LocalLogError("LOG_FILE_INVALID", `The local log ${label} is invalid.`);
  }
  return value;
};

const resolveLimits = (overrides: Partial<LocalLogLimits> = {}): LocalLogLimits => {
  const limits = {
    retentionMs: overrides.retentionMs ?? LOCAL_LOG_RETENTION_MS,
    rotationMs: overrides.rotationMs ?? LOCAL_LOG_ROTATION_MS,
    maintenanceMs: overrides.maintenanceMs ?? LOCAL_LOG_MAINTENANCE_MS,
    segmentBytes: overrides.segmentBytes ?? LOCAL_LOG_SEGMENT_BYTES,
    totalBytes: overrides.totalBytes ?? LOCAL_LOG_TOTAL_BYTES,
    lineBytes: overrides.lineBytes ?? LOCAL_LOG_LINE_BYTES,
  };
  Object.entries(limits).forEach(([label, value]) => safeInteger(value, label));
  if (limits.lineBytes > limits.segmentBytes || limits.segmentBytes > limits.totalBytes) {
    throw new LocalLogError("LOG_FILE_INVALID", "The local log byte limits are inconsistent.");
  }
  return limits;
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const typedFailure = (error: unknown, message: string): LocalLogError =>
  error instanceof LocalLogError ? error : new LocalLogError("LOG_IO_FAILED", message, { cause: error });

const hasOwnerOnlyPermissions = (mode: number): boolean =>
  process.platform === "win32" || (mode & 0o077) === 0;

const stripUnsafeControlCharacters = (value: string): string => {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13 || (codePoint >= 32 && codePoint !== 127)) {
      result += character;
    }
  }
  return result;
};

export const redactOperationalText = (value: string, maxBytes = 1_000): string => {
  const redacted = stripUnsafeControlCharacters(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|cookie|csrf)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'`]+/gu, "[REDACTED_PATH]")
    .replace(/\\\\[^\s<>"'`]+/gu, "[REDACTED_PATH]")
    .replace(/(?:file:\/\/)?\/(?:Users|home|private|tmp|var\/folders)\/[^\s<>"'`]+/gu, "[REDACTED_PATH]")
    .replace(/(^|[\s("'`=])\/(?!\/)[^\s<>"'`]+/gmu, "$1[REDACTED_PATH]")
    .replace(/\b[A-Za-z0-9_-]{40,}={0,2}\b/g, "[REDACTED_TOKEN]")
    .trim();
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  let shortened = "";
  for (const character of redacted) {
    if (Buffer.byteLength(`${shortened}${character}…`, "utf8") > maxBytes) break;
    shortened += character;
  }
  return `${shortened}…`;
};

const allowedTopLevelFields = new Set([
  "accepted",
  "action",
  "agentRunId",
  "attachmentId",
  "budgetTokens",
  "carriedPaths",
  "cliAvailable",
  "code",
  "correlationId",
  "costUsd",
  "deadlineMs",
  "dispatchId",
  "error",
  "errorCode",
  "errorName",
  "inputTokens",
  "limit",
  "maxSessions",
  "operationId",
  "outcome",
  "outputTokens",
  "pid",
  "projectId",
  "provider",
  "providerSessionId",
  "publicationId",
  "qaRunId",
  "reason",
  "recorded",
  "redactedFields",
  "removed",
  "requiredBytes",
  "selected",
  "serverPid",
  "sessionOrdinal",
  "skipped",
  "stage",
  "stageAttemptId",
  "state",
  "status",
  "usedTokens",
  "workspaceId",
  "workItemId",
]);

const safePrimitive = (value: unknown, maxBytes: number): string | number | boolean | null | undefined => {
  if (typeof value === "string") return redactOperationalText(value, maxBytes);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
};

const safeArray = (value: unknown[], maxBytes: number): readonly (string | number | boolean | null)[] =>
  value
    .slice(0, 16)
    .map((entry) => safePrimitive(entry, maxBytes))
    .filter((entry): entry is string | number | boolean | null => entry !== undefined);

const plainObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const safeRequest = (value: unknown, maxBytes: number): Record<string, unknown> | undefined => {
  const request = plainObject(value);
  if (request === null) return undefined;
  const result: Record<string, unknown> = {};
  if (typeof request["method"] === "string") {
    result["method"] = redactOperationalText(request["method"], 16);
  }
  if (typeof request["url"] === "string") {
    try {
      result["url"] = new URL(request["url"], "http://127.0.0.1").pathname.slice(0, 500);
    } catch {
      result["url"] = "[INVALID_URL]";
    }
  }
  if (typeof request["id"] === "string") {
    result["id"] = redactOperationalText(request["id"], maxBytes);
  }
  return Object.keys(result).length === 0 ? undefined : result;
};

const safeResponse = (value: unknown): Record<string, unknown> | undefined => {
  const response = plainObject(value);
  if (response === null || !Number.isInteger(response["statusCode"])) return undefined;
  return { statusCode: response["statusCode"] };
};

const safeError = (value: unknown, maxBytes: number): Record<string, unknown> | undefined => {
  const error = plainObject(value);
  if (error === null) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["type", "name", "code", "message"] as const) {
    if (typeof error[key] === "string") result[key] = redactOperationalText(error[key], maxBytes);
  }
  return Object.keys(result).length === 0 ? undefined : result;
};

const droppedLine = (now: Date): Record<string, unknown> => ({
  schemaVersion: 1,
  time: now.getTime(),
  level: 40,
  component: "daemon",
  code: "LOG_LINE_DROPPED",
  msg: "A malformed or oversized operational log record was dropped before persistence.",
});

const sanitizedObject = (
  parsed: Record<string, unknown>,
  now: Date,
  lineBytes: number,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    time:
      Number.isSafeInteger(parsed["time"]) && Number(parsed["time"]) >= 0 ? parsed["time"] : now.getTime(),
    level:
      Number.isInteger(parsed["level"]) && Number(parsed["level"]) >= 10 && Number(parsed["level"]) <= 60
        ? parsed["level"]
        : 30,
    component: "daemon",
  };
  let redactedFields = 0;
  if (typeof parsed["msg"] === "string") {
    result["msg"] = redactOperationalText(parsed["msg"], Math.min(2_000, lineBytes));
  } else {
    result["msg"] = "Operational event";
  }
  if (typeof parsed["reqId"] === "string") {
    result["reqId"] = redactOperationalText(parsed["reqId"], 200);
  }
  if (typeof parsed["responseTime"] === "number" && Number.isFinite(parsed["responseTime"])) {
    result["responseTime"] = parsed["responseTime"];
  }
  const req = safeRequest(parsed["req"], 200);
  if (req !== undefined) result["req"] = req;
  const res = safeResponse(parsed["res"]);
  if (res !== undefined) result["res"] = res;
  const err = safeError(parsed["err"], Math.min(2_000, lineBytes));
  if (err !== undefined) result["err"] = err;

  for (const [key, value] of Object.entries(parsed)) {
    if (
      [
        "schemaVersion",
        "level",
        "time",
        "component",
        "msg",
        "reqId",
        "responseTime",
        "req",
        "res",
        "err",
      ].includes(key)
    ) {
      continue;
    }
    if (!allowedTopLevelFields.has(key)) {
      redactedFields += 1;
      continue;
    }
    const safe = Array.isArray(value) ? safeArray(value, 200) : safePrimitive(value, 500);
    if (safe === undefined) redactedFields += 1;
    else result[key] = safe;
  }
  if (redactedFields > 0) result["redactedFields"] = redactedFields;
  return result;
};

const serializeWithinLimit = (value: Record<string, unknown>, lineBytes: number): string => {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") <= lineBytes) return serialized;
  const bounded = {
    schemaVersion: 1,
    time: value["time"],
    level: value["level"],
    component: "daemon",
    code: "LOG_LINE_TRUNCATED",
    msg: "An operational log record exceeded the sanitized line limit.",
  };
  return `${JSON.stringify(bounded)}\n`;
};

const sanitizeLine = (raw: string, now: Date, lineBytes: number, invalid: "REPLACE" | "THROW"): string => {
  if (Buffer.byteLength(raw, "utf8") > rawLineBytes) {
    if (invalid === "THROW") throw new LocalLogError("LOG_FILE_INVALID", "A local log line is oversized.");
    return serializeWithinLimit(droppedLine(now), lineBytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    if (invalid === "THROW") {
      throw new LocalLogError("LOG_FILE_INVALID", "A local log line is malformed.", { cause: error });
    }
    return serializeWithinLimit(droppedLine(now), lineBytes);
  }
  const object = plainObject(parsed);
  if (object === null) {
    if (invalid === "THROW")
      throw new LocalLogError("LOG_FILE_INVALID", "A local log line is not an object.");
    return serializeWithinLimit(droppedLine(now), lineBytes);
  }
  return serializeWithinLimit(sanitizedObject(object, now, lineBytes), lineBytes);
};

export const sanitizeOperationalLogLine = (raw: string, now = new Date()): string =>
  sanitizeLine(raw, now, LOCAL_LOG_LINE_BYTES, "REPLACE");

const ensureLogsDirectory = async (dataDirectory: string): Promise<string> => {
  const logsDirectory = join(dataDirectory, "logs");
  try {
    await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(logsDirectory);
    if (!metadata.isDirectory() || !hasOwnerOnlyPermissions(metadata.mode)) {
      throw new LocalLogError("LOG_DIRECTORY_INVALID", "The local logs location is not a private directory.");
    }
    return logsDirectory;
  } catch (error: unknown) {
    throw typedFailure(error, "The local logs directory could not be opened.");
  }
};

type LockRecord = { schemaVersion: 1; processId: number; token: string };

const parseLock = (value: unknown): LockRecord => {
  const lock = plainObject(value);
  if (
    lock === null ||
    Object.keys(lock).sort().join(",") !== "processId,schemaVersion,token" ||
    lock["schemaVersion"] !== 1 ||
    !Number.isSafeInteger(lock["processId"]) ||
    Number(lock["processId"]) <= 0 ||
    typeof lock["token"] !== "string" ||
    !lockTokenPattern.test(lock["token"])
  ) {
    throw new LocalLogError("LOG_LOCK_INVALID", "The local log writer lock is invalid.");
  }
  return { schemaVersion: 1, processId: Number(lock["processId"]), token: lock["token"] };
};

const readLock = async (path: string): Promise<LockRecord> => {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    !hasOwnerOnlyPermissions(metadata.mode) ||
    metadata.size <= 0 ||
    metadata.size > 1_024
  ) {
    throw new LocalLogError("LOG_LOCK_INVALID", "The local log writer lock is invalid.");
  }
  try {
    return parseLock(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error: unknown) {
    if (error instanceof LocalLogError) throw error;
    throw new LocalLogError("LOG_LOCK_INVALID", "The local log writer lock is invalid.", { cause: error });
  }
};

const defaultProcessAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
};

type AcquiredLock = { release: () => Promise<void> };

const acquireLock = async (
  logsDirectory: string,
  processId: number,
  isProcessAlive: (processId: number) => boolean,
): Promise<AcquiredLock> => {
  const path = join(logsDirectory, lockFilename);
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, processId, token })}\n`, "utf8");
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await handle?.close();
          const current = await readLock(path).catch((error: unknown) => {
            if (errorCode(error) === "ENOENT") return null;
            throw error;
          });
          if (current === null) return;
          if (current.token !== token || current.processId !== processId) {
            throw new LocalLogError("LOG_LOCK_INVALID", "The local log writer lock changed ownership.");
          }
          await unlink(path);
        },
      };
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      if (errorCode(error) !== "EEXIST") {
        if (handle !== undefined) await unlink(path).catch(() => undefined);
        throw typedFailure(error, "The local log writer lock could not be created.");
      }
      const existing = await readLock(path).catch((readError: unknown) => {
        if (errorCode(readError) === "ENOENT") return null;
        throw readError;
      });
      if (existing === null) continue;
      if (isProcessAlive(existing.processId)) {
        throw new LocalLogError(
          "LOG_WRITER_ACTIVE",
          "Stop the running Loomrail daemon before managing logs.",
        );
      }
      await unlink(path).catch((unlinkError: unknown) => {
        if (errorCode(unlinkError) !== "ENOENT") {
          throw typedFailure(unlinkError, "A stale local log writer lock could not be reclaimed.");
        }
      });
    }
  }
  throw new LocalLogError("LOG_WRITER_ACTIVE", "The local log writer lock is contended.");
};

const listOwnedSegments = async (logsDirectory: string, limits: LocalLogLimits): Promise<OwnedSegment[]> => {
  const entries = await readdir(logsDirectory, { withFileTypes: true });
  const owned: OwnedSegment[] = [];
  for (const entry of entries) {
    if (!segmentFilenamePattern.test(entry.name)) continue;
    if (owned.length >= maxOwnedSegments) {
      throw new LocalLogError("LOG_FILE_INVALID", "The local log segment count exceeds its limit.");
    }
    const path = join(logsDirectory, entry.name);
    const metadata = await lstat(path);
    if (
      !entry.isFile() ||
      !metadata.isFile() ||
      !hasOwnerOnlyPermissions(metadata.mode) ||
      metadata.size > limits.segmentBytes
    ) {
      throw new LocalLogError("LOG_FILE_INVALID", "A local log segment is not a bounded regular file.");
    }
    owned.push({ name: entry.name, path, size: metadata.size, modifiedAtMs: metadata.mtimeMs });
  }
  return owned.sort((left, right) => left.name.localeCompare(right.name));
};

const removeOwnedSegment = async (segment: OwnedSegment): Promise<void> => {
  const metadata = await lstat(segment.path);
  if (!metadata.isFile()) throw new LocalLogError("LOG_FILE_INVALID", "A local log segment changed type.");
  await unlink(segment.path);
};

const cleanupSegments = async (
  logsDirectory: string,
  now: Date,
  limits: LocalLogLimits,
  excludeNames: ReadonlySet<string> = new Set(),
): Promise<LocalLogCleanup> => {
  const summary: LocalLogCleanup = { expiredFiles: 0, capacityFiles: 0, deletedBytes: 0 };
  const segments = await listOwnedSegments(logsDirectory, limits);
  const remaining = new Map(segments.map((segment) => [segment.name, segment]));
  const expiredBefore = now.getTime() - limits.retentionMs;
  for (const segment of segments) {
    if (excludeNames.has(segment.name) || segment.modifiedAtMs > expiredBefore) continue;
    await removeOwnedSegment(segment);
    remaining.delete(segment.name);
    summary.expiredFiles += 1;
    summary.deletedBytes += segment.size;
  }
  const capacityTarget = limits.totalBytes - limits.segmentBytes;
  let total = [...remaining.values()].reduce((sum, segment) => sum + segment.size, 0);
  const byAge = [...remaining.values()].sort(
    (left, right) => left.modifiedAtMs - right.modifiedAtMs || left.name.localeCompare(right.name),
  );
  for (const segment of byAge) {
    if (total <= capacityTarget) break;
    if (excludeNames.has(segment.name)) continue;
    await removeOwnedSegment(segment);
    remaining.delete(segment.name);
    total -= segment.size;
    summary.capacityFiles += 1;
    summary.deletedBytes += segment.size;
  }
  if (total > capacityTarget) {
    throw new LocalLogError("LOG_FILE_INVALID", "The retained local logs exceed their capacity.");
  }
  return summary;
};

const timestampForFilename = (date: Date): string => date.toISOString().replace(/\D/g, "").slice(0, 17);

class SegmentWriter extends Writable {
  readonly #logsDirectory: string;
  readonly #now: () => Date;
  readonly #processId: number;
  readonly #writerId: string;
  readonly #limits: LocalLogLimits;
  #queue: Promise<void> = Promise.resolve();
  #handle: FileHandle | null = null;
  #segmentName: string | null = null;
  #segmentBytes = 0;
  #segmentOpenedAt = 0;
  #segmentIndex = 0;
  #pending = "";
  #discardUntilNewline = false;

  constructor(input: {
    logsDirectory: string;
    now: () => Date;
    processId: number;
    writerId: string;
    limits: LocalLogLimits;
  }) {
    super({ decodeStrings: false });
    this.#logsDirectory = input.logsDirectory;
    this.#now = input.now;
    this.#processId = input.processId;
    this.#writerId = input.writerId;
    this.#limits = input.limits;
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #openSegment(): Promise<void> {
    if (this.#segmentIndex > 9_999) {
      throw new LocalLogError("LOG_FILE_INVALID", "The local log segment index exceeds its limit.");
    }
    const now = this.#now();
    const segmentIndex = this.#segmentIndex.toString().padStart(4, "0");
    const name = `daemon-${timestampForFilename(now)}-${this.#processId.toString()}-${this.#writerId}-${segmentIndex}.ndjson`;
    this.#segmentIndex += 1;
    this.#handle = await open(join(this.#logsDirectory, name), "wx", 0o600);
    this.#segmentName = name;
    this.#segmentBytes = 0;
    this.#segmentOpenedAt = now.getTime();
  }

  async #closeSegment(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    this.#segmentName = null;
    if (handle !== null) await handle.close();
  }

  async #rotate(): Promise<void> {
    await this.#closeSegment();
    await cleanupSegments(this.#logsDirectory, this.#now(), this.#limits);
    await this.#openSegment();
  }

  async #writeSanitized(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.#handle === null) await this.#openSegment();
    if (
      this.#segmentBytes > 0 &&
      (this.#segmentBytes + bytes > this.#limits.segmentBytes ||
        this.#now().getTime() - this.#segmentOpenedAt >= this.#limits.rotationMs)
    ) {
      await this.#rotate();
    }
    if (this.#handle === null)
      throw new LocalLogError("LOG_IO_FAILED", "The local log segment is unavailable.");
    await this.#handle.writeFile(line, "utf8");
    this.#segmentBytes += bytes;
  }

  async #consume(chunk: string): Promise<void> {
    let text = chunk;
    if (this.#discardUntilNewline) {
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      text = text.slice(newline + 1);
      this.#discardUntilNewline = false;
    }
    const pieces = `${this.#pending}${text}`.split("\n");
    this.#pending = pieces.pop() ?? "";
    for (const raw of pieces) {
      if (raw.length === 0) continue;
      await this.#writeSanitized(sanitizeLine(raw, this.#now(), this.#limits.lineBytes, "REPLACE"));
    }
    if (Buffer.byteLength(this.#pending, "utf8") > rawLineBytes) {
      this.#pending = "";
      this.#discardUntilNewline = true;
      await this.#writeSanitized(serializeWithinLimit(droppedLine(this.#now()), this.#limits.lineBytes));
    }
  }

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString(encoding);
    void this.#enqueue(() => this.#consume(text)).then(
      () => {
        callback();
      },
      (error: unknown) => {
        callback(typedFailure(error, "The local log segment could not be written."));
      },
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.#enqueue(async () => {
      if (this.#pending.length > 0 && !this.#discardUntilNewline) {
        await this.#writeSanitized(
          sanitizeLine(this.#pending, this.#now(), this.#limits.lineBytes, "REPLACE"),
        );
      }
      this.#pending = "";
      await this.#closeSegment();
    }).then(
      () => {
        callback();
      },
      (error: unknown) => {
        callback(typedFailure(error, "The local log writer could not be closed."));
      },
    );
  }

  maintain(): Promise<LocalLogCleanup> {
    let summary: LocalLogCleanup = { expiredFiles: 0, capacityFiles: 0, deletedBytes: 0 };
    return this.#enqueue(async () => {
      const now = this.#now();
      if (
        this.#handle !== null &&
        this.#segmentBytes > 0 &&
        now.getTime() - this.#segmentOpenedAt >= this.#limits.rotationMs
      ) {
        await this.#closeSegment();
      }
      summary = await cleanupSegments(
        this.#logsDirectory,
        now,
        this.#limits,
        this.#segmentName === null ? new Set() : new Set([this.#segmentName]),
      );
      if (this.#handle === null) await this.#openSegment();
    }).then(() => summary);
  }
}

export const openLocalLogWriter = async (
  dataDirectory: string,
  options: LocalLogOptions = {},
): Promise<LocalLogWriter> => {
  const now = options.now ?? (() => new Date());
  const processId = options.processId ?? process.pid;
  safeInteger(processId, "process id");
  const writerId = options.writerId ?? randomBytes(8).toString("hex");
  if (!/^[a-f0-9]{16}$/.test(writerId)) {
    throw new LocalLogError("LOG_FILE_INVALID", "The local log writer identifier is invalid.");
  }
  const limits = resolveLimits(options.limits);
  const logsDirectory = await ensureLogsDirectory(dataDirectory);
  const lock = await acquireLock(logsDirectory, processId, options.isProcessAlive ?? defaultProcessAlive);
  try {
    const initialCleanup = await cleanupSegments(logsDirectory, now(), limits);
    const stream = new SegmentWriter({ logsDirectory, now, processId, writerId, limits });
    let reportFailure: (error: LocalLogError) => void = () => undefined;
    const failed = new Promise<LocalLogError>((resolve) => {
      reportFailure = resolve;
    });
    stream.once("error", (error: Error) => {
      reportFailure(typedFailure(error, "The local log writer failed."));
    });
    const timer = setInterval(() => {
      void stream.maintain().catch((error: unknown) => {
        stream.destroy(typedFailure(error, "Local log retention failed."));
      });
    }, limits.maintenanceMs);
    timer.unref();
    let closed = false;
    return {
      stream,
      initialCleanup,
      failed,
      maintain: () => stream.maintain(),
      close: async () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          if (!stream.destroyed) stream.end();
          await finished(stream).catch((error: unknown) => {
            throw typedFailure(error, "The local log writer could not be closed.");
          });
        } finally {
          await lock.release();
        }
      },
    };
  } catch (error: unknown) {
    await lock.release().catch(() => undefined);
    throw typedFailure(error, "The local log writer could not start.");
  }
};

const withManagementLock = async <T>(
  dataDirectory: string,
  options: LocalLogOptions,
  operation: (logsDirectory: string, limits: LocalLogLimits, now: () => Date) => Promise<T>,
): Promise<T> => {
  const logsDirectory = await ensureLogsDirectory(dataDirectory);
  const processId = options.processId ?? process.pid;
  safeInteger(processId, "process id");
  const limits = resolveLimits(options.limits);
  const lock = await acquireLock(logsDirectory, processId, options.isProcessAlive ?? defaultProcessAlive);
  try {
    return await operation(logsDirectory, limits, options.now ?? (() => new Date()));
  } catch (error: unknown) {
    throw typedFailure(error, "The local log operation failed.");
  } finally {
    await lock.release();
  }
};

export const exportLocalLogs = (
  dataDirectory: string,
  options: LocalLogOptions = {},
): Promise<LocalLogExport> =>
  withManagementLock(dataDirectory, options, async (logsDirectory, limits, now) => {
    const segments = await listOwnedSegments(logsDirectory, limits);
    const total = segments.reduce((sum, segment) => sum + segment.size, 0);
    if (total > limits.totalBytes) {
      throw new LocalLogError("LOG_FILE_INVALID", "The retained local logs exceed their export bound.");
    }
    const lines: string[] = [];
    for (const segment of segments) {
      const bytes = await readFile(segment.path);
      if (bytes.byteLength !== segment.size || (bytes.byteLength > 0 && bytes.at(-1) !== 0x0a)) {
        throw new LocalLogError("LOG_FILE_INVALID", "A local log segment changed or is incomplete.");
      }
      const text = bytes.toString("utf8");
      for (const raw of text.split("\n")) {
        if (raw.length === 0) continue;
        lines.push(sanitizeLine(raw, now(), limits.lineBytes, "THROW"));
      }
    }
    const ndjson = lines.join("");
    if (Buffer.byteLength(ndjson, "utf8") > limits.totalBytes) {
      throw new LocalLogError("LOG_FILE_INVALID", "The redacted local log export exceeds its byte limit.");
    }
    return {
      ndjson,
      files: segments.length,
      entries: lines.length,
      bytes: Buffer.byteLength(ndjson, "utf8"),
    };
  });

export const deleteLocalLogs = (
  dataDirectory: string,
  options: LocalLogOptions = {},
): Promise<LocalLogDeletion> =>
  withManagementLock(dataDirectory, options, async (logsDirectory, limits) => {
    const segments = await listOwnedSegments(logsDirectory, limits);
    for (const segment of segments) await removeOwnedSegment(segment);
    return {
      files: segments.length,
      bytes: segments.reduce((sum, segment) => sum + segment.size, 0),
    };
  });
