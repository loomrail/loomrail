import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupWorkspaceToolArtifacts,
  reconcileWorkspaceToolProcessProofs,
  WORKSPACE_TOOL_RECONCILE_BATCH_SIZE,
} from "../src/workspace-tool-recovery.js";

describe("workspace tool startup recovery handoff", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("removes only regular ephemeral command output without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail workspace recovery "));
    roots.push(root);
    const artifacts = join(root, "artifacts");
    await mkdir(artifacts);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "keep");
    await writeFile(join(artifacts, "workspace-tool-output-safe.txt"), "remove");
    await writeFile(join(artifacts, "unrelated.txt"), "keep");
    await symlink(outside, join(artifacts, "workspace-tool-output-link.txt"));

    await expect(cleanupWorkspaceToolArtifacts(artifacts)).resolves.toBe(1);
    await expect(readFile(outside, "utf8")).resolves.toBe("keep");
    await expect(readFile(join(artifacts, "unrelated.txt"), "utf8")).resolves.toBe("keep");
  });

  it("commits bounded UNKNOWN_OUTCOME batches before removing process proofs", async () => {
    const callIds = Array.from(
      { length: WORKSPACE_TOOL_RECONCILE_BATCH_SIZE + 1 },
      (_, index) => `workspace-call-${index.toString().padStart(4, "0")}`,
    );
    const events: string[] = [];
    let id = 0;
    await reconcileWorkspaceToolProcessProofs({
      callIds,
      registryDirectory: "/synthetic/workspace-processes",
      createId: () => (id++).toString(),
      execute: (command) => {
        events.push(
          `commit:${(command.payload.workspaceToolProcessAuthorityReleasedCallIds?.length ?? 0).toString()}`,
        );
      },
      removeRecord: (_directory, callId) => {
        events.push(`remove:${callId}`);
        return Promise.resolve();
      },
    });
    expect(events[0]).toBe(`commit:${WORKSPACE_TOOL_RECONCILE_BATCH_SIZE.toString()}`);
    expect(events[WORKSPACE_TOOL_RECONCILE_BATCH_SIZE + 1]).toBe("commit:1");
    expect(events.at(-1)).toBe(`remove:${callIds.at(-1) ?? "missing"}`);
  });

  it("keeps process proofs when durable reconciliation fails", async () => {
    const removed: string[] = [];
    await expect(
      reconcileWorkspaceToolProcessProofs({
        callIds: ["workspace-call-1"],
        registryDirectory: "/synthetic/workspace-processes",
        execute: () => {
          throw new Error("synthetic SQLite failure");
        },
        removeRecord: (_directory, callId) => {
          removed.push(callId);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("synthetic SQLite failure");
    expect(removed).toEqual([]);
  });
});
