import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseClaudeActivity } from "../src/activity.js";

const recording = (name: string): readonly string[] =>
  readFileSync(fileURLToPath(new URL(`./recordings/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter(Boolean);

// None of the captured recordings contain an assistant `text` block (see
// `test/recordings/README.md` -- those runs only exercised tool calls), which is exactly why the
// `text-${index}` collision this file regression-tests survived review undetected. These lines are
// hand-built, not captured: they mimic the real stream-json shape (`type`, top-level `uuid`,
// `message.id`, `message.content`) closely enough to exercise the parser honestly, without
// pretending to be a real CLI run. Do not add these to `test/recordings/`.
const syntheticLine = (fields: Record<string, unknown>): string => JSON.stringify(fields);

const assistantTextLine = (
  uuid: string | undefined,
  messageId: string | undefined,
  texts: readonly string[],
): string =>
  syntheticLine({
    type: "assistant",
    ...(uuid === undefined ? {} : { uuid }),
    message: {
      role: "assistant",
      ...(messageId === undefined ? {} : { id: messageId }),
      content: texts.map((text) => ({ type: "text", text })),
    },
  });

describe("parseClaudeActivity", () => {
  it("reports tool calls from a real run that used MCP tools", () => {
    const entries = recording("claude-2.1.260-mcp-macos-arm64.jsonl").flatMap(parseClaudeActivity);
    const calls = entries.filter((entry) => entry.kind === "TOOL_CALL" && !entry.terminal);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((entry) => entry.label !== null)).toBe(true);
  });

  it("pairs a tool result with the call it answers", () => {
    const entries = recording("claude-2.1.260-mcp-macos-arm64.jsonl").flatMap(parseClaudeActivity);
    const started = entries.filter((entry) => entry.kind === "TOOL_CALL" && !entry.terminal);
    const finished = entries.filter((entry) => entry.kind === "TOOL_CALL" && entry.terminal);
    expect(finished.every((end) => started.some((start) => start.actionKey === end.actionKey))).toBe(true);
  });

  it("never carries tool result content", () => {
    const entries = recording("claude-2.1.260-mcp-macos-arm64.jsonl").flatMap(parseClaudeActivity);
    const finished = entries.filter((entry) => entry.kind === "TOOL_CALL" && entry.terminal);
    expect(finished.every((entry) => entry.detail === null)).toBe(true);
  });

  it("drops every system event, including hook events", () => {
    const entries = recording("not-logged-in.jsonl").flatMap(parseClaudeActivity);
    expect(entries.every((entry) => entry.kind !== "PROVIDER_ERROR" || entry.label !== null)).toBe(true);
    const systemLines = recording("not-logged-in.jsonl").filter((line) => line.includes('"type":"system"'));
    expect(systemLines.flatMap(parseClaudeActivity)).toEqual([]);
  });

  describe("AGENT_TEXT action keys (synthetic: no recording carries a text block)", () => {
    it("keys two different assistant lines' text blocks differently", () => {
      // Regression test for the defect this task fixes: a positional `text-${index}` key resets to
      // 0 on every line, so two different lines' first text block used to collide and the second
      // one's content silently vanished under the daemon's per-(session, actionKey) upsert.
      const lineA = assistantTextLine(
        "35789066-19f1-44fc-b31c-ee1b3270044f",
        "msg_011Cei1VTTJuHTZVrsEeNppU",
        ["first message"],
      );
      const lineB = assistantTextLine(
        "d8a9b6f2-8cf8-4874-8588-abca838381d1",
        "msg_011Cei1VgPBeHeCeZZ82vb7D",
        ["second message"],
      );

      const [entryA] = parseClaudeActivity(lineA);
      const [entryB] = parseClaudeActivity(lineB);

      expect(entryA?.kind).toBe("AGENT_TEXT");
      expect(entryB?.kind).toBe("AGENT_TEXT");
      expect(entryA?.actionKey).not.toBe(entryB?.actionKey);
    });

    it("keys two text blocks on the same line differently", () => {
      const line = assistantTextLine("11111111-1111-4111-8111-111111111111", "msg_same_line", [
        "first block",
        "second block",
      ]);

      const entries = parseClaudeActivity(line);

      expect(entries).toHaveLength(2);
      expect(entries[0]?.actionKey).not.toBe(entries[1]?.actionKey);
    });

    it("drops a text block when the line has neither uuid nor message.id", () => {
      const line = assistantTextLine(undefined, undefined, ["orphaned text"]);

      const entries = parseClaudeActivity(line);

      expect(entries).toEqual([]);
    });

    it("drops a text entry rather than emit an actionKey the contract would reject", () => {
      // message.id is provider process output, not a contract Loomrail controls -- nothing bounds
      // its length. Truncating it would risk exactly the collision this fix removes, so an
      // over-length identifier must drop the entry, not produce a key longer than 200 chars.
      const pathologicalMessageId = `msg_${"x".repeat(250)}`;
      const line = assistantTextLine(undefined, pathologicalMessageId, ["still too long"]);

      const entries = parseClaudeActivity(line);

      expect(entries).toEqual([]);
    });
  });
});
