import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseClaudeEvent } from "../src/stream.js";

const recordingPath = fileURLToPath(new URL("./recordings/not-logged-in.jsonl", import.meta.url));

describe("parseClaudeEvent", () => {
  it("treats an authentication failure as a failure, even though its subtype says success", () => {
    const event = parseClaudeEvent(
      '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}',
    );
    expect(event).toEqual({
      type: "result",
      ok: false,
      rateLimited: false,
      text: "Not logged in · Please run /login",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("treats a real success as a success", () => {
    const event = parseClaudeEvent(
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.0031,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}',
    );
    expect(event).toEqual({
      type: "result",
      ok: true,
      rateLimited: false,
      text: "ok",
      costUsd: 0.0031,
      inputTokens: 15,
      outputTokens: 5,
      cachedInputTokens: 3,
    });
  });

  it("recognises an error result with API status 429 as a provider rate limit", () => {
    const event = parseClaudeEvent(
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"capacity unavailable","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}',
    );

    expect(event).toMatchObject({ type: "result", ok: false, rateLimited: true });
  });

  it("keeps the CLI's structured output separate from its display result", () => {
    const structuredOutput = {
      result: {
        type: "COMPLETED",
        summary: "The review passed.",
      },
    };
    const event = parseClaudeEvent(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "The review passed.",
        structured_output: structuredOutput,
        total_cost_usd: 0.0031,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
      }),
    );

    expect(event).toMatchObject({ structuredOutput });
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
