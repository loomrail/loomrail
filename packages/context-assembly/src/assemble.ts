import { createHash } from "node:crypto";

import type { ContextPack, ContextPackSpec, ContextSectionId } from "@loomrail/contracts";

import { renderSection } from "./render.js";
import type { ContextSourceRef, ContextSources, RenderedSection } from "./render.js";

export type AssembleInput = {
  sources: ContextSources;
  spec: ContextPackSpec;
  budgetTokens: number;
  bytesPerToken: number;
};

// Per-section provenance is a list, not a single { kind, id, version } pair: cardinality carries
// meaning (0 = derived, 1 = one durable entity, N = a collection), and DECISIONS/EVIDENCE/ACTIVITY
// are collections. Identifiers and timestamps for the persisted recipe are added by the
// persistence layer (a later task) -- this is only the draft the assembler itself knows.
export type ContextPackRecipeDraft = {
  sections: readonly { id: ContextSectionId; sources: readonly ContextSourceRef[]; bytes: number }[];
  omitted: readonly { id: ContextSectionId; reason: "CONTEXT_BUDGET" }[];
  estimatedTokens: number;
  budgetTokens: number;
};

export type AssembleResult =
  | { type: "ASSEMBLED"; pack: ContextPack; recipe: ContextPackRecipeDraft }
  | { type: "FLOOR_EXCEEDED"; requiredBytes: number; budgetBytes: number };

const budgetBytesOf = (budgetTokens: number, bytesPerToken: number): number => budgetTokens * bytesPerToken;

// The `\n` join between sections adds (n - 1) bytes that the sum of individual section byte
// counts never includes. Any budget comparison has to account for that, or a pack can silently
// exceed its budget by the separator count.
const separatorBytes = (sectionCount: number): number => Math.max(0, sectionCount - 1);

const joinedBytes = (parts: readonly RenderedSection[]): number =>
  parts.reduce((sum, part) => sum + part.bytes, 0) + separatorBytes(parts.length);

export const assembleContextPack = (input: AssembleInput): AssembleResult => {
  const orderedSections = [...input.spec.sections].sort((a, b) => a.ordinal - b.ordinal);
  const rendered = orderedSections.map((section) => ({
    section,
    rendered: renderSection(section.id, input.sources),
  }));

  const budgetBytes = budgetBytesOf(input.budgetTokens, input.bytesPerToken);

  const requiredBytes = joinedBytes(
    rendered.filter(({ section }) => section.required).map(({ rendered: part }) => part),
  );

  if (requiredBytes > budgetBytes) {
    return { type: "FLOOR_EXCEEDED", requiredBytes, budgetBytes };
  }

  // Truncation goes from the end of the declared order backwards: the last declared, non-required
  // section is dropped first, skipping any required section it passes over.
  const kept = [...rendered];
  const omitted: { id: ContextSectionId; reason: "CONTEXT_BUDGET" }[] = [];

  for (
    let index = kept.length - 1;
    index >= 0 && joinedBytes(kept.map(({ rendered: part }) => part)) > budgetBytes;
    index -= 1
  ) {
    const candidate = kept[index];
    if (candidate === undefined || candidate.section.required) continue;
    omitted.unshift({ id: candidate.section.id, reason: "CONTEXT_BUDGET" });
    kept.splice(index, 1);
  }

  const text = kept.map(({ rendered: part }) => part.text).join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  const contentHash = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

  const recipe: ContextPackRecipeDraft = {
    sections: kept.map(({ section, rendered: part }) => ({
      id: section.id,
      sources: part.sources,
      bytes: part.bytes,
    })),
    omitted,
    // Describes the text that was actually produced (including separators), not the sum of the
    // kept sections' individual byte counts.
    estimatedTokens: Math.ceil(bytes / input.bytesPerToken),
    budgetTokens: input.budgetTokens,
  };

  return { type: "ASSEMBLED", pack: { schemaVersion: 1, text, contentHash }, recipe };
};
