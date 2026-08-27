import { z } from "zod";

/**
 * One line of `codex exec`'s JSONL event stream, translated into the shape the rest of Loomrail
 * expects. The wire format is snake_case; that stops here and nowhere else, so no consumer of
 * `CodexEvent` has to know what Codex's stream looks like.
 */
export type CodexEvent =
  | { type: "thread.started"; threadId: string }
  | { type: "turn.started" }
  | { type: "item.completed"; item: { id: string; type: "agent_message"; text: string } }
  // The CLI's own report that the turn it was running failed -- a rate limit, an auth refusal, a
  // model error. Captured from the real CLI (see recordings/turn-failed.jsonl): the diagnostic
  // arrives as `error.message`, and is untrusted process output like every other field here.
  | { type: "turn.failed"; errorMessage: string }
  | {
      type: "turn.completed";
      usage: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      };
    };

const rawThreadStartedSchema = z.object({
  type: z.literal("thread.started"),
  thread_id: z.string(),
});

const rawTurnStartedSchema = z.object({
  type: z.literal("turn.started"),
});

const rawItemCompletedSchema = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    id: z.string(),
    type: z.literal("agent_message"),
    text: z.string(),
  }),
});

const rawTurnFailedSchema = z.object({
  type: z.literal("turn.failed"),
  error: z.object({ message: z.string() }),
});

const rawTurnCompletedSchema = z.object({
  type: z.literal("turn.completed"),
  usage: z.object({
    input_tokens: z.number(),
    cached_input_tokens: z.number(),
    output_tokens: z.number(),
    reasoning_output_tokens: z.number(),
  }),
});

const rawCodexEventSchema = z.discriminatedUnion("type", [
  rawThreadStartedSchema,
  rawTurnStartedSchema,
  rawItemCompletedSchema,
  rawTurnFailedSchema,
  rawTurnCompletedSchema,
]);

// Turns a line of text into the value it would parse to as JSON, or `undefined` if it does not
// parse. Folded into the same schema pipeline as the shape check below (see `codexLineSchema`) so
// that "not JSON" and "not a known event" are both surfaced through the one `safeParse` call --
// never a `try`/`catch` of their own that a caller could route around.
const parseJsonLine = (line: unknown): unknown => {
  if (typeof line !== "string") return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

const codexLineSchema = z.preprocess(parseJsonLine, rawCodexEventSchema);

const toCodexEvent = (raw: z.infer<typeof rawCodexEventSchema>): CodexEvent => {
  switch (raw.type) {
    case "thread.started":
      return { type: "thread.started", threadId: raw.thread_id };
    case "turn.started":
      return { type: "turn.started" };
    case "item.completed":
      return {
        type: "item.completed",
        item: { id: raw.item.id, type: raw.item.type, text: raw.item.text },
      };
    case "turn.failed":
      return { type: "turn.failed", errorMessage: raw.error.message };
    case "turn.completed":
      return {
        type: "turn.completed",
        usage: {
          inputTokens: raw.usage.input_tokens,
          cachedInputTokens: raw.usage.cached_input_tokens,
          outputTokens: raw.usage.output_tokens,
          reasoningOutputTokens: raw.usage.reasoning_output_tokens,
        },
      };
  }
};

/**
 * Parses one line of `codex exec`'s JSONL stream.
 *
 * Codex's output is untrusted process input, not a contract Loomrail controls: a line that is not
 * JSON, or JSON that does not match a known event shape, is dropped by returning `null` rather
 * than thrown on -- a parser that throws would take the whole session down, because the caller is
 * a stream handler with no per-line recovery of its own.
 */
export const parseCodexEvent = (line: string): CodexEvent | null => {
  const result = codexLineSchema.safeParse(line);
  return result.success ? toCodexEvent(result.data) : null;
};
