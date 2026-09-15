import { describe, expect, it } from "vitest";

import type { WorkspaceToolCallRecord } from "@loomrail/contracts";
import type { WorkItemActivityRow } from "@loomrail/persistence-sqlite";

import {
  buildAgentRunActivityPage,
  decodeCursor,
  encodeCursor,
  mergeRunActivity,
  resolveAuditedCallsForRead,
  resolveReferencedRuns,
  MAX_ACTIVITY_PAGE_SIZE,
  type RunActivityContext,
  type RunLookup,
} from "../src/agent-run-activity.js";

// Minimal fixtures shaped like the two upstream rows this module never queries the database for
// itself -- both sources are handed in already read, so these tests exercise merge/cursor/pagination
// in isolation from SQLite (packages/persistence-sqlite/test/agent-run-activity.integration.test.ts
// owns proving the underlying tables read back correctly).

const workspaceToolCall = (overrides: Partial<WorkspaceToolCallRecord> = {}): WorkspaceToolCallRecord => ({
  schemaVersion: 1,
  id: "workspace-tool-call-1",
  projectId: "project-1",
  workItemId: "work-item-1",
  stageAttemptId: "stage-attempt-1",
  agentRunId: "agent-run-1",
  providerSessionId: "provider-session-1",
  providerCallKey: "a".repeat(64),
  operation: "READ_FILE",
  target: "src/index.ts",
  policyDigest: "b".repeat(64),
  inputDigest: "c".repeat(64),
  status: "SUCCEEDED",
  failureCode: null,
  outputDigest: "d".repeat(64),
  outputBytes: 128,
  exitCode: null,
  startedAt: "2026-09-14T10:00:00.000Z",
  finishedAt: "2026-09-14T10:00:01.000Z",
  ...overrides,
});

const reportedRow = (overrides: Partial<WorkItemActivityRow> = {}): WorkItemActivityRow => ({
  id: "reported-1",
  seq: 1,
  agentRunId: "agent-run-1",
  observedAt: "2026-09-14T10:00:00.000Z",
  provider: "CODEX",
  kind: "AGENT_TEXT",
  label: null,
  detail: "Reading the file now",
  status: null,
  truncated: false,
  ...overrides,
});

// Matches `workspaceToolCall`/`reportedRow`'s own default `agentRunId` ("agent-run-1"), so a
// single-run test can supply just `[runContext()]` and have every fixture's row resolve against it.
const runContext = (overrides: Partial<RunActivityContext> = {}): RunActivityContext => ({
  agentRunId: "agent-run-1",
  provider: "CODEX",
  stage: "IMPLEMENT",
  ...overrides,
});

describe("mergeRunActivity", () => {
  const audited = { id: "w1", at: "2026-09-14T10:00:00.000Z", origin: "DAEMON_AUDITED" } as const;
  const reported = { id: "a1", at: "2026-09-14T10:00:00.000Z", origin: "PROVIDER_REPORTED" } as const;

  it("orders by time, then origin, then id, so equal timestamps are stable", () => {
    const first = mergeRunActivity([audited], [reported]).map((entry) => entry.id);
    const second = mergeRunActivity([reported], [audited]).map((entry) => entry.id);
    expect(first).toEqual(second);
  });

  it("marks each entry with the origin of its source, never with a provider-supplied value", () => {
    const merged = mergeRunActivity([audited], [reported]);
    expect(merged.map((entry) => entry.origin)).toEqual(["DAEMON_AUDITED", "PROVIDER_REPORTED"]);
  });

  it("orders distinct timestamps chronologically regardless of source", () => {
    const later = { id: "w2", at: "2026-09-14T10:00:05.000Z", origin: "DAEMON_AUDITED" } as const;
    const earlier = { id: "a2", at: "2026-09-14T09:59:55.000Z", origin: "PROVIDER_REPORTED" } as const;
    const merged = mergeRunActivity([later], [earlier]);
    expect(merged.map((entry) => entry.id)).toEqual(["a2", "w2"]);
  });
});

