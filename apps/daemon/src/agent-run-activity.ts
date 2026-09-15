import {
  agentRunActivityEntrySchema,
  agentRunActivityPageSchema,
  activityOriginSchema,
  type AgentRunActivityEntry,
  type AgentRunActivityPage,
  type LiveProviderId,
  type WorkspaceToolCallRecord,
} from "@loomrail/contracts";
import type { WorkItemActivityRow } from "@loomrail/persistence-sqlite";
import { z } from "zod";

/**
 * The merged Run Activity feed, scoped to a WorkItem rather than one AgentRun (spec 128 / ADR-0034):
 * an audited action made on an earlier stage must stay visible after the pipeline advances past it,
 * so the feed spans every one of the WorkItem's runs, not the current attempt's alone.
 *
 * Two sources, different authority: `workspace_tool_calls` is daemon-verified and append-only
 * (`origin: "DAEMON_AUDITED"`); `agent_run_activity` is the provider's unverified, prunable account
 * of itself (`origin: "PROVIDER_REPORTED"`). Storage stays separate so the audited trail is never
 * mixed with untrusted diagnostics; this module is where the two become one chronological story on
 * read. `origin` is always computed here from which source a row came from, never accepted from
 * either table -- a stored column would be a value that could be written wrongly.
 */

type ActivityOrigin = AgentRunActivityEntry["origin"];
type ActivityStage = AgentRunActivityEntry["stage"];

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
 *
 * Unchanged by the feed's WorkItem scoping: time order runs straight through a run boundary the same
 * way it runs through two entries of the same run, so crossing one is not a special case here -- it
 * never was. What changed is only which rows the caller hands in.
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

// Handed to LIST_WORK_ITEM_ACTIVITY's own `limit`. Comfortably above one run's 1_000-row eviction
// bound (Task 6) even for a WorkItem with several runs' worth of headroom to spare, so this always
// reads back everything the buffer currently holds in one query; the merge-and-paginate below is
// what turns that into pages, not a second round trip to the table.
export const REPORTED_ENTRIES_FETCH_LIMIT = 2_000;

/**
 * What a WorkItem's own AgentRun contributes to the merged feed besides its rows: the provider to
 * label its audited calls with (`workspace_tool_calls` carries none of its own -- ADR-0014) and the
 * stage to name its group with in the UI (neither source table carries `stage` -- resolving it would
 * need a join through `stage_attempts` that Task 1 deliberately kept out of both entry reads).
 *
 * Keyed by `agentRunId` rather than positional, so a page spanning several runs can look either
 * source's own per-entry `agentRunId` up directly instead of the caller pre-sorting or zipping rows
 * against runs. Resolving this -- reading each referenced AgentRun and its stage -- is the caller's
 * job (server.ts), the same division `provider` already drew before this task: this module never
 * touches SQLite to be tested.
 */
export type RunActivityContext = {
  readonly agentRunId: string;
  // `null` when the AgentRun's own provider is not a live one (MOCK, in tests and fixtures only --
  // `RECORD_AGENT_RUN_ACTIVITY` already requires a live provider, and nothing in production drives a
  // MOCK session through the real workspace-tool gateway either).
  readonly provider: LiveProviderId | null;
  readonly stage: ActivityStage;
};

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
 * `agentRunId` comes straight off the call's own column -- `workspace_tool_calls` has always carried
 * it (ADR-0014), so unlike `stage` this needs no resolution from the caller. `seq` has no column to
 * read on this table (unlike the reported side's own `agent_run_activity.seq` counter): assigned by
 * the caller as the entry's 1-based rank within its own run's own calls, in `startedAt` order --
 * see `mapAuditedEntries` below for why that is per-run and not per-page.
 */
const activityEntryFromWorkspaceToolCall = (
  call: WorkspaceToolCallRecord,
  provider: LiveProviderId,
  stage: ActivityStage,
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
    agentRunId: call.agentRunId,
    stage,
  } satisfies AgentRunActivityEntry);

// The reported side's raw row already carries everything an entry needs, `agentRunId` included
// (Task 1's own `WorkItemActivityRow`); this only adds the `origin` its source table implies and the
// `stage` the caller resolved for that row's run. `failureCode` is always `null` here --
// `agent_run_activity` has no such column, since it is the provider's own unverified account, not an
// audited outcome.
const activityEntryFromReportedRow = (
  row: WorkItemActivityRow,
  stage: ActivityStage,
): AgentRunActivityEntry =>
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
    agentRunId: row.agentRunId,
    stage,
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
  /** Every `workspace_tool_calls` row for the WorkItem's runs, ordered by `(started_at, id)` ascending. */
  readonly auditedCalls: readonly WorkspaceToolCallRecord[];
  /** `LIST_WORK_ITEM_ACTIVITY`'s rows, ordered by `(observed_at, id)` ascending. */
  readonly reportedRows: readonly WorkItemActivityRow[];
  // One context per AgentRun either source above references. A row naming an AgentRun missing here
  // is a caller bug (see `runContextFor` below), not a data condition this module tries to recover
  // from -- `resolveAuditedCallsForRead` is where a genuinely absent live provider gets a safe answer,
  // before it ever reaches here.
  readonly runs: readonly RunActivityContext[];
  readonly omittedCount: number;
  readonly degraded: boolean;
  /** Already decoded by the caller (`decodeCursor`); `null` means "from the start". */
  readonly cursor: ActivityCursor | null;
  readonly pageSize?: number;
};

