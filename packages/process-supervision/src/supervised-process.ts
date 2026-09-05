import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { createProcessTreeOperations, type ProcessTreeOperations } from "./process-tree.js";
import {
  verificationProcessIsStopped,
  verificationProcessRecordPath,
} from "./verification-process-record.js";

export type SupervisedProcessTermination =
  "EXITED" | "TIMED_OUT" | "OUTPUT_LIMIT_REACHED" | "CANCELLED" | "SPAWN_FAILED" | "TERMINATION_FAILED";

export type SupervisedProcessOutput = {
  text: string;
  capturedBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
};

export type SupervisedProcessResult = {
  termination: SupervisedProcessTermination;
  spawnErrorCode: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  output: SupervisedProcessOutput;
};

export type SupervisedProcessOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  deadlineMs: number;
  graceMs?: number;
  outputLimitBytes: number;
  redactValues: readonly string[];
  signal?: AbortSignal;
  processTree?: ProcessTreeOperations;
  orphanGuard?: {
    runId: string;
    registryDirectory: string;
    supervisorEntrypoint?: string;
  };
};

const DEFAULT_GRACE_MS = 5_000;
const FORCE_EXIT_WAIT_MS = 2_000;
// The trusted supervisor bounds each Windows taskkill/CIM command itself. Give those sequential
// fail-closed operations enough time to publish STOPPED before using the supervisor kill as the
// final backstop; CANCELLING keeps workspace authority reserved throughout this wait.
const SUPERVISOR_FINALIZATION_WAIT_MS = 90_000;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

export const sanitizeSupervisedOutput = (text: string, redactValues: readonly string[]): string => {
  let withoutEscapes = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 27) {
      withoutEscapes += text[index] ?? "";
      continue;
    }
    const introducer = text[index + 1];
    if (introducer === "]") {
      index += 2;
      while (index < text.length) {
        if (text.charCodeAt(index) === 7) break;
        if (text.charCodeAt(index) === 27 && text[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
    } else if (introducer === "[") {
      index += 2;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code >= 64 && code <= 126) break;
        index += 1;
      }
    } else if (introducer !== undefined) {
      index += 1;
    }
  }
  let sanitized = withoutEscapes;
  sanitized = sanitized
    .replace(/\r\n?/gu, "\n")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character === "\n" || character === "\t" || (code >= 32 && code !== 127);
    })
    .join("");
  for (const value of [...new Set(redactValues.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  )) {
    sanitized = sanitized.split(value).join("[REDACTED]");
  }
  return sanitized;
};

const requirePositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
};

const boundUtf8Text = (text: string, limit: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= limit) return text;
  const decoder = new StringDecoder("utf8");
  return decoder.write(bytes.subarray(0, limit));
};

