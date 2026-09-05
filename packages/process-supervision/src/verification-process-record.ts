import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createProcessTreeOperations, type ProcessTreeOperations } from "./process-tree.js";

const PROCESS_START_TOLERANCE_MS = 3_000;
const RECORD_LIMIT_BYTES = 4_096;
const FORCE_WAIT_MS = 2_000;
const GRACE_WAIT_MS = 7_500;
const runIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export type VerificationProcessRecord =
  | { schemaVersion: 1; runId: string; state: "INTENT" }
  | {
      schemaVersion: 1;
      runId: string;
      state: "ACTIVE";
      supervisorPid: number;
      supervisorStartedAt: string;
      targetPid: number | null;
      targetStartedAt: string | null;
    }
  | { schemaVersion: 1; runId: string; state: "STOPPED"; stoppedAt: string };

export type VerificationProcessRecoveryReport = {
  runId: string;
  recordFile: string;
  action: "NO_RECORD" | "CONFIRMED" | "KILLED" | "BLOCKED";
  reason:
    | "NO_RECORD"
    | "NO_PROCESS_STARTED"
    | "ALREADY_GONE"
    | "IDENTITY_CONFIRMED"
    | "INVALID_RECORD"
    | "START_TIME_MISMATCH"
    | "TARGET_IDENTITY_UNKNOWN"
    | "SIGNAL_REFUSED"
    | "PROCESS_STILL_RUNNING";
};

const validPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const exactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(record).sort().join("\0") === [...expected].sort().join("\0");

export const parseVerificationProcessRecord = (value: unknown): VerificationProcessRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1 ||
    typeof record["runId"] !== "string" ||
    !runIdPattern.test(record["runId"]) ||
    typeof record["state"] !== "string"
  ) {
    return null;
  }
  if (record["state"] === "INTENT") {
    return exactKeys(record, ["schemaVersion", "runId", "state"])
      ? { schemaVersion: 1, runId: record["runId"], state: "INTENT" }
      : null;
  }
  if (record["state"] === "STOPPED") {
    return exactKeys(record, ["schemaVersion", "runId", "state", "stoppedAt"]) &&
      validTimestamp(record["stoppedAt"])
      ? {
          schemaVersion: 1,
          runId: record["runId"],
          state: "STOPPED",
          stoppedAt: record["stoppedAt"],
        }
      : null;
  }
  if (
    record["state"] !== "ACTIVE" ||
    !exactKeys(record, [
      "schemaVersion",
      "runId",
      "state",
      "supervisorPid",
      "supervisorStartedAt",
      "targetPid",
      "targetStartedAt",
    ]) ||
    !validPid(record["supervisorPid"]) ||
    !validTimestamp(record["supervisorStartedAt"]) ||
    !(
      (record["targetPid"] === null && record["targetStartedAt"] === null) ||
      (validPid(record["targetPid"]) && validTimestamp(record["targetStartedAt"]))
    )
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    runId: record["runId"],
    state: "ACTIVE",
    supervisorPid: record["supervisorPid"],
    supervisorStartedAt: record["supervisorStartedAt"],
    targetPid: record["targetPid"],
    targetStartedAt: record["targetStartedAt"],
  };
};

const recordName = (runId: string): string => {
  if (!runIdPattern.test(runId)) throw new TypeError("Invalid verification Run identity");
  return `verification-${createHash("sha256").update(runId).digest("hex")}.json`;
};

export const verificationProcessRecordPath = (registryDirectory: string, runId: string): string =>
  join(registryDirectory, recordName(runId));

const readRecord = async (path: string): Promise<VerificationProcessRecord | null> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > RECORD_LIMIT_BYTES) return null;
  return parseVerificationProcessRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
};

export const prepareVerificationProcessIntent = async (
  registryDirectory: string,
  runId: string,
): Promise<string> => {
  const path = verificationProcessRecordPath(registryDirectory, runId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, runId, state: "INTENT" }), "utf8");
    await handle.sync();
    await handle.close();
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
};

export const verificationProcessIsStopped = async (path: string, runId: string): Promise<boolean> => {
  const record = await readRecord(path).catch(() => null);
  return record?.runId === runId && record.state === "STOPPED";
};

export const removeVerificationProcessRecord = async (
  registryDirectory: string,
  runId: string,
): Promise<void> => {
  await unlink(verificationProcessRecordPath(registryDirectory, runId)).catch(() => undefined);
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

const waitUntilGone = async (
  processTree: ProcessTreeOperations,
  pid: number,
  milliseconds: number,
): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processTree.treeExists(pid)) return true;
    await delay(25);
  }
  return !processTree.treeExists(pid);
};

const identityMatches = async (
  processTree: ProcessTreeOperations,
  pid: number,
  recordedStartedAt: string,
  now: Date,
): Promise<boolean> => {
  const observed = await processTree.startedAt(pid, now).catch(() => null);
  return (
    observed !== null &&
    Math.abs(observed.getTime() - Date.parse(recordedStartedAt)) <= PROCESS_START_TOLERANCE_MS
  );
};

