import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { readCodexAllowance } from "../src/index.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");
const now = () => new Date("2026-09-04T20:00:00.000Z");
const temporaryDirectories: string[] = [];

const readFixture = (
  mode: string,
  options: { logPath?: string; deadlineMs?: number; terminationGraceMs?: number } = {},
) =>
  readCodexAllowance({
    command: process.execPath,
    commandArgsPrefix: [fixturePath, mode, options.logPath ?? ""],
    now,
    deadlineMs: options.deadlineMs ?? 1_000,
    terminationGraceMs: options.terminationGraceMs ?? 50,
  });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Codex allowance App Server reader", () => {
  it.each(["success", "notification", "current-shape"])(
    "accepts the documented %s path and drops unrelated account fields",
    async (mode) => {
      const snapshot = await readFixture(mode);
      expect(snapshot).toMatchObject({
        provider: "CODEX",
        freshness: "LIVE",
        buckets: [
          { id: "codex:primary", remainingPercent: 76 },
          { id: "codex:secondary", remainingPercent: 49 },
        ],
      });
      expect(JSON.stringify(snapshot)).not.toContain("sensitive-canary");
    },
  );

  it("omits an incomplete provider window instead of inventing its reset or duration", async () => {
    await expect(readFixture("incomplete-window")).resolves.toMatchObject({
      provider: "CODEX",
      freshness: "LIVE",
      buckets: [{ id: "codex:secondary", remainingPercent: 49 }],
    });
  });

  it("sends only the fixed handshake and allowance read vocabulary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail allowance path Пример "));
    temporaryDirectories.push(directory);
    const logPath = join(directory, "request log.jsonl");
    await readFixture("success", { logPath });
    const requests = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(requests).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "loomrail", title: "Loomrail", version: "0.0.0" },
          capabilities: {},
        },
      },
      { method: "initialized", params: {} },
      { id: 2, method: "account/rateLimits/read", params: null },
    ]);
  });

  it.each([
    ["wrong-id", "PROVIDER_SCHEMA_DRIFT"],
    ["malformed", "PROVIDER_SCHEMA_DRIFT"],
    ["overlong", "PROVIDER_SCHEMA_DRIFT"],
    ["error", "PROVIDER_UNAVAILABLE"],
    ["premature-exit", "PROVIDER_UNAVAILABLE"],
    ["timeout", "PROVIDER_TIMEOUT"],
  ] as const)("fails closed for %s", async (mode, unavailableReason) => {
    // Process startup can exceed 100 ms on a loaded CI host. Only the timeout fixture needs the
    // short clock; every immediate-response fixture gets enough time to prove its intended branch.
    await expect(readFixture(mode, { deadlineMs: mode === "timeout" ? 100 : 1_000 })).resolves.toMatchObject({
      freshness: "UNAVAILABLE",
      unavailableReason,
      buckets: [],
    });
  });

  it("escalates a child that ignores graceful termination and waits for its real exit", async () => {
    const startedAt = Date.now();
    await expect(
      readFixture("timeout-stubborn", { deadlineMs: 150, terminationGraceMs: 80 }),
    ).resolves.toMatchObject({ unavailableReason: "PROVIDER_TIMEOUT" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(210);
  });

  it("maps an unlaunchable command to unavailable instead of rejecting", async () => {
    await expect(
      readCodexAllowance({
        command: join(tmpdir(), "missing-codex-command"),
        now,
        deadlineMs: 100,
        terminationGraceMs: 20,
      }),
    ).resolves.toMatchObject({
      freshness: "UNAVAILABLE",
      unavailableReason: "PROVIDER_UNAVAILABLE",
    });
  });
});
