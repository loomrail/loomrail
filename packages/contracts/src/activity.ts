import { z } from "zod";

/**
 * What a provider adapter reports about one action it took.
 *
 * Bounded and `.strict()` on purpose: this crosses the boundary from untrusted process output into
 * Loomrail, so a field added later fails to parse rather than riding along. It carries no
 * authority -- `git diff` and measured verification remain the source of truth about what changed.
 */
export const providerActivityKindSchema = z.enum([
  "TOOL_CALL",
  "AGENT_TEXT",
  "FILE_CHANGE",
  "PROVIDER_ERROR",
]);

export const providerActivityEntrySchema = z
  .object({
    // The provider's own identifier for the action, so a terminal report updates the record the
    // starting one created instead of appending a second row for the same action.
    actionKey: z.string().trim().min(1).max(200),
    kind: providerActivityKindSchema,
    label: z.string().trim().min(1).max(500).nullable(),
    detail: z.string().trim().min(1).max(2_000).nullable(),
    status: z.string().trim().min(1).max(120).nullable(),
    terminal: z.boolean(),
    // True when any text on this entry was cut to fit its bound. Silent truncation would let a
    // reader mistake a fragment for the whole thing.
    truncated: z.boolean(),
  })
  .strict();

export type ProviderActivityEntry = z.infer<typeof providerActivityEntrySchema>;

/**
 * Where an entry came from, and therefore how much it is worth.
 *
 * `DAEMON_AUDITED` passed through the daemon-owned gateway and is recorded in append-only
 * `workspace_tool_calls`. `PROVIDER_REPORTED` is the provider's account of itself: unverified,
 * prunable, and never evidence. Computed by the reader from the source table, never accepted from
 * a provider.
 */
export const activityOriginSchema = z.enum(["DAEMON_AUDITED", "PROVIDER_REPORTED"]);

export const agentRunActivityEntrySchema = z
  .object({
    id: z.string().min(1),
    // Monotonic within a run but NOT dense: eviction leaves gaps, and a reader that treats a
    // missing number as a defect would report every long run as broken.
    seq: z.number().int().positive(),
    at: z.string().datetime(),
    origin: activityOriginSchema,
    provider: z.enum(["CODEX", "CLAUDE_CODE"]),
    kind: providerActivityKindSchema,
    label: z.string().max(500).nullable(),
    detail: z.string().max(2_000).nullable(),
    status: z.string().max(120).nullable(),
    truncated: z.boolean(),
  })
  .strict();

export type AgentRunActivityEntry = z.infer<typeof agentRunActivityEntrySchema>;

export const agentRunActivityPageSchema = z
  .object({
    entries: z.array(agentRunActivityEntrySchema).max(200),
    // Opaque: the client hands it back and never parses it. The merged feed has two sources, so a
    // single table's row number cannot address a position in it.
    nextCursor: z.string().min(1).nullable(),
    omittedCount: z.number().int().nonnegative(),
    degraded: z.boolean(),
    // True when the cursor named a pruned position and the page restarts from the oldest entry
    // still held, so the client can say so instead of showing a silent hole.
    gap: z.boolean(),
  })
  .strict();

export type AgentRunActivityPage = z.infer<typeof agentRunActivityPageSchema>;
