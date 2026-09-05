import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSupervisedProcess } from "../src/index.js";

describe("supervised local process", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("passes every argument as inert argv with no shell interpretation", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail argv test "));
    roots.push(root);
    const marker = join(root, "must-not-exist");
    const payload = `; require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`;

    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", payload],
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      deadlineMs: 2_000,
      graceMs: 100,
      outputLimitBytes: 4_096,
      redactValues: [],
    });

    expect(result.termination).toBe("EXITED");
    expect(result.exitCode).toBe(0);
    expect(result.output.text).toContain(payload);
    await expect(access(marker)).rejects.toThrow();
  });

  it("bounds aggregate output, kills the process tree and reports observed byte counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail output test "));
    roots.push(root);

    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)'],
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      deadlineMs: 2_000,
      graceMs: 50,
      outputLimitBytes: 128,
      redactValues: [],
    });

    expect(result.termination).toBe("OUTPUT_LIMIT_REACHED");
    expect(result.output.capturedBytes).toBe(128);
    expect(result.output.stdoutBytes).toBeGreaterThan(128);
    expect(result.output.truncated).toBe(true);
  });

  it("removes control sequences and exact sensitive values from captured text", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail redact test "));
    roots.push(root);
    const secret = "canary-secret-123456";

    const result = await runSupervisedProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(`\u001b[31m${secret}\u001b[0m\u001b]8;;https://bad.example\u0007click\u001b]8;;\u0007`)})`,
      ],
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      deadlineMs: 2_000,
      graceMs: 100,
      outputLimitBytes: 4_096,
      redactValues: [secret],
    });

    expect(result.termination).toBe("EXITED");
    expect(result.output.text).toContain("[REDACTED]");
    expect(result.output.text).toContain("click");
    expect(result.output.text).not.toContain(secret);
    expect(result.output.text).not.toContain("bad.example");
    expect(result.output.text).not.toContain("\u001b");
  });

  it("distinguishes deadline and owner cancellation while waiting for real exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail stop test "));
    roots.push(root);
    const common = {
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      graceMs: 50,
      outputLimitBytes: 4_096,
      redactValues: [] as string[],
    };

    const timedOut = await runSupervisedProcess({ ...common, deadlineMs: 80 });
    expect(timedOut.termination).toBe("TIMED_OUT");
    expect(timedOut.signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL");

    const authority = new AbortController();
    const cancelledPromise = runSupervisedProcess({
      ...common,
      deadlineMs: 2_000,
      signal: authority.signal,
    });
    setTimeout(() => {
      authority.abort();
    }, 50);
    const cancelled = await cancelledPromise;
    expect(cancelled.termination).toBe("CANCELLED");
  });

  it("reports spawn failure as data", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail spawn test "));
    roots.push(root);
    const result = await runSupervisedProcess({
      command: `missing-loomrail-command-${process.pid.toString()}`,
      args: ["literal"],
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      deadlineMs: 1_000,
      graceMs: 50,
      outputLimitBytes: 4_096,
      redactValues: [],
    });

    expect(result).toMatchObject({ termination: "SPAWN_FAILED", exitCode: null, signal: null });
  });
});
