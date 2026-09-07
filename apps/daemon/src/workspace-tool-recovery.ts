import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { StateCommand } from "@loomrail/contracts";
import { removeVerificationProcessRecord } from "@loomrail/project-readiness";

export const WORKSPACE_TOOL_RECONCILE_BATCH_SIZE = 1_000;
const WORKSPACE_TOOL_ARTIFACT_LIMIT = 1_000;
const workspaceToolArtifactPattern = /^workspace-tool-output-[a-zA-Z0-9._:-]+\.txt$/u;

type ReconcileCommand = Extract<StateCommand, { type: "RECONCILE_WORKFLOWS" }>;

/** Removes crash-left raw command output only after process authority has been released. */
export const cleanupWorkspaceToolArtifacts = async (artifactsDirectory: string): Promise<number> => {
  const metadata = await lstat(artifactsDirectory).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (metadata === null) return 0;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The workspace tool artifact root is not a regular directory");
  }
  const root = await realpath(artifactsDirectory);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > WORKSPACE_TOOL_ARTIFACT_LIMIT) {
    throw new Error("The workspace tool artifact cleanup limit was exceeded");
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !workspaceToolArtifactPattern.test(entry.name)) continue;
    await unlink(join(root, entry.name));
    removed += 1;
  }
  return removed;
};

export const reconcileWorkspaceToolProcessProofs = async (input: {
  callIds: readonly string[];
  registryDirectory: string;
  execute: (command: ReconcileCommand) => void;
  createId?: () => string;
  removeRecord?: (registryDirectory: string, callId: string) => Promise<void>;
}): Promise<void> => {
  const createId = input.createId ?? randomUUID;
  const removeRecord = input.removeRecord ?? removeVerificationProcessRecord;
  const batches = Array.from(
    { length: Math.ceil(input.callIds.length / WORKSPACE_TOOL_RECONCILE_BATCH_SIZE) },
    (_, index) =>
      input.callIds.slice(
        index * WORKSPACE_TOOL_RECONCILE_BATCH_SIZE,
        (index + 1) * WORKSPACE_TOOL_RECONCILE_BATCH_SIZE,
      ),
  );
  for (const workspaceToolProcessAuthorityReleasedCallIds of batches) {
    input.execute({
      schemaVersion: 1,
      commandId: `reconcile-workspace-tools-${createId()}`,
      correlationId: `startup-workspace-tools-${createId()}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: { workspaceToolProcessAuthorityReleasedCallIds },
    });
    await Promise.all(
      workspaceToolProcessAuthorityReleasedCallIds.map((callId) =>
        removeRecord(input.registryDirectory, callId),
      ),
    );
  }
};
