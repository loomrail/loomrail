import { createHash } from "node:crypto";

import { deleteExpiredBrowserQAArtifacts } from "@loomrail/browser-qa";
import type { LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

const RETENTION_DAYS = 30;
const RETENTION_BATCH_SIZE = 1_000;
const MAX_RETENTION_BATCHES_PER_STARTUP = 20;

export type BrowserQARetentionSummary = {
  selected: number;
  recorded: number;
  skipped: number;
};

const commandIdFor = (attachmentId: string): string =>
  `qa-retention-${createHash("sha256").update(attachmentId).digest("hex").slice(0, 40)}`;

/** Applies SD-004 to terminal work without delaying startup for an unbounded artifact history. */
export const cleanupExpiredBrowserQAArtifacts = async (input: {
  state: LocalState;
  artifactsDirectory: string;
  now: Date;
  logger: FastifyBaseLogger;
}): Promise<BrowserQARetentionSummary> => {
  const closedBefore = new Date(input.now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const summary: BrowserQARetentionSummary = { selected: 0, recorded: 0, skipped: 0 };

  for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_STARTUP; batch += 1) {
    const candidates = input.state.query({
      type: "LIST_EXPIRED_QA_ATTACHMENTS",
      closedBefore,
      limit: RETENTION_BATCH_SIZE,
    });
    if (candidates.type !== "QA_ATTACHMENTS" || candidates.attachments.length === 0) break;
    summary.selected += candidates.attachments.length;
    const results = await deleteExpiredBrowserQAArtifacts({
      artifactsDirectory: input.artifactsDirectory,
      attachments: candidates.attachments,
    });
    let recordedThisBatch = 0;
    for (const result of results) {
      if (result.action === "DELETED" || result.action === "ALREADY_ABSENT") {
        try {
          const commandId = commandIdFor(result.attachmentId);
          input.state.execute({
            schemaVersion: 1,
            commandId,
            correlationId: `correlation-${commandId}`,
            actor: { type: "SYSTEM", id: "local-daemon" },
            type: "RECORD_QA_ATTACHMENT_RETENTION",
            payload: { attachmentId: result.attachmentId, outcome: result.action },
          });
          summary.recorded += 1;
          recordedThisBatch += 1;
        } catch (error: unknown) {
          summary.skipped += 1;
          input.logger.error(
            {
              attachmentId: result.attachmentId,
              storageKey: result.storageKey,
              error: error instanceof Error ? error.name : "unknown",
            },
            "Browser QA retention deleted evidence but could not record the cleanup",
          );
        }
        continue;
      }
      summary.skipped += 1;
      const details = {
        attachmentId: result.attachmentId,
        storageKey: result.storageKey,
        action: result.action,
      };
      if (result.action === "FAILED") {
        input.logger.error(details, "Browser QA retention could not remove an expired attachment");
      } else {
        input.logger.warn(details, "Browser QA retention left an expired attachment in place safely");
      }
    }
    if (candidates.attachments.length < RETENTION_BATCH_SIZE || recordedThisBatch === 0) break;
  }

  if (summary.recorded > 0) {
    input.logger.info(
      { selected: summary.selected, recorded: summary.recorded, skipped: summary.skipped },
      "Browser QA retention cleanup completed",
    );
  }
  return summary;
};
