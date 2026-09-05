import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import process from "node:process";

import { createProcessTreeOperations, stopAndReapProcessTree } from "./process-tree.js";
import {
  parseVerificationProcessRecord,
  type VerificationProcessRecord,
} from "./verification-process-record.js";

const FORCE_WAIT_MS = 2_000;
const PARENT_CHECK_MS = 250;
const CONTROL_LIMIT_BYTES = 256;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const runIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const processTree = createProcessTreeOperations();

const parseInvocation = (): {
  parentPid: number;
  controlToken: string;
  runId: string;
  registryFile: string;
  graceMs: number;
  command: string;
  args: string[];
} | null => {
  const separator = process.argv.indexOf("--");
  if (
    process.argv[2] !== "--parent-pid" ||
    process.argv[4] !== "--control-token" ||
    process.argv[6] !== "--run-id" ||
    process.argv[8] !== "--registry-file" ||
    process.argv[10] !== "--grace-ms" ||
    separator !== 12
  ) {
    return null;
  }
  const parentPid = Number(process.argv[3]);
  const controlToken = process.argv[5];
  const runId = process.argv[7];
  const registryFile = process.argv[9];
  const graceMs = Number(process.argv[11]);
  const command = process.argv[separator + 1];
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    controlToken === undefined ||
    !tokenPattern.test(controlToken) ||
    runId === undefined ||
    !runIdPattern.test(runId) ||
    registryFile === undefined ||
    !isAbsolute(registryFile) ||
    !Number.isSafeInteger(graceMs) ||
    graceMs <= 0 ||
    graceMs > 60_000 ||
    basename(registryFile) !== `verification-${createHash("sha256").update(runId).digest("hex")}.json` ||
    command === undefined ||
    command === ""
  ) {
    return null;
  }
  return {
    parentPid,
    controlToken,
    runId,
    registryFile,
    graceMs,
    command,
    args: process.argv.slice(separator + 2),
  };
};

