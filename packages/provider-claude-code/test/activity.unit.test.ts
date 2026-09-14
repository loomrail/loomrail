import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseClaudeActivity } from "../src/activity.js";

const recording = (name: string): readonly string[] =>
  readFileSync(fileURLToPath(new URL(`./recordings/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter(Boolean);

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
});
