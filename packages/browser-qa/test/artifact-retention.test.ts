import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QAAttachmentRef } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { BROWSER_QA_RECOVERY_MARKER, deleteExpiredBrowserQAArtifacts } from "../src/index.js";

const runStorageSegment = `run-${"a".repeat(32)}`;
const directories: string[] = [];

const attachment = (filename = "screenshot.png"): QAAttachmentRef => ({
  schemaVersion: 1,
  id: `attachment-${filename.replaceAll(".", "-")}`,
  qaRunId: "qa-run-1",
  kind: "SCREENSHOT",
  contentHash: `sha256:${"b".repeat(64)}`,
  byteSize: 8,
  targetId: "desktop-light-en",
  scenarioId: "current-work",
  capturedAt: "2026-08-01T10:00:00.000Z",
  retentionClass: "STANDARD_30_DAYS",
  storageKey: `${runStorageSegment}/${filename}`,
});

const setup = async (): Promise<{ directory: string; runDirectory: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "loomrail-qa-retention-"));
  directories.push(directory);
  const runDirectory = join(directory, "qa", runStorageSegment);
  await mkdir(runDirectory, { recursive: true });
  return { directory, runDirectory };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Browser QA artifact retention", () => {
  it("unlinks only the exact durable attachment and removes its directory only when empty", async () => {
    const { directory, runDirectory } = await setup();
    await writeFile(join(runDirectory, "screenshot.png"), "evidence");

    await expect(
      deleteExpiredBrowserQAArtifacts({ artifactsDirectory: directory, attachments: [attachment()] }),
    ).resolves.toEqual([
      {
        attachmentId: "attachment-screenshot-png",
        storageKey: `${runStorageSegment}/screenshot.png`,
        action: "DELETED",
      },
    ]);
    await expect(access(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unknown siblings and marker-bound runs without recursive cleanup", async () => {
    const { directory, runDirectory } = await setup();
    await writeFile(join(runDirectory, "screenshot.png"), "evidence");
    await writeFile(join(runDirectory, "owner-note.txt"), "preserve me");

    await deleteExpiredBrowserQAArtifacts({ artifactsDirectory: directory, attachments: [attachment()] });

    await expect(readFile(join(runDirectory, "owner-note.txt"), "utf8")).resolves.toBe("preserve me");
    await writeFile(join(runDirectory, "trace.zip"), "evidence");
    await writeFile(join(runDirectory, BROWSER_QA_RECOVERY_MARKER), "pending");
    await expect(
      deleteExpiredBrowserQAArtifacts({
        artifactsDirectory: directory,
        attachments: [attachment("trace.zip")],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ action: "SKIPPED_PENDING", storageKey: `${runStorageSegment}/trace.zip` }),
    ]);
    await expect(readFile(join(runDirectory, "trace.zip"), "utf8")).resolves.toBe("evidence");
  });

  it("rejects storage outside the managed two-segment layout", async () => {
    const value = { ...attachment(), storageKey: "unmanaged/screenshot.png" };
    await expect(
      deleteExpiredBrowserQAArtifacts({ artifactsDirectory: "/not-used", attachments: [value] }),
    ).resolves.toEqual([
      {
        attachmentId: value.id,
        storageKey: value.storageKey,
        action: "SKIPPED_UNSAFE",
      },
    ]);
  });

  it.skipIf(process.platform === "win32")("never follows an attachment symlink", async () => {
    const { directory, runDirectory } = await setup();
    const outside = join(directory, "outside.txt");
    await writeFile(outside, "preserve me");
    await symlink(outside, join(runDirectory, "screenshot.png"));

    await expect(
      deleteExpiredBrowserQAArtifacts({ artifactsDirectory: directory, attachments: [attachment()] }),
    ).resolves.toEqual([expect.objectContaining({ action: "SKIPPED_UNSAFE" })]);
    await expect(readFile(outside, "utf8")).resolves.toBe("preserve me");
  });

  it.skipIf(process.platform === "win32")("never follows a symlinked QA root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail-qa-retention-root-"));
    directories.push(directory);
    const outsideQADirectory = join(directory, "outside-qa");
    const outsideRunDirectory = join(outsideQADirectory, runStorageSegment);
    await mkdir(outsideRunDirectory, { recursive: true });
    await writeFile(join(outsideRunDirectory, "screenshot.png"), "preserve me");
    await symlink(outsideQADirectory, join(directory, "qa"));

    await expect(
      deleteExpiredBrowserQAArtifacts({ artifactsDirectory: directory, attachments: [attachment()] }),
    ).resolves.toEqual([expect.objectContaining({ action: "SKIPPED_UNSAFE" })]);
    await expect(readFile(join(outsideRunDirectory, "screenshot.png"), "utf8")).resolves.toBe("preserve me");
  });
});