describe("cursor codec", () => {
  it("round-trips an entry through encode and decode", () => {
    const cursor = encodeCursor({ at: "2026-09-14T10:00:00.000Z", origin: "DAEMON_AUDITED", id: "w1" });
    expect(decodeCursor(cursor)).toEqual({
      at: "2026-09-14T10:00:00.000Z",
      origin: "DAEMON_AUDITED",
      id: "w1",
    });
  });

  it("rejects a cursor that is not valid base64url", () => {
    expect(decodeCursor("not base64!! at all")).toBeNull();
  });

  it("rejects a cursor whose payload is not JSON", () => {
    expect(decodeCursor(Buffer.from("not json").toString("base64url"))).toBeNull();
  });

  it("rejects a well-formed but forged cursor carrying an unknown field", () => {
    // .strict() on the schema is what catches this: valid base64, valid JSON, but a shape the real
    // encoder never produces. A forged cursor is not trusted just because it happens to parse.
    const forged = Buffer.from(
      JSON.stringify({ at: "2026-09-14T10:00:00.000Z", origin: "DAEMON_AUDITED", id: "w1", admin: true }),
    ).toString("base64url");
    expect(decodeCursor(forged)).toBeNull();
  });

  it("rejects a cursor with an origin value no source could ever produce", () => {
    const forged = Buffer.from(
      JSON.stringify({ at: "2026-09-14T10:00:00.000Z", origin: "OWNER_ASSERTED", id: "w1" }),
    ).toString("base64url");
    expect(decodeCursor(forged)).toBeNull();
  });

  it("rejects a cursor whose timestamp is not a valid ISO instant", () => {
    const forged = Buffer.from(
      JSON.stringify({ at: "not-a-date", origin: "DAEMON_AUDITED", id: "w1" }),
    ).toString("base64url");
    expect(decodeCursor(forged)).toBeNull();
  });
});