export const runSupervisedProcess = async (
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> => {
  requirePositiveSafeInteger(options.deadlineMs, "deadlineMs");
  requirePositiveSafeInteger(options.outputLimitBytes, "outputLimitBytes");
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  requirePositiveSafeInteger(graceMs, "graceMs");

  const processTree = options.processTree ?? createProcessTreeOperations();
  const startedAt = Date.now();
  let termination: SupervisedProcessTermination = "EXITED";
  let spawnErrorCode: string | null = null;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let capturedBytes = 0;
  const outputParts: string[] = [];
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const closed = deferred<boolean>();
  let closeObserved = false;
  const hasClosed = (): boolean => closeObserved;
  let settled = false;
  let stopPromise: Promise<void> | undefined;
  const controlToken = options.orphanGuard === undefined ? null : randomBytes(32).toString("base64url");
  const recordFile =
    options.orphanGuard === undefined
      ? null
      : verificationProcessRecordPath(options.orphanGuard.registryDirectory, options.orphanGuard.runId);
  const supervisedCommand = options.orphanGuard === undefined ? options.command : process.execPath;
  const supervisedArgs =
    options.orphanGuard === undefined || controlToken === null || recordFile === null
      ? [...options.args]
      : [
          options.orphanGuard.supervisorEntrypoint ??
            fileURLToPath(new URL("./verification-supervisor.js", import.meta.url)),
          "--parent-pid",
          process.pid.toString(),
          "--control-token",
          controlToken,
          "--run-id",
          options.orphanGuard.runId,
          "--registry-file",
          recordFile,
          "--grace-ms",
          graceMs.toString(),
          "--",
          options.command,
          ...options.args,
        ];
  let supervisorReady = options.orphanGuard === undefined;
  let targetExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let controlBuffer = Buffer.alloc(0);

  const result = (): SupervisedProcessResult => {
    const sanitized = sanitizeSupervisedOutput(outputParts.join(""), options.redactValues);
    const sanitizedBytes = Buffer.byteLength(sanitized, "utf8");
    return {
      termination,
      spawnErrorCode,
      exitCode,
      signal: exitSignal,
      durationMs: Math.max(0, Date.now() - startedAt),
      output: {
        text: boundUtf8Text(sanitized, options.outputLimitBytes),
        capturedBytes,
        stdoutBytes,
        stderrBytes,
        truncated: capturedBytes < stdoutBytes + stderrBytes || sanitizedBytes > options.outputLimitBytes,
      },
    };
  };

  const child = spawn(supervisedCommand, supervisedArgs, {
    cwd: options.cwd,
    detached: processTree.detachChild,
    env: { ...options.env },
    shell: false,
    stdio: options.orphanGuard === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const rootPid = child.pid;
  if (child.stdout === null || child.stderr === null) {
    child.kill();
    termination = "SPAWN_FAILED";
    spawnErrorCode = "STDIO_UNAVAILABLE";
    return result();
  }
  const childStdout = child.stdout;
  const childStderr = child.stderr;

  return await new Promise<SupervisedProcessResult>((resolve) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", cancel);
      resolve(result());
    };

    const finishAfterStop = (): void => {
      if (stopPromise === undefined) {
        finish();
      } else {
        void stopPromise.then(finish);
      }
    };

    const stop = (reason: Exclude<SupervisedProcessTermination, "EXITED" | "SPAWN_FAILED">): void => {
      if (stopPromise !== undefined || closeObserved) return;
      termination = reason;
      stopPromise = (async () => {
        if (rootPid === undefined) return;
        if (options.orphanGuard !== undefined && child.stdin !== null) {
          try {
            child.stdin.end();
          } catch {
            // A closed control pipe is already the supervisor's stop signal.
          }
        } else {
          await processTree.gracefulStop(rootPid).catch(() => undefined);
        }
        const supervisorWaitMs =
          options.orphanGuard === undefined
            ? graceMs
            : graceMs + FORCE_EXIT_WAIT_MS + SUPERVISOR_FINALIZATION_WAIT_MS;
        await Promise.race([closed.promise, delay(supervisorWaitMs)]);
        if (processTree.treeExists(rootPid)) {
          await processTree.forceStop(rootPid).catch(() => undefined);
          await Promise.race([closed.promise, delay(FORCE_EXIT_WAIT_MS)]);
        }
        if (!hasClosed() && processTree.treeExists(rootPid)) {
          termination = "TERMINATION_FAILED";
        }
        if (
          recordFile !== null &&
          options.orphanGuard !== undefined &&
          !(await verificationProcessIsStopped(recordFile, options.orphanGuard.runId).catch(() => false))
        ) {
          termination = "TERMINATION_FAILED";
        }
      })();
    };

    const append = (channel: "stdout" | "stderr", chunk: Buffer): void => {
      if (channel === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      const remaining = Math.max(0, options.outputLimitBytes - capturedBytes);
      const kept = chunk.subarray(0, Math.min(remaining, chunk.byteLength));
      if (kept.byteLength > 0) {
        capturedBytes += kept.byteLength;
        const decoder = channel === "stdout" ? stdoutDecoder : stderrDecoder;
        const decoded = decoder.write(kept);
        if (decoded !== "") outputParts.push(`[${channel}] ${decoded}`);
      }
      if (stdoutBytes + stderrBytes > options.outputLimitBytes) {
        stop("OUTPUT_LIMIT_REACHED");
      }
    };

    const flush = (channel: "stdout" | "stderr"): void => {
      const decoded = channel === "stdout" ? stdoutDecoder.end() : stderrDecoder.end();
      if (decoded !== "") outputParts.push(`[${channel}] ${decoded}`);
    };

    function cancel(): void {
      stop("CANCELLED");
    }

    const deadlineTimer = setTimeout(() => {
      stop("TIMED_OUT");
    }, options.deadlineMs);
    deadlineTimer.unref();

    childStdout.on("data", (chunk: Buffer) => {
      append("stdout", chunk);
    });
    childStderr.on("data", (chunk: Buffer) => {
      append("stderr", chunk);
    });
    childStdout.once("end", () => {
      flush("stdout");
    });
    childStderr.once("end", () => {
      flush("stderr");
    });
    if (options.orphanGuard !== undefined && controlToken !== null) {
      const control = child.stdio[3];
      control?.on("data", (chunk: Buffer) => {
        controlBuffer = Buffer.concat([controlBuffer, chunk]);
        if (controlBuffer.byteLength > 1_024) {
          stop("TERMINATION_FAILED");
          return;
        }
        let newline = controlBuffer.indexOf(0x0a);
        while (newline !== -1) {
          const message = controlBuffer.subarray(0, newline).toString("utf8");
          controlBuffer = controlBuffer.subarray(newline + 1);
          if (message === `READY:${controlToken}` && !supervisorReady) {
            supervisorReady = true;
            child.stdin?.write(`GO:${controlToken}\n`);
          } else {
            const exit = new RegExp(`^EXIT:${controlToken}:(-?\\d+|null):(SIG[A-Z0-9]+|null)$`, "u").exec(
              message,
            );
            if (exit === null) {
              stop("TERMINATION_FAILED");
              return;
            }
            const code = exit[1] === "null" ? null : Number(exit[1]);
            const signal = exit[2] === "null" ? null : (exit[2] as NodeJS.Signals);
            if ((code !== null && !Number.isSafeInteger(code)) || targetExit !== null) {
              stop("TERMINATION_FAILED");
              return;
            }
            targetExit = { code, signal };
          }
          newline = controlBuffer.indexOf(0x0a);
        }
      });
      control?.once("error", () => {
        stop("TERMINATION_FAILED");
      });
    }
    child.once("error", (error: Error) => {
      termination = "SPAWN_FAILED";
      spawnErrorCode = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN_SPAWN_ERROR";
      closeObserved = true;
      closed.resolve(true);
      finish();
    });
    child.once("close", (code, signal) => {
      void (async (): Promise<void> => {
        const recordStopped =
          recordFile === null ||
          options.orphanGuard === undefined ||
          (await verificationProcessIsStopped(recordFile, options.orphanGuard.runId));
        if (!recordStopped) {
          termination = "TERMINATION_FAILED";
          exitCode = null;
          exitSignal = null;
        } else if (options.orphanGuard !== undefined && (!supervisorReady || targetExit === null)) {
          if (termination === "EXITED") {
            termination = "SPAWN_FAILED";
            spawnErrorCode = "SUPERVISOR_START_FAILED";
          }
          exitCode = code;
          exitSignal = signal;
        } else {
          exitCode = targetExit?.code ?? code;
          exitSignal = targetExit?.signal ?? signal;
        }
        closeObserved = true;
        closed.resolve(true);
        finishAfterStop();
      })();
    });
    if (options.signal?.aborted === true) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
  });
};
