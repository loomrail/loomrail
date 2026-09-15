import {
  agentRunActivityEntrySchema,
  agentRunActivityPageSchema,
  activityOriginSchema,
  type AgentRunActivityEntry,
  type AgentRunActivityPage,
  type LiveProviderId,
  type WorkspaceToolCallRecord,
} from "@loomrail/contracts";
import type { AgentRunActivityRow } from "@loomrail/persistence-sqlite";
import { z } from "zod";

/**
 * The merged Run Activity feed (Task 8).
 *
 * Two sources, different authority: `workspace_tool_calls` is daemon-verified and append-only
 * (`origin: "DAEMON_AUDITED"`); `agent_run_activity` is the provider's unverified, prunable account
 * of itself (`origin: "PROVIDER_REPORTED"`). Storage stays separate so the audited trail is never
 * mixed with untrusted diagnostics; this module is where the two become one chronological story on
 * read. `origin` is always computed here from which source a row came from, never accepted from
 * either table -- a stored column would be a value that could be written wrongly.
 */

type ActivityOrigin = AgentRunActivityEntry["origin"];

const ORIGIN_ORDER: Readonly<Record<ActivityOrigin, number>> = {
  DAEMON_AUDITED: 0,
  PROVIDER_REPORTED: 1,
};

// Code-unit comparison, not `localeCompare`: the SQL that establishes the audited side's own
// ordering (`ORDER BY started_at, id`) sorts under SQLite's BINARY collation, which is a byte
// comparison, not a locale-aware one. `localeCompare`'s result depends on the host's ICU/locale
// data and can disagree with BINARY on mixed-case ids -- exactly the disagreement "deterministic
// ordering" (this task's whole point) cannot afford. This matches BINARY for the ASCII opaque ids
// and ISO timestamps every caller here actually produces.
const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Orders the two sources into one feed.
 *
 * Three keys, not one: two entries can share a timestamp to the millisecond, and an order that
 * depends on which source was read first would reshuffle the page between two identical requests
 * and make the cursor skip or repeat rows. Generic over the entry shape (rather than fixed to
 * `AgentRunActivityEntry`) so this stays a pure ordering rule, independently testable from the
 * field-mapping that turns a raw row into a full entry. Two independent type parameters, not one,
 * because the two sources carry different literal `origin` values -- inferring a single `T` from
 * both arrays at once would force TypeScript to unify those into one type and reject either call.
 */
export const mergeRunActivity = <
  Audited extends { id: string; at: string; origin: ActivityOrigin },
  Reported extends { id: string; at: string; origin: ActivityOrigin },
>(
  audited: readonly Audited[],
  reported: readonly Reported[],
): readonly (Audited | Reported)[] =>
  [...audited, ...reported].sort(
    (left, right) =>
      compareStrings(left.at, right.at) ||
      ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin] ||
      compareStrings(left.id, right.id),
  );

// What a cursor carries: the sort key of the last entry a page ended on. `.strict()` on purpose --
// this crosses from untrusted client input back into the daemon, so an extra field a hand-crafted
// cursor adds fails to parse rather than riding along unnoticed.
const cursorSchema = z
  .object({ at: z.iso.datetime(), origin: activityOriginSchema, id: z.string().min(1) })
  .strict();

export type ActivityCursor = z.infer<typeof cursorSchema>;

export const encodeCursor = (position: ActivityCursor): string =>
  Buffer.from(
    JSON.stringify({ at: position.at, origin: position.origin, id: position.id } satisfies ActivityCursor),
  ).toString("base64url");

