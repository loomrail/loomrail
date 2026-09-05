import { describe, expect, it } from "vitest";

import {
  createProcessTreeOperations,
  stopAndReapProcessTree,
  type ProcessTreeDependencies,
} from "../src/index.js";

type SignalCall = {
  pid: number;
  signal: 0 | "SIGTERM" | "SIGKILL";
};

type ExecuteCall = {
  file: string;
  args: readonly string[];
};

const dependencies = (options?: {
  stdout?: string;
  executionSucceeds?: boolean;
  signalSucceeds?: boolean;
}): {
  value: ProcessTreeDependencies;
  signalCalls: SignalCall[];
  executeCalls: ExecuteCall[];
} => {
  const signalCalls: SignalCall[] = [];
  const executeCalls: ExecuteCall[] = [];
  return {
    value: {
      signal: (pid, signal) => {
        signalCalls.push({ pid, signal });
        if (options?.signalSucceeds === false) throw new Error("signal refused");
      },
      execute: (file, args) => {
        executeCalls.push({ file, args });
        return Promise.resolve({ ok: options?.executionSucceeds ?? true, stdout: options?.stdout ?? "" });
      },
    },
    signalCalls,
    executeCalls,
  };
};

describe("shared process-tree platform operations", () => {
  it("addresses a POSIX child as a detached process group", async () => {
    const fixture = dependencies({ stdout: "1-02:03:04\n" });
    const operations = createProcessTreeOperations("darwin", fixture.value);
    const now = new Date("2026-08-31T12:00:00.000Z");

    expect(operations.detachChild).toBe(true);
    expect(operations.pidExists(42)).toBe(true);
    expect(operations.treeExists(42)).toBe(true);
    await operations.gracefulStop(42);
    await operations.forceStop(42);
    await expect(operations.startedAt(42, now)).resolves.toEqual(
      new Date(now.getTime() - (86_400 + 2 * 3_600 + 3 * 60 + 4) * 1_000),
    );

    expect(fixture.signalCalls).toEqual([
      { pid: 42, signal: 0 },
      { pid: -42, signal: 0 },
      { pid: -42, signal: "SIGTERM" },
      { pid: -42, signal: "SIGKILL" },
    ]);
    expect(fixture.executeCalls).toEqual([{ file: "ps", args: ["-o", "etime=", "-p", "42"] }]);
  });

  it("uses taskkill tree mode for graceful and forced Windows shutdown", async () => {
    const fixture = dependencies();
    const operations = createProcessTreeOperations("win32", fixture.value);

    expect(operations.detachChild).toBe(false);
    await operations.gracefulStop(7301);
    await operations.forceStop(7301);

    expect(fixture.executeCalls).toEqual([
      { file: "taskkill.exe", args: ["/PID", "7301", "/T"] },
      { file: "taskkill.exe", args: ["/PID", "7301", "/T", "/F"] },
    ]);
  });

  it("reads the Windows process start time with a fixed executable and argv", async () => {
    const startedAt = new Date("2026-08-31T11:59:58.750Z");
    const fixture = dependencies({ stdout: `${startedAt.getTime().toString()}\r\n` });
    const operations = createProcessTreeOperations("win32", fixture.value);

    await expect(operations.startedAt(7301, new Date("2026-08-31T12:00:00.000Z"))).resolves.toEqual(
      startedAt,
    );
    expect(fixture.executeCalls[0]?.file).toBe("powershell.exe");
    expect(fixture.executeCalls[0]?.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(fixture.executeCalls[0]?.args[4]).toContain("ProcessId = 7301");
  });

  it("reaps descendants after a Windows root exits through a bounded trusted query", async () => {
    const fixture = dependencies({ stdout: "STOPPED\r\n" });
    const operations = createProcessTreeOperations("win32", fixture.value);
    const startedAt = new Date("2026-08-31T11:59:58.750Z");

    await expect(operations.reapDescendants(7301, startedAt)).resolves.toBe(true);
    expect(fixture.executeCalls[0]?.file).toBe("powershell.exe");
    expect(fixture.executeCalls[0]?.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(fixture.executeCalls[0]?.args[4]).toContain("$rootProcessId = 7301");
    expect(fixture.executeCalls[0]?.args[4]).toContain(startedAt.getTime().toString());
  });

  it("reaps Windows descendants when cancellation observes an already-exited root", async () => {
    const fixture = dependencies({ signalSucceeds: false, stdout: "STOPPED\r\n" });
    const operations = createProcessTreeOperations("win32", fixture.value);
    const startedAt = new Date("2026-08-31T11:59:58.750Z");

    await expect(
      stopAndReapProcessTree({
        operations,
        rootPid: 7301,
        rootStartedAt: startedAt,
        gracefulWaitMs: 100,
        forceWaitMs: 100,
      }),
    ).resolves.toBe(true);

    expect(fixture.executeCalls).toHaveLength(1);
    expect(fixture.executeCalls[0]?.file).toBe("powershell.exe");
    expect(fixture.executeCalls[0]?.args[4]).toContain("$rootProcessId = 7301");
  });

  it("rejects invalid process identifiers before constructing an OS command", async () => {
    const fixture = dependencies();
    const operations = createProcessTreeOperations("win32", fixture.value);

    expect(operations.pidExists(Number.NaN)).toBe(false);
    await expect(operations.forceStop(-1)).rejects.toThrow("Invalid process identifier");
    expect(fixture.executeCalls).toEqual([]);
  });
});
