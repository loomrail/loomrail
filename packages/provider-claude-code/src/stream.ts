import { z } from "zod";

/**
 * One line of the `claude` CLI's JSONL event stream, translated into the shape the rest of
 * Loomrail expects. The wire format is snake_case; that stops here and nowhere else, so no
 * consumer of `ClaudeEvent` has to know what Claude Code's stream looks like.
 *
 * Only the terminal `result` event is exposed. Every `system` event -- the CLI's own session-init
 * line and the owner's `hook_started` / `hook_response` / `hook_progress` events -- is dropped by
 * `parseClaudeEvent` before it ever reaches a caller: hook events carry `stdout`/`stderr` captured
 * on the owner's machine, and SD-003 forbids Loomrail recording that text.
 */
export type ClaudeEvent = {
  type: "result";
  ok: boolean;
  text: string;
  // Claude Code may keep the schema-constrained value here even when `result` is only display
  // prose. This stays `unknown` until the stage-specific provider contract validates it.
  structuredOutput?: unknown;
  costUsd: number;
  // Normalized total input: ordinary + cache creation + cache read. Claude's wire splits these
  // while Codex reports total input with cached input as a subdivision; normalizing here keeps the
  // provider-neutral ProviderUsage budget quantity comparable and prevents cache-heavy sessions
  // from being charged as though only their tiny uncached tail ran.
  inputTokens: number;
  outputTokens: number;
  // Only `cache_read_input_tokens` (the wire's own name for tokens served from a previous cache
  // entry) maps to this -- it is what "cached input tokens" means in the everyday sense: input
  // the CLI did not have to reprocess. `cache_creation_input_tokens` (tokens spent *writing* a new
  // cache entry) is a distinct, separately-billed quantity that is not "cached input" in that
  // sense. Both are included in normalized `inputTokens`; this field remains the cache-read
  // subdivision the wire reports, not another quantity the budget sums.
  cachedInputTokens: number;
};

const rawSystemEventSchema = z.object({
  type: z.literal("system"),
  subtype: z.string(),
});

// `subtype` is read here only so the mutation proof for "branch on subtype instead of is_error"
// (see the test suite) has something to branch on -- reconnaissance on the real CLI found a
// `result` event reporting an authentication failure with `subtype: "success"` and
// `is_error: true`. `ok` below is read from `is_error`, never from `subtype`.
const rawResultEventSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number(),
  // Not `.strict()`: the real `usage` object also carries `server_tool_use`, `service_tier`, and
  // more. Cache creation is read because it is a separately-billed input class and therefore part
  // of the provider-neutral normalized input total.
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number(),
    cache_creation_input_tokens: z.number().default(0),
  }),
});

const rawClaudeLineSchema = z.discriminatedUnion("type", [rawSystemEventSchema, rawResultEventSchema]);

// Turns a line of text into the value it would parse to as JSON, or `undefined` if it does not
// parse. Folded into the same schema pipeline as the shape check below (see `claudeLineSchema`)
// so that "not JSON" and "not a known event" are both surfaced through the one `safeParse` call --
// never a `try`/`catch` of their own that a caller could route around.
const parseJsonLine = (line: unknown): unknown => {
  if (typeof line !== "string") return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

const claudeLineSchema = z.preprocess(parseJsonLine, rawClaudeLineSchema);

/**
 * Parses one line of the `claude` CLI's JSONL stream.
 *
 * Claude's output is untrusted process input, not a contract Loomrail controls: a line that is
 * not JSON, JSON that does not match a known event shape, or a `system` event, is dropped by
 * returning `null` rather than thrown on -- a parser that throws would take the whole session
 * down, because the caller is a stream handler with no per-line recovery of its own.
 */
export const parseClaudeEvent = (line: string): ClaudeEvent | null => {
  const parsed = claudeLineSchema.safeParse(line);
  if (!parsed.success) return null;
  const raw = parsed.data;
  switch (raw.type) {
    case "system":
      // Covers both the CLI's own `init` line and the owner's hook events -- dropping every
      // system event, not only the hook-named ones, keeps hook stdout/stderr out of Loomrail's
      // recorded stream even if a future hook subtype this parser has not seen carries the same.
      return null;
    case "result":
      return {
        type: "result",
        ok: !raw.is_error,
        text: raw.result,
        ...(raw.structured_output === undefined ? {} : { structuredOutput: raw.structured_output }),
        costUsd: raw.total_cost_usd,
        inputTokens:
          raw.usage.input_tokens + raw.usage.cache_creation_input_tokens + raw.usage.cache_read_input_tokens,
        outputTokens: raw.usage.output_tokens,
        cachedInputTokens: raw.usage.cache_read_input_tokens,
      };
  }
};