// A cursor is client-supplied input like any other: decoded through the schema, never trusted to be
// the value this daemon handed out. `null` covers every way it can fail to be that -- invalid
// base64, invalid JSON, or JSON that does not match the exact shape (including a forged one that
// merely happens to be well-formed JSON) -- so the caller has one thing to check, not three.
export const decodeCursor = (value: string): ActivityCursor | null => {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

// Bounded by the response schema's own `entries` cap (`agentRunActivityPageSchema`): a page cannot
// carry more than this regardless of what the caller asks for.
export const MAX_ACTIVITY_PAGE_SIZE = 200;

// Handed to LIST_AGENT_RUN_ACTIVITY's own `limit`. Comfortably above that table's 1_000-row eviction
// bound (Task 6), so this always reads back everything the buffer currently holds in one query; the
// merge-and-paginate below is what turns that into pages, not a second round trip to the table.
export const REPORTED_ENTRIES_FETCH_LIMIT = 2_000;

/**
 * One workspace tool call, read as a Run Activity entry.
 *
 * `kind` is always `TOOL_CALL`: a daemon-gated workspace operation is definitionally a tool call, no
 * provider guess involved. `label`/`detail`/`status` mirror the table's own
 * `operation`/`target`/`status` columns exactly, bare -- all three are read as i18n lookup keys
 * (`workspaceTool.status.*` and friends), never parsed for embedded structure, so folding
 * `failureCode` into `status` (`"FAILED:PATH_FORBIDDEN"`) would break that lookup. `failureCode`
 * travels in its own field instead.
 *
 * `seq` has no column to read on this table (unlike the reported side's own `agent_run_activity.seq`
 * counter): assigned here as the entry's 1-based rank in `startedAt` order, which the caller supplies
 * pre-sorted so this stays a pure per-entry mapping. It is a per-source counter, not a cross-source
 * one -- see the field's own comment in the contract.
 */
const activityEntryFromWorkspaceToolCall = (
  call: WorkspaceToolCallRecord,
  provider: LiveProviderId,
  seq: number,
): AgentRunActivityEntry =>
  agentRunActivityEntrySchema.parse({
    id: call.id,
    seq,
    at: call.startedAt,
    origin: "DAEMON_AUDITED",
    provider,
    kind: "TOOL_CALL",
    label: call.operation,
    detail: call.target,
    status: call.status,
    failureCode: call.failureCode,
    truncated: false,
  } satisfies AgentRunActivityEntry);

// The reported side's raw row already carries everything an entry needs (Task 6/7); this only adds
// the `origin` its source table implies. `failureCode` is always `null` here -- `agent_run_activity`
// has no such column, since it is the provider's own unverified account, not an audited outcome.
const activityEntryFromReportedRow = (row: AgentRunActivityRow): AgentRunActivityEntry =>
  agentRunActivityEntrySchema.parse({
    id: row.id,
    seq: row.seq,
    at: row.observedAt,
    origin: "PROVIDER_REPORTED",
    provider: row.provider,
    kind: row.kind,
    label: row.label,
    detail: row.detail,
    status: row.status,
    failureCode: null,
    truncated: row.truncated,
  } satisfies AgentRunActivityEntry);

// Where in the merged feed a page starts, and whether that start is a gap.
//
// `cursor === null` is the first page: start at the beginning, no gap. Otherwise, the cursor names
// an exact (at, origin, id) triple; if the merged feed still has it, the page starts right after it.
// If not -- whether because the reported row it named was evicted, or because the cursor never named
// a real position at all -- there is no way here to tell those two apart, and both get the same safe
// answer: restart from the start of the window this daemon can still see, flagged so the owner is
// told about the gap instead of being shown a silently incomplete tail.
const locateCursor = (
  merged: readonly AgentRunActivityEntry[],
  cursor: ActivityCursor | null,
): { readonly index: number; readonly gap: boolean } => {
  if (cursor === null) return { index: 0, gap: false };
  const position = merged.findIndex(
    (entry) => entry.at === cursor.at && entry.origin === cursor.origin && entry.id === cursor.id,
  );
  return position === -1 ? { index: 0, gap: true } : { index: position + 1, gap: false };
};

export type BuildActivityPageInput = {
  /** Every `workspace_tool_calls` row for this AgentRun, ordered by `(started_at, id)` ascending. */
  readonly auditedCalls: readonly WorkspaceToolCallRecord[];
  // `null` when the AgentRun's own provider is not a live one (MOCK, in tests and fixtures only --
  // `RECORD_AGENT_RUN_ACTIVITY` already requires a live provider, and nothing in production drives a
  // MOCK session through the real workspace-tool gateway either). Real, not assumed: `auditedCalls`
  // is asserted empty below whenever this is `null`, so a MOCK run that somehow does have audited
  // rows fails loudly instead of mislabelling them with a provider it never had.
  readonly provider: LiveProviderId | null;
  /** `LIST_AGENT_RUN_ACTIVITY`'s rows, ordered by `(observed_at, id)` ascending. */
  readonly reportedRows: readonly AgentRunActivityRow[];
  readonly omittedCount: number;
  readonly degraded: boolean;
  /** Already decoded by the caller (`decodeCursor`); `null` means "from the start". */
  readonly cursor: ActivityCursor | null;
  readonly pageSize?: number;
};

// Separated from `buildAgentRunActivityPage` so the `provider === null` narrowing (audited calls
// need a live provider to become entries; a MOCK AgentRun's `null` is fine as long as there is
// nothing to map) happens in exactly one place, without a cast or a non-null assertion at the call
// site.
const mapAuditedEntries = (
  calls: readonly WorkspaceToolCallRecord[],
  provider: LiveProviderId | null,
): readonly AgentRunActivityEntry[] => {
  if (calls.length === 0) return [];
  if (provider === null) {
    throw new Error("Audited workspace tool calls exist for an AgentRun with no live provider");
  }
  return calls.map((call, index) => activityEntryFromWorkspaceToolCall(call, provider, index + 1));
};

export type ResolvedAuditedCalls = {
  readonly auditedCalls: readonly WorkspaceToolCallRecord[];
  readonly degraded: boolean;
};

/**
 * Guards `mapAuditedEntries`'s own defence-in-depth invariant (audited calls need a live provider,
 * or it throws) at the read boundary, before that throw can turn an ordinary GET into a 500.
 *
 * The invariant itself stays enforced inside the page builder -- RECORD_AGENT_RUN_ACTIVITY and the
 * workspace-tool gateway both still require a live provider, so production cannot produce this
 * combination going forward, and a caller that got `provider` wrong should still fail loudly. But
 * MOCK is a real, historical AgentRun provider (tests, fixtures, and any row written before that
 * invariant existed), and a read that 500s over a data shape the caller has no way to fix is the
 * wrong failure mode for what is, at worst, stale diagnostic data. The read path calls this first:
 * drop the orphaned calls and flag the page `degraded` instead of failing the whole request.
 */
export const resolveAuditedCallsForRead = (
  auditedCalls: readonly WorkspaceToolCallRecord[],
  provider: LiveProviderId | null,
): ResolvedAuditedCalls =>
  provider === null && auditedCalls.length > 0
    ? { auditedCalls: [], degraded: true }
    : { auditedCalls, degraded: false };

/**
 * Merges both sources and slices out one page, entirely in memory.
 *
 * Pure and side-effect-free on purpose: every read this needs (the AgentRun's provider, both
 * sources' rows) is the caller's job, so this function -- the one with the pagination and gap logic
 * that most needs direct tests -- never has to touch SQLite to be tested.
 *
 * A merged page can legitimately repeat `seq` values across origins (an audited entry and a reported
 * entry can both be `seq: 1`): it is a per-source counter, not a cross-source one. `id` is the only
 * identity a reader -- or a UI keying rows -- can rely on here.
 */
export const buildAgentRunActivityPage = (input: BuildActivityPageInput): AgentRunActivityPage => {
  const pageSize = input.pageSize ?? MAX_ACTIVITY_PAGE_SIZE;
  const audited = mapAuditedEntries(input.auditedCalls, input.provider);
  const reported = input.reportedRows.map(activityEntryFromReportedRow);
  const merged = mergeRunActivity(audited, reported);

  const { index: startIndex, gap } = locateCursor(merged, input.cursor);
  const endIndex = Math.min(startIndex + pageSize, merged.length);
  const entries = merged.slice(startIndex, endIndex);
  const lastEntry = entries[entries.length - 1];
  const nextCursor = endIndex < merged.length && lastEntry !== undefined ? encodeCursor(lastEntry) : null;

  return agentRunActivityPageSchema.parse({
    entries,
    nextCursor,
    omittedCount: input.omittedCount,
    degraded: input.degraded,
    gap,
  } satisfies AgentRunActivityPage);
};
