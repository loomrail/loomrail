import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QAAttachmentRef } from "@loomrail/contracts";
import type { LocalState, StateQuery, StateQueryResult } from "@loomrail/persistence-sqlite";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupExpiredBrowserQAArtifacts } from "../src/browser-qa-retention.js";

const runStorageSegment = `run-${"c".repeat(32)}`;

describe("daemon Browser QA retention", () => {
  let artifactsDirectory = "";

  beforeEach(async () => {
    artifactsDirectory = await mkdtemp(join(tmpdir(), "loomrail daemon qa retention "));
  });

  afterEach(async () => {
    await rm(artifactsDirectory, { recursive: true, force: true });
  });

  it("deletes an expired file, records the outcome, and does not select it again", async () => {
    const attachment: QAAttachmentRef = {
      schemaVersion: 1,
      id: "attachment-expired",
      qaRunId: "qa-run-expired",
      kind: "SCREENSHOT",
      contentHash: `sha256:${"d".repeat(64)}`,
      byteSize: 8,
      targetId: "desktop-light-en",
      scenarioId: "current-work",
      capturedAt: "2026-07-01T10:00:00.000Z",
      retentionClass: "STANDARD_30_DAYS",
      storageKey: `${runStorageSegment}/screenshot.png`,
    };
    const runDirectory = join(artifactsDirectory, "qa", runStorageSegment);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "screenshot.png"), "evidence");

    let recorded = false;
    let selectedCutoff = "";
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      execute: (command) => {
        if (command.type !== "RECORD_QA_ATTACHMENT_RETENTION") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        expect(command.payload).toEqual({ attachmentId: attachment.id, outcome: "DELETED" });
        recorded = true;
        return {
          schemaVersion: 1,
          type: "QA_ATTACHMENT_RETENTION_RECORDED",
          replayed: false,
          attachmentId: attachment.id,
          outcome: "DELETED",
          recordedAt: "2026-09-02T12:00:00.000Z",
        };
      },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type !== "LIST_EXPIRED_QA_ATTACHMENTS") {
          throw new Error(`Unexpected query ${query.type}`);
        }
        selectedCutoff = query.closedBefore;
        return { type: "QA_ATTACHMENTS", attachments: recorded ? [] : [attachment] };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    await expect(
      cleanupExpiredBrowserQAArtifacts({
        state,
        artifactsDirectory,
        now: new Date("2026-09-02T12:00:00.000Z"),
        logger: app.log,
      }),
    ).resolves.toEqual({ selected: 1, recorded: 1, skipped: 0 });
    expect(selectedCutoff).toBe("2026-08-03T12:00:00.000Z");
    await expect(access(join(runDirectory, "screenshot.png"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      cleanupExpiredBrowserQAArtifacts({
        state,
        artifactsDirectory,
        now: new Date("2026-09-02T12:00:00.000Z"),
        logger: app.log,
      }),
    ).resolves.toEqual({ selected: 0, recorded: 0, skipped: 0 });
    await app.close();
  });
});
