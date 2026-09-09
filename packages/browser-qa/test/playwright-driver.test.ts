import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_QA_RESPONSE_BYTES, type QAAttachmentRef, type QARun } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_QA_RECOVERY_MARKER,
  BrowserQAArtifactRecoveryError,
  BrowserDriverError,
  type BrowserDriverErrorCode,
  createPlaywrightDriver,
  openVerifiedBrowserQAArtifact,
  recoverBrowserQAArtifacts,
} from "../src/index.js";

const createDirectoryLink = (target: string, path: string): Promise<void> =>
  symlink(target, path, process.platform === "win32" ? "junction" : "dir");

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const startServer = async (
  handler: RequestListener,
): Promise<{
  server: Server;
  origin: string;
}> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("The browser QA fixture server did not expose a TCP port");
  }
  return { server, origin: `http://127.0.0.1:${address.port.toString()}` };
};

const acceptWebSocketUpgrades = (
  server: Server,
  onClientFrame: (opcode: number, payload: Buffer) => void = () => undefined,
  serverMessages: readonly Buffer[] = [],
  upgradeDelayMs = 0,
): void => {
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    setTimeout(() => {
      if (socket.destroyed) return;
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
        () => {
          for (const payload of serverMessages) {
            const header =
              payload.byteLength < 126
                ? Buffer.from([0x81, payload.byteLength])
                : payload.byteLength <= 65_535
                  ? (() => {
                      const value = Buffer.alloc(4);
                      value[0] = 0x81;
                      value[1] = 126;
                      value.writeUInt16BE(payload.byteLength, 2);
                      return value;
                    })()
                  : (() => {
                      const value = Buffer.alloc(10);
                      value[0] = 0x81;
                      value[1] = 127;
                      value.writeBigUInt64BE(BigInt(payload.byteLength), 2);
                      return value;
                    })();
            socket.write(Buffer.concat([header, payload]));
          }
        },
      );
    }, upgradeDelayMs);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.byteLength >= 2) {
        const first = pending.at(0);
        const second = pending.at(1);
        if (first === undefined || second === undefined) return;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        const lengthCode = second & 0x7f;
        if (lengthCode >= 126) throw new Error("Test WebSocket frame exceeded the fixture limit");
        const headerLength = masked ? 6 : 2;
        if (pending.byteLength < headerLength + lengthCode) return;
        const payload = Buffer.from(pending.subarray(headerLength, headerLength + lengthCode));
        if (masked) {
          const mask = pending.subarray(2, 6);
          for (let index = 0; index < payload.byteLength; index += 1) {
            const value = payload.at(index);
            const maskValue = mask.at(index % 4);
            if (value === undefined || maskValue === undefined) return;
            payload[index] = value ^ maskValue;
          }
        }
        pending = pending.subarray(headerLength + lengthCode);
        onClientFrame(opcode, payload);
        if (opcode === 8) socket.destroy();
      }
    });
  });
};

const qaRun = (targetOrigin: string): QARun => ({
  schemaVersion: 1,
  id: "qa-run-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "pipeline-run-1",
  stageAttemptId: "stage-attempt-1",
  agentRunId: "agent-run-1",
  driverId: "PLAYWRIGHT",
  testedTree: "a".repeat(40),
  targetOrigin,
  plan: {
    schemaVersion: 1,
    revision: 1,
    contentHash: `sha256:${"b".repeat(64)}`,
    targets: [
      {
        id: "desktop-light-en",
        viewport: { width: 1_280, height: 800 },
        locale: "en-US",
        theme: "LIGHT",
      },
    ],
    scenarios: [
      {
        id: "current-work",
        title: "Owner can inspect current work",
        steps: [
          { id: "open-home", title: "Open home", action: { type: "NAVIGATE", path: "/" } },
          {
            id: "focus-action",
            title: "Focus the primary action",
            action: {
              type: "PRESS",
              locator: { by: "ROLE", role: "button", name: "Continue" },
              key: "Tab",
            },
          },
        ],
        assertions: [
          {
            id: "heading-visible",
            title: "Current work heading is visible",
            rule: { type: "VISIBLE", locator: { by: "ROLE", role: "heading", name: "Current work" } },
          },
          { id: "home-path", title: "Home path is current", rule: { type: "URL_PATH", path: "/" } },
          {
            id: "no-overflow",
            title: "The page has no horizontal overflow",
            rule: { type: "NO_HORIZONTAL_OVERFLOW" },
          },
        ],
      },
    ],
  },
  scope: { type: "FULL" },
  status: "RUNNING",
  error: null,
  startedAt: "2026-09-02T10:00:00.000Z",
  completedAt: null,
  version: 1,
});

