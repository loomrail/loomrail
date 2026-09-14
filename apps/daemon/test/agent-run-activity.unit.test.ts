import { describe, expect, it } from "vitest";

import type { WorkspaceToolCallRecord } from "@loomrail/contracts";
import type { AgentRunActivityRow } from "@loomrail/persistence-sqlite";

import {
  buildAgentRunActivityPage,
  decodeCursor,
  encodeCursor,
  mergeRunActivity,
  MAX_ACTIVITY_PAGE_SIZE,
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

const reportedRow = (overrides: Partial<AgentRunActivityRow> = {}): AgentRunActivityRow => ({
  id: "reported-1",
  seq: 1,
  observedAt: "2026-09-14T10:00:00.000Z",
  provider: "CODEX",
  kind: "AGENT_TEXT",
  label: null,
  detail: "Reading the file now",
  status: null,
  truncated: false,
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
      provider: "CODEX",
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
      provider: "CLAUDE_CODE",
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
      provider: "CODEX",
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
      provider: "CODEX",
      reportedRows: [],
      omittedCount: 42,
      degraded: true,
      cursor: null,
    });
    expect(page.omittedCount).toBe(42);
    expect(page.degraded).toBe(true);
  });

  it("serves the page from the window start with gap:true when the cursor names a pruned position", () => {
    // The reported row this cursor once pointed at is gone from `reportedRows` -- eviction, in
    // production -- and nothing here can tell that apart from a cursor that never existed. Both get
    // the same safe answer.
    const page = buildAgentRunActivityPage({
      auditedCalls: [workspaceToolCall({ id: "w1", startedAt: "2026-09-14T10:00:00.000Z" })],
      provider: "CODEX",
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
      provider: "CODEX",
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
        provider: "CODEX",
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
      provider: "CODEX",
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
    // `provider: null` must not stop its (perfectly normal) reported rows from reaching the page.
    const page = buildAgentRunActivityPage({
      auditedCalls: [],
      provider: null,
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
    // got AgentRun.provider wrong must not see its audited call silently mislabelled with a made-up
    // provider instead.
    expect(() =>
      buildAgentRunActivityPage({
        auditedCalls: [workspaceToolCall({ id: "w1" })],
        provider: null,
        reportedRows: [],
        omittedCount: 0,
        degraded: false,
        cursor: null,
      }),
    ).toThrow(/no live provider/);
  });
});
