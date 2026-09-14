import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCodexActivity } from "../src/activity.js";

const recording = (name: string): readonly string[] =>
  readFileSync(fileURLToPath(new URL(`./recordings/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter(Boolean);

describe("parseCodexActivity", () => {
  it("reports a command and its exit code from a real workspace-write run", () => {
    const entries = recording("workspace-write.jsonl").flatMap(parseCodexActivity);
    const commands = entries.filter((entry) => entry.kind === "TOOL_CALL");
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((entry) => entry.label !== null)).toBe(true);
    expect(commands.some((entry) => entry.terminal && entry.status !== null)).toBe(true);
  });

  it("pairs the start and the completion of one action under one key", () => {
    const entries = recording("workspace-write.jsonl").flatMap(parseCodexActivity);
    const keys = entries.filter((entry) => entry.kind === "TOOL_CALL").map((entry) => entry.actionKey);
    expect(new Set(keys).size).toBeLessThan(keys.length);
  });

  it("reports file changes as paths without their content", () => {
    const entries = recording("workspace-write.jsonl").flatMap(parseCodexActivity);
    const changes = entries.filter((entry) => entry.kind === "FILE_CHANGE");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((entry) => entry.detail === null || entry.detail.length <= 2_000)).toBe(true);
  });

  it("returns nothing for a line it does not understand", () => {
    expect(parseCodexActivity("not json")).toEqual([]);
    expect(parseCodexActivity(JSON.stringify({ type: "turn.started" }))).toEqual([]);
  });
});
