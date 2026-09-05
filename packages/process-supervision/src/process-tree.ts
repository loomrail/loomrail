import { execFile } from "node:child_process";
import process from "node:process";

type ProcessSignal = 0 | "SIGTERM" | "SIGKILL";

type ExecutionResult = {
  ok: boolean;
  stdout: string;
};

export type ProcessTreeDependencies = {
  signal: (pid: number, signal: ProcessSignal) => void;
  execute: (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecutionResult>;
};

export type ProcessTreeOperations = {
  detachChild: boolean;
  /** Startup may only infer orphan lineage after the root exits when the OS has a stable group identity. */
  orphanRecoveryRequiresLiveRootIdentity: boolean;
  pidExists: (pid: number) => boolean;
  treeExists: (rootPid: number) => boolean;
  gracefulStop: (rootPid: number) => Promise<void>;
  forceStop: (rootPid: number) => Promise<void>;
  reapDescendants: (rootPid: number, rootStartedAt: Date) => Promise<boolean>;
  startedAt: (pid: number, now: Date) => Promise<Date | null>;
};

export type StopAndReapProcessTreeOptions = {
  operations: ProcessTreeOperations;
  rootPid: number;
  rootStartedAt: Date;
  gracefulWaitMs: number;
  forceWaitMs: number;
};

const DESCENDANT_REAP_GRACE_MS = 500;
const DESCENDANT_REAP_FORCE_MS = 2_000;
const PROCESS_QUERY_TIMEOUT_MS = 10_000;
const WINDOWS_TREE_STOP_TIMEOUT_MS = 10_000;
const WINDOWS_DESCENDANT_REAP_TIMEOUT_MS = 30_000;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const waitForTreeExit = async (exists: () => boolean, milliseconds: number): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!exists()) return true;
    await delay(25);
  }
  return !exists();
};

export const stopAndReapProcessTree = async ({
  operations,
  rootPid,
  rootStartedAt,
  gracefulWaitMs,
  forceWaitMs,
}: StopAndReapProcessTreeOptions): Promise<boolean> => {
  if (operations.treeExists(rootPid)) {
    await operations.gracefulStop(rootPid).catch(() => undefined);
    if (!(await waitForTreeExit(() => operations.treeExists(rootPid), gracefulWaitMs))) {
      await operations.forceStop(rootPid).catch(() => undefined);
      await waitForTreeExit(() => operations.treeExists(rootPid), forceWaitMs);
    }
  }
  if (operations.treeExists(rootPid)) return false;

  // On Windows treeExists only observes the root PID. The root can exit before
  // its descendants, so descendant reaping is required even when it is already absent.
  return operations.reapDescendants(rootPid, rootStartedAt);
};

const executeFile = (file: string, args: readonly string[], timeoutMs: number): Promise<ExecutionResult> =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        resolve({ ok: error === null, stdout });
      },
    );
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
  orphanRecoveryRequiresLiveRootIdentity: false,
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
  reapDescendants: async (rootPid) => {
    const exists = (): boolean => signalExists(dependencies, rootPid, true);
    if (!exists()) return true;
    try {
      dependencies.signal(-Number(requirePid(rootPid)), "SIGTERM");
      if (await waitForTreeExit(exists, DESCENDANT_REAP_GRACE_MS)) return true;
      dependencies.signal(-Number(requirePid(rootPid)), "SIGKILL");
      return await waitForTreeExit(exists, DESCENDANT_REAP_FORCE_MS);
    } catch {
      return !exists();
    }
  },
  startedAt: async (pid, now) => {
    const output = await dependencies.execute(
      "ps",
      ["-o", "etime=", "-p", requirePid(pid)],
      PROCESS_QUERY_TIMEOUT_MS,
    );
    return output.ok ? elapsedToStartedAt(output.stdout, now) : null;
  },
});

