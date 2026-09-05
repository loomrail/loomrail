import { describe, expect, it } from "vitest";

import {
  ProcessListenerError,
  ProcessSpawnError,
  runProcess,
  type ProcessExitOutcome,
} from "../src/process-runner.js";

// A real child process, not a double: the thing under test IS the process boundary. A double
// would only prove that the double behaves as written.
const node = process.execPath;

// Timeout used only to race against a promise under test; never left to keep the test runner
// itself alive.
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

// Waits for the child to print a specific line before the test signals it. Sending a signal
// before a freshly spawned child has installed its own handler races the child's startup: on a
// loaded machine the OS default disposition (terminate) can win before the handler exists, which
// would kill the child outright instead of exercising escalation. Rather than guess a duration,
// the child announces the handler is installed and the test waits for that announcement -- a real
// synchronisation on the thing being waited for, which holds at any load.
const waitForLine = (marker: string): { promise: Promise<void>; onLine: (line: string) => void } => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    onLine: (line) => {
      if (line === marker) {
        resolvePromise?.();
      }
    },
  };
};

const HUNG = "hung" as const;

// Bounds a wait on `exited` against a generous, explicit deadline so that a regression which
// makes the child un-killable reads as a real assertion failure ("expected 'hung' not to be
// 'hung'") instead of an opaque harness timeout, which is indistinguishable from this machine
// merely being slow.
const raceAgainstHang = (
  exited: Promise<ProcessExitOutcome>,
  boundMs: number,
): Promise<ProcessExitOutcome | typeof HUNG> => Promise.race([exited, delay(boundMs).then(() => HUNG)]);

