import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { createProcessTreeOperations, type ProcessTreeOperations } from "./process-tree.js";

const PROCESS_START_TOLERANCE_MS = 2_000;
const PROCESS_SPAWN_WINDOW_LIMIT_MS = 10_000;
const PROCESS_START_OBSERVATION_ATTEMPTS = 2;
const REGISTRY_FILE_LIMIT_BYTES = 4_096;

const legacyMcpProcessRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    supervisorPid: z.number().int().positive(),
    serverPid: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const boundedSpawnMcpProcessRecordSchema = z
  .object({
    schemaVersion: z.literal(2),
    supervisorPid: z.number().int().positive(),
    serverPid: z.number().int().positive(),
    spawnStartedAt: z.iso.datetime({ offset: true }),
    spawnCompletedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (record) => {
      const duration = Date.parse(record.spawnCompletedAt) - Date.parse(record.spawnStartedAt);
      return duration >= 0 && duration <= PROCESS_SPAWN_WINDOW_LIMIT_MS;
    },
    { message: "MCP process spawn interval is invalid", path: ["spawnCompletedAt"] },
  );

export const mcpProcessRecordSchema = z.union([
  legacyMcpProcessRecordSchema,
  boundedSpawnMcpProcessRecordSchema,
]);

export type McpProcessRecord = z.infer<typeof mcpProcessRecordSchema>;

export const createMcpProcessRecord = ({
  supervisorPid,
  serverPid,
  spawnStartedAt,
  spawnCompletedAt,
}: {
  supervisorPid: number;
  serverPid: number;
  spawnStartedAt: Date;
  spawnCompletedAt: Date;
}): McpProcessRecord =>
  mcpProcessRecordSchema.parse({
    schemaVersion: 2,
    supervisorPid,
    serverPid,
    spawnStartedAt: spawnStartedAt.toISOString(),
    spawnCompletedAt: spawnCompletedAt.toISOString(),
  });

export type McpOrphanRecoveryReport = {
  recordFile: string;
  serverPid: number | null;
  action: "KILLED" | "REMOVED" | "SKIPPED";
  reason:
    | "IDENTITY_CONFIRMED"
    | "ALREADY_GONE"
    | "INVALID_RECORD"
    | "STALE_TEMPORARY"
    | "SUPERVISOR_STILL_RUNNING"
    | "START_TIME_MISMATCH"
    | "SIGNAL_REFUSED";
};

const removeRecord = async (path: string): Promise<void> => {
  await unlink(path).catch(() => undefined);
};

const observeProcessStart = async (
  processTree: ProcessTreeOperations,
  pid: number,
  now: () => Date,
): Promise<Date | null> => {
  for (let attempt = 0; attempt < PROCESS_START_OBSERVATION_ATTEMPTS; attempt += 1) {
    const observed = await processTree.startedAt(pid, now()).catch(() => null);
    if (observed !== null) return observed;
    if (!processTree.pidExists(pid)) return null;
  }
  return null;
};

const processStartMatches = (record: McpProcessRecord, observed: Date): boolean => {
  const observedMilliseconds = observed.getTime();
  if (!Number.isSafeInteger(observedMilliseconds) || observedMilliseconds < 0) return false;
  if (record.schemaVersion === 1) {
    return Math.abs(observedMilliseconds - Date.parse(record.startedAt)) <= PROCESS_START_TOLERANCE_MS;
  }
  return (
    observedMilliseconds >= Date.parse(record.spawnStartedAt) - PROCESS_START_TOLERANCE_MS &&
    observedMilliseconds <= Date.parse(record.spawnCompletedAt) + PROCESS_START_TOLERANCE_MS
  );
};

export const recoverMcpOrphans = async (
  registryDirectory: string | undefined,
  now: () => Date = () => new Date(),
  processTree: ProcessTreeOperations = createProcessTreeOperations(),
): Promise<McpOrphanRecoveryReport[]> => {
  if (registryDirectory === undefined) return [];
  const names = await readdir(registryDirectory).catch(() => []);
  const reports: McpOrphanRecoveryReport[] = [];
  for (const name of names.filter((candidate) =>
    /^mcp-[A-Za-z0-9_-]{43}\.json(?:\.tmp-\d+)?$/u.test(candidate),
  )) {
    const path = join(registryDirectory, name);
    let record: McpProcessRecord | null = null;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > REGISTRY_FILE_LIMIT_BYTES) {
        throw new Error("Invalid MCP process record file");
      }
      record = mcpProcessRecordSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch {
      // A half-written `.json.tmp-<pid>` whose writer is gone is the residue of a supervisor that
      // crashed between write and rename. It can never become a valid record, so it is removed
      // instead of being reported as invalid on every start for the rest of the install's life. A
      // final `.json` that fails to parse is left alone: unknown state is never deleted.
      const temporaryWriter = /\.json\.tmp-(\d+)$/u.exec(name);
      if (temporaryWriter?.[1] !== undefined && !processTree.pidExists(Number(temporaryWriter[1]))) {
        await removeRecord(path);
        reports.push({ recordFile: name, serverPid: null, action: "REMOVED", reason: "STALE_TEMPORARY" });
        continue;
      }
      reports.push({
        recordFile: name,
        serverPid: null,
        action: "SKIPPED",
        reason: "INVALID_RECORD",
      });
      continue;
    }

    if (processTree.pidExists(record.supervisorPid)) {
      reports.push({
        recordFile: name,
        serverPid: record.serverPid,
        action: "SKIPPED",
        reason: "SUPERVISOR_STILL_RUNNING",
      });
      continue;
    }
    if (!processTree.pidExists(record.serverPid)) {
      await removeRecord(path);
      reports.push({
        recordFile: name,
        serverPid: record.serverPid,
        action: "REMOVED",
        reason: "ALREADY_GONE",
      });
      continue;
    }
    const observedStartedAt = await observeProcessStart(processTree, record.serverPid, now);
    if (observedStartedAt === null || !processStartMatches(record, observedStartedAt)) {
      reports.push({
        recordFile: name,
        serverPid: record.serverPid,
        action: "SKIPPED",
        reason: "START_TIME_MISMATCH",
      });
      continue;
    }
    try {
      await processTree.forceStop(record.serverPid);
      await removeRecord(path);
      reports.push({
        recordFile: name,
        serverPid: record.serverPid,
        action: "KILLED",
        reason: "IDENTITY_CONFIRMED",
      });
    } catch {
      reports.push({
        recordFile: name,
        serverPid: record.serverPid,
        action: "SKIPPED",
        reason: "SIGNAL_REFUSED",
      });
    }
  }
  return reports;
};
