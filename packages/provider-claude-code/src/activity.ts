import type { ProviderActivityEntry } from "@loomrail/contracts";
import { boundActivityText } from "@loomrail/provider-core";
import { z } from "zod";

// Which single argument identifies the target of a call, per tool. Read as a closed lookup rather
// than by serializing `input`: the argument object is provider-controlled and may carry file
// contents, so taking one named string keeps content out by construction, not by filtering.
const TOOL_TARGET_FIELDS: Readonly<Record<string, string>> = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Glob: "pattern",
  Grep: "pattern",
};

const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});

const assistantLineSchema = z.object({
  type: z.literal("assistant"),
  // Read through the schema, not assumed: see `lineId` below for how these key AGENT_TEXT entries.
  uuid: z.string().optional(),
  message: z.object({ id: z.string().optional(), content: z.array(z.unknown()) }),
});

const userLineSchema = z.object({
  type: z.literal("user"),
  uuid: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});

const activityLineSchema = z.union([assistantLineSchema, userLineSchema]);

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

const targetOf = (name: string, input: Record<string, unknown> | undefined): string | null => {
  const field = TOOL_TARGET_FIELDS[name];
  if (field === undefined || input === undefined) return null;
  const value = input[field];
  return typeof value === "string" ? value : null;
};

// An empty string is not a usable identifier; treat it the same as the field being absent rather
// than let it flow into a key.
const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const MAX_ACTION_KEY_LENGTH = 200;

/**
 * Builds diagnostic activity entries from one line of the `claude` CLI's stream-json output.
 *
 * `system` events -- the CLI's own init line and the owner's hook events -- are not in the union
 * this parser reads, so hook stdout/stderr cannot reach an entry even through a subtype nobody has
 * seen yet. That is the same rule `parseClaudeEvent` enforces for the result path (SD-003).
 */
export const parseClaudeActivity = (line: string): readonly ProviderActivityEntry[] => {
  const parsed = activityLineSchema.safeParse(parseJsonLine(line));
  if (!parsed.success) return [];
  const entries: ProviderActivityEntry[] = [];

  // AGENT_TEXT entries key off this, not off their position in the array: the daemon upserts on
  // `UNIQUE (provider_session_id, action_key)`, so a key that repeats across lines -- a plain
  // block-count index does, because every line restarts its count at 0 -- silently merges two
  // different messages into one stored row instead of producing two. `uuid` is unique per line in
  // the real stream; `message.id` (assistant lines only) is the fallback for a line that omits it.
  // If neither is present there is no way to key the text safely, so it is dropped below rather
  // than merged under a guess.
  const lineId =
    nonEmpty(parsed.data.uuid) ??
    (parsed.data.type === "assistant" ? nonEmpty(parsed.data.message.id) : undefined);

  for (const [blockIndex, raw] of parsed.data.message.content.entries()) {
    const toolUse = toolUseBlockSchema.safeParse(raw);
    if (toolUse.success) {
      const label = boundActivityText(toolUse.data.name, 500);
      if (label.text === null) continue;
      const target = targetOf(toolUse.data.name, toolUse.data.input);
      const detail = target === null ? null : boundActivityText(target, 2_000);
      entries.push({
        actionKey: toolUse.data.id,
        kind: "TOOL_CALL",
        label: label.text,
        detail: detail?.text ?? null,
        status: null,
        terminal: false,
        truncated: label.truncated || (detail?.truncated ?? false),
      });
      continue;
    }

    const toolResult = toolResultBlockSchema.safeParse(raw);
    if (toolResult.success) {
      // Only the verdict. `content` is the tool's output and may be a file the agent read.
      entries.push({
        actionKey: toolResult.data.tool_use_id,
        kind: "TOOL_CALL",
        label: null,
        detail: null,
        status: toolResult.data.is_error === true ? "error" : "ok",
        terminal: true,
        truncated: false,
      });
      continue;
    }

    const text = textBlockSchema.safeParse(raw);
    if (text.success) {
      if (lineId === undefined) continue;
      const detail = boundActivityText(text.data.text, 2_000);
      if (detail.text === null) continue;
      const actionKey = `${lineId}-text-${blockIndex.toString()}`;
      // `lineId` falls back to the provider's own `message.id`, which is process output Loomrail
      // does not bound -- a pathological one could blow the contract's 200-char limit. Truncating
      // it would risk re-creating the same collision this key exists to prevent, so an over-length
      // key is dropped rather than cut down.
      if (actionKey.length > MAX_ACTION_KEY_LENGTH) continue;
      entries.push({
        actionKey,
        kind: "AGENT_TEXT",
        label: null,
        detail: detail.text,
        status: null,
        terminal: true,
        truncated: detail.truncated,
      });
    }
  }

  return entries;
};