const invocation = parseInvocation();
if (invocation === null) {
  process.stderr.write("Invalid Loomrail verification supervisor invocation\n");
  process.exitCode = 2;
} else {
  let child: ChildProcess | null = null;
  let childStartedAt: Date | null = null;
  let stopping = false;
  let finished = false;
  let temporaryFile: string | null = null;
  let controlBuffer = Buffer.alloc(0);
  const supervisorStartedAt = new Date().toISOString();

  const removeTemporary = (): void => {
    if (temporaryFile !== null) {
      try {
        unlinkSync(temporaryFile);
      } catch {
        // A stale pre-spawn temporary file cannot authorize repository execution.
      }
    }
  };

  const writeRecord = (record: VerificationProcessRecord): void => {
    mkdirSync(dirname(invocation.registryFile), { recursive: true, mode: 0o700 });
    const candidate = `${invocation.registryFile}.tmp-${process.pid.toString()}`;
    temporaryFile = candidate;
    writeFileSync(candidate, JSON.stringify(record), {
      encoding: "utf8",
      flag: "wx",
      flush: true,
      mode: 0o600,
    });
    renameSync(candidate, invocation.registryFile);
    temporaryFile = null;
  };

  const markStopped = (): boolean => {
    try {
      writeRecord({
        schemaVersion: 1,
        runId: invocation.runId,
        state: "STOPPED",
        stoppedAt: new Date().toISOString(),
      });
      return true;
    } catch {
      removeTemporary();
      return false;
    }
  };

  const writeControl = (message: string): boolean => {
    try {
      writeFileSync(3, `${message}\n`, { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  };

  const finish = (exitCode: number): void => {
    if (finished) return;
    finished = true;
    clearInterval(parentCheck);
    process.stdin.pause();
    process.exit(exitCode);
  };

  const stop = (): void => {
    if (stopping || finished) return;
    stopping = true;
    const target = child;
    const targetPid = target?.pid;
    void (async (): Promise<void> => {
      if (targetPid === undefined || !processTree.treeExists(targetPid)) {
        if (
          targetPid !== undefined &&
          childStartedAt !== null &&
          !(await stopAndReapProcessTree({
            operations: processTree,
            rootPid: targetPid,
            rootStartedAt: childStartedAt,
            gracefulWaitMs: invocation.graceMs,
            forceWaitMs: FORCE_WAIT_MS,
          }))
        ) {
          finish(1);
          return;
        }
        finish(markStopped() ? (target === null ? 1 : 0) : 1);
        return;
      }
      target?.stdin?.end();
      if (
        childStartedAt === null ||
        !(await stopAndReapProcessTree({
          operations: processTree,
          rootPid: targetPid,
          rootStartedAt: childStartedAt,
          gracefulWaitMs: invocation.graceMs,
          forceWaitMs: FORCE_WAIT_MS,
        }))
      ) {
        finish(1);
        return;
      }
      finish(markStopped() ? 0 : 1);
    })();
  };

  const startTarget = (): void => {
    if (child !== null || stopping || finished || !processTree.pidExists(invocation.parentPid)) {
      stop();
      return;
    }
    const target = spawn(invocation.command, invocation.args, {
      detached: processTree.detachChild,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = target;
    const targetPid = target.pid;
    const targetStartedAt = new Date();
    childStartedAt = targetStartedAt;
    if (targetPid === undefined) {
      stop();
      return;
    }
    try {
      writeRecord({
        schemaVersion: 1,
        runId: invocation.runId,
        state: "ACTIVE",
        supervisorPid: process.pid,
        supervisorStartedAt,
        targetPid,
        targetStartedAt: targetStartedAt.toISOString(),
      });
    } catch {
      stop();
      return;
    }

    target.stdout.pipe(process.stdout);
    target.stderr.pipe(process.stderr);
    target.stdout.on("error", stop);
    target.stderr.on("error", stop);
    target.once("error", stop);
    target.once("close", (code, signal) => {
      if (stopping) return;
      stopping = true;
      void (async (): Promise<void> => {
        const exitReported = writeControl(
          `EXIT:${invocation.controlToken}:${code === null ? "null" : code.toString()}:${signal ?? "null"}`,
        );
        if (
          !exitReported ||
          !(await processTree.reapDescendants(targetPid, targetStartedAt)) ||
          !markStopped()
        ) {
          finish(1);
          return;
        }
        finish(code ?? 1);
      })();
    });
  };

  const parentCheck = setInterval(() => {
    if (!processTree.pidExists(invocation.parentPid)) stop();
  }, PARENT_CHECK_MS);
  parentCheck.unref();

  process.stdin.on("data", (chunk: Buffer) => {
    if (child !== null || stopping || finished) return;
    controlBuffer = Buffer.concat([controlBuffer, chunk]);
    if (controlBuffer.byteLength > CONTROL_LIMIT_BYTES) {
      stop();
      return;
    }
    const newline = controlBuffer.indexOf(0x0a);
    if (newline === -1) return;
    const command = controlBuffer.subarray(0, newline).toString("utf8");
    controlBuffer = controlBuffer.subarray(newline + 1);
    if (command !== `GO:${invocation.controlToken}` || controlBuffer.byteLength !== 0) {
      stop();
      return;
    }
    startTarget();
  });
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  try {
    const intent = parseVerificationProcessRecord(
      JSON.parse(readFileSync(invocation.registryFile, "utf8")) as unknown,
    );
    if (intent?.runId !== invocation.runId || intent.state !== "INTENT") {
      throw new Error("Verification process intent is missing");
    }
    writeRecord({
      schemaVersion: 1,
      runId: invocation.runId,
      state: "ACTIVE",
      supervisorPid: process.pid,
      supervisorStartedAt,
      targetPid: null,
      targetStartedAt: null,
    });
    if (!writeControl(`READY:${invocation.controlToken}`)) stop();
  } catch {
    removeTemporary();
    finish(1);
  }
}
