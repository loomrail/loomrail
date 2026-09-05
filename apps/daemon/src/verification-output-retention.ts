import { createHash } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

const RETENTION_DAYS = 30;
const RETENTION_BATCH_SIZE = 1_000;
const MAX_RETENTION_BATCHES_PER_STARTUP = 20;
const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*\.txt$/u;

type CleanupAction = "DELETED" | "ALREADY_ABSENT" | "SKIPPED_UNSAFE" | "FAILED";

export type VerificationOutputRetentionSummary = {
  selected: number;
  recorded: number;
  skipped: number;
};

const commandIdFor = (artifactId: string): string =>
  `verification-retention-${createHash("sha256").update(artifactId).digest("hex").slice(0, 40)}`;

const errorCode = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

const deleteArtifact = async (input: {
  artifactsDirectory: string;
  storageKey: string;
}): Promise<CleanupAction> => {
  if (basename(input.storageKey) !== input.storageKey || !STORAGE_KEY_PATTERN.test(input.storageKey)) {
    return "SKIPPED_UNSAFE";
  }
  let root: string;
  try {
    root = await realpath(input.artifactsDirectory);
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? "ALREADY_ABSENT" : "FAILED";
  }
  const candidate = join(root, input.storageKey);
  try {
    const details = await lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink()) return "SKIPPED_UNSAFE";
    await unlink(candidate);
    return "DELETED";
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? "ALREADY_ABSENT" : "FAILED";
  }
};

/** Deletes bounded 30-day diagnostic output while preserving immutable measured Check history. */
export const cleanupExpiredVerificationOutputs = async (input: {
  state: LocalState;
  artifactsDirectory: string;
  now: Date;
  logger: FastifyBaseLogger;
}): Promise<VerificationOutputRetentionSummary> => {
  const closedBefore = new Date(input.now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const summary: VerificationOutputRetentionSummary = { selected: 0, recorded: 0, skipped: 0 };

  for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_STARTUP; batch += 1) {
    const candidates = input.state.query({
      type: "LIST_EXPIRED_VERIFICATION_OUTPUTS",
      closedBefore,
      limit: RETENTION_BATCH_SIZE,
    });
    if (candidates.type !== "VERIFICATION_OUTPUTS" || candidates.artifacts.length === 0) break;
    summary.selected += candidates.artifacts.length;
    let recordedThisBatch = 0;
    for (const artifact of candidates.artifacts) {
      const action = await deleteArtifact({
        artifactsDirectory: input.artifactsDirectory,
        storageKey: artifact.storageKey,
      });
      if (action === "DELETED" || action === "ALREADY_ABSENT") {
        try {
          const commandId = commandIdFor(artifact.artifactId);
          input.state.execute({
            schemaVersion: 1,
            commandId,
            correlationId: `correlation-${commandId}`,
            actor: { type: "SYSTEM", id: "local-daemon" },
            type: "RECORD_VERIFICATION_OUTPUT_RETENTION",
            payload: { artifactId: artifact.artifactId, outcome: action },
          });
          summary.recorded += 1;
          recordedThisBatch += 1;
        } catch (error: unknown) {
          summary.skipped += 1;
          input.logger.error(
            { artifactId: artifact.artifactId, errorName: error instanceof Error ? error.name : "unknown" },
            "Project verification output retention could not be recorded",
          );
        }
        continue;
      }
      summary.skipped += 1;
      const details = { artifactId: artifact.artifactId, action };
      if (action === "FAILED") {
        input.logger.error(details, "Project verification output retention could not remove an artifact");
      } else {
        input.logger.warn(details, "Project verification output retention refused an unsafe artifact path");
      }
    }
    if (candidates.artifacts.length < RETENTION_BATCH_SIZE || recordedThisBatch === 0) break;
  }

  if (summary.recorded > 0) {
    input.logger.info(
      { selected: summary.selected, recorded: summary.recorded, skipped: summary.skipped },
      "Project verification output retention cleanup completed",
    );
  }
  return summary;
};
