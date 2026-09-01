import { execFile } from "node:child_process";
import process from "node:process";

type ProcessSignal = 0 | "SIGTERM" | "SIGKILL";

type ExecutionResult = {
  ok: boolean;
  stdout: string;
};

export type ProcessTreeDependencies = {
  signal: (pid: number, signal: ProcessSignal) => void;
  execute: (file: string, args: readonly string[]) => Promise<ExecutionResult>;
};

export type ProcessTreeOperations = {
  detachChild: boolean;
  pidExists: (pid: number) => boolean;
  treeExists: (rootPid: number) => boolean;
  gracefulStop: (rootPid: number) => Promise<void>;
  forceStop: (rootPid: number) => Promise<void>;
  startedAt: (pid: number, now: Date) => Promise<Date | null>;
};

const executeFile = (file: string, args: readonly string[]): Promise<ExecutionResult> =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", windowsHide: true }, (error, stdout) => {
      resolve({ ok: error === null, stdout });
    });
  });

const productionDependencies: ProcessTreeDependencies = {
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  execute: executeFile,
};

const validPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;

const requirePid = (pid: number): string => {
  if (!validPid(pid)) throw new Error("Invalid process identifier");
  return String(pid);
};

const signalExists = (dependencies: ProcessTreeDependencies, pid: number, processGroup: boolean): boolean => {
  if (!validPid(pid)) return false;
  try {
    dependencies.signal(processGroup ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
};

const elapsedToStartedAt = (value: string, now: Date): Date | null => {
  const match = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/u.exec(value);
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  const elapsedSeconds =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return new Date(now.getTime() - elapsedSeconds * 1_000);
};

const createPosixOperations = (dependencies: ProcessTreeDependencies): ProcessTreeOperations => ({
  detachChild: true,
  pidExists: (pid) => signalExists(dependencies, pid, false),
  treeExists: (rootPid) => signalExists(dependencies, rootPid, true),
  gracefulStop: (rootPid) => {
    dependencies.signal(-Number(requirePid(rootPid)), "SIGTERM");
    return Promise.resolve();
  },
  forceStop: (rootPid) => {
    dependencies.signal(-Number(requirePid(rootPid)), "SIGKILL");
    return Promise.resolve();
  },
  startedAt: async (pid, now) => {
    const output = await dependencies.execute("ps", ["-o", "etime=", "-p", requirePid(pid)]);
    return output.ok ? elapsedToStartedAt(output.stdout, now) : null;
  },
});

const stopWindowsTree = async (
  dependencies: ProcessTreeDependencies,
  rootPid: number,
  force: boolean,
): Promise<void> => {
  const result = await dependencies.execute("taskkill.exe", [
    "/PID",
    requirePid(rootPid),
    "/T",
    ...(force ? ["/F"] : []),
  ]);
  if (!result.ok) throw new Error("The MCP process tree could not be terminated");
};

const createWindowsOperations = (dependencies: ProcessTreeDependencies): ProcessTreeOperations => ({
  detachChild: false,
  pidExists: (pid) => signalExists(dependencies, pid, false),
  treeExists: (rootPid) => signalExists(dependencies, rootPid, false),
  gracefulStop: (rootPid) => stopWindowsTree(dependencies, rootPid, false),
  forceStop: (rootPid) => stopWindowsTree(dependencies, rootPid, true),
  startedAt: async (pid, now) => {
    const pidText = requirePid(pid);
    const output = await dependencies.execute("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$candidate = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pidText}' -Property CreationDate; if ($null -ne $candidate) { [int64](([DateTime]::UtcNow - $candidate.CreationDate.ToUniversalTime()).TotalMilliseconds) }`,
    ]);
    if (!output.ok) return null;
    const elapsedMilliseconds = Number(output.stdout.trim());
    if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) return null;
    return new Date(now.getTime() - elapsedMilliseconds);
  },
});

export const createProcessTreeOperations = (
  platform: NodeJS.Platform = process.platform,
  dependencies: ProcessTreeDependencies = productionDependencies,
): ProcessTreeOperations =>
  platform === "win32" ? createWindowsOperations(dependencies) : createPosixOperations(dependencies);
