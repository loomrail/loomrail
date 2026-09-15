import { randomUUID } from "node:crypto";

import type { LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

const RETENTION_DAYS = 30;
const RETENTION_BATCH_SIZE = 1_000;
const MAX_RETENTION_BATCHES_PER_STARTUP = 20;

export type AgentRunActivityRetentionSummary = {
  selected: number;
  entriesDeleted: number;
  stateRowsDeleted: number;
};

/**
 * SD-004 applied to `agent_run_activity` (docs/plans/126, ADR-0034): the per-run 1,000-entry cap
 * bounds one run's Level 1 diagnostic feed, but the number of runs is unbounded, so the table grows
 * for the life of the database until something ages it out by closed-work date. This is that sweep.
 *
 * Mirrors cleanupExpiredBrowserQAArtifacts's shape -- injected clock, a bounded LIST query per
 * batch, a hard cap on batches per startup so a huge backlog cannot delay startup indefinitely --
 * but needs no retention log and no per-item command: unlike deleting a QA attachment's file, a row
 * delete is idempotent and self-evident from the row's own absence, so the query and the delete
 * (both in packages/persistence-sqlite) operate on a whole bounded page at once, in one short
 * transaction per batch, rather than one command per row.
 *
 * DELETE_EXPIRED_AGENT_RUN_ACTIVITY also prunes any `agent_run_activity_state` counters row a page
 * just emptied (or that was already empty for a closed, expired run -- e.g. one whose recorder
 * failed on every write) -- see that command's persistence-sqlite doc comment for why the counters
 * row does not outlive the entries it describes.
 *
 * Runs once at startup, exactly like the QA and Project verification output sweeps beside it: a
 * daemon that is never restarted never sweeps.
 *
 * Synchronous, unlike those two: `LocalState.query`/`.execute` are synchronous (the SQLite driver
 * they close over has no async API), and this sweep does no I/O of its own -- no file to delete, no
 * process to wait on -- so there is nothing here an `async` signature would actually be awaiting.
 */
export const cleanupExpiredAgentRunActivity = (input: {
  state: LocalState;
  now: Date;
  logger: FastifyBaseLogger;
}): AgentRunActivityRetentionSummary => {
  const closedBefore = new Date(input.now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const summary: AgentRunActivityRetentionSummary = { selected: 0, entriesDeleted: 0, stateRowsDeleted: 0 };

  for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_STARTUP; batch += 1) {
    const candidates = input.state.query({
      type: "LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES",
      closedBefore,
      limit: RETENTION_BATCH_SIZE,
    });
    if (candidates.type !== "AGENT_RUN_ACTIVITY_RETENTION_CANDIDATES" || candidates.entryIds.length === 0) {
      break;
    }
    summary.selected += candidates.entryIds.length;
    // A fresh, random commandId every call -- deliberately not derived from `closedBefore`/`limit`
    // (which repeat across batches whose page has already fully drained, and would repeat across
    // startups sharing the same rounded `now`). Unlike RECORD_QA_ATTACHMENT_RETENTION, this command
    // does not want the generic commandId-replay cache providing its idempotence: a replay would
    // skip the real DELETE and echo a stale count instead of re-checking the database, and this
    // command does not need that cache for safety in the first place -- the DELETE's own predicate
    // is what makes a second sweep over the same window a no-op.
    const commandId = `agent-run-activity-retention-${randomUUID()}`;
    const result = input.state.execute({
      schemaVersion: 1,
      commandId,
      correlationId: `correlation-${commandId}`,
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "DELETE_EXPIRED_AGENT_RUN_ACTIVITY",
      payload: { closedBefore, limit: RETENTION_BATCH_SIZE },
    });
    if (result.type !== "AGENT_RUN_ACTIVITY_RETENTION_APPLIED") {
      throw new Error(`Unexpected result type ${result.type} for DELETE_EXPIRED_AGENT_RUN_ACTIVITY`);
    }
    summary.entriesDeleted += result.entriesDeleted;
    summary.stateRowsDeleted += result.stateRowsDeleted;
    if (candidates.entryIds.length < RETENTION_BATCH_SIZE) break;
  }

  if (summary.entriesDeleted > 0 || summary.stateRowsDeleted > 0) {
    input.logger.info(
      {
        selected: summary.selected,
        entriesDeleted: summary.entriesDeleted,
        stateRowsDeleted: summary.stateRowsDeleted,
      },
      "Agent run activity retention cleanup completed",
    );
  }
  return summary;
};
