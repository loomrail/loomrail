import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { mcpProbeEnvironment } from "../src/probe.js";
import { recoverMcpOrphans } from "../src/process-registry.js";

const fixturePath = fileURLToPath(new URL("./fixtures/modern-server.mjs", import.meta.url));
const supervisorEntrypoint = fileURLToPath(new URL("../dist/supervisor.js", import.meta.url));

type TreePids = { serverPid: number; helperPid: number };

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const forceStop = (child: ChildProcess | undefined): void => {
  if (child?.pid === undefined || !processExists(child.pid)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Test cleanup only; the process may have exited between the probe and signal.
  }
};

const forceStopPid = (pid: number | undefined): void => {
  if (pid === undefined || !processExists(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Test cleanup only; the process may have exited between the probe and signal.
  }
};

const waitForTreePids = async (pidFile: string): Promise<TreePids> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(pidFile, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "serverPid" in parsed &&
        typeof parsed.serverPid === "number" &&
        "helperPid" in parsed &&
        typeof parsed.helperPid === "number"
      ) {
        return { serverPid: parsed.serverPid, helperPid: parsed.helperPid };
      }
    } catch {
      // The fixture writes the file only after both processes exist.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The supervised MCP process tree did not report its pids");
};

const waitUntilGone = async (pids: readonly number[]): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`The supervised MCP process tree is still alive: ${pids.join(",")}`);
};

