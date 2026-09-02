import { createServer, type RequestListener, type Server } from "node:http";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QARun } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_QA_RECOVERY_MARKER,
  createPlaywrightDriver,
  recoverBrowserQAArtifacts,
} from "../src/index.js";

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

    const execution = await createPlaywrightDriver({ artifactsDirectory: directory }).run(
      qaRun(fixture.origin),
    );

    if (execution.result.outcome !== "ERROR") throw new Error(JSON.stringify(execution.result));
    expect(execution.result).toMatchObject({ outcome: "ERROR", code: "ORIGIN_FORBIDDEN" });
    await expect(
      execution.finalizeAttachments({ qaRunId: "qa-run-1", createAttachmentId: () => "attachment-1" }),
    ).resolves.toEqual([]);
    await execution.dispose();
    await expect(access(join(directory, ".quarantine"))).resolves.toBeUndefined();
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
});