const resources: { server?: Server; directory?: string }[] = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ server, directory }) => {
      if (server?.listening) await closeServer(server);
      if (directory) await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Playwright BrowserDriver", () => {
  it("measures the exact matrix and atomically finalizes portable evidence", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><main><h1>Current work</h1><button>Continue</button></main></body></html>",
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    expect(execution.result.outcome).toBe("MEASURED");
    if (execution.result.outcome !== "MEASURED") throw new Error("Expected measured browser evidence");
    expect(execution.result.executions).toHaveLength(1);
    expect(execution.result.executions[0]?.steps.every(({ status }) => status === "PASSED")).toBe(true);
    expect(execution.result.executions[0]?.assertions.every(({ status }) => status === "PASSED")).toBe(true);
    expect(execution.result.observations).toEqual([]);
    expect(execution.result.defects).toEqual([]);
    expect(execution.result.attachments.map(({ kind }) => kind).sort()).toEqual(["SCREENSHOT", "TRACE"]);

    let attachmentIndex = 0;
    await expect(
      execution.finalizeAttachments({
        qaRunId: "qa-run-1",
        createAttachmentId: () => {
          throw new Error("CANARY_UNTYPED_ATTACHMENT_ID_FAILURE");
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserDriverError",
        code: "ATTACHMENT_FINALIZATION_FAILED",
        message: "Browser QA attachments could not be finalized safely.",
      }),
    );
    const finalized = await execution.finalizeAttachments({
      qaRunId: "qa-run-1",
      createAttachmentId: () => `attachment-${(attachmentIndex += 1).toString()}`,
    });
    expect(finalized).toHaveLength(2);
    for (const item of finalized) {
      expect(item.ref.storageKey.startsWith("run-")).toBe(true);
      await expect(access(join(directory, "qa", item.ref.storageKey))).resolves.toBeUndefined();
    }
    await execution.dispose();
    await expect(
      access(join(directory, "qa", finalized[0]?.ref.storageKey.split("/")[0] ?? "")),
    ).resolves.toBeUndefined();
    const runStorageSegment = finalized[0]?.ref.storageKey.split("/")[0];
    if (!runStorageSegment) throw new Error("Expected an attachment storage segment");
    await expect(
      access(join(directory, "qa", runStorageSegment, BROWSER_QA_RECOVERY_MARKER)),
    ).resolves.toBeUndefined();
    await execution.confirmAttachments();
    await expect(
      access(join(directory, "qa", runStorageSegment, BROWSER_QA_RECOVERY_MARKER)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports keyboard focus through the public measured result", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><body><main><a href="#start">Start</a><button>Continue</button></main></body></html>',
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-focus-"));
    resources.push({ server: fixture.server, directory });
    const baseline = qaRun(fixture.origin);
    const run: QARun = {
      ...baseline,
      plan: {
        ...baseline.plan,
        scenarios: [
          {
            id: "keyboard-focus",
            title: "Owner can reach the primary action with the keyboard",
            steps: [
              { id: "open-home", title: "Open home", action: { type: "NAVIGATE", path: "/" } },
              {
                id: "focus-action",
                title: "Move focus to the primary action",
                action: {
                  type: "PRESS",
                  locator: { by: "ROLE", role: "link", name: "Start" },
                  key: "Tab",
                },
              },
            ],
            assertions: [
              {
                id: "primary-action-focused",
                title: "The primary action receives keyboard focus",
                rule: { type: "FOCUSED", locator: { by: "ROLE", role: "button", name: "Continue" } },
              },
            ],
          },
        ],
      },
    };

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(run);

    expect(execution.result).toMatchObject({
      outcome: "MEASURED",
      executions: [
        {
          assertions: [{ id: "primary-action-focused", status: "PASSED", details: null }],
        },
      ],
      defects: [],
    });
    await execution.dispose();
  });

  it("waits a bounded interval for client-side navigation and rendered assertions", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>
        <button id="continue">Continue</button>
        <script>
          document.querySelector("#continue").addEventListener("click", () => {
            setTimeout(() => {
              history.pushState({}, "", "/ready");
              document.body.innerHTML = '<main><h1>Ready</h1><input aria-label="Email"></main>';
              document.querySelector('input').focus();
            }, 100);
          });
        </script>
      </body></html>`);
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-client-navigation-"));
    resources.push({ server: fixture.server, directory });
    const baseline = qaRun(fixture.origin);
    const run: QARun = {
      ...baseline,
      plan: {
        ...baseline.plan,
        scenarios: [
          {
            id: "client-navigation",
            title: "Client navigation settles before assertions",
            steps: [
              { id: "open-home", title: "Open home", action: { type: "NAVIGATE", path: "/" } },
              {
                id: "continue",
                title: "Continue",
                action: {
                  type: "CLICK",
                  locator: { by: "ROLE", role: "button", name: "Continue" },
                },
              },
            ],
            assertions: [
              {
                id: "ready-path",
                title: "Ready path is current",
                rule: { type: "URL_PATH", path: "/ready" },
              },
              {
                id: "ready-heading",
                title: "Ready heading is visible",
                rule: { type: "VISIBLE", locator: { by: "ROLE", role: "heading", name: "Ready" } },
              },
              {
                id: "email-focused",
                title: "Email is focused",
                rule: { type: "FOCUSED", locator: { by: "ROLE", role: "textbox", name: "Email" } },
              },
            ],
          },
        ],
      },
    };

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory, timeoutMs: 1_000 }).run(
      run,
    );

    expect(execution.result).toMatchObject({ outcome: "MEASURED", defects: [] });
    await execution.dispose();
  });

  it("executes only the ordered cells selected by a correction retest plan", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><main><h1>Current work</h1><button>Continue</button></main></body></html>",
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-retest-"));
    resources.push({ server: fixture.server, directory });
    const baseline = qaRun(fixture.origin);
    const baselineTarget = baseline.plan.targets[0];
    const baselineScenario = baseline.plan.scenarios[0];
    if (baselineTarget === undefined || baselineScenario === undefined) {
      throw new Error("Expected a non-empty Browser QA baseline fixture");
    }
    const secondTarget = {
      ...baselineTarget,
      id: "mobile-dark-ru",
      viewport: { width: 320, height: 720 },
      locale: "ru-RU",
      theme: "DARK" as const,
    };
    const secondScenario = {
      ...baselineScenario,
      id: "acceptance",
      title: "Owner can inspect acceptance",
    };
    const run: QARun = {
      ...baseline,
      plan: {
        ...baseline.plan,
        targets: [...baseline.plan.targets, secondTarget],
        scenarios: [...baseline.plan.scenarios, secondScenario],
      },
      scope: {
        type: "RETEST",
        correctionRunId: "correction-1",
        retestPlanId: "retest-plan-1",
      },
    };

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(run, [
      {
        targetId: secondTarget.id,
        scenarioId: secondScenario.id,
        reasons: ["FAILED_CHECK", "OPEN_DEFECT"],
      },
    ]);

    expect(execution.result).toMatchObject({
      outcome: "MEASURED",
      executions: [{ targetId: secondTarget.id, scenarioId: secondScenario.id }],
      attachments: [
        { kind: "SCREENSHOT", targetId: secondTarget.id, scenarioId: secondScenario.id },
        { kind: "TRACE", targetId: secondTarget.id, scenarioId: secondScenario.id },
      ],
    });
    await execution.dispose();
  });

  it("confirms committed attachments and quarantines uncommitted attachments after restart", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><main><h1>Current work</h1><button>Continue</button></main></body></html>",
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-recovery-"));
    resources.push({ server: fixture.server, directory });
    const driver = createPlaywrightDriver({ artifactsDirectory: directory });

    const orphanedExecution = await driver.run(qaRun(fixture.origin));
    const orphaned = await orphanedExecution.finalizeAttachments({
      qaRunId: "qa-run-1",
      createAttachmentId: () => "orphaned-attachment",
    });
    const orphanedSegment = orphaned[0]?.ref.storageKey.split("/")[0];
    if (!orphanedSegment) throw new Error("Expected orphaned attachments");
    await expect(
      recoverBrowserQAArtifacts({ artifactsDirectory: directory, isCommitted: () => false }),
    ).resolves.toEqual([
      {
        qaRunId: "qa-run-1",
        runStorageSegment: orphanedSegment,
        action: "QUARANTINED_ORPHAN",
      },
    ]);
    await expect(access(join(directory, "qa", orphanedSegment))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(directory, ".quarantine", "orphaned"))).toHaveLength(1);

    let attachmentIndex = 0;
    const committedExecution = await driver.run(qaRun(fixture.origin));
    const committed = await committedExecution.finalizeAttachments({
      qaRunId: "qa-run-1",
      createAttachmentId: () => `committed-${(attachmentIndex += 1).toString()}`,
    });
    const committedSegment = committed[0]?.ref.storageKey.split("/")[0];
    if (!committedSegment) throw new Error("Expected committed attachments");
    await expect(
      recoverBrowserQAArtifacts({
        artifactsDirectory: directory,
        isCommitted: (marker) =>
          marker.qaRunId === "qa-run-1" && marker.attachments.length === committed.length,
      }),
    ).resolves.toEqual([{ qaRunId: "qa-run-1", runStorageSegment: committedSegment, action: "CONFIRMED" }]);
    await expect(
      access(join(directory, "qa", committedSegment, BROWSER_QA_RECOVERY_MARKER)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const item of committed) {
      await expect(access(join(directory, "qa", item.ref.storageKey))).resolves.toBeUndefined();
    }
  });

  it("normalizes recovery scan failures without exposing filesystem details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-recovery-errors-"));
    resources.push({ directory });
    const occupied = join(directory, "occupied");
    await writeFile(occupied, "not a directory", "utf8");

    await expect(
      recoverBrowserQAArtifacts({ artifactsDirectory: occupied, isCommitted: () => false }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserQAArtifactRecoveryError",
        code: "RECOVERY_SCAN_FAILED",
        message: "Browser QA artifact recovery could not inspect the managed storage safely.",
      }),
    );
    await expect(
      recoverBrowserQAArtifacts({ artifactsDirectory: occupied, isCommitted: () => false }),
    ).rejects.toBeInstanceOf(BrowserQAArtifactRecoveryError);
  });

  it("treats an absent artifact root or qa child as nothing to recover", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-empty-recovery-"));
    resources.push({ directory });

    await expect(
      recoverBrowserQAArtifacts({
        artifactsDirectory: join(directory, "absent"),
        isCommitted: () => false,
      }),
    ).resolves.toEqual([]);
    await expect(
      recoverBrowserQAArtifacts({ artifactsDirectory: directory, isCommitted: () => false }),
    ).resolves.toEqual([]);
  });

  it("fails closed when a recovery root exceeds the 10,000-entry scan bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-bounded-recovery-"));
    resources.push({ directory });
    const qaDirectory = join(directory, "qa");
    await mkdir(qaDirectory);
    const totalEntries = 10_001;
    const batchSize = 250;
    for (let offset = 0; offset < totalEntries; offset += batchSize) {
      await Promise.all(
        Array.from({ length: Math.min(batchSize, totalEntries - offset) }, (_value, index) =>
          mkdir(join(qaDirectory, `entry-${(offset + index).toString().padStart(5, "0")}`)),
        ),
      );
    }

    await expect(
      recoverBrowserQAArtifacts({ artifactsDirectory: directory, isCommitted: () => false }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserQAArtifactRecoveryError",
        code: "RECOVERY_SCAN_FAILED",
      }),
    );
  }, 60_000);

  it("refuses a linked recovery root without mutating its external target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-symlink-root-"));
    const external = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-external-root-"));
    resources.push({ directory }, { directory: external });
    const segment = `run-${"a".repeat(32)}`;
    const externalRun = join(external, segment);
    await mkdir(externalRun);
    const marker = join(externalRun, BROWSER_QA_RECOVERY_MARKER);
    await writeFile(marker, "not-json", "utf8");
    await createDirectoryLink(external, join(directory, "qa"));

    await expect(
      recoverBrowserQAArtifacts({ artifactsDirectory: directory, isCommitted: () => false }),
    ).rejects.toBeInstanceOf(BrowserQAArtifactRecoveryError);
    await expect(access(marker)).resolves.toBeUndefined();
    await expect(access(externalRun)).resolves.toBeUndefined();
    await expect(access(join(directory, ".quarantine"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses a dangling symlink at the recovery root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-dangling-root-"));
    resources.push({ directory });
    await symlink(join(directory, "missing-target"), join(directory, "qa"));

    await expect(
      recoverBrowserQAArtifacts({ artifactsDirectory: directory, isCommitted: () => false }),
    ).rejects.toBeInstanceOf(BrowserQAArtifactRecoveryError);
  });

  it("refuses linked setup and finalization roots without mutating their targets", async () => {
    const setupRoot = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-setup-root-"));
    const setupExternal = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-setup-external-"));
    resources.push({ directory: setupRoot }, { directory: setupExternal });
    const sentinel = join(setupExternal, "sentinel.txt");
    await writeFile(sentinel, "preserve me", "utf8");
    await createDirectoryLink(setupExternal, join(setupRoot, ".quarantine"));

    await expect(
      createPlaywrightDriver({ artifactsDirectory: setupRoot }).run(qaRun("http://127.0.0.1:4173")),
    ).rejects.toMatchObject({ code: "DRIVER_SETUP_FAILED" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve me");

    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><main><h1>Current work</h1><button>Continue</button></main></body></html>",
      );
    });
    const finalRoot = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-final-root-"));
    const finalExternal = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-final-external-"));
    resources.push({ server: fixture.server, directory: finalRoot }, { directory: finalExternal });
    const execution = await createPlaywrightDriver({ artifactsDirectory: finalRoot }).run(
      qaRun(fixture.origin),
    );
    await createDirectoryLink(finalExternal, join(finalRoot, "qa"));
    await expect(
      execution.finalizeAttachments({ qaRunId: "qa-run-1", createAttachmentId: () => "attachment-1" }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_FINALIZATION_FAILED" });
    await expect(readdir(finalExternal)).resolves.toEqual([]);
    await execution.dispose();
  });

  it("refuses to open matching evidence through a linked QA root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-open-root-"));
    const external = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-open-external-"));
    resources.push({ directory }, { directory: external });
    const segment = `run-${"a".repeat(32)}`;
    await mkdir(join(external, segment));
    await writeFile(join(external, segment, "evidence.txt"), "evidence", "utf8");
    await createDirectoryLink(external, join(directory, "qa"));
    const value: QAAttachmentRef = {
      schemaVersion: 1,
      id: "attachment-1",
      qaRunId: "qa-run-1",
      kind: "SCREENSHOT",
      contentHash: `sha256:${"a".repeat(64)}`,
      byteSize: 8,
      targetId: "desktop-light-en",
      scenarioId: "current-work",
      capturedAt: "2026-09-03T09:00:00.000Z",
      retentionClass: "STANDARD_30_DAYS",
      storageKey: `${segment}/evidence.txt`,
    };

    await expect(
      openVerifiedBrowserQAArtifact({ artifactsDirectory: directory, attachment: value }),
    ).rejects.toMatchObject({ code: "STORAGE_LAYOUT_INVALID" });
    await expect(readFile(join(external, segment, "evidence.txt"), "utf8")).resolves.toBe("evidence");
  });

  it("blocks off-origin redirects and exposes no finalizable evidence", async () => {
    const destination = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><h1>Outside</h1>");
    });
    const fixture = await startServer((_request, response) => {
      response.writeHead(302, { location: destination.origin });
      response.end();
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server }, { server: destination.server, directory });

    const startedAt = Date.now();
    const execution = await createPlaywrightDriver({
      artifactsDirectory: directory,
      timeoutMs: 30_000,
    }).run(qaRun(fixture.origin));

    if (execution.result.outcome !== "ERROR") throw new Error(JSON.stringify(execution.result));
    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "ORIGIN_FORBIDDEN" });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    await expect(
      execution.finalizeAttachments({ qaRunId: "qa-run-1", createAttachmentId: () => "attachment-1" }),
    ).resolves.toEqual([]);
    await execution.dispose();
    await expect(access(join(directory, ".quarantine"))).resolves.toBeUndefined();
  });

  it("hydrates through a bounded same-origin WebSocket without forwarding client frames", async () => {
    const clientTextFrames: string[] = [];
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><h1>Current work</h1>" +
          "<script>const socket=new WebSocket(`ws://${location.host}/dev`);" +
          "socket.addEventListener('open',()=>{" +
          "socket.send('client-command-must-not-leave-browser');" +
          "const button=document.createElement('button');button.textContent='Continue';document.body.append(button)" +
          "})</script></body></html>",
      );
    });
    acceptWebSocketUpgrades(fixture.server, (opcode, payload) => {
      if (opcode === 1) clientTextFrames.push(payload.toString("utf8"));
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-websocket-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    expect(execution.result.outcome).toBe("MEASURED");
    expect(clientTextFrames).toEqual([]);
    await execution.dispose();
  });

  it("does not click server-rendered controls before same-origin hydration is ready", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><h1>Current work</h1><button>Continue</button>" +
          "<script>const socket=new WebSocket(`ws://${location.host}/dev`);" +
          "socket.addEventListener('open',()=>document.querySelector('button').addEventListener('click',()=>{" +
          "const input=document.createElement('input');input.setAttribute('aria-label','Email');document.body.append(input)" +
          "}))</script></body></html>",
      );
    });
    acceptWebSocketUpgrades(fixture.server, () => undefined, [], 200);
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-hydration-"));
    resources.push({ server: fixture.server, directory });
    const run = qaRun(fixture.origin);
    const scenario = run.plan.scenarios[0];
    if (!scenario) throw new Error("Expected a fixture scenario");
    scenario.steps = [
      { id: "open-home", title: "Open home", action: { type: "NAVIGATE", path: "/" } },
      {
        id: "continue",
        title: "Continue",
        action: { type: "CLICK", locator: { by: "ROLE", role: "button", name: "Continue" } },
      },
      {
        id: "focus-email",
        title: "Focus email",
        action: { type: "PRESS", locator: { by: "ROLE", role: "textbox", name: "Email" }, key: "Space" },
      },
    ];

    const execution = await createPlaywrightDriver({
      artifactsDirectory: directory,
      timeoutMs: 1_000,
    }).run(run);

    expect(execution.result.outcome).toBe("MEASURED");
    await execution.dispose();
  });

  it("blocks an off-origin WebSocket and exposes no finalizable evidence", async () => {
    const destination = await startServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const websocketOrigin = destination.origin.replace("http://", "ws://");
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><h1>Current work</h1><button>Continue</button>" +
          `<script>new WebSocket('${websocketOrigin}/outside')</script></body></html>`,
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-websocket-"));
    resources.push({ server: fixture.server }, { server: destination.server, directory });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "ORIGIN_FORBIDDEN" });
    await expect(
      execution.finalizeAttachments({ qaRunId: "qa-run-1", createAttachmentId: () => "attachment-1" }),
    ).resolves.toEqual([]);
    await execution.dispose();
  });

  it("fails closed when same-origin WebSocket evidence exceeds its message limit", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><h1>Current work</h1>" +
          "<script>const socket=new WebSocket(`ws://${location.host}/dev`);" +
          "socket.addEventListener('message',()=>{" +
          "const button=document.createElement('button');button.textContent='Continue';document.body.append(button)" +
          "})</script></body></html>",
      );
    });
    acceptWebSocketUpgrades(fixture.server, () => undefined, [
      Buffer.from("ready", "utf8"),
      Buffer.alloc(1 * 1_024 * 1_024 + 1, 97),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-websocket-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "EVIDENCE_INVALID" });
    await execution.dispose();
  });

  it("turns a blocked mutation into measured blocking evidence and a defect", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><main><h1>Current work</h1><button>Continue</button></main><script>fetch('/mutation',{method:'POST'}).catch(()=>undefined)</script></body></html>",
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    expect(execution.result.outcome).toBe("MEASURED");
    if (execution.result.outcome !== "MEASURED") throw new Error("Expected measured browser evidence");
    expect(execution.result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "NETWORK", severity: "ERROR", blocking: true }),
      ]),
    );
    expect(execution.result.defects).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Blocking network error" })]),
    );
    await execution.dispose();
  });

  it("fails closed when the page opens a dialog", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><main><h1>Current work</h1><button>Continue</button></main><script>alert('blocked')</script></body></html>",
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "EVIDENCE_INVALID" });
    await execution.dispose();
  });

  it("pins a verified localhost target to its resolved loopback address", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><h1>Current work</h1><button>Continue</button>");
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });
    const localhostOrigin = fixture.origin.replace("127.0.0.1", "localhost");

    const execution = await createPlaywrightDriver({
      artifactsDirectory: directory,
      resolveHostname: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    }).run(qaRun(localhostOrigin));

    expect(execution.result.outcome).toBe("MEASURED");
    await execution.dispose();
  });

  it("rejects localhost when resolution includes a non-loopback address", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><h1>Current work</h1><button>Continue</button>");
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });
    const localhostOrigin = fixture.origin.replace("127.0.0.1", "localhost");

    const execution = await createPlaywrightDriver({
      artifactsDirectory: directory,
      resolveHostname: () =>
        Promise.resolve([
          { address: "127.0.0.1", family: 4 },
          { address: "203.0.113.10", family: 4 },
        ]),
    }).run(qaRun(localhostOrigin));

    expect(execution.result).toEqual({
      outcome: "ERROR",
      code: "ORIGIN_FORBIDDEN",
      summary: "The localhost QA target did not resolve exclusively to loopback addresses.",
    });
    await execution.dispose();
  });

  it("fails closed when a response exceeds the per-response limit", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": (MAX_QA_RESPONSE_BYTES + 1).toString(),
      });
      response.end(Buffer.alloc(MAX_QA_RESPONSE_BYTES + 1, 97));
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({
      artifactsDirectory: directory,
      timeoutMs: 1_000,
    }).run(qaRun(fixture.origin));

    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "EVIDENCE_INVALID" });
    await execution.dispose();
  });

  it("reports navigation timeouts distinctly and exposes no finalizable evidence", async () => {
    const fixture = await startServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><h1>Current work</h1><button>Continue</button>");
      }, 250);
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({
      artifactsDirectory: directory,
      timeoutMs: 50,
    }).run(qaRun(fixture.origin));

    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "TIMEOUT" });
    await expect(
      execution.finalizeAttachments({ qaRunId: "qa-run-1", createAttachmentId: () => "attachment-1" }),
    ).resolves.toEqual([]);
    await execution.dispose();
  });

  it("redacts secrets and personal paths before observations become durable", async () => {
    const macOSPath = ["", "Users", "owner", "private.txt"].join("/");
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><h1>Current work</h1><button>Continue</button>" +
          `<script>console.error('token=CANARY_TOKEN Bearer CANARY_BEARER ${macOSPath} C:\\\\Users\\\\owner\\\\secret.txt')</script>`,
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    if (execution.result.outcome !== "MEASURED") throw new Error(JSON.stringify(execution.result));
    const durableText = JSON.stringify({
      observations: execution.result.observations,
      defects: execution.result.defects,
    });
    expect(durableText).not.toContain("CANARY_TOKEN");
    expect(durableText).not.toContain("CANARY_BEARER");
    expect(durableText).not.toContain(macOSPath);
    expect(durableText).not.toContain("C:\\\\Users\\\\owner");
    expect(durableText).toContain("[redacted]");
    expect(durableText).toContain("[local-path]");
    await execution.dispose();
  });

  it("does not forward page-created credentials or persist target cookies", async () => {
    const receivedCredentialHeaders: { path: string; authorization?: string; cookie?: string }[] = [];
    const fixture = await startServer((request, response) => {
      if (request.url === "/probe" || request.url === "/credential") {
        receivedCredentialHeaders.push({
          path: request.url,
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          ...(request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }),
        });
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ready");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "qa-secret=CANARY_COOKIE; Path=/",
      });
      response.end(
        "<!doctype html><h1>Current work</h1><button>Continue</button>" +
          "<script>fetch('/probe').then(()=>fetch('/credential',{headers:{authorization:'Bearer CANARY_AUTH'}}))</script>",
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-"));
    resources.push({ server: fixture.server, directory });
    const run = qaRun(fixture.origin);
    const scenario = run.plan.scenarios[0];
    if (!scenario) throw new Error("Expected a fixture scenario");
    scenario.steps.push({
      id: "wait-for-probe",
      title: "Wait for the credential probe",
      action: { type: "WAIT_FOR_IDLE" },
    });

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(run);

    expect(receivedCredentialHeaders).toEqual([{ path: "/probe" }]);
    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "EVIDENCE_INVALID" });
    expect(JSON.stringify(execution.result)).not.toContain("CANARY_AUTH");
    expect(JSON.stringify(execution.result)).not.toContain("CANARY_COOKIE");
    await execution.dispose();
  });

  it("rejects unsafe runtime limits before launching Chromium", () => {
    expect(() => createPlaywrightDriver({ artifactsDirectory: "/tmp/browser-qa", timeoutMs: 0 })).toThrow();
  });

  it("normalizes every asynchronous setup rejection to the closed BrowserDriver error vocabulary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-browser-qa-errors-"));
    resources.push({ directory });
    const artifactFile = join(directory, "not-a-directory");
    await writeFile(artifactFile, "occupied", "utf8");
    const driver = createPlaywrightDriver({ artifactsDirectory: artifactFile });

    await expect(driver.run({ ...qaRun("http://127.0.0.1:4173"), id: "" })).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserDriverError",
        code: "INVALID_INPUT",
        message: "The Browser QA run input is invalid.",
      }),
    );
    await expect(driver.run(qaRun("http://127.0.0.1:4173"))).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserDriverError",
        code: "DRIVER_SETUP_FAILED",
        message: "The Browser QA driver could not start safely.",
      }),
    );
    await expect(driver.run(qaRun("http://127.0.0.1:4173"), [])).rejects.toBeInstanceOf(BrowserDriverError);

    const hostileRun = qaRun("http://127.0.0.1:4173");
    Object.defineProperty(hostileRun, "id", {
      get: () => {
        throw new BrowserDriverError("INVALID_INPUT", "CANARY_SECRET_FROM_CALLBACK");
      },
    });
    const rejection = createPlaywrightDriver({ artifactsDirectory: directory }).run(hostileRun);
    await expect(rejection).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserDriverError",
        code: "INVALID_INPUT",
        message: "The Browser QA run input is invalid.",
      }),
    );
    await expect(rejection).rejects.not.toHaveProperty("message", expect.stringContaining("CANARY_SECRET"));

    const runtimeOpenCode = new BrowserDriverError(
      "CANARY_SECRET" as BrowserDriverErrorCode,
      "CANARY_SECRET_FROM_CODE",
    );
    Object.defineProperty(runtimeOpenCode, "code", { value: "CANARY_SECRET" });
    const hostileCodeRun = qaRun("http://127.0.0.1:4173");
    Object.defineProperty(hostileCodeRun, "id", {
      get: () => {
        throw runtimeOpenCode;
      },
    });
    const hostileCodeRejection = createPlaywrightDriver({ artifactsDirectory: directory }).run(
      hostileCodeRun,
    );
    await expect(hostileCodeRejection).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserDriverError",
        code: "DRIVER_SETUP_FAILED",
        message: "The Browser QA driver could not start safely.",
      }),
    );
    await expect(hostileCodeRejection).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining("CANARY_SECRET"),
    );

    const hostileGetterError = new BrowserDriverError("INVALID_INPUT", "CANARY_SECRET_FROM_GETTER");
    Object.defineProperty(hostileGetterError, "code", {
      get: () => {
        throw new Error("CANARY_SECRET_FROM_CODE_GETTER");
      },
    });
    const hostileGetterRun = qaRun("http://127.0.0.1:4173");
    Object.defineProperty(hostileGetterRun, "id", {
      get: () => {
        throw hostileGetterError;
      },
    });
    await expect(
      createPlaywrightDriver({ artifactsDirectory: directory }).run(hostileGetterRun),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "BrowserDriverError",
        code: "DRIVER_SETUP_FAILED",
        message: "The Browser QA driver could not start safely.",
      }),
    );

    let codeReads = 0;
    const changingGetterError = new BrowserDriverError("INVALID_INPUT", "CANARY_SECRET_FROM_CHANGING_GETTER");
    Object.defineProperty(changingGetterError, "code", {
      get: () => {
        codeReads += 1;
        if (codeReads === 1) return "INVALID_INPUT";
        return {
          [Symbol.toPrimitive]: () => {
            throw new Error("CANARY_SECRET_FROM_SECOND_CODE_READ");
          },
        };
      },
    });
    const changingGetterRun = qaRun("http://127.0.0.1:4173");
    Object.defineProperty(changingGetterRun, "id", {
      get: () => {
        throw changingGetterError;
      },
    });
    let changingGetterRejection: unknown;
    try {
      await createPlaywrightDriver({ artifactsDirectory: directory }).run(changingGetterRun);
    } catch (error: unknown) {
      changingGetterRejection = error;
    }
    expect(changingGetterRejection).toBeInstanceOf(BrowserDriverError);
    if (!(changingGetterRejection instanceof BrowserDriverError)) {
      throw new Error("Expected a normalized BrowserDriverError");
    }
    expect(changingGetterRejection.code).toBe("INVALID_INPUT");
    expect(changingGetterRejection.message).toBe("The Browser QA run input is invalid.");
    expect(codeReads).toBe(1);
  });
});
