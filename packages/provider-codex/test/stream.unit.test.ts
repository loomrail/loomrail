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
