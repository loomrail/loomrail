import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { createProcessTreeOperations, type ProcessTreeOperations } from "./process-tree.js";

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
};

const DEFAULT_GRACE_MS = 5_000;
const FORCE_EXIT_WAIT_MS = 2_000;

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

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    detached: processTree.detachChild,
    env: { ...options.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const rootPid = child.pid;

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
        try {
          await processTree.gracefulStop(rootPid);
          await Promise.race([closed.promise, delay(graceMs)]);
          if (processTree.treeExists(rootPid)) {
            await processTree.forceStop(rootPid);
            await Promise.race([closed.promise, delay(FORCE_EXIT_WAIT_MS)]);
          }
          if (!hasClosed() && processTree.treeExists(rootPid)) {
            termination = "TERMINATION_FAILED";
          }
        } catch {
          if (!hasClosed() && processTree.treeExists(rootPid)) {
            termination = "TERMINATION_FAILED";
          }
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

    child.stdout.on("data", (chunk: Buffer) => {
      append("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append("stderr", chunk);
    });
    child.stdout.once("end", () => {
      flush("stdout");
    });
    child.stderr.once("end", () => {
      flush("stderr");
    });
    child.once("error", (error: Error) => {
      termination = "SPAWN_FAILED";
      spawnErrorCode = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN_SPAWN_ERROR";
      closeObserved = true;
      closed.resolve(true);
      finish();
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closeObserved = true;
      closed.resolve(true);
      finishAfterStop();
    });
    if (options.signal?.aborted === true) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
  });
};
