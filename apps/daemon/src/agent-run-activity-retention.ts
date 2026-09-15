import { randomUUID } from "node:crypto";

import type { LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

const RETENTION_DAYS = 30;
const RETENTION_BATCH_SIZE = 1_000;
const MAX_RETENTION_BATCHES_PER_STARTUP = 20;

export type AgentRunActivityRetentionSummary = {
  entriesDeleted: number;
  stateRowsDeleted: number;
};

/**
 * SD-004 applied to `agent_run_activity` (docs/plans/126, ADR-0034): the per-run 1,000-entry cap
 * bounds one run's Level 1 diagnostic feed, but the number of runs is unbounded, so the table grows
 * for the life of the database until something ages it out by closed-work date. This is that sweep.
 *
 * Mirrors cleanupExpiredBrowserQAArtifacts's shape -- injected clock, a hard cap on batches per
 * startup so a huge backlog cannot delay startup indefinitely -- but needs no retention log and no
 * per-item command, and no separate LIST-then-DELETE round trip either: unlike deleting a QA
 * attachment's file, a row delete is idempotent and self-evident from the row's own absence, so
 * `DELETE_EXPIRED_AGENT_RUN_ACTIVITY` (packages/persistence-sqlite) both selects and removes a whole
 * bounded page in one short transaction per batch, rather than one command per row.
 *
 * There used to be a `LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES` query here before each delete, purely
 * to report how many entries the delete was about to remove. It was dropped: its predicate is
 * identical to the delete's own (see `deleteExpiredAgentRunActivityEntries`'s doc comment in
 * persistence-sqlite), so it always found exactly what the delete went on to remove, and its count
 * fed nothing but the completion log line below -- a whole extra query per batch, against a
 * four-table join with a correlated `MAX(sequence)` subquery, for a number the delete's own result
 * already carries. `entriesDeleted` is that same number now.
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
 *
 * `DELETE_EXPIRED_AGENT_RUN_ACTIVITY` runs every batch unconditionally -- there is no LIST page left
 * to gate it on -- and its own two counts decide whether to keep batching (fix-round-1, finding 2).
 * A run whose recorder never wrote an entry can still carry an orphaned, closed-and-expired
 * `agent_run_activity_state` row with nothing in `agent_run_activity` beside it; calling the delete
 * unconditionally every batch is what prunes that orphan even when no other entries are expired at
 * the same time -- the same unbounded-in-runs leak this task exists to close, just moved one table
 * over.
 */
export const cleanupExpiredAgentRunActivity = (input: {
  state: LocalState;
  now: Date;
  logger: FastifyBaseLogger;
}): AgentRunActivityRetentionSummary => {
  const closedBefore = new Date(input.now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const summary: AgentRunActivityRetentionSummary = { entriesDeleted: 0, stateRowsDeleted: 0 };

  for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_STARTUP; batch += 1) {
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
    // Fix-round-1, finding 4: neither side of this batch removed anything, so neither side of the
    // next one would either -- stop instead of paying for up to 19 more full scans that cannot make
    // progress (e.g. the ordinary case of a clean database with nothing expired at all).
    if (result.entriesDeleted === 0 && result.stateRowsDeleted === 0) break;
    // Both sides came back short of a full page: nothing is waiting behind this batch on either
    // side, so another call could only repeat this one's own (now empty) result.
    if (result.entriesDeleted < RETENTION_BATCH_SIZE && result.stateRowsDeleted < RETENTION_BATCH_SIZE) {
      break;
    }
  }

  if (summary.entriesDeleted > 0 || summary.stateRowsDeleted > 0) {
    input.logger.info(
      { entriesDeleted: summary.entriesDeleted, stateRowsDeleted: summary.stateRowsDeleted },
      "Agent run activity retention cleanup completed",
    );
  }
  return summary;
};
