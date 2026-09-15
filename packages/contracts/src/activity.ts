import { z } from "zod";

import { liveProviderIdSchema } from "./provider-selection.js";
import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import { workflowStageSchema } from "./workflow.js";
import { workspaceToolFailureCodeSchema } from "./workspace-tool.js";

/**
 * What a provider adapter reports about one action it took.
 *
 * Bounded and `.strict()` on purpose: this crosses the boundary from untrusted process output into
 * Loomrail, so a field added later fails to parse rather than riding along. It carries no
 * authority -- `git diff` and measured verification remain the source of truth about what changed.
 */
export const providerActivityKindSchema = z.enum([
  "TOOL_CALL",
  "AGENT_TEXT",
  "FILE_CHANGE",
  "PROVIDER_ERROR",
]);

// Exported so a parser building an actionKey from provider-controlled input (e.g. a Claude Code
// text block keyed off the line's own uuid/message.id) can check its own bound before handing the
// entry to this schema, instead of duplicating the literal and risking the two drifting apart.
export const MAX_ACTION_KEY_LENGTH = 200;

export const providerActivityEntrySchema = z
  .object({
    // The provider's own identifier for the action, so a terminal report updates the record the
    // starting one created instead of appending a second row for the same action.
    actionKey: z.string().trim().min(1).max(MAX_ACTION_KEY_LENGTH),
    kind: providerActivityKindSchema,
    label: z.string().trim().min(1).max(500).nullable(),
    detail: z.string().trim().min(1).max(2_000).nullable(),
    status: z.string().trim().min(1).max(120).nullable(),
    terminal: z.boolean(),
    // True when any text on this entry was cut to fit its bound. Silent truncation would let a
    // reader mistake a fragment for the whole thing.
    truncated: z.boolean(),
  })
  .strict();

export type ProviderActivityEntry = z.infer<typeof providerActivityEntrySchema>;

/**
 * Where an entry came from, and therefore how much it is worth.
 *
 * `DAEMON_AUDITED` passed through the daemon-owned gateway and is recorded in append-only
 * `workspace_tool_calls`. `PROVIDER_REPORTED` is the provider's account of itself: unverified,
 * prunable, and never evidence. Computed by the reader from the source table, never accepted from
 * a provider.
 */
export const activityOriginSchema = z.enum(["DAEMON_AUDITED", "PROVIDER_REPORTED"]);
// Named and exported on its own, not left as an inline literal union, because Task 10 needs it in
// packages/persistence-sqlite: a second package that computes this same value from which table a
// row came from (the Fleet's "latest action" read, newest-first across both sources) and must not
// hand-roll its own copy of the two-value vocabulary this schema already owns.
export type ActivityOrigin = z.infer<typeof activityOriginSchema>;

export const agentRunActivityEntrySchema = z
  .object({
    // The only identity that holds across the merged feed. `seq` below does not: it is monotonic
    // per *origin* within one *run*, not across the page, so two entries from different sources --
    // or from two different runs of the same source -- legitimately share a `seq` value. The cursor
    // is `(at, origin, id)` for the same reason -- never `seq` alone.
    id: z.string().min(1),
    // Monotonic within a run's own source but NOT dense: eviction leaves gaps on the reported side,
    // and a reader that treats a missing number as a defect would report every long run as broken.
    // Not unique across a merged page -- an audited entry and a reported entry can both be `seq: 1`,
    // one counting its own source's rows, the other counting the other source's. Use `id` for
    // identity and `(at, origin, id)` for ordering; never key UI rows on `seq` alone.
    seq: z.number().int().positive(),
    at: z.iso.datetime(),
    origin: activityOriginSchema,
    provider: z.enum(["CODEX", "CLAUDE_CODE"]),
    kind: providerActivityKindSchema,
    label: z.string().max(500).nullable(),
    detail: z.string().max(2_000).nullable(),
    status: z.string().max(120).nullable(),
    // Bare, matching `status` and `label` above -- both already read as opaque i18n lookup keys
    // (`workspaceTool.status.*`), never parsed for embedded structure. `null` for a
    // PROVIDER_REPORTED entry (the table this reads from has no such column) and for a
    // DAEMON_AUDITED entry that did not fail.
    failureCode: workspaceToolFailureCodeSchema.nullable(),
    truncated: z.boolean(),
    // Which run produced this entry. The feed spans a WorkItem's runs, so the reader groups by
    // this and names the group with `stage`; without it a reader cannot tell one run's actions
    // from the next run's, and the two can be minutes apart or days.
    agentRunId: z.string().min(1),
    stage: workflowStageSchema,
    // No run NUMBER travels with the entry, deliberately. An earlier cut carried
    // `agent_runs.ordinal` so a reader could head each group "Run N", on the premise that the
    // number distinguishes two adjacent groups of the same stage. It does not: `agent_runs.ordinal`
    // is `UNIQUE (stage_attempt_id, ordinal)`, so a stage RETRY opens a new StageAttempt whose first
    // AgentRun is ordinal 1 again -- two adjacent groups for two attempts of the same stage would
    // both read "Run 1", which is the very indistinguishability the number was added to prevent. A
    // number that repeats across different runs is worse than none, and the groups are already
    // ordered by their entries' own timestamps, so the heading carries `stage` alone.
  })
  .strict();

export type AgentRunActivityEntry = z.infer<typeof agentRunActivityEntrySchema>;

