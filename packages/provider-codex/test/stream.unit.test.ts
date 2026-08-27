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

  // R7: with write access the stream carries `item.started` events and the `command_execution` /
  // `file_change` item types, none of which the read-only milestone's parser modelled. Six of these
  // eleven lines are one of those -- so a parser that does not know them returns null for more than
  // half of a run that succeeded, and the adapter's own diagnostic then reports a healthy session as
  // one it could not read. Every line of this capture must be understood; what the adapter then does
  // with each is a separate question, answered by `item.ignored`.
  it("understands every line of a real run that edited a file and ran a command", () => {
    const path = fileURLToPath(new URL("./recordings/workspace-write.jsonl", import.meta.url));
    const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map(parseCodexEvent);
    expect(events.map((event) => event?.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.completed",
      "item.ignored",
      "item.ignored",
      "item.ignored",
      "item.ignored",
      "item.ignored",
      "item.ignored",
      "item.completed",
      "turn.completed",
    ]);
  });

  // The asymmetry that keeps "understood" from becoming "waved through": `item.started` is accepted
  // whatever it announces, because nothing is ever read out of one, while a COMPLETED item -- the
  // place the structured answer arrives -- is accepted only for the kinds a real run has shown.
  it("still drops a completed item of a kind no observed run emits", () => {
    expect(
      parseCodexEvent('{"type":"item.completed","item":{"id":"item_9","type":"web_search","query":"x"}}'),
    ).toBeNull();
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
