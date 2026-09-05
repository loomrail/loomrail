import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareVerificationProcessIntent,
  recoverVerificationRunProcesses,
  removeVerificationProcessRecord,
  runSupervisedProcess,
  verificationProcessIsStopped,
  verificationProcessRecordPath,
  type ProcessTreeOperations,
} from "../src/index.js";

const verificationSupervisorEntrypoint = fileURLToPath(
  new URL("../dist/verification-supervisor.js", import.meta.url),
);

describe("supervised local process", () => {
  const roots: string[] = [];
  const fixturePids: number[] = [];

  const processExists = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const waitUntilGone = async (pids: readonly number[]): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (pids.every((pid) => !processExists(pid))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The supervised process tree is still alive: ${pids.join(",")}`);
  };

  afterEach(async () => {
    for (const pid of fixturePids.splice(0)) {
      if (!processExists(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Test cleanup only; the process may have exited between the probe and signal.
      }
    }
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
    expect(Buffer.byteLength(result.output.text, "utf8")).toBeLessThanOrEqual(128);
  });

  it("leaves no signal-resistant descendant after an output-bound stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail descendant test "));
    roots.push(root);
    const pidFile = join(root, "tree-pids.json");
    const readyFile = join(root, "descendant-ready");
    const registryDirectory = join(root, "processes");
    const runId = "verification-run-resistant-descendant";
    const descendantSource = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      'fs.writeFileSync(process.argv[1], "ready");',
      "setInterval(() => {}, 1000);",
    ].join("");
    const rootSource = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, ${JSON.stringify(readyFile)}], { stdio: "ignore", windowsHide: true });`,
      'process.on("SIGTERM", () => {});',
      "const ready = setInterval(() => {",
      `if (!fs.existsSync(${JSON.stringify(readyFile)})) return;`,
      "clearInterval(ready);",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ rootPid: process.pid, descendantPid: descendant.pid }));`,
      'process.stdout.write("x".repeat(4096));',
      "}, 10);",
      "setInterval(() => {}, 1000);",
    ].join("");

    await prepareVerificationProcessIntent(registryDirectory, runId);
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", rootSource],
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      deadlineMs: 10_000,
      graceMs: 100,
      outputLimitBytes: 128,
      redactValues: [],
      orphanGuard: { runId, registryDirectory, supervisorEntrypoint: verificationSupervisorEntrypoint },
    });
    const parsed = JSON.parse(await readFile(pidFile, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("rootPid" in parsed) ||
      typeof parsed.rootPid !== "number" ||
      !("descendantPid" in parsed) ||
      typeof parsed.descendantPid !== "number"
    ) {
      throw new Error("The process-tree fixture did not report numeric pids");
    }
    const pids = [parsed.rootPid, parsed.descendantPid];
    fixturePids.push(...pids);

    expect(result.termination).toBe("OUTPUT_LIMIT_REACHED");
    await waitUntilGone(pids);
    await expect(
      verificationProcessIsStopped(verificationProcessRecordPath(registryDirectory, runId), runId),
    ).resolves.toBe(true);
    await removeVerificationProcessRecord(registryDirectory, runId);
  }, 15_000);

  it("reaps an ignored descendant before reporting a successful root exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail successful descendant "));
    roots.push(root);
    const pidFile = join(root, "successful-descendant-pid");
    const registryDirectory = join(root, "processes");
    const runId = "verification-run-successful-descendant";
    const descendantSource = "setInterval(() => {}, 1000);";
    const rootSource = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore", windowsHide: true });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, descendant.pid.toString());`,
      "descendant.unref();",
    ].join("");

    await prepareVerificationProcessIntent(registryDirectory, runId);
    const result = await runSupervisedProcess({
      command: process.execPath,
      args: ["-e", rootSource],
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      deadlineMs: 10_000,
      graceMs: 100,
      outputLimitBytes: 4_096,
      redactValues: [],
      orphanGuard: { runId, registryDirectory, supervisorEntrypoint: verificationSupervisorEntrypoint },
    });
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    if (!Number.isSafeInteger(descendantPid) || descendantPid <= 0) {
      throw new Error("The successful process-tree fixture did not report its descendant pid");
    }
    fixturePids.push(descendantPid);

    expect(result).toMatchObject({ termination: "EXITED", exitCode: 0, signal: null });
    await waitUntilGone([descendantPid]);
    await expect(
      verificationProcessIsStopped(verificationProcessRecordPath(registryDirectory, runId), runId),
    ).resolves.toBe(true);
    await removeVerificationProcessRecord(registryDirectory, runId);
  }, 15_000);

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

    const timedOut = await runSupervisedProcess({ ...common, deadlineMs: 500 });
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

  it("reaps only a durable process identity before recovery releases its Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail verification orphan "));
    roots.push(root);
    const registryDirectory = join(root, "processes");
    await mkdir(registryDirectory, { recursive: true });
    const runId = "verification-run-orphan";
    const recordPath = verificationProcessRecordPath(registryDirectory, runId);
    const recordedAt = "2026-09-05T10:00:00.000Z";
    await writeFile(
      recordPath,
      JSON.stringify({
        schemaVersion: 1,
        runId,
        state: "ACTIVE",
        supervisorPid: 101,
        supervisorStartedAt: recordedAt,
        targetPid: 102,
        targetStartedAt: recordedAt,
      }),
    );
    const alive = new Set([101, 102]);
    const stopped: number[] = [];
    const processTree: ProcessTreeOperations = {
      detachChild: true,
      orphanRecoveryRequiresLiveRootIdentity: false,
      pidExists: (pid) => alive.has(pid),
      treeExists: (pid) => alive.has(pid),
      gracefulStop: (pid) => {
        stopped.push(pid);
        alive.delete(pid);
        return Promise.resolve();
      },
      forceStop: (pid) => {
        stopped.push(pid);
        alive.delete(pid);
        return Promise.resolve();
      },
      reapDescendants: () => Promise.resolve(true),
      startedAt: () => Promise.resolve(new Date(recordedAt)),
    };

    await expect(
      recoverVerificationRunProcesses({
        registryDirectory,
        runIds: [runId],
        now: () => new Date(recordedAt),
        processTree,
      }),
    ).resolves.toEqual([
      {
        runId,
        recordFile: basename(recordPath),
        action: "KILLED",
        reason: "IDENTITY_CONFIRMED",
      },
    ]);
    expect(stopped).toEqual([102, 101]);
    await expect(verificationProcessIsStopped(recordPath, runId)).resolves.toBe(true);
  });

  it("refuses to signal or release a reused process identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail verification reused pid "));
    roots.push(root);
    const registryDirectory = join(root, "processes");
    await mkdir(registryDirectory, { recursive: true });
    const runId = "verification-run-reused-pid";
    const recordPath = verificationProcessRecordPath(registryDirectory, runId);
    await writeFile(
      recordPath,
      JSON.stringify({
        schemaVersion: 1,
        runId,
        state: "ACTIVE",
        supervisorPid: 201,
        supervisorStartedAt: "2026-09-05T10:00:00.000Z",
        targetPid: 202,
        targetStartedAt: "2026-09-05T10:00:00.000Z",
      }),
    );
    const stopped: number[] = [];
    const processTree: ProcessTreeOperations = {
      detachChild: true,
      orphanRecoveryRequiresLiveRootIdentity: false,
      pidExists: () => true,
      treeExists: () => true,
      gracefulStop: (pid) => {
        stopped.push(pid);
        return Promise.resolve();
      },
      forceStop: (pid) => {
        stopped.push(pid);
        return Promise.resolve();
      },
      reapDescendants: () => Promise.resolve(false),
      startedAt: () => Promise.resolve(new Date("2026-09-05T11:00:00.000Z")),
    };

    await expect(
      recoverVerificationRunProcesses({
        registryDirectory,
        runIds: [runId],
        now: () => new Date("2026-09-05T11:00:00.000Z"),
        processTree,
      }),
    ).resolves.toEqual([
      {
        runId,
        recordFile: basename(recordPath),
        action: "BLOCKED",
        reason: "START_TIME_MISMATCH",
      },
    ]);
    expect(stopped).toEqual([]);
    await expect(access(recordPath)).resolves.toBeUndefined();
  });

  it("blocks Windows recovery when the recorded root vanished before identity could be checked", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail verification missing windows root "));
    roots.push(root);
    const registryDirectory = join(root, "processes");
    await mkdir(registryDirectory, { recursive: true });
    const runId = "verification-run-missing-windows-root";
    const recordPath = verificationProcessRecordPath(registryDirectory, runId);
    const recordedAt = "2026-09-05T10:00:00.000Z";
    await writeFile(
      recordPath,
      JSON.stringify({
        schemaVersion: 1,
        runId,
        state: "ACTIVE",
        supervisorPid: 301,
        supervisorStartedAt: recordedAt,
        targetPid: 302,
        targetStartedAt: recordedAt,
      }),
    );
    let descendantReapCalled = false;
    const processTree: ProcessTreeOperations = {
      detachChild: false,
      orphanRecoveryRequiresLiveRootIdentity: true,
      pidExists: () => false,
      treeExists: () => false,
      gracefulStop: () => Promise.resolve(),
      forceStop: () => Promise.resolve(),
      reapDescendants: () => {
        descendantReapCalled = true;
        return Promise.resolve(true);
      },
      startedAt: () => Promise.resolve(null),
    };

    await expect(
      recoverVerificationRunProcesses({
        registryDirectory,
        runIds: [runId],
        now: () => new Date(recordedAt),
        processTree,
      }),
    ).resolves.toEqual([
      {
        runId,
        recordFile: basename(recordPath),
        action: "BLOCKED",
        reason: "TARGET_IDENTITY_UNKNOWN",
      },
    ]);
    expect(descendantReapCalled).toBe(false);
    await expect(access(recordPath)).resolves.toBeUndefined();
  });

  it("retains a pre-spawn intent as proof that no child was started", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail verification intent "));
    roots.push(root);
    const registryDirectory = join(root, "processes");
    const runId = "verification-run-intent-only";
    const recordPath = await prepareVerificationProcessIntent(registryDirectory, runId);

    await expect(recoverVerificationRunProcesses({ registryDirectory, runIds: [runId] })).resolves.toEqual([
      {
        runId,
        recordFile: basename(recordPath),
        action: "CONFIRMED",
        reason: "NO_PROCESS_STARTED",
      },
    ]);
    await expect(access(recordPath)).resolves.toBeUndefined();
  });

  it("kills a resistant child tree when the daemon control pipe disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail verification parent crash "));
    roots.push(root);
    const registryDirectory = join(root, "processes");
    const runId = "verification-run-parent-crash";
    const recordPath = await prepareVerificationProcessIntent(registryDirectory, runId);
    const pidFile = join(root, "orphan-pids.json");
    const readyFile = join(root, "orphan-ready");
    const descendantSource = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      'fs.writeFileSync(process.argv[1], "ready");',
      "setInterval(() => {}, 1000);",
    ].join("");
    const rootSource = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, ${JSON.stringify(readyFile)}], { stdio: "ignore", windowsHide: true });`,
      'process.on("SIGTERM", () => {});',
      "const ready = setInterval(() => {",
      `if (!fs.existsSync(${JSON.stringify(readyFile)})) return;`,
      "clearInterval(ready);",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ rootPid: process.pid, descendantPid: descendant.pid }));`,
      "}, 10);",
      "setInterval(() => {}, 1000);",
    ].join("");
    const token = "a".repeat(43);
    const supervisor = spawn(
      process.execPath,
      [
        verificationSupervisorEntrypoint,
        "--parent-pid",
        process.pid.toString(),
        "--control-token",
        token,
        "--run-id",
        runId,
        "--registry-file",
        recordPath,
        "--grace-ms",
        "100",
        "--",
        process.execPath,
        "-e",
        rootSource,
      ],
      { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"], windowsHide: true },
    );
    supervisor.stdout.on("data", () => undefined);
    supervisor.stderr.on("data", () => undefined);
    const control = supervisor.stdio[3];
    if (control === null || control === undefined) throw new Error("Supervisor control pipe is missing");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Supervisor did not become ready"));
      }, 5_000);
      control.once("data", (chunk: Buffer) => {
        clearTimeout(timeout);
        if (chunk.toString("utf8") !== `READY:${token}\n`) {
          reject(new Error("Supervisor returned an invalid ready frame"));
          return;
        }
        resolve();
      });
    });
    supervisor.stdin.write(`GO:${token}\n`);
    let parsed: { rootPid: number; descendantPid: number } | null = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && parsed === null) {
      try {
        parsed = JSON.parse(await readFile(pidFile, "utf8")) as {
          rootPid: number;
          descendantPid: number;
        };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (parsed === null) throw new Error("The supervised orphan fixture did not start");
    const pids = [parsed.rootPid, parsed.descendantPid];
    fixturePids.push(...pids);
    supervisor.stdin.end();
    await new Promise<void>((resolve) =>
      supervisor.once("close", () => {
        resolve();
      }),
    );

    await waitUntilGone(pids);
    await expect(verificationProcessIsStopped(recordPath, runId)).resolves.toBe(true);
    await removeVerificationProcessRecord(registryDirectory, runId);
  }, 15_000);
});