describe("runProcess", () => {
  it("delivers stdout as whole lines even when the child writes them in pieces", async () => {
    const lines: string[] = [];
    const run = runProcess({
      command: node,
      args: ["-e", `process.stdout.write("{\\"a\\":1}\\n{\\"b\\":"); process.stdout.write("2}\\n");`],
      cwd: process.cwd(),
      onLine: (line) => lines.push(line),
      onStderr: () => undefined,
      deadlineMs: 10_000,
    });
    await run.exited;
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  // The claim A1.5 deferred to this milestone: resolving is not the same as having stopped. The
  // check is against the real OS process table (`process.kill(pid, 0)`), not against this
  // module's own bookkeeping -- otherwise a `stop()` that resolves `exited` itself, instead of
  // waiting for the real `exit` event, would look identical to a correct implementation, since
  // both make `exited` become true by the time `stop()` returns.
  it("resolves `exited` only after the child has really gone", async () => {
    const armed = waitForLine("armed");
    const run = runProcess({
      command: node,
      args: ["-e", "process.on('SIGTERM', () => {}); console.log('armed'); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      onLine: armed.onLine,
      onStderr: () => undefined,
      deadlineMs: 30_000,
      graceMs: 200,
    });
    await armed.promise;

    const pid = run.pid;
    if (pid === undefined) {
      throw new Error("expected runProcess to report a pid for a spawned child");
    }

    let aliveWhenExitedResolved = true;
    void run.exited.then(() => {
      try {
        process.kill(pid, 0);
        aliveWhenExitedResolved = true;
      } catch {
        // ESRCH: the OS confirms the process is really gone.
        aliveWhenExitedResolved = false;
      }
    });

    await run.stop();
    expect(aliveWhenExitedResolved).toBe(false);
  });

  it("stops a child that ignores termination where the platform permits it", async () => {
    const armed = waitForLine("armed");
    const run = runProcess({
      command: node,
      args: ["-e", "process.on('SIGTERM', () => {}); console.log('armed'); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      onLine: armed.onLine,
      onStderr: () => undefined,
      deadlineMs: 30_000,
      graceMs: 200,
    });
    await armed.promise;
    void run.stop();

    const outcome = await raceAgainstHang(run.exited, 2_000);
    expect(outcome).not.toBe(HUNG);
    if (outcome === HUNG) {
      return;
    }
    // Windows has no POSIX signal delivery: Node forcefully terminates the process on the first
    // SIGTERM and reports that requested signal. On POSIX the child can really ignore SIGTERM, so
    // runProcess must reach its post-grace SIGKILL escalation.
    expect(outcome.signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  });

  it("stops a child that produces nothing once its deadline passes", async () => {
    const run = runProcess({
      command: node,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      onLine: () => undefined,
      onStderr: () => undefined,
      deadlineMs: 150,
      graceMs: 100,
    });
    const outcome = await run.exited;
    expect(outcome.code === null || outcome.code !== 0).toBe(true);
  });

  it("is safe to stop twice", async () => {
    const run = runProcess({
      command: node,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      onLine: () => undefined,
      onStderr: () => undefined,
      deadlineMs: 30_000,
      graceMs: 100,
    });
    await run.stop();
    await expect(run.stop()).resolves.toBeUndefined();
  });

  // A CLI that ends its output without a trailing newline used to have its last line held in the
  // splitter's buffer forever. For an adapter that reads its whole result off the final line, that
  // is "the parser saw nothing" -- the exact failure shape of both of this milestone's Criticals.
  it("delivers a final line the child never terminated with a newline", async () => {
    const lines: string[] = [];
    const run = runProcess({
      command: node,
      args: ["-e", `process.stdout.write("{\\"a\\":1}\\n{\\"b\\":2}");`],
      cwd: process.cwd(),
      onLine: (line) => lines.push(line),
      onStderr: () => undefined,
      deadlineMs: 10_000,
    });
    await run.exited;
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  // The flush must not become a way around the cap: a child could otherwise send a gigabyte with
  // no newline at all and have it delivered whole at stream end.
  it("does not deliver an overlong final line through the end-of-stream flush", async () => {
    const lines: string[] = [];
    const run = runProcess({
      command: node,
      args: ["-e", `process.stdout.write("kept\\n" + "x".repeat(1_100_000));`],
      cwd: process.cwd(),
      onLine: (line) => lines.push(line),
      onStderr: () => undefined,
      deadlineMs: 20_000,
    });
    await run.exited;
    expect(lines).toEqual(["kept"]);
  });

  it("drops a line longer than the cap instead of buffering it forever", async () => {
    const lines: string[] = [];
    const run = runProcess({
      command: node,
      args: ["-e", `process.stdout.write("x".repeat(1_100_000) + "\\nkept\\n");`],
      cwd: process.cwd(),
      onLine: (line) => lines.push(line),
      onStderr: () => undefined,
      deadlineMs: 20_000,
    });
    await run.exited;
    expect(lines).toEqual(["kept"]);
  });

  // With no `error` listener on the child, a bad executable is an uncaught exception that takes
  // the daemon down instead of something a caller can react to -- and a later task has to turn
  // exactly this into "provider unavailable" when a CLI is not installed.
  it("keeps a line that never ends bounded, not just its first megabyte", async () => {
    // 3 MB without a newline, written in chunks: the cap used to reset after the first drop and let
    // every later chunk accumulate again.
    const lines: string[] = [];
    const run = runProcess({
      command: node,
      args: [
        "-e",
        `const chunk = "x".repeat(65536); for (let i = 0; i < 48; i += 1) process.stdout.write(chunk); process.stdout.write("\\ntail\\n");`,
      ],
      cwd: process.cwd(),
      onLine: (line) => lines.push(line),
      onStderr: () => undefined,
      deadlineMs: 20_000,
    });
    await run.exited;
    expect(lines).toEqual(["tail"]);
  });

  it("turns a throwing line listener into a stopped child and a typed rejection", async () => {
    const seen: string[] = [];
    const run = runProcess({
      command: node,
      args: [
        "-e",
        `console.log("first"); console.log("second"); setInterval(() => console.log("more"), 50);`,
      ],
      cwd: process.cwd(),
      onLine: (line) => {
        seen.push(line);
        if (line === "second") throw new Error("the store refused this line");
      },
      onStderr: () => undefined,
      deadlineMs: 20_000,
    });
    await expect(run.exited).rejects.toBeInstanceOf(ProcessListenerError);
    expect(seen).toEqual(["first", "second"]);
    await expect(run.stop()).resolves.toBeUndefined();
  });

  it("reports an argument spawn refuses (a NUL byte) as a spawn failure, not a thrown TypeError", async () => {
    const run = runProcess({
      command: node,
      args: ["-e", "process.exit(0)", "a\u0000b"],
      cwd: process.cwd(),
      onLine: () => undefined,
      onStderr: () => undefined,
      deadlineMs: 10_000,
    });
    await expect(run.exited).rejects.toBeInstanceOf(ProcessSpawnError);
    expect(run.pid).toBeUndefined();
    await expect(run.stop()).resolves.toBeUndefined();
  });

  it("reports a spawn failure through `exited` instead of crashing the process", async () => {
    const run = runProcess({
      command: "/definitely/not/a/real/executable-loomrail-test",
      args: [],
      cwd: process.cwd(),
      onLine: () => undefined,
      onStderr: () => undefined,
      deadlineMs: 5_000,
    });
    await expect(run.exited).rejects.toBeInstanceOf(ProcessSpawnError);
  });
});
