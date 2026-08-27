import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCodexEvent } from "../src/stream.js";

const recordingPath = fileURLToPath(new URL("./recordings/hello.jsonl", import.meta.url));

describe("parseCodexEvent", () => {
  it("reads the recorded stream of a real run", () => {
    const events = readFileSync(recordingPath, "utf8").split("\n").filter(Boolean).map(parseCodexEvent);
    expect(events.map((event) => event?.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("carries the usage a completed turn reports", () => {
    const event = parseCodexEvent(
      '{"type":"turn.completed","usage":{"input_tokens":17854,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
    );
    expect(event).toEqual({
      type: "turn.completed",
      usage: { inputTokens: 17854, cachedInputTokens: 9984, outputTokens: 5, reasoningOutputTokens: 0 },
    });
  });

  // M1: the parser knew four of the seven event types the shipped binary defines, and `turn.failed`
  // -- where a rate limit, an auth refusal or a model error arrives -- was one of the three it
  // dropped. The line below is verbatim from `recordings/turn-failed.jsonl`, captured by pointing
  // the real CLI at a model that does not exist.
  it("reads the failure a turn reports, rather than dropping it", () => {
    const event = parseCodexEvent(
      '{"type":"turn.failed","error":{"message":"The model is not supported when using Codex with a ChatGPT account."}}',
    );
    expect(event).toEqual({
      type: "turn.failed",
      errorMessage: "The model is not supported when using Codex with a ChatGPT account.",
    });
  });

  it("reads the recorded stream of a real failed run", () => {
    const failedPath = fileURLToPath(new URL("./recordings/turn-failed.jsonl", import.meta.url));
    const events = readFileSync(failedPath, "utf8").split("\n").filter(Boolean).map(parseCodexEvent);
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  // Provider output is untrusted input: a line that cannot be used is dropped, never thrown on.
  it("drops a line that is not JSON", () => {
    expect(parseCodexEvent("Reading additional input from stdin…")).toBeNull();
  });

  it("drops a JSON line whose shape is not an event", () => {
    expect(parseCodexEvent('{"hello":"world"}')).toBeNull();
  });

  it("drops a turn.completed whose usage is missing the fields it is read for", () => {
    expect(parseCodexEvent('{"type":"turn.completed","usage":{"input_tokens":"lots"}}')).toBeNull();
  });
});
