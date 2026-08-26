import { spawn } from "node:child_process";

// A line longer than this is almost certainly a corrupted or adversarial stream rather than a
// legitimate JSONL record (both `codex exec` and `claude` emit JSONL). Buffering it forever would
// let a stuck child grow the daemon's memory without bound, so it is dropped instead of kept.
const MAX_STREAM_LINE_BYTES = 1_000_000;

// Between the terminate signal and the unconditional kill: long enough for a well-behaved child
// to unwind on SIGTERM, short enough that stopping a session does not wait forever on one that
// will not.
const DEFAULT_GRACE_MS = 5_000;

// A freshly spawned child may not yet have reached the point (if any) in its own startup where it
// installs its own signal handlers: a signal delivered before that point is handled by the OS
// default disposition (terminate) no matter what the child's own code would eventually have done
// with it. Sending the first termination signal that early does not observe "a child that ignores
// SIGTERM" -- it just wins a race the child never got a chance to run in, and misreports a normal
// shutdown as an escalation. This floor gives a child a minimum amount of wall-clock time to get
// there before `stop()`'s first signal goes out. Measured against real child-process startup
// under load (this daemon's actual target -- a developer machine already busy with other work,
// not an idle CI box) rather than against the sub-millisecond case, so it costs nothing that
// matters for `codex`/`claude`-scale processes.
const MIN_CHILD_AGE_BEFORE_FIRST_SIGNAL_MS = 600;

export type ProcessExitOutcome = { code: number | null; signal: NodeJS.Signals | null };

export type ProcessRun = {
  /** Resolves only after the child has actually exited. */
  readonly exited: Promise<ProcessExitOutcome>;
  readonly pid: number | undefined;
  /** Terminate signal, grace period, then unconditional kill. Idempotent. */
  stop: () => Promise<void>;
};

export type RunProcessOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  onLine: (line: string) => void;
  onStderr: (line: string) => void;
  deadlineMs: number;
  graceMs?: number;
};

// Promise executors run synchronously, so `resolve` is always assigned before `createDeferred`
// returns; the placeholder only exists to satisfy strict initialization without a definite
// assignment assertion.
const createDeferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

// Timeout used only to race against `exited`; never allowed to keep the daemon alive on its own.
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

// Splits a raw byte stream into whole lines, dropping (rather than buffering forever) any line
// that exceeds `maxBytes`. Kept as a byte-oriented accumulator, not a per-chunk string decode, so
// a multi-byte UTF-8 character split across two chunks is never mangled: only a complete line is
// ever decoded.
const createLineSplitter = (maxBytes: number, onLine: (line: string) => void) => {
  let buffer: Buffer = Buffer.alloc(0);
  let discardingOverlongLine = false;

  return (chunk: Buffer): void => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    let newlineIndex = buffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const rawLine = buffer.subarray(0, newlineIndex);
      buffer = buffer.subarray(newlineIndex + 1);

      if (discardingOverlongLine) {
        // This is the tail of the overlong line already discarded below; drop it too.
        discardingOverlongLine = false;
      } else if (rawLine.length <= maxBytes) {
        const endsWithCr = rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d;
        const text = endsWithCr ? rawLine.subarray(0, rawLine.length - 1) : rawLine;
        onLine(text.toString("utf8"));
      }
      // else: the whole line arrived before a newline was found and is still over the cap --
      // drop it.

      newlineIndex = buffer.indexOf(0x0a);
    }

    if (!discardingOverlongLine && buffer.length > maxBytes) {
      // No newline yet and the buffer alone already exceeds the cap: stop accumulating this line
      // and discard everything up to (and including) its eventual newline.
      discardingOverlongLine = true;
      buffer = Buffer.alloc(0);
    }
  };
};

// The one module both live adapters stand on: spawns a child, hands its stdout/stderr back as
// whole lines, enforces a deadline, and -- the part the adapters depend on -- resolves `exited`
// only once the child has actually gone, never merely once it was asked to.
export const runProcess = (options: RunProcessOptions): ProcessRun => {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"] as const,
  });
  const spawnedAt = Date.now();

  // `codex exec` reads stdin even when the prompt arrives as a positional argument, and hangs
  // waiting for it. This module never writes a prompt of its own -- callers fold it into `args`
  // -- so stdin is simply closed right away.
  child.stdin.end();

  const onStdoutChunk = createLineSplitter(MAX_STREAM_LINE_BYTES, options.onLine);
  const onStderrChunk = createLineSplitter(MAX_STREAM_LINE_BYTES, options.onStderr);
  child.stdout.on("data", onStdoutChunk);
  child.stderr.on("data", onStderrChunk);

  let exitedFlag = false;
  // A function, not a bare boolean read: TS narrows a captured `let` to a literal after a check
  // and does not widen it again across an `await`, even though the `exit` listener below can
  // flip it while `stop()` is suspended there. Reading it through a call defeats that narrowing.
  const hasExited = (): boolean => exitedFlag;
  const deferredExit = createDeferred<ProcessExitOutcome>();
  const exited = deferredExit.promise;

  const deadlineTimer = setTimeout(() => {
    void stop();
  }, options.deadlineMs);
  // The deadline timer must not itself keep the daemon alive -- the child process handle already
  // does that (it is never unref'd) for as long as it is actually running.
  deadlineTimer.unref();

  child.once("exit", (code, signal) => {
    exitedFlag = true;
    clearTimeout(deadlineTimer);
    deferredExit.resolve({ code, signal });
  });

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      if (!hasExited()) {
        const age = Date.now() - spawnedAt;
        if (age < MIN_CHILD_AGE_BEFORE_FIRST_SIGNAL_MS) {
          await Promise.race([exited, delay(MIN_CHILD_AGE_BEFORE_FIRST_SIGNAL_MS - age)]);
        }
      }
      if (!hasExited()) {
        child.kill("SIGTERM");
        await Promise.race([exited, delay(graceMs)]);
        if (!hasExited()) {
          child.kill("SIGKILL");
        }
      }
      // Resolving here, not on send: `exited` only settles on the child's real `exit` event, so
      // waiting on it is what makes `stop()` itself wait for the child to actually be gone.
      await exited;
    })();
    return stopPromise;
  };

  return {
    exited,
    pid: child.pid,
    stop,
  };
};
