import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseClaudeEvent } from "../src/stream.js";

const recordingPath = fileURLToPath(new URL("./recordings/not-logged-in.jsonl", import.meta.url));

describe("parseClaudeEvent", () => {
  it("treats an authentication failure as a failure, even though its subtype says success", () => {
    const event = parseClaudeEvent(
      '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","total_cost_usd":0}',
    );
    expect(event).toEqual({
      type: "result",
      ok: false,
      text: "Not logged in · Please run /login",
      costUsd: 0,
    });
  });

  it("treats a real success as a success", () => {
    const event = parseClaudeEvent(
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.0031}',
    );
    expect(event).toEqual({ type: "result", ok: true, text: "ok", costUsd: 0.0031 });
  });

  // The user's own hooks stream through here carrying their stdout and stderr. They are not provider
  // events, and SD-003 forbids Loomrail recording that text.
  it("drops the user's hook events", () => {
    const recorded = readFileSync(recordingPath, "utf8").split("\n").filter(Boolean);
    const kept = recorded.map(parseClaudeEvent).filter((event) => event !== null);
    expect(kept.some((event) => JSON.stringify(event).includes("hook"))).toBe(false);
  });

  it("drops a line that is not JSON", () => {
    expect(parseClaudeEvent("some warning printed by a wrapper")).toBeNull();
  });
});
