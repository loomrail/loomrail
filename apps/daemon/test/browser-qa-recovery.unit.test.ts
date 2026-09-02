import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BROWSER_QA_RECOVERY_MARKER } from "@loomrail/browser-qa";
import type { QAAttachmentRef, QARun } from "@loomrail/contracts";
import type { LocalState, StateQuery, StateQueryResult } from "@loomrail/persistence-sqlite";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileBrowserQAArtifacts } from "../src/browser-qa-recovery.js";

const qaRun = (id: string, status: QARun["status"]): QARun => ({
  schemaVersion: 1,
  id,
  projectId: "project-qa",
  workItemId: "work-item-qa",
  pipelineRunId: "pipeline-run-qa",
  stageAttemptId: "stage-attempt-qa",
  agentRunId: "agent-run-qa",
  driverId: "PLAYWRIGHT",
  testedTree: "a".repeat(40),
  targetOrigin: "http://127.0.0.1:4173",
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
        id: "home",
        title: "Home opens",
        steps: [{ id: "open", title: "Open home", action: { type: "NAVIGATE", path: "/" } }],
        assertions: [{ id: "home-path", title: "Home path", rule: { type: "URL_PATH", path: "/" } }],
      },
    ],
  },
  scope: { type: "FULL" },
  status,
  error: null,
  startedAt: "2026-09-02T00:00:00.000Z",
  completedAt: status === "RUNNING" ? null : "2026-09-02T00:01:00.000Z",
  version: status === "RUNNING" ? 1 : 2,
});

const stateFor = (run: QARun | null, attachments: QAAttachmentRef[]): LocalState => ({
  startup: { appliedMigrations: [] },
  execute: () => {
    throw new Error("Recovery is read-only");
  },
  query: (query: StateQuery): StateQueryResult => {
    if (query.type === "GET_QA_RUN") return { type: "QA_RUN", qaRun: run };
    if (query.type === "GET_QA_STATE") {
      return { type: "QA_STATE", runs: run === null ? [] : [run], evidence: [], attachments, defects: [] };
    }
    throw new Error(`Unexpected query ${query.type}`);
  },
  close: () => undefined,
});

describe("daemon Browser QA artifact recovery", () => {
  let artifactsDirectory = "";

  beforeEach(async () => {
    artifactsDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon qa recovery "));
  });

  afterEach(async () => {
    await rm(artifactsDirectory, { recursive: true, force: true });
  });

  const stageMarker = async (runStorageSegment: string, runId: string): Promise<QAAttachmentRef> => {
    const directory = join(artifactsDirectory, "qa", runStorageSegment);
    const filename = "target-1--scenario-1.png";
    const content = Buffer.from("bounded screenshot evidence", "utf8");
    const attachment: QAAttachmentRef = {
      schemaVersion: 1,
      id: `attachment-${runId}`,
      qaRunId: runId,
      kind: "SCREENSHOT",
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      byteSize: content.byteLength,
      targetId: "desktop-light-en",
      scenarioId: "home",
      capturedAt: "2026-09-02T00:00:30.000Z",
      retentionClass: "STANDARD_30_DAYS",
      storageKey: `${runStorageSegment}/${filename}`,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename), content);
    await writeFile(
      join(directory, BROWSER_QA_RECOVERY_MARKER),
      JSON.stringify({
        schemaVersion: 1,
        qaRunId: runId,
        attachments: [{ handle: "screenshot:desktop-light-en:home", ref: attachment }],
      }),
    );
    return attachment;
  };

  it("removes only the marker when SQLite already committed the exact attachment", async () => {
    const runId = "qa-run-committed";
    const segment = `run-${"c".repeat(32)}`;
    const attachment = await stageMarker(segment, runId);

    await reconcileBrowserQAArtifacts({
      state: stateFor(qaRun(runId, "PASSED"), [attachment]),
      artifactsDirectory,
      logger: Fastify({ logger: false }).log,
    });

    await expect(
      access(join(artifactsDirectory, "qa", segment, BROWSER_QA_RECOVERY_MARKER)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(artifactsDirectory, "qa", attachment.storageKey))).resolves.toBeUndefined();
  });

  it("quarantines a marker whose QARun never committed", async () => {
    const runId = "qa-run-orphaned";
    const segment = `run-${"d".repeat(32)}`;
    await stageMarker(segment, runId);

    await reconcileBrowserQAArtifacts({
      state: stateFor(qaRun(runId, "RUNNING"), []),
      artifactsDirectory,
      logger: Fastify({ logger: false }).log,
    });

    await expect(access(join(artifactsDirectory, "qa", segment))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(artifactsDirectory, ".quarantine", "orphaned"))).toHaveLength(1);
  });

  it("quarantines committed metadata when the finalized file no longer matches its hash", async () => {
    const runId = "qa-run-tampered";
    const segment = `run-${"e".repeat(32)}`;
    const attachment = await stageMarker(segment, runId);
    await writeFile(join(artifactsDirectory, "qa", attachment.storageKey), "tampered evidence");

    await reconcileBrowserQAArtifacts({
      state: stateFor(qaRun(runId, "PASSED"), [attachment]),
      artifactsDirectory,
      logger: Fastify({ logger: false }).log,
    });

    await expect(access(join(artifactsDirectory, "qa", segment))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(artifactsDirectory, ".quarantine", "orphaned"))).toHaveLength(1);
  });
});
