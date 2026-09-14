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
  message: z.object({ content: z.array(z.unknown()) }),
});

const userLineSchema = z.object({
  type: z.literal("user"),
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

  for (const raw of parsed.data.message.content) {
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
      const detail = boundActivityText(text.data.text, 2_000);
      if (detail.text === null) continue;
      entries.push({
        actionKey: `text-${entries.length.toString()}`,
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