describe("buildAgentRunActivityPage", () => {
  it("attaches origin by source table and merges both into one deterministic page", () => {
    const page = buildAgentRunActivityPage({
      auditedCalls: [workspaceToolCall({ id: "w1", startedAt: "2026-09-14T10:00:00.000Z" })],
      runs: [runContext()],
      reportedRows: [reportedRow({ id: "a1", observedAt: "2026-09-14T10:00:00.000Z" })],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    expect(page.entries.map((entry) => [entry.id, entry.origin])).toEqual([
      ["w1", "DAEMON_AUDITED"],
      ["a1", "PROVIDER_REPORTED"],
    ]);
    expect(page.gap).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("describes an audited entry from the workspace tool call's own fields, not a provider guess", () => {
    const page = buildAgentRunActivityPage({
      auditedCalls: [
        workspaceToolCall({
          id: "w1",
          operation: "WRITE_FILE",
          target: "src/config.ts",
          status: "FAILED",
          failureCode: "PATH_FORBIDDEN",
        }),
      ],
      runs: [runContext({ provider: "CLAUDE_CODE" })],
      reportedRows: [],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    const [entry] = page.entries;
    // Bare, not folded: `status` and `failureCode` are separate fields because the UI reads both as
    // opaque i18n lookup keys (`workspaceTool.status.*`) and never parses one apart from the other.
    expect(entry).toMatchObject({
      origin: "DAEMON_AUDITED",
      provider: "CLAUDE_CODE",
      kind: "TOOL_CALL",
      label: "WRITE_FILE",
      detail: "src/config.ts",
      status: "FAILED",
      failureCode: "PATH_FORBIDDEN",
      truncated: false,
    });
  });

  it("carries a null failureCode for a reported entry, which has no such column to read", () => {
    const page = buildAgentRunActivityPage({
      auditedCalls: [],
      runs: [runContext()],
      reportedRows: [reportedRow({ id: "a1" })],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    expect(page.entries[0]).toMatchObject({ origin: "PROVIDER_REPORTED", failureCode: null });
  });

  it("passes omittedCount and degraded through from the reported source untouched", () => {
    const page = buildAgentRunActivityPage({
      auditedCalls: [],
      runs: [],
      reportedRows: [],
      omittedCount: 42,
      degraded: true,
      cursor: null,
    });
    expect(page.omittedCount).toBe(42);
    expect(page.degraded).toBe(true);
  });

  it("surfaces the already-aggregated omittedCount unchanged from a page spanning several runs", () => {
    // LIST_WORK_ITEM_ACTIVITY sums omittedCount across the WorkItem's runs in SQL (Task 1); this
    // pins that building a real multi-run page around that number does not re-derive or clobber it.
    const page = buildAgentRunActivityPage({
      auditedCalls: [
        workspaceToolCall({ id: "w1", agentRunId: "agent-run-1" }),
        workspaceToolCall({ id: "w2", agentRunId: "agent-run-2", startedAt: "2026-09-14T10:00:05.000Z" }),
      ],
      runs: [runContext({ agentRunId: "agent-run-1" }), runContext({ agentRunId: "agent-run-2" })],
      reportedRows: [],
      omittedCount: 7,
      degraded: false,
      cursor: null,
    });
    expect(page.omittedCount).toBe(7);
  });

  it("serves the page from the window start with gap:true when the cursor names a pruned position", () => {
    // The reported row this cursor once pointed at is gone from `reportedRows` -- eviction, in
    // production -- and nothing here can tell that apart from a cursor that never existed. Both get
    // the same safe answer.
    const page = buildAgentRunActivityPage({
      auditedCalls: [workspaceToolCall({ id: "w1", startedAt: "2026-09-14T10:00:00.000Z" })],
      runs: [runContext()],
      reportedRows: [],
      omittedCount: 5,
      degraded: false,
      cursor: { at: "2026-09-14T09:00:00.000Z", origin: "PROVIDER_REPORTED", id: "evicted-1" },
    });
    expect(page.gap).toBe(true);
    expect(page.entries.map((entry) => entry.id)).toEqual(["w1"]);
  });

  it("does not set gap when the cursor names a position that is still present", () => {
    const first = workspaceToolCall({ id: "w1", startedAt: "2026-09-14T10:00:00.000Z" });
    const second = workspaceToolCall({ id: "w2", startedAt: "2026-09-14T10:00:05.000Z" });
    const page = buildAgentRunActivityPage({
      auditedCalls: [first, second],
      runs: [runContext()],
      reportedRows: [],
      omittedCount: 0,
      degraded: false,
      cursor: { at: "2026-09-14T10:00:00.000Z", origin: "DAEMON_AUDITED", id: "w1" },
    });
    expect(page.gap).toBe(false);
    expect(page.entries.map((entry) => entry.id)).toEqual(["w2"]);
  });

  it("paginates without gaps or repeats across a full sweep using each page's own nextCursor", () => {
    const calls = Array.from({ length: 5 }, (_, index) =>
      workspaceToolCall({
        id: `w${(index + 1).toString()}`,
        startedAt: `2026-09-14T10:00:0${index.toString()}.000Z`,
      }),
    );
    const pageSize = 2;
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = buildAgentRunActivityPage({
        auditedCalls: calls,
        runs: [runContext()],
        reportedRows: [],
        omittedCount: 0,
        degraded: false,
        cursor,
        pageSize,
      });
      seen.push(...page.entries.map((entry) => entry.id));
      if (page.nextCursor === null) break;
      cursor = decodeCursor(page.nextCursor);
    }
    expect(seen).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  it("caps a page at MAX_ACTIVITY_PAGE_SIZE even when far more entries are available", () => {
    // A fact about the constant (`MAX_ACTIVITY_PAGE_SIZE <= 200`) would pass against a builder that
    // ignored the cap entirely -- this instead builds past it and checks the slice and the
    // nextCursor-on-a-full-page branch actually fire.
    const totalCalls = MAX_ACTIVITY_PAGE_SIZE + 50;
    const calls = Array.from({ length: totalCalls }, (_, index) =>
      workspaceToolCall({
        id: `w${index.toString().padStart(4, "0")}`,
        startedAt: new Date(Date.UTC(2026, 8, 14, 10, 0, 0) + index).toISOString(),
      }),
    );
    const page = buildAgentRunActivityPage({
      auditedCalls: calls,
      runs: [runContext()],
      reportedRows: [],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    expect(page.entries).toHaveLength(MAX_ACTIVITY_PAGE_SIZE);
    expect(page.entries[0]?.id).toBe("w0000");
    expect(page.entries[page.entries.length - 1]?.id).toBe(
      `w${(MAX_ACTIVITY_PAGE_SIZE - 1).toString().padStart(4, "0")}`,
    );
    expect(page.nextCursor).not.toBeNull();
  });

  it("serves a MOCK AgentRun's reported-only feed instead of failing on its non-live provider", () => {
    // MOCK is a real AgentRun provider (tests and fixtures), just not one RECORD_AGENT_RUN_ACTIVITY
    // or the workspace-tool gateway is ever wired to -- so a MOCK run has no audited rows to map and
    // `provider: null` must not stop its (perfectly normal) reported rows from reaching the page. Its
    // run must still be supplied, though -- a reported row still needs its stage resolved.
    const page = buildAgentRunActivityPage({
      auditedCalls: [],
      runs: [runContext({ provider: null })],
      reportedRows: [reportedRow({ id: "a1" })],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    expect(page.entries.map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("refuses to guess a provider for an audited entry that should not exist", () => {
    // Defence in depth: production can never produce this combination (RECORD_AGENT_RUN_ACTIVITY
    // requires a live provider and nothing drives MOCK through the real gateway), but a caller that
    // resolved a run's provider wrong must not see its audited call silently mislabelled with a
    // made-up provider instead.
    expect(() =>
      buildAgentRunActivityPage({
        auditedCalls: [workspaceToolCall({ id: "w1" })],
        runs: [runContext({ provider: null })],
        reportedRows: [],
        omittedCount: 0,
        degraded: false,
        cursor: null,
      }),
    ).toThrow(/no live provider/);
  });

  it("refuses to build an entry for an audited call whose own run was never supplied", () => {
    // Distinct from the provider===null case above: here the caller omitted the run from `runs`
    // entirely, so there is nothing -- not even a MOCK provider -- to resolve it against.
    expect(() =>
      buildAgentRunActivityPage({
        auditedCalls: [workspaceToolCall({ id: "w1", agentRunId: "agent-run-missing" })],
        runs: [],
        reportedRows: [],
        omittedCount: 0,
        degraded: false,
        cursor: null,
      }),
    ).toThrow(/was not given a run for/);
  });

  it("refuses to build an entry for a reported row whose own run was never supplied", () => {
    expect(() =>
      buildAgentRunActivityPage({
        auditedCalls: [],
        runs: [],
        reportedRows: [reportedRow({ id: "a1", agentRunId: "agent-run-missing" })],
        omittedCount: 0,
        degraded: false,
        cursor: null,
      }),
    ).toThrow(/was not given a run for/);
  });

  it("orders entries by time across a run boundary, never by which run each one belongs to", () => {
    // Two runs' entries interleave in time (run2, run1, run2, run1); the merged page must read out
    // in that chronological order, proving the run boundary is not a grouping the merge respects.
    const page = buildAgentRunActivityPage({
      auditedCalls: [
        workspaceToolCall({
          id: "w-run2-early",
          agentRunId: "agent-run-2",
          startedAt: "2026-09-14T10:00:01.000Z",
        }),
        workspaceToolCall({
          id: "w-run1-late",
          agentRunId: "agent-run-1",
          startedAt: "2026-09-14T10:00:03.000Z",
        }),
      ],
      reportedRows: [
        reportedRow({
          id: "a-run1-earliest",
          agentRunId: "agent-run-1",
          observedAt: "2026-09-14T10:00:00.000Z",
        }),
        reportedRow({ id: "a-run2-late", agentRunId: "agent-run-2", observedAt: "2026-09-14T10:00:02.000Z" }),
      ],
      runs: [runContext({ agentRunId: "agent-run-1" }), runContext({ agentRunId: "agent-run-2" })],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    expect(page.entries.map((entry) => entry.id)).toEqual([
      "a-run1-earliest",
      "w-run2-early",
      "a-run2-late",
      "w-run1-late",
    ]);
  });

  it("does not drop or duplicate an entry when a page boundary lands in the middle of one run's own calls", () => {
    // Five audited calls across two runs, ordered as LIST_WORKSPACE_TOOL_CALLS_FOR_WORK_ITEM would
    // hand them in. pageSize 2 cuts page 1 inside agent-run-1's own calls (after its 2nd, before its
    // 3rd) and page 2 straddles the run boundary itself (agent-run-1's 3rd call, then agent-run-2's
    // 1st) -- both a mid-run cut and a cross-run page in one sweep.
    const calls = [
      workspaceToolCall({ id: "w1", agentRunId: "agent-run-1", startedAt: "2026-09-14T10:00:00.000Z" }),
      workspaceToolCall({ id: "w2", agentRunId: "agent-run-1", startedAt: "2026-09-14T10:00:01.000Z" }),
      workspaceToolCall({ id: "w3", agentRunId: "agent-run-1", startedAt: "2026-09-14T10:00:02.000Z" }),
      workspaceToolCall({ id: "w4", agentRunId: "agent-run-2", startedAt: "2026-09-14T10:00:03.000Z" }),
      workspaceToolCall({ id: "w5", agentRunId: "agent-run-2", startedAt: "2026-09-14T10:00:04.000Z" }),
    ];
    const runs = [runContext({ agentRunId: "agent-run-1" }), runContext({ agentRunId: "agent-run-2" })];
    const pageSize = 2;
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = buildAgentRunActivityPage({
        auditedCalls: calls,
        reportedRows: [],
        runs,
        omittedCount: 0,
        degraded: false,
        cursor,
        pageSize,
      });
      seen.push(...page.entries.map((entry) => entry.id));
      if (page.nextCursor === null) break;
      cursor = decodeCursor(page.nextCursor);
    }
    expect(seen).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  it("labels each entry with its own run's stage and agentRunId, never another run's", () => {
    const page = buildAgentRunActivityPage({
      auditedCalls: [
        workspaceToolCall({ id: "w1", agentRunId: "agent-run-1", startedAt: "2026-09-14T10:00:00.000Z" }),
      ],
      reportedRows: [
        reportedRow({ id: "a1", agentRunId: "agent-run-2", observedAt: "2026-09-14T10:00:01.000Z" }),
      ],
      runs: [
        runContext({ agentRunId: "agent-run-1", stage: "PLAN" }),
        runContext({ agentRunId: "agent-run-2", stage: "REVIEW" }),
      ],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    expect(page.entries.map((entry) => [entry.id, entry.agentRunId, entry.stage])).toEqual([
      ["w1", "agent-run-1", "PLAN"],
      ["a1", "agent-run-2", "REVIEW"],
    ]);
  });

  it("restarts an audited run's own seq at 1, matching the contract's per-run promise", () => {
    // The contract's own doc comment on `seq` promises it is monotonic "within a run's own source".
    // A global running count across the whole page would give agent-run-2's first call seq 3 instead
    // of 1, breaking that promise the moment a page holds more than one run's audited calls.
    const page = buildAgentRunActivityPage({
      auditedCalls: [
        workspaceToolCall({ id: "w1", agentRunId: "agent-run-1", startedAt: "2026-09-14T10:00:00.000Z" }),
        workspaceToolCall({ id: "w2", agentRunId: "agent-run-1", startedAt: "2026-09-14T10:00:01.000Z" }),
        workspaceToolCall({ id: "w3", agentRunId: "agent-run-2", startedAt: "2026-09-14T10:00:02.000Z" }),
      ],
      reportedRows: [],
      runs: [runContext({ agentRunId: "agent-run-1" }), runContext({ agentRunId: "agent-run-2" })],
      omittedCount: 0,
      degraded: false,
      cursor: null,
    });
    expect(page.entries.map((entry) => [entry.id, entry.agentRunId, entry.seq])).toEqual([
      ["w1", "agent-run-1", 1],
      ["w2", "agent-run-1", 2],
      ["w3", "agent-run-2", 1],
    ]);
  });

  it("flags gap when a source hits its own read-ahead cap and the page still claims there is nothing more", () => {
    // Fix round 2: a source that returns exactly `pageSize + 1` rows (the caller's own read-ahead
    // bound) might hold more beyond what it fetched. Three reported rows share one timestamp here,
    // matching `pageSize + 1` (2 + 1); the cursor names the middle one, so the page's own slice
    // lands exactly at the end of what was fetched -- the same shape a run of same-timestamp ties
    // outlasting the caller's `>= cursor.at` fetch window produces in production (see this
    // function's own doc comment). `nextCursor: null` here would silently claim completeness.
    const tiedAt = "2026-09-14T10:00:00.000Z";
    const page = buildAgentRunActivityPage({
      auditedCalls: [],
      runs: [runContext()],
      reportedRows: [
        reportedRow({ id: "r1", observedAt: tiedAt }),
        reportedRow({ id: "r2", observedAt: tiedAt }),
        reportedRow({ id: "r3", observedAt: tiedAt }),
      ],
      omittedCount: 0,
      degraded: false,
      cursor: { at: tiedAt, origin: "PROVIDER_REPORTED", id: "r2" },
      pageSize: 2,
    });
    expect(page.gap).toBe(true);
    expect(page.entries.map((entry) => entry.id)).toEqual(["r3"]);
  });

  it("does not flag gap when a source's own row count falls short of its read-ahead cap", () => {
    // Same shape as the test above, one row short of the cap (2, not pageSize + 1 = 3): the
    // source's own fetch could not have been truncated, so there is nothing to doubt about
    // `nextCursor: null` here -- this is what keeps the new guard from firing on an ordinary,
    // genuinely-complete last page.
    const tiedAt = "2026-09-14T10:00:00.000Z";
    const page = buildAgentRunActivityPage({
      auditedCalls: [],
      runs: [runContext()],
      reportedRows: [
        reportedRow({ id: "r1", observedAt: tiedAt }),
        reportedRow({ id: "r2", observedAt: tiedAt }),
      ],
      omittedCount: 0,
      degraded: false,
      cursor: { at: tiedAt, origin: "PROVIDER_REPORTED", id: "r1" },
      pageSize: 2,
    });
    expect(page.gap).toBe(false);
    expect(page.entries.map((entry) => entry.id)).toEqual(["r2"]);
  });
});

describe("resolveAuditedCallsForRead", () => {
  it("passes audited calls through unchanged for a live provider", () => {
    const calls = [workspaceToolCall({ id: "w1" })];
    expect(resolveAuditedCallsForRead(calls, [runContext()])).toEqual({
      auditedCalls: calls,
      degraded: false,
    });
  });

  it("passes an empty list through for a MOCK (null) provider -- the ordinary case", () => {
    expect(resolveAuditedCallsForRead([], [runContext({ provider: null })])).toEqual({
      auditedCalls: [],
      degraded: false,
    });
  });

  // The read-boundary fix this guards: a MOCK AgentRun that somehow does have audited rows (fixture
  // data, or a row written before the provider/audited-calls invariant existed) must not reach
  // `buildAgentRunActivityPage` -- which throws on exactly this combination -- and turn an ordinary
  // GET into a 500. Dropping the orphaned calls and flagging `degraded` keeps the read alive.
  it("drops orphaned audited calls for a null provider and flags the page degraded", () => {
    const calls = [workspaceToolCall({ id: "w1" })];
    expect(resolveAuditedCallsForRead(calls, [runContext({ provider: null })])).toEqual({
      auditedCalls: [],
      degraded: true,
    });
    // And the drop actually neutralises the throw `buildAgentRunActivityPage` would otherwise raise.
    const resolved = resolveAuditedCallsForRead(calls, [runContext({ provider: null })]);
    expect(() =>
      buildAgentRunActivityPage({
        auditedCalls: resolved.auditedCalls,
        runs: [runContext({ provider: null })],
        reportedRows: [],
        omittedCount: 0,
        degraded: resolved.degraded,
        cursor: null,
      }),
    ).not.toThrow();
  });

  it("drops only the orphaned run's calls when several runs are in scope, and flags the page degraded", () => {
    // A WorkItem's runs can straddle live and MOCK providers -- e.g. a MOCK fixture run alongside
    // real ones. One run's orphaned calls must not push every other run's calls out of the page too.
    const healthy = workspaceToolCall({ id: "w1", agentRunId: "agent-run-1" });
    const orphaned = workspaceToolCall({ id: "w2", agentRunId: "agent-run-2" });
    const resolved = resolveAuditedCallsForRead(
      [healthy, orphaned],
      [
        runContext({ agentRunId: "agent-run-1", provider: "CODEX" }),
        runContext({ agentRunId: "agent-run-2", provider: null }),
      ],
    );
    expect(resolved).toEqual({ auditedCalls: [healthy], degraded: true });
  });
});

describe("resolveReferencedRuns", () => {
  // A run whose lookup succeeds twice (AgentRun found, then its StageAttempt found too).
  const workingLookup = (
    overrides: Partial<{ provider: string; stageAttemptId: string; stage: RunActivityContext["stage"] }> = {},
  ): RunLookup => {
    const provider = overrides.provider ?? "CODEX";
    const stageAttemptId = overrides.stageAttemptId ?? "stage-attempt-1";
    const stage = overrides.stage ?? "IMPLEMENT";
    return {
      getAgentRun: (agentRunId) => (agentRunId === "agent-run-1" ? { stageAttemptId, provider } : undefined),
      getStageAttempt: (id) => (id === stageAttemptId ? { stage } : undefined),
    };
  };

  it("resolves provider and stage for every referenced run through the lookup callbacks", () => {
    const lookup: RunLookup = {
      getAgentRun: (agentRunId) =>
        agentRunId === "agent-run-1"
          ? { stageAttemptId: "stage-attempt-1", provider: "CODEX" }
          : agentRunId === "agent-run-2"
            ? { stageAttemptId: "stage-attempt-2", provider: "CLAUDE_CODE" }
            : undefined,
      getStageAttempt: (id) =>
        id === "stage-attempt-1"
          ? { stage: "PLAN" }
          : id === "stage-attempt-2"
            ? { stage: "REVIEW" }
            : undefined,
    };
    const result = resolveReferencedRuns(["agent-run-1", "agent-run-2"], lookup);
    expect(result.unresolvedRunIds.size).toBe(0);
    expect(result.runs).toEqual([
      { agentRunId: "agent-run-1", provider: "CODEX", stage: "PLAN" },
      { agentRunId: "agent-run-2", provider: "CLAUDE_CODE", stage: "REVIEW" },
    ]);
  });

  it("resolves a null provider for a MOCK run instead of guessing a live one", () => {
    const result = resolveReferencedRuns(["agent-run-1"], workingLookup({ provider: "MOCK" }));
    expect(result.runs).toEqual([{ agentRunId: "agent-run-1", provider: null, stage: "IMPLEMENT" }]);
    expect(result.unresolvedRunIds.size).toBe(0);
  });

  it("marks a run unresolved when its AgentRun cannot be found, without calling getStageAttempt for it", () => {
    let stageAttemptCalls = 0;
    const lookup: RunLookup = {
      getAgentRun: () => undefined,
      getStageAttempt: () => {
        stageAttemptCalls += 1;
        return { stage: "IMPLEMENT" };
      },
    };
    const result = resolveReferencedRuns(["agent-run-missing"], lookup);
    expect(result.runs).toEqual([]);
    expect(result.unresolvedRunIds).toEqual(new Set(["agent-run-missing"]));
    expect(stageAttemptCalls).toBe(0);
  });

  it("marks a run unresolved when its own StageAttempt cannot be found", () => {
    // This is fix round 1's "genuinely unresolvable stage" path (packages/persistence-sqlite's
    // GET_STAGE_ATTEMPT returning nothing for the AgentRun's own stageAttemptId) -- unreachable
    // through the real command surface (both sources' foreign keys, and the AgentRun's own
    // stage_attempt_id FK, make an orphan impossible in production), which is exactly why this
    // needs a plain lookup stub rather than a corrupted SQLite database to exercise directly.
    const lookup: RunLookup = {
      getAgentRun: (agentRunId) =>
        agentRunId === "agent-run-1"
          ? { stageAttemptId: "stage-attempt-gone", provider: "CODEX" }
          : undefined,
      getStageAttempt: () => undefined,
    };
    const result = resolveReferencedRuns(["agent-run-1"], lookup);
    expect(result.runs).toEqual([]);
    expect(result.unresolvedRunIds).toEqual(new Set(["agent-run-1"]));
  });

  it("resolves the runs it can and marks only the runs it cannot, in one call", () => {
    const lookup: RunLookup = {
      getAgentRun: (agentRunId) =>
        agentRunId === "agent-run-1"
          ? { stageAttemptId: "stage-attempt-1", provider: "CODEX" }
          : agentRunId === "agent-run-2"
            ? { stageAttemptId: "stage-attempt-gone", provider: "CODEX" }
            : undefined,
      getStageAttempt: (id) => (id === "stage-attempt-1" ? { stage: "PLAN" } : undefined),
    };
    const result = resolveReferencedRuns(["agent-run-1", "agent-run-2"], lookup);
    expect(result.runs).toEqual([{ agentRunId: "agent-run-1", provider: "CODEX", stage: "PLAN" }]);
    expect(result.unresolvedRunIds).toEqual(new Set(["agent-run-2"]));
  });
});
