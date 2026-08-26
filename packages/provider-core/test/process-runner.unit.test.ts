import { describe, expect, it } from "vitest";

import { runProcess } from "../src/process-runner.js";

// A real child process, not a double: the thing under test IS the process boundary. A double
// would only prove that the double behaves as written.
const node = process.execPath;

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

  // The claim A1.5 deferred to this milestone: resolving is not the same as having stopped.
  it("resolves `exited` only after the child has really gone", async () => {
    const run = runProcess({
      command: node,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      onLine: () => undefined,
      onStderr: () => undefined,
      deadlineMs: 30_000,
      graceMs: 200,
    });
    let exited = false;
    void run.exited.then(() => {
      exited = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exited).toBe(false);
    await run.stop();
    expect(exited).toBe(true);
  });

  it("kills a child that ignores the terminate signal", async () => {
    const run = runProcess({
      command: node,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      onLine: () => undefined,
      onStderr: () => undefined,
      deadlineMs: 30_000,
      graceMs: 200,
    });
    await run.stop();
    const outcome = await run.exited;
    expect(outcome.signal).toBe("SIGKILL");
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
});