const reapWindowsDescendants = async (
  dependencies: ProcessTreeDependencies,
  rootPid: number,
  rootStartedAt: Date,
): Promise<boolean> => {
  const pidText = requirePid(rootPid);
  const startedAtMilliseconds = rootStartedAt.getTime();
  if (!Number.isSafeInteger(startedAtMilliseconds) || startedAtMilliseconds < 0) return false;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `$rootProcessId = ${pidText};`,
    `$minimumCreation = [DateTimeOffset]::FromUnixTimeMilliseconds(${startedAtMilliseconds.toString()}).UtcDateTime.AddSeconds(-3);`,
    "$known = [System.Collections.Generic.HashSet[int]]::new();",
    "[void]$known.Add($rootProcessId);",
    "$quietScans = 0;",
    "for ($attempt = 0; $attempt -lt 80; $attempt++) {",
    "$all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate);",
    "$expanded = $true;",
    "while ($expanded) {",
    "$expanded = $false;",
    "foreach ($candidate in $all) {",
    "$candidateId = [int]$candidate.ProcessId;",
    "$parentId = [int]$candidate.ParentProcessId;",
    "if ($known.Contains($candidateId) -or -not $known.Contains($parentId)) { continue; }",
    "if ($null -eq $candidate.CreationDate -or $candidate.CreationDate.ToUniversalTime() -lt $minimumCreation) { throw 'Process identity mismatch'; }",
    "[void]$known.Add($candidateId);",
    "$expanded = $true;",
    "}",
    "}",
    "$alive = @($all | Where-Object { ([int]$_.ProcessId) -ne $rootProcessId -and $known.Contains([int]$_.ProcessId) });",
    "if ($alive.Count -eq 0) {",
    "$quietScans++;",
    "if ($quietScans -ge 2) { Write-Output 'STOPPED'; exit 0; }",
    "} else {",
    "$quietScans = 0;",
    "foreach ($candidate in $alive) { Stop-Process -Id ([int]$candidate.ProcessId) -Force -ErrorAction SilentlyContinue; }",
    "}",
    "Start-Sleep -Milliseconds 25;",
    "}",
    "Write-Output 'RUNNING';",
    "exit 1;",
  ].join(" ");
  const result = await dependencies.execute(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    WINDOWS_DESCENDANT_REAP_TIMEOUT_MS,
  );
  return result.ok && result.stdout.trim() === "STOPPED";
};

const stopWindowsTree = async (
  dependencies: ProcessTreeDependencies,
  rootPid: number,
  force: boolean,
): Promise<void> => {
  const result = await dependencies.execute(
    "taskkill.exe",
    ["/PID", requirePid(rootPid), "/T", ...(force ? ["/F"] : [])],
    WINDOWS_TREE_STOP_TIMEOUT_MS,
  );
  if (!result.ok) throw new Error("The local process tree could not be terminated");
};

const createWindowsOperations = (dependencies: ProcessTreeDependencies): ProcessTreeOperations => ({
  detachChild: false,
  orphanRecoveryRequiresLiveRootIdentity: true,
  pidExists: (pid) => signalExists(dependencies, pid, false),
  treeExists: (rootPid) => signalExists(dependencies, rootPid, false),
  gracefulStop: (rootPid) => stopWindowsTree(dependencies, rootPid, false),
  forceStop: (rootPid) => stopWindowsTree(dependencies, rootPid, true),
  reapDescendants: (rootPid, rootStartedAt) => reapWindowsDescendants(dependencies, rootPid, rootStartedAt),
  startedAt: async (pid, _now) => {
    const pidText = requirePid(pid);
    const output = await dependencies.execute(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$candidate = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pidText}' -Property CreationDate; if ($null -ne $candidate) { [int64]([DateTimeOffset]$candidate.CreationDate).ToUnixTimeMilliseconds() }`,
      ],
      PROCESS_QUERY_TIMEOUT_MS,
    );
    if (!output.ok) return null;
    const startedAtMilliseconds = Number(output.stdout.trim());
    if (!Number.isSafeInteger(startedAtMilliseconds) || startedAtMilliseconds < 0) return null;
    return new Date(startedAtMilliseconds);
  },
});

export const createProcessTreeOperations = (
  platform: NodeJS.Platform = process.platform,
  dependencies: ProcessTreeDependencies = productionDependencies,
): ProcessTreeOperations =>
  platform === "win32" ? createWindowsOperations(dependencies) : createPosixOperations(dependencies);
