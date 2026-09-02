import { access, chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  deleteLocalLogs,
  exportLocalLogs,
  LocalLogError,
  openLocalLogWriter,
  sanitizeOperationalLogLine,
} from "../src/log-lifecycle.js";

const writerId = "0123456789abcdef";
const processId = 4242;
const activeProcess = (candidate: number): boolean => candidate === processId;
const ownedName = "daemon-20260801000000000-4242-0123456789abcdef-0000.ndjson";

const writeLine = (stream: Writable, value: string): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(value, "utf8", (error: Error | null | undefined) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });

const ownedFiles = async (dataDirectory: string): Promise<string[]> =>
  (await readdir(join(dataDirectory, "logs"))).filter((name) => name.startsWith("daemon-")).sort();

describe("local operational log lifecycle", () => {
  const directories: string[] = [];

  const temporaryDataDirectory = async (): Promise<string> => {
    const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "loomrail logs ")),
    );
    directories.push(directory);
    return directory;
  };

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("keeps only allowlisted structured fields and redacts secrets and local paths", () => {
    const raw = JSON.stringify({
      level: 50,
      time: 1_788_300_000_000,
      msg: "token=SECRET_CANARY Bearer BEARER_CANARY /private/loomrail-fixture/private.txt",
      reqId: "request-one",
      req: {
        method: "POST",
        url: "/api/v1/tasks?token=QUERY_CANARY",
        headers: { cookie: "COOKIE_CANARY" },
      },
      res: { statusCode: 500, headers: { "set-cookie": "SESSION_CANARY" } },
      err: {
        type: "Error",
        message: "password=PASSWORD_CANARY at C:\\sensitive-fixture\\secret.txt",
        stack: "STACK_CANARY /private/tmp/repository/file.ts:1",
      },
      prompt: "PROMPT_CANARY",
      body: "BODY_CANARY",
      workItemId: "work-item-one",
    });

    const sanitized = sanitizeOperationalLogLine(raw, new Date("2026-09-02T12:00:00.000Z"));
    const parsed = JSON.parse(sanitized) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      component: "daemon",
      level: 50,
      req: { method: "POST", url: "/api/v1/tasks" },
      res: { statusCode: 500 },
      workItemId: "work-item-one",
    });
    expect(parsed).not.toHaveProperty("prompt");
    expect(parsed).not.toHaveProperty("body");
    expect(parsed).not.toHaveProperty("err.stack");
    expect(sanitized).not.toMatch(
      /SECRET_CANARY|BEARER_CANARY|QUERY_CANARY|COOKIE_CANARY|SESSION_CANARY|PASSWORD_CANARY|STACK_CANARY|sensitive-fixture|\/private\/loomrail-fixture|\/private\/tmp/,
    );
  });

  it("writes redacted segments, blocks management while active, then exports and deletes only owned files", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const log = await openLocalLogWriter(dataDirectory, {
      processId,
      writerId,
      isProcessAlive: activeProcess,
    });
    await writeLine(
      log.stream,
      `${JSON.stringify({ level: 30, time: Date.now(), msg: "Bearer DISK_CANARY", workItemId: "work-one" })}\n`,
    );
    await writeLine(log.stream, "not-json CANARY_RAW_LINE\n");
    await writeLine(log.stream, `${"OVERSIZED_CANARY".repeat(5_000)}\n`);

    await expect(
      exportLocalLogs(dataDirectory, { processId, isProcessAlive: activeProcess }),
    ).rejects.toMatchObject({ code: "LOG_WRITER_ACTIVE" } satisfies Partial<LocalLogError>);
    await writeFile(join(dataDirectory, "logs", "owner-note.txt"), "OWNER_FILE_CANARY\n", "utf8");
    await log.close();

    const files = await ownedFiles(dataDirectory);
    expect(files).toHaveLength(1);
    const segmentName = files[0];
    if (segmentName === undefined) throw new Error("Expected one local log segment.");
    const diskBytes = await readFile(join(dataDirectory, "logs", segmentName), "utf8");
    expect(diskBytes).toContain("LOG_LINE_DROPPED");
    expect(diskBytes).not.toMatch(/DISK_CANARY|CANARY_RAW_LINE|OVERSIZED_CANARY/);
    if (process.platform !== "win32") {
      expect((await stat(join(dataDirectory, "logs", segmentName))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dataDirectory, "logs"))).mode & 0o777).toBe(0o700);
    }

    const exported = await exportLocalLogs(dataDirectory, { processId, isProcessAlive: activeProcess });
    expect(exported).toMatchObject({ files: 1, entries: 3 });
    expect(exported.ndjson).not.toMatch(
      /DISK_CANARY|CANARY_RAW_LINE|OVERSIZED_CANARY|owner-note|OWNER_FILE_CANARY/,
    );

    const deleted = await deleteLocalLogs(dataDirectory, { processId, isProcessAlive: activeProcess });
    expect(deleted.files).toBe(1);
    await expect(access(join(dataDirectory, "logs", "owner-note.txt"))).resolves.toBeUndefined();
    expect(await ownedFiles(dataDirectory)).toEqual([]);
  });

  it("rotates by size and age while enforcing the total capacity", async () => {
    const dataDirectory = await temporaryDataDirectory();
    let currentTime = new Date("2026-09-02T12:00:00.000Z");
    const log = await openLocalLogWriter(dataDirectory, {
      processId,
      writerId,
      isProcessAlive: activeProcess,
      now: () => currentTime,
      limits: {
        lineBytes: 220,
        segmentBytes: 320,
        totalBytes: 700,
        rotationMs: 1_000,
        maintenanceMs: 60_000,
      },
    });

    for (let index = 0; index < 12; index += 1) {
      const suffix = index.toString();
      await writeLine(
        log.stream,
        `${JSON.stringify({ level: 30, time: currentTime.getTime(), msg: `bounded event ${suffix}`, dispatchId: `dispatch-${suffix}` })}\n`,
      );
    }
    currentTime = new Date(currentTime.getTime() + 2_000);
    await writeLine(
      log.stream,
      `${JSON.stringify({ level: 30, time: currentTime.getTime(), msg: "after daily rotation" })}\n`,
    );
    await log.close();

    const files = await ownedFiles(dataDirectory);
    const sizes = await Promise.all(
      files.map((name) => stat(join(dataDirectory, "logs", name)).then(({ size }) => size)),
    );
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThan(12);
    expect(sizes.every((size) => size <= 320)).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(700);
  });

  it("removes expired owned segments but preserves unknown siblings", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const logsDirectory = join(dataDirectory, "logs");
    await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
    const oldSegment = join(logsDirectory, ownedName);
    const unknown = join(logsDirectory, "keep-forever.txt");
    await writeFile(
      oldSegment,
      sanitizeOperationalLogLine(JSON.stringify({ level: 30, time: 1, msg: "old" })),
      "utf8",
    );
    await writeFile(unknown, "unknown sibling\n", "utf8");
    if (process.platform !== "win32") await chmod(oldSegment, 0o600);
    const oldTime = new Date("2026-09-01T00:00:00.000Z");
    await utimes(oldSegment, oldTime, oldTime);

    const log = await openLocalLogWriter(dataDirectory, {
      processId,
      writerId,
      isProcessAlive: activeProcess,
      now: () => new Date("2026-09-02T00:00:02.000Z"),
      limits: { retentionMs: 1_000 },
    });
    expect(log.initialCleanup).toMatchObject({ expiredFiles: 1, capacityFiles: 0 });
    await log.close();

    await expect(access(oldSegment)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unknown)).resolves.toBeUndefined();
  });

  it("reclaims a dead valid lock but preserves invalid locks and non-regular owned names", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const logsDirectory = join(dataDirectory, "logs");
    await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(logsDirectory, ".writer.lock");
    await writeFile(lockPath, "invalid lock\n", "utf8");
    await expect(
      openLocalLogWriter(dataDirectory, { processId, writerId, isProcessAlive: () => false }),
    ).rejects.toMatchObject({ code: "LOG_LOCK_INVALID" } satisfies Partial<LocalLogError>);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("invalid lock\n");

    await writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, processId: 9999, token: "a".repeat(32) })}\n`,
      "utf8",
    );
    if (process.platform !== "win32") await chmod(lockPath, 0o600);
    const log = await openLocalLogWriter(dataDirectory, {
      processId,
      writerId,
      isProcessAlive: () => false,
    });
    await log.close();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(logsDirectory, ownedName));
    await expect(
      exportLocalLogs(dataDirectory, { processId, isProcessAlive: activeProcess }),
    ).rejects.toMatchObject({ code: "LOG_FILE_INVALID" } satisfies Partial<LocalLogError>);
    await expect(stat(join(logsDirectory, ownedName))).resolves.toMatchObject({});
  });

  it("rejects overly broad POSIX permissions without deleting the affected node", async () => {
    if (process.platform === "win32") return;
    const dataDirectory = await temporaryDataDirectory();
    const logsDirectory = join(dataDirectory, "logs");
    await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
    await chmod(logsDirectory, 0o755);

    await expect(exportLocalLogs(dataDirectory)).rejects.toMatchObject({
      code: "LOG_DIRECTORY_INVALID",
    } satisfies Partial<LocalLogError>);
    await chmod(logsDirectory, 0o700);
    const segmentPath = join(logsDirectory, ownedName);
    await writeFile(segmentPath, sanitizeOperationalLogLine(JSON.stringify({ msg: "private" })), "utf8");
    await chmod(segmentPath, 0o644);

    await expect(exportLocalLogs(dataDirectory)).rejects.toMatchObject({
      code: "LOG_FILE_INVALID",
    } satisfies Partial<LocalLogError>);
    await expect(access(segmentPath)).resolves.toBeUndefined();
  });
});
