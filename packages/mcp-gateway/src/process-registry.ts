import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { createProcessTreeOperations, type ProcessTreeOperations } from "./process-tree.js";

const PROCESS_START_TOLERANCE_MS = 2_000;
const REGISTRY_FILE_LIMIT_BYTES = 4_096;

export const mcpProcessRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    supervisorPid: z.number().int().positive(),
    serverPid: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type McpProcessRecord = z.infer<typeof mcpProcessRecordSchema>;

export type McpOrphanRecoveryReport = {
  recordFile: string;
  serverPid: number | null;
  action: "KILLED" | "REMOVED" | "SKIPPED";
  reason:
    | "IDENTITY_CONFIRMED"
    | "ALREADY_GONE"
    | "INVALID_RECORD"
    | "SUPERVISOR_STILL_RUNNING"
    | "START_TIME_MISMATCH"
    | "SIGNAL_REFUSED";
};

const removeRecord = async (path: string): Promise<void> => {
  await unlink(path).catch(() => undefined);
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
    const observedStartedAt = await processTree.startedAt(record.serverPid, now());
    if (
      observedStartedAt === null ||
      Math.abs(observedStartedAt.getTime() - Date.parse(record.startedAt)) > PROCESS_START_TOLERANCE_MS
    ) {
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
