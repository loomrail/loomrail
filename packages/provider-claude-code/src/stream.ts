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
export type ClaudeEvent = { type: "result"; ok: boolean; text: string; costUsd: number };

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
  total_cost_usd: z.number(),
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
      return { type: "result", ok: !raw.is_error, text: raw.result, costUsd: raw.total_cost_usd };
  }
};
