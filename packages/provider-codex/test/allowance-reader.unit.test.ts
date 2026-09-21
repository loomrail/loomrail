import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { readCodexAllowance } from "../src/index.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-app-server.mjs");

// Every fixture spawns a real `node`, so the read deadline has to outlast a cold child start on a
// loaded host. Except where the timeout itself is the subject, the deadline here is scaffolding:
// these tests assert parsing, projection and redaction, never how fast the reader gives up. A tight
// value made them fail as PROVIDER_TIMEOUT under parallel load while the reader was behaving
// correctly. Vitest's own per-test timeout still catches a genuine hang.
const SCAFFOLD_DEADLINE_MS = 30_000;
// The stubborn child can only ignore SIGTERM once Node has booted it and run its handler. The
// deadline must therefore clear that start, or the signal lands on a process still using the
// default action and the escalation branch never runs.
const STUBBORN_DEADLINE_MS = 2_000;
const STUBBORN_GRACE_MS = 80;
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
    deadlineMs: options.deadlineMs ?? SCAFFOLD_DEADLINE_MS,
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
    await expect(
      readFixture(mode, { deadlineMs: mode === "timeout" ? 100 : SCAFFOLD_DEADLINE_MS }),
    ).resolves.toMatchObject({
      freshness: "UNAVAILABLE",
      unavailableReason,
      buckets: [],
    });
  });

  it("escalates a child that ignores graceful termination and waits for its real exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail allowance signals Пример "));
    temporaryDirectories.push(directory);
    const logPath = join(directory, "signal log.jsonl");
    const startedAt = Date.now();
    await expect(
      readFixture("timeout-stubborn", {
        logPath,
        deadlineMs: STUBBORN_DEADLINE_MS,
        terminationGraceMs: STUBBORN_GRACE_MS,
      }),
    ).resolves.toMatchObject({ unavailableReason: "PROVIDER_TIMEOUT" });
    const elapsedMs = Date.now() - startedAt;
    if (process.platform === "win32") {
      // Windows delivers no catchable SIGTERM: Node terminates the child at once, so the grace
      // period is unobservable and only the deadline itself can be asserted.
      expect(elapsedMs).toBeGreaterThanOrEqual(STUBBORN_DEADLINE_MS - 10);
      return;
    }
    // The child logging the signal is the direct evidence that it received SIGTERM and stayed
    // alive, which is what makes the following elapsed time the grace period rather than a child
    // that simply died on the default action.
    const logged = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(logged).toContainEqual({ ignoredSignal: "SIGTERM" });
    expect(elapsedMs).toBeGreaterThanOrEqual(STUBBORN_DEADLINE_MS + STUBBORN_GRACE_MS - 20);
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