describe("MCP process-tree supervisor", () => {
  let directory = "";
  let treePids: TreePids | undefined;
  let orphanRoot: ChildProcess | undefined;
  let watchedParent: ChildProcess | undefined;
  let supervisor: ChildProcess | undefined;

  afterEach(async () => {
    forceStop(supervisor);
    forceStop(orphanRoot);
    forceStop(watchedParent);
    forceStopPid(treePids?.serverPid);
    forceStopPid(treePids?.helperPid);
    if (directory !== "") await rm(directory, { recursive: true, force: true });
    directory = "";
    treePids = undefined;
    orphanRoot = undefined;
    watchedParent = undefined;
    supervisor = undefined;
  });

  it("closes the server and its signal-resistant descendant with the MCP transport", async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail mcp tree "));
    const pidFile = join(directory, "pids.json");
    const recordFile = join(directory, `mcp-${randomBytes(32).toString("base64url")}.json`);
    const client = new Client({ name: "supervisor-close-test", version: "1.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            supervisorEntrypoint,
            "--parent-pid",
            String(process.pid),
            "--control-token",
            randomBytes(32).toString("base64url"),
            "--registry-file",
            recordFile,
            "--",
            process.execPath,
            fixturePath,
            "tree",
            pidFile,
          ],
          env: mcpProbeEnvironment(),
          stderr: "pipe",
        }),
        { timeout: 5_000, maxTotalTimeout: 5_000 },
      );
      treePids = await waitForTreePids(pidFile);
      await expect(readFile(recordFile, "utf8")).resolves.toContain(
        `"serverPid":${treePids.serverPid.toString()}`,
      );
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(["tool_00", "tool_01"]);
    } finally {
      await client.close().catch(() => undefined);
    }
    await waitUntilGone([treePids.serverPid, treePids.helperPid]);
    await expect(readFile(recordFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("reaps the whole tree when its watched daemon process disappears", async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail mcp orphan "));
    const pidFile = join(directory, "pids.json");
    watchedParent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (watchedParent.pid === undefined) throw new Error("The watched daemon fixture did not start");
    supervisor = spawn(
      process.execPath,
      [
        supervisorEntrypoint,
        "--parent-pid",
        String(watchedParent.pid),
        "--control-token",
        randomBytes(32).toString("base64url"),
        "--",
        process.execPath,
        fixturePath,
        "tree",
        pidFile,
      ],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    if (supervisor.pid === undefined) throw new Error("The MCP supervisor fixture did not start");
    const supervisorPid = supervisor.pid;
    treePids = await waitForTreePids(pidFile);

    const parentExit = once(watchedParent, "exit");
    watchedParent.kill("SIGKILL");
    await parentExit;
    await waitUntilGone([treePids.serverPid, treePids.helperPid]);
    await waitUntilGone([supervisorPid]);
  }, 15_000);

  it("recovers a durable process tree after both daemon and supervisor disappeared", async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail mcp durable orphan "));
    const pidFile = join(directory, "pids.json");
    const recordFile = join(directory, `mcp-${randomBytes(32).toString("base64url")}.json`);
    orphanRoot = spawn(process.execPath, [fixturePath, "orphan-tree", pidFile], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    if (orphanRoot.pid === undefined) throw new Error("The durable MCP orphan fixture did not start");
    const startedAt = new Date().toISOString();
    treePids = await waitForTreePids(pidFile);
    expect(treePids.serverPid).toBe(orphanRoot.pid);
    await writeFile(
      recordFile,
      JSON.stringify({
        schemaVersion: 1,
        supervisorPid: 2_147_483_647,
        serverPid: treePids.serverPid,
        startedAt,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    expect(processExists(treePids.serverPid)).toBe(true);

    await expect(recoverMcpOrphans(directory)).resolves.toEqual([
      {
        recordFile: basename(recordFile),
        serverPid: treePids.serverPid,
        action: "KILLED",
        reason: "IDENTITY_CONFIRMED",
      },
    ]);
    await waitUntilGone([treePids.serverPid, treePids.helperPid]);
    await expect(readFile(recordFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("leaves a reused pid alone when the durable record identity does not match", async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail mcp reused pid "));
    const recordFile = join(directory, `mcp-${randomBytes(32).toString("base64url")}.json`);
    watchedParent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (watchedParent.pid === undefined) throw new Error("The reused-pid fixture did not start");
    await writeFile(
      recordFile,
      JSON.stringify({
        schemaVersion: 1,
        supervisorPid: 2_147_483_647,
        serverPid: watchedParent.pid,
        startedAt: "2020-01-01T00:00:00.000Z",
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    await expect(recoverMcpOrphans(directory)).resolves.toEqual([
      {
        recordFile: basename(recordFile),
        serverPid: watchedParent.pid,
        action: "SKIPPED",
        reason: "START_TIME_MISMATCH",
      },
    ]);
    expect(processExists(watchedParent.pid)).toBe(true);
  }, 15_000);

  it("does not reconcile a record whose supervisor is still running", async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail mcp live supervisor "));
    const recordFile = join(directory, `mcp-${randomBytes(32).toString("base64url")}.json`);
    watchedParent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (watchedParent.pid === undefined) throw new Error("The live-supervisor fixture did not start");
    await writeFile(
      recordFile,
      JSON.stringify({
        schemaVersion: 1,
        supervisorPid: process.pid,
        serverPid: watchedParent.pid,
        startedAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    await expect(recoverMcpOrphans(directory)).resolves.toEqual([
      {
        recordFile: basename(recordFile),
        serverPid: watchedParent.pid,
        action: "SKIPPED",
        reason: "SUPERVISOR_STILL_RUNNING",
      },
    ]);
    expect(processExists(watchedParent.pid)).toBe(true);
  });

  it("removes a half-written temporary record whose writer is gone and keeps one whose writer lives", async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail mcp stale temp "));
    const staleName = `mcp-${randomBytes(32).toString("base64url")}.json.tmp-2147483647`;
    const liveName = `mcp-${randomBytes(32).toString("base64url")}.json.tmp-${process.pid.toString()}`;
    await writeFile(join(directory, staleName), '{"schemaVersion":1,"supervisorPid":', {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(join(directory, liveName), '{"schemaVersion":1,"supervisorPid":', {
      encoding: "utf8",
      mode: 0o600,
    });

    const reports = await recoverMcpOrphans(directory);

    expect(reports).toEqual(
      expect.arrayContaining([
        { recordFile: staleName, serverPid: null, action: "REMOVED", reason: "STALE_TEMPORARY" },
        { recordFile: liveName, serverPid: null, action: "SKIPPED", reason: "INVALID_RECORD" },
      ]),
    );
    await expect(readFile(join(directory, staleName), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(directory, liveName), "utf8")).resolves.toContain("supervisorPid");
  });
});