// Shared by both entry mappers below: every row and call on a WorkItem-scoped page names its own
// run, so both need the same "look it up or fail loudly" step. A row naming a run the caller did not
// resolve into `runs` cannot be labelled correctly -- silently guessing a stage or provider would be
// worse than refusing, so this throws rather than defaulting.
const runContextFor = (
  runs: ReadonlyMap<string, RunActivityContext>,
  agentRunId: string,
): RunActivityContext => {
  const context = runs.get(agentRunId);
  if (context === undefined) {
    throw new Error(
      `Run Activity entry references an AgentRun this page was not given a run for: ${agentRunId}`,
    );
  }
  return context;
};

// Separated from `buildAgentRunActivityPage` so the `provider === null` narrowing (audited calls
// need a live provider to become entries; a MOCK AgentRun's `null` is fine as long as there is
// nothing to map) happens in exactly one place, without a cast or a non-null assertion at the call
// site.
//
// `seq` is assigned per RUN, not per page: the contract's own doc comment on `seq` promises it is
// "monotonic within a run's own source", and a WorkItem's audited calls arrive from the caller as one
// array spanning every run, pre-sorted by `(started_at, id)` across all of them. Counting per run
// (not resetting per page, and not counting across runs either) is what keeps that promise once a
// page can hold more than one run's calls -- a global running count would make the second run's first
// entry read `seq: N+1` instead of `seq: 1`, contradicting the very comment this field carries.
const mapAuditedEntries = (
  calls: readonly WorkspaceToolCallRecord[],
  runs: ReadonlyMap<string, RunActivityContext>,
): readonly AgentRunActivityEntry[] => {
  const seqByRun = new Map<string, number>();
  return calls.map((call) => {
    const context = runContextFor(runs, call.agentRunId);
    if (context.provider === null) {
      throw new Error("Audited workspace tool calls exist for an AgentRun with no live provider");
    }
    const seq = (seqByRun.get(call.agentRunId) ?? 0) + 1;
    seqByRun.set(call.agentRunId, seq);
    return activityEntryFromWorkspaceToolCall(call, context.provider, context.stage, seq);
  });
};

const mapReportedEntries = (
  rows: readonly WorkItemActivityRow[],
  runs: ReadonlyMap<string, RunActivityContext>,
): readonly AgentRunActivityEntry[] =>
  rows.map((row) => activityEntryFromReportedRow(row, runContextFor(runs, row.agentRunId).stage));

export type ResolvedAuditedCalls = {
  readonly auditedCalls: readonly WorkspaceToolCallRecord[];
  readonly degraded: boolean;
};

/**
 * Guards `mapAuditedEntries`'s own defence-in-depth invariant (an audited call's own run needs a live
 * provider, or it throws) at the read boundary, before that throw can turn an ordinary GET into a
 * 500.
 *
 * The invariant itself stays enforced inside the page builder -- RECORD_AGENT_RUN_ACTIVITY and the
 * workspace-tool gateway both still require a live provider, so production cannot produce this
 * combination going forward, and a caller that got a run's provider wrong should still fail loudly.
 * But MOCK is a real, historical AgentRun provider (tests, fixtures, and any row written before that
 * invariant existed), and a read that 500s over a data shape the caller has no way to fix is the
 * wrong failure mode for what is, at worst, stale diagnostic data. The read path calls this first:
 * drop the calls whose own run has no live provider and flag the page `degraded`, instead of failing
 * the whole request over one run out of the WorkItem's many.
 *
 * Generalises the single-run version this replaced: instead of one `provider` applying to every call,
 * each call is judged by its own run's entry in `runs` -- a WorkItem's runs can straddle live and MOCK
 * providers (a MOCK fixture run alongside real ones, say), so one run's orphaned calls must not force
 * every other run's calls out of the page too.
 */
export const resolveAuditedCallsForRead = (
  auditedCalls: readonly WorkspaceToolCallRecord[],
  runs: readonly RunActivityContext[],
): ResolvedAuditedCalls => {
  const providerByRun = new Map(runs.map((run) => [run.agentRunId, run.provider]));
  const isOrphaned = (call: WorkspaceToolCallRecord): boolean =>
    (providerByRun.get(call.agentRunId) ?? null) === null;
  if (!auditedCalls.some(isOrphaned)) return { auditedCalls, degraded: false };
  return { auditedCalls: auditedCalls.filter((call) => !isOrphaned(call)), degraded: true };
};

/**
 * Merges both sources and slices out one page, entirely in memory.
 *
 * Pure and side-effect-free on purpose: every read this needs (each referenced AgentRun's provider
 * and stage, both sources' rows) is the caller's job, so this function -- the one with the merge,
 * pagination and gap logic that most needs direct tests -- never has to touch SQLite to be tested.
 *
 * A merged page can legitimately repeat `seq` values, both across origins (an audited entry and a
 * reported entry can both be `seq: 1`) and now across runs of the same origin too (two different
 * runs' first audited call are both `seq: 1`): it counts its own run's own source, nothing wider.
 * `id` is the only identity a reader -- or a UI keying rows -- can rely on here.
 */
export const buildAgentRunActivityPage = (input: BuildActivityPageInput): AgentRunActivityPage => {
  const pageSize = input.pageSize ?? MAX_ACTIVITY_PAGE_SIZE;
  const runsById = new Map(input.runs.map((run) => [run.agentRunId, run]));
  const audited = mapAuditedEntries(input.auditedCalls, runsById);
  const reported = mapReportedEntries(input.reportedRows, runsById);
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
