import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

// The one place in this package that drives a DOUBLE rather than a real child, and the reason is
// the property under test. `process-runner.unit.test.ts` uses real children on purpose ("the thing
// under test IS the process boundary"), but the ordering asserted here -- that stdout's residual
// line is delivered BEFORE `exited` resolves -- is a race a real child wins the safe way essentially
// always. Forty observed runs put `end` first, twice over. A test against a real child would
// therefore pass just as happily against the version that had no guarantee at all, which is exactly
// how this got shipped as "measured, not enforced". Only a child whose event order this test
// chooses can pin it.
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const { runProcess } = await import("../src/process-runner.js");

// Node's own contract, the part this module now depends on: `exit` fires when the child is reaped,
// `close` only once its stdio has closed too, and the first may precede the second.
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = { end: (): void => undefined };
  readonly pid = 4242;
  kill = (): boolean => true;
}

// One turn of the macrotask queue, which is what a PassThrough needs to deliver `data` and `end` to
// listeners attached to it.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const HUNG = "hung" as const;

// Bounds a wait on `exited` against a generous, explicit deadline, so that a regression which
// leaves it unsettled forever reads as a failed assertion naming the hang rather than as an opaque
// harness timeout, which is indistinguishable from this machine merely being slow. Same reasoning
// (and name) as `raceAgainstHang` in process-runner.unit.test.ts. The timer is unref'd and never
// waited on when `exited` settles first.
const raceAgainstHang = <T>(promise: Promise<T>, boundMs: number): Promise<T | typeof HUNG> =>
  Promise.race([
    promise,
    new Promise<typeof HUNG>((resolve) => {
      const timer = setTimeout(() => {
        resolve(HUNG);
      }, boundMs);
      timer.unref();
    }),
  ]);

const startFakeRun = (
  onLine: (line: string) => void,
): { child: FakeChild; run: ReturnType<typeof runProcess> } => {
  const child = new FakeChild();
  spawn.mockReturnValue(child);
  const run = runProcess({
    command: "fake",
    args: [],
    cwd: process.cwd(),
    onLine,
    onStderr: () => undefined,
    deadlineMs: 60_000,
  });
  return { child, run };
};

describe("runProcess exit ordering", () => {
  // The failure this pins is not "a line is lost" but "a line arrives after the only caller that
  // would have read it stopped looking": both live adapters read `finalCheckpoint` the instant
  // `exited` resolves. A checkpoint delivered a turn later is a session that reports no result at
  // all -- the shape of both of this milestone's Criticals.
  it("delivers the residual line before `exited` resolves, even when the child exits first", async () => {
    const observed: string[] = [];
    const { child, run } = startFakeRun((line) => observed.push(`line:${line}`));
    void run.exited.then(() => observed.push("exited"));

    // The documented-but-rare order, forced: the child is reaped while its stdout still holds the
    // final, newline-less line.
    child.emit("exit", 0, null);
    await tick();

    child.stdout.write('{"summary":"the last line"}');
    child.stdout.end();
    child.stderr.end();
    await tick();
    child.emit("close", 0, null);

    await expect(run.exited).resolves.toEqual({ code: 0, signal: null });
    expect(observed).toEqual(['line:{"summary":"the last line"}', "exited"]);
  });

  // Delivering the residue is now part of settling `exited`, which puts an adapter's own callback on
  // the path to that settlement -- and both live adapters do real work in `onLine` (a checkpoint
  // listener reaches the state store). A callback that throws there used to be a crash; it must not
  // become a promise that never settles, which is the same failure with nobody to notice it.
  it("settles `exited` even when a line callback throws on the residue", async () => {
    const { child, run } = startFakeRun(() => {
      throw new Error("the adapter's own listener failed");
    });

    child.stdout.write("residue with no newline");
    await tick();
    child.emit("exit", 0, null);
    await tick();

    // The throw is not swallowed -- it still leaves the handler the way it always did, which is
    // what this test observes by catching it at the emit.
    expect(() => child.emit("close", 0, null)).toThrow("the adapter's own listener failed");
    await expect(raceAgainstHang(run.exited, 1_000)).resolves.toEqual({ code: 0, signal: null });
  });

  // The other half of the same change, and the reason `exited` is not simply chained to stdout's
  // EOF: a grandchild that inherited the pipe can hold it open after the child itself is gone, and
  // a promise that never settles there would quietly undo the deadline's whole purpose. `exited`
  // waits for the drain, then stops waiting.
  it("still resolves when the child is gone and its stdio never closes", async () => {
    vi.useFakeTimers();
    try {
      const observed: string[] = [];
      const { child, run } = startFakeRun((line) => observed.push(line));

      child.stdout.write("residue with no newline");
      await vi.advanceTimersByTimeAsync(0);
      // Reaped, but nothing ever ends or closes the pipes.
      child.emit("exit", 0, null);
      // Raced against an explicit, generous bound rather than simply awaited: a regression that
      // leaves `exited` unsettled forever must read as a failed assertion naming the hang, not as
      // an opaque harness timeout indistinguishable from a slow machine. (Same reasoning as
      // `raceAgainstHang` in process-runner.unit.test.ts.)
      const settled = raceAgainstHang(run.exited, 10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(settled).resolves.toEqual({ code: 0, signal: null });
      // And the residue is still delivered on the way out, rather than being the price of the bound.
      expect(observed).toEqual(["residue with no newline"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
