import { describe, expect, it } from "vitest";

import { createProcessTreeOperations, type ProcessTreeDependencies } from "../src/process-tree.js";

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
        return Promise.resolve({
          ok: options?.executionSucceeds ?? true,
          stdout: options?.stdout ?? "",
        });
      },
    },
    signalCalls,
    executeCalls,
  };
};

describe("process-tree platform operations", () => {
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

  it("reads the absolute Windows process start time with a fixed executable and argument vector", async () => {
    const startedAt = new Date("2026-08-31T11:59:58.750Z");
    const fixture = dependencies({ stdout: `${startedAt.getTime().toString()}\r\n` });
    const operations = createProcessTreeOperations("win32", fixture.value);
    const now = new Date("2026-08-31T12:00:00.000Z");

    await expect(operations.startedAt(7301, now)).resolves.toEqual(startedAt);
    expect(fixture.executeCalls).toHaveLength(1);
    expect(fixture.executeCalls[0]?.file).toBe("powershell.exe");
    expect(fixture.executeCalls[0]?.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(fixture.executeCalls[0]?.args[4]).toContain("ProcessId = 7301");
    expect(fixture.executeCalls[0]?.args[4]).toContain("ToUnixTimeMilliseconds");
  });

  it("reports missing processes and failed start-time probes without throwing", async () => {
    const fixture = dependencies({ executionSucceeds: false, signalSucceeds: false });
    const operations = createProcessTreeOperations("win32", fixture.value);

    expect(operations.pidExists(7301)).toBe(false);
    expect(operations.treeExists(7301)).toBe(false);
    await expect(operations.startedAt(7301, new Date())).resolves.toBeNull();
    await expect(operations.forceStop(7301)).rejects.toThrow("The MCP process tree could not be terminated");
  });

  it("rejects invalid process identifiers before constructing an OS command", async () => {
    const fixture = dependencies();
    const operations = createProcessTreeOperations("win32", fixture.value);

    expect(operations.pidExists(Number.NaN)).toBe(false);
    await expect(operations.forceStop(-1)).rejects.toThrow("Invalid process identifier");
    expect(fixture.executeCalls).toEqual([]);
  });
});