export const agentRunActivityPageSchema = z
  .object({
    entries: z.array(agentRunActivityEntrySchema).max(200),
    // Opaque: the client hands it back and never parses it. The merged feed has two sources, so a
    // single table's row number cannot address a position in it.
    nextCursor: z.string().min(1).nullable(),
    omittedCount: z.number().int().nonnegative(),
    degraded: z.boolean(),
    // "This page may be incomplete", from either of two causes the client cannot tell apart and
    // does not need to: the cursor named a position no longer held, so the page restarted from the
    // oldest entry still there; or a source returned its entire read-ahead and the page still ended
    // with no `nextCursor`, where "nothing more" is a claim the read cannot support. Either way the
    // client says the list may be incomplete instead of showing a silent hole. Never set on a first
    // page: with no cursor the page starts at index 0, so a source big enough to trip the second
    // cause always leaves more rows than fit and `nextCursor` is non-null.
    gap: z.boolean(),
  })
  .strict();

export type AgentRunActivityPage = z.infer<typeof agentRunActivityPageSchema>;

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

const commandResultBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
  })
  .strict();

/**
 * Records one action a provider reported taking against a running AgentRun.
 *
 * `projectId`/`workItemId` are deliberately absent from the payload: `agent_runs` already holds
 * both and is the single source, so the persistence layer derives them from `agentRunId` inside the
 * write transaction rather than trusting a second, potentially divergent copy carried here.
 */
export const recordAgentRunActivityCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECORD_AGENT_RUN_ACTIVITY"),
  payload: z
    .object({
      agentRunId: opaqueIdSchema,
      providerSessionId: opaqueIdSchema,
      provider: liveProviderIdSchema,
      entry: providerActivityEntrySchema,
    })
    .strict(),
});

// No `event` field: the activity feed is not domain history, so recording an entry never appends
// to the append-only Event vocabulary. `entryId`/`seq` identify the row this write touched --
// either a freshly created one or the one its matching start already created -- and
// `omittedCount`/`degraded` echo the run's current buffer counters so a caller never has to issue a
// second read just to see them.
export const agentRunActivityRecordedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("AGENT_RUN_ACTIVITY_RECORDED"),
  entryId: opaqueIdSchema,
  seq: z.number().int().positive(),
  omittedCount: z.number().int().nonnegative(),
  degraded: z.boolean(),
});

export type RecordAgentRunActivityCommand = z.infer<typeof recordAgentRunActivityCommandSchema>;
export type AgentRunActivityRecordedResult = z.infer<typeof agentRunActivityRecordedResultSchema>;

/**
 * Marks an AgentRun's activity feed degraded, as its own short command rather than a side effect of
 * RECORD_AGENT_RUN_ACTIVITY: when the recorder fails to write an entry, that write's transaction has
 * already rolled back, so it cannot also record its own failure. A separate command with its own
 * transaction is what lets the degradation survive that rollback -- issued the moment the failure
 * first happens, and again at session end as a backstop.
 *
 * Idempotent by design: marking an already-degraded run again must succeed and change nothing, since
 * the backstop call is the ordinary path, not an error.
 */
export const markAgentRunActivityDegradedCommandSchema = commandBaseSchema.extend({
  type: z.literal("MARK_AGENT_RUN_ACTIVITY_DEGRADED"),
  payload: z
    .object({
      agentRunId: opaqueIdSchema,
    })
    .strict(),
});

// No `event`, same reasoning as AGENT_RUN_ACTIVITY_RECORDED above: the activity feed carries no
// authority, so marking it degraded does not enter the append-only Event vocabulary either.
export const agentRunActivityDegradedMarkedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("AGENT_RUN_ACTIVITY_DEGRADED_MARKED"),
  agentRunId: opaqueIdSchema,
});

export type MarkAgentRunActivityDegradedCommand = z.infer<typeof markAgentRunActivityDegradedCommandSchema>;
export type AgentRunActivityDegradedMarkedResult = z.infer<typeof agentRunActivityDegradedMarkedResultSchema>;

/**
 * SD-004's 30-day sweep for `agent_run_activity`: bounded per call by `limit`, and per call means
 * per orchestrator batch, not per row, so this deletes a whole page of expired entries (and any
 * `agent_run_activity_state` counters row a page just emptied) in one short transaction rather than
 * apps/daemon issuing one command per row the way RECORD_QA_ATTACHMENT_RETENTION does for files.
 *
 * That precedent needs a per-row command because deleting a file is neither idempotent nor visible
 * from the database, so it records an outcome per attachment to avoid re-attempting or re-counting
 * one on a retry. A row delete carries neither problem: the row's own absence on a later sweep IS
 * the record, so this command needs no retention log and no per-row identity in its payload --
 * `closedBefore`/`limit` describe the same bounded page apps/daemon just read with
 * LIST_EXPIRED_AGENT_RUN_ACTIVITY_ENTRIES, not a list of ids to thread through a hand-built SQL
 * `IN (?, ?, ...)` -- the pattern `selectLatestAgentRunActivity`'s own doc comment in
 * packages/persistence-sqlite calls out as worth avoiding.
 */
export const deleteExpiredAgentRunActivityCommandSchema = commandBaseSchema.extend({
  type: z.literal("DELETE_EXPIRED_AGENT_RUN_ACTIVITY"),
  payload: z
    .object({
      closedBefore: utcTimestampSchema,
      limit: z.number().int().min(1).max(1_000),
    })
    .strict(),
});

// No `event`: same reasoning as AGENT_RUN_ACTIVITY_RECORDED -- this table carries no authority, so
// pruning it does not enter the append-only Event vocabulary either.
export const agentRunActivityRetentionAppliedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("AGENT_RUN_ACTIVITY_RETENTION_APPLIED"),
  entriesDeleted: z.number().int().nonnegative(),
  stateRowsDeleted: z.number().int().nonnegative(),
});

export type DeleteExpiredAgentRunActivityCommand = z.infer<typeof deleteExpiredAgentRunActivityCommandSchema>;
export type AgentRunActivityRetentionAppliedResult = z.infer<
  typeof agentRunActivityRetentionAppliedResultSchema
>;