const report = (
  runId: string,
  recordFile: string,
  action: VerificationProcessRecoveryReport["action"],
  reason: VerificationProcessRecoveryReport["reason"],
): VerificationProcessRecoveryReport => ({ runId, recordFile, action, reason });

const writeStoppedProof = async (path: string, runId: string, stoppedAt: string): Promise<void> => {
  const temporaryPath = `${path}.tmp-${process.pid.toString()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, runId, state: "STOPPED", stoppedAt }), "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const recoverVerificationRunProcesses = async (input: {
  registryDirectory: string;
  runIds: readonly string[];
  now?: () => Date;
  processTree?: ProcessTreeOperations;
}): Promise<VerificationProcessRecoveryReport[]> => {
  const processTree = input.processTree ?? createProcessTreeOperations();
  const now = input.now ?? (() => new Date());
  const reports: VerificationProcessRecoveryReport[] = [];
  for (const runId of [...new Set(input.runIds)].sort()) {
    const path = verificationProcessRecordPath(input.registryDirectory, runId);
    const recordFile = basename(path);
    let record: VerificationProcessRecord | null;
    try {
      record = await readRecord(path);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        reports.push(report(runId, recordFile, "NO_RECORD", "NO_RECORD"));
      } else {
        reports.push(report(runId, recordFile, "BLOCKED", "INVALID_RECORD"));
      }
      continue;
    }
    if (record?.runId !== runId) {
      reports.push(report(runId, recordFile, "BLOCKED", "INVALID_RECORD"));
      continue;
    }
    if (record.state === "INTENT" || record.state === "STOPPED") {
      reports.push(
        report(
          runId,
          recordFile,
          "CONFIRMED",
          record.state === "INTENT" ? "NO_PROCESS_STARTED" : "ALREADY_GONE",
        ),
      );
      continue;
    }

    if (record.targetPid !== null) {
      if (record.targetStartedAt === null) {
        reports.push(report(runId, recordFile, "BLOCKED", "TARGET_IDENTITY_UNKNOWN"));
        continue;
      }
      if (processTree.treeExists(record.targetPid)) {
        if (!(await identityMatches(processTree, record.targetPid, record.targetStartedAt, now()))) {
          reports.push(report(runId, recordFile, "BLOCKED", "START_TIME_MISMATCH"));
          continue;
        }
        try {
          await processTree.forceStop(record.targetPid);
        } catch {
          reports.push(report(runId, recordFile, "BLOCKED", "SIGNAL_REFUSED"));
          continue;
        }
        if (!(await waitUntilGone(processTree, record.targetPid, FORCE_WAIT_MS))) {
          reports.push(report(runId, recordFile, "BLOCKED", "PROCESS_STILL_RUNNING"));
          continue;
        }
        if (!(await processTree.reapDescendants(record.targetPid, new Date(record.targetStartedAt)))) {
          reports.push(report(runId, recordFile, "BLOCKED", "PROCESS_STILL_RUNNING"));
          continue;
        }
      } else if (
        processTree.orphanRecoveryRequiresLiveRootIdentity ||
        !(await processTree.reapDescendants(record.targetPid, new Date(record.targetStartedAt)))
      ) {
        reports.push(report(runId, recordFile, "BLOCKED", "TARGET_IDENTITY_UNKNOWN"));
        continue;
      }
    }

    if (processTree.treeExists(record.supervisorPid)) {
      if (!(await identityMatches(processTree, record.supervisorPid, record.supervisorStartedAt, now()))) {
        reports.push(report(runId, recordFile, "BLOCKED", "START_TIME_MISMATCH"));
        continue;
      }
      try {
        if (record.targetPid === null) {
          await processTree.gracefulStop(record.supervisorPid);
          if (!(await waitUntilGone(processTree, record.supervisorPid, GRACE_WAIT_MS))) {
            reports.push(report(runId, recordFile, "BLOCKED", "TARGET_IDENTITY_UNKNOWN"));
            continue;
          }
        } else {
          await processTree.forceStop(record.supervisorPid);
          if (!(await waitUntilGone(processTree, record.supervisorPid, FORCE_WAIT_MS))) {
            reports.push(report(runId, recordFile, "BLOCKED", "PROCESS_STILL_RUNNING"));
            continue;
          }
        }
      } catch {
        reports.push(report(runId, recordFile, "BLOCKED", "SIGNAL_REFUSED"));
        continue;
      }
    } else if (record.targetPid === null) {
      reports.push(report(runId, recordFile, "BLOCKED", "TARGET_IDENTITY_UNKNOWN"));
      continue;
    }

    if (
      (record.targetPid !== null && processTree.treeExists(record.targetPid)) ||
      processTree.treeExists(record.supervisorPid)
    ) {
      reports.push(report(runId, recordFile, "BLOCKED", "PROCESS_STILL_RUNNING"));
      continue;
    }
    try {
      await writeStoppedProof(path, runId, now().toISOString());
    } catch {
      reports.push(report(runId, recordFile, "BLOCKED", "INVALID_RECORD"));
      continue;
    }
    reports.push(report(runId, recordFile, "KILLED", "IDENTITY_CONFIRMED"));
  }
  return reports;
};
