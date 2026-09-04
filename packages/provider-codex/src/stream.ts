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
  // A line this adapter UNDERSTANDS and deliberately takes nothing from -- as opposed to one it
  // could not read, which `parseCodexEvent` still reports by returning null. A session with write
  // access emits these constantly: an `item.started` announcing each item, and `command_execution`
  // / `file_change` items for the work itself. Six of the eleven lines of a real, successful
  // workspace-write run are this (see recordings/workspace-write.jsonl), so folding them in with
  // the unreadable ones left the adapter's own diagnostic reporting that a healthy session had
  // failed to understand most of its stream -- a counter that fires on every successful run is not
  // a signal.
  //
  // Carries no payload on purpose. Loomrail's account of what a session changed comes from `git
  // diff` against the worktree, which is ground truth; modelling `file_change.changes[]` here would
  // stand up a second, weaker source for a fact that already has a strong one, and invite a
  // consumer to trust the provider's report of itself over the disk. The one bit this event
  // carries -- "understood" -- is the only bit anything needs.
  | { type: "item.ignored" }
  // The CLI's own report that the turn it was running failed -- a rate limit, an auth refusal, a
  // model error. Captured from the real CLI (see recordings/turn-failed.jsonl): the diagnostic
  // arrives as `error.message`, and is untrusted process output like every other field here.
  | { type: "turn.failed"; errorMessage: string; rateLimited: boolean }
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

// `item.started` is matched on its top-level type alone, with no claim about WHICH item it
// announces: nothing is ever read out of a started event, so what it names cannot change how this
// adapter behaves. `item.completed` is the opposite -- it is where the structured answer arrives --
// so there the item type is enumerated, and a completed item of a kind never observed from the real
// CLI stays unreadable rather than being waved through as understood.
const rawItemStartedSchema = z.object({
  type: z.literal("item.started"),
  item: z.object({ id: z.string() }),
});

const rawItemCompletedSchema = z.object({
  type: z.literal("item.completed"),
  item: z.discriminatedUnion("type", [
    z.object({
      id: z.string(),
      type: z.literal("agent_message"),
      text: z.string(),
    }),
    // Recorded from a real workspace-write run. Their contents are not modelled -- see the
    // `item.ignored` comment on `CodexEvent` for why the disk, not the provider, is the source of
    // truth about what changed.
    z.object({ id: z.string(), type: z.literal("command_execution") }),
    z.object({ id: z.string(), type: z.literal("file_change") }),
  ]),
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
  rawItemStartedSchema,
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

const structuredErrorStatusSchema = z.object({ status: z.literal(429) });

// `turn.failed.error.message` is sometimes a JSON-encoded API error. Only an exact structured 429
// is authoritative; human-readable text containing "rate limit" is untrusted prose and must not
// create a typed system reason.
const isStructuredRateLimit = (message: string): boolean => {
  try {
    return structuredErrorStatusSchema.safeParse(JSON.parse(message) as unknown).success;
  } catch {
    return false;
  }
};

const toCodexEvent = (raw: z.infer<typeof rawCodexEventSchema>): CodexEvent => {
  switch (raw.type) {
    case "thread.started":
      return { type: "thread.started", threadId: raw.thread_id };
    case "turn.started":
      return { type: "turn.started" };
    case "item.started":
      return { type: "item.ignored" };
    case "item.completed":
      return raw.item.type === "agent_message"
        ? {
            type: "item.completed",
            item: { id: raw.item.id, type: raw.item.type, text: raw.item.text },
          }
        : { type: "item.ignored" };
    case "turn.failed":
      return {
        type: "turn.failed",
        errorMessage: raw.error.message,
        rateLimited: isStructuredRateLimit(raw.error.message),
      };
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

/**
 * The name of the terminal turn event, as it appears on the wire.
 *
 * Here so that a diagnosis can NAME the signal it waited for and never got (see
 * `TERMINAL_TURN_EVENT_MISSING` in `@loomrail/provider-core`) without a second copy of the string
 * living in the adapter, where the two would drift the first time Codex renamed it -- and the
 * message that exists to explain a rename would then be the one thing still saying the old name.
 *
 * `satisfies` rather than a bare string: if this event is ever renamed in `CodexEvent` above, this
 * line stops compiling instead of quietly naming an event nothing waits for any more.
 */
export const TERMINAL_TURN_EVENT = "turn.completed" satisfies CodexEvent["type"];
