import type { ProviderActivityEntry } from "@loomrail/contracts";
import { z } from "zod";

import { boundActivityText } from "@loomrail/provider-core";

// Only the fields an entry is built from. Not `.strict()`: the real CLI carries more on these
// items, and a field added upstream must not turn a readable action into an unreadable line.
//
// `exit_code` is `.nullish()`, not `.optional()`: a real `item.started` line for a still-running
// command carries an explicit `"exit_code": null` (see recordings/workspace-write.jsonl), not a
// missing key. `.optional()` alone rejects that line's `null`, which would silently drop the start
// half of every command pair and break the one-key-two-reports pairing this parser exists for.
const commandItemSchema = z.object({
  id: z.string(),
  type: z.literal("command_execution"),
  command: z.string(),
  status: z.string().optional(),
  exit_code: z.number().int().nullish(),
});

const fileChangeItemSchema = z.object({
  id: z.string(),
  type: z.literal("file_change"),
  changes: z.array(z.object({ path: z.string(), kind: z.string().optional() })).optional(),
});

const agentMessageItemSchema = z.object({
  id: z.string(),
  type: z.literal("agent_message"),
  text: z.string(),
});

const activityLineSchema = z.object({
  type: z.enum(["item.started", "item.completed"]),
  item: z.union([commandItemSchema, fileChangeItemSchema, agentMessageItemSchema]),
});

const parseJsonLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Builds diagnostic activity entries from one line of `codex exec`'s JSONL stream.
 *
 * Deliberately separate from `parseCodexEvent`: that parser decides the session's outcome, and
 * widening it to also describe actions would make one failure mode -- an unreadable action -- able
 * to change what Loomrail believes about the result. Returns an empty array for anything it does
 * not understand, exactly as the event parser returns null.
 */
export const parseCodexActivity = (line: string): readonly ProviderActivityEntry[] => {
  const parsed = activityLineSchema.safeParse(parseJsonLine(line));
  if (!parsed.success) return [];
  const { type, item } = parsed.data;
  const terminal = type === "item.completed";

  switch (item.type) {
    case "command_execution": {
      const label = boundActivityText(item.command, 500);
      return [
        {
          actionKey: item.id,
          kind: "TOOL_CALL",
          label: label.text,
          detail: null,
          status: terminal
            ? item.exit_code === undefined || item.exit_code === null
              ? (item.status ?? null)
              : `exit ${item.exit_code.toString()}`
            : null,
          terminal,
          truncated: label.truncated,
        },
      ];
    }
    case "file_change": {
      // Paths only. The content of a change is never read here: `git diff` against the worktree is
      // Loomrail's account of what changed, and a second, weaker source invites a reader to trust
      // the provider's report of itself over the disk.
      if (!terminal) return [];
      const paths = (item.changes ?? []).map((change) => change.path);
      if (paths.length === 0) return [];
      const label = boundActivityText(paths[0] ?? "", 500);
      const detail = paths.length > 1 ? boundActivityText(paths.slice(1).join(", "), 2_000) : null;
      return [
        {
          actionKey: item.id,
          kind: "FILE_CHANGE",
          label: label.text,
          detail: detail?.text ?? null,
          status: null,
          terminal: true,
          truncated: label.truncated || (detail?.truncated ?? false),
        },
      ];
    }
    case "agent_message": {
      if (!terminal) return [];
      const detail = boundActivityText(item.text, 2_000);
      if (detail.text === null) return [];
      return [
        {
          actionKey: item.id,
          kind: "AGENT_TEXT",
          label: null,
          detail: detail.text,
          status: null,
          terminal: true,
          truncated: detail.truncated,
        },
      ];
    }
  }
};
