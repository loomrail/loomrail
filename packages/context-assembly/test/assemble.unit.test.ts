import { describe, expect, it } from "vitest";

import { assembleContextPack, renderSection } from "../src/index.js";
import { sampleSources, specWithAllSections } from "./fixtures.js";

const input = (budgetTokens: number) => ({
  sources: sampleSources(),
  spec: specWithAllSections(),
  budgetTokens,
  bytesPerToken: 4,
});

describe("context pack assembly", () => {
  it("produces a stable hash for the same input", () => {
    const first = assembleContextPack(input(10_000));
    const second = assembleContextPack(input(10_000));
    expect(first.type).toBe("ASSEMBLED");
    if (first.type !== "ASSEMBLED" || second.type !== "ASSEMBLED") throw new Error("not assembled");
    expect(first.pack.contentHash).toBe(second.pack.contentHash);
    expect(first.pack.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("drops optional sections from the end when the budget is tight", () => {
    const generous = assembleContextPack(input(10_000));
    if (generous.type !== "ASSEMBLED") throw new Error("not assembled");
    const tight = assembleContextPack(input(Math.ceil(generous.recipe.estimatedTokens / 2)));
    if (tight.type !== "ASSEMBLED") throw new Error("not assembled");

    // Truncation goes from the end: the last declared section is dropped first.
    expect(tight.recipe.omitted.map(({ id }) => id)).toContain("ACTIVITY");
    expect(tight.recipe.sections.map(({ id }) => id)).toContain("WORK_ITEM_BRIEF");
  });

  it("never drops a required section", () => {
    const result = assembleContextPack(input(1));
    expect(result.type).toBe("FLOOR_EXCEEDED");
  });

  it("records every omission with its reason", () => {
    const generous = assembleContextPack(input(10_000));
    if (generous.type !== "ASSEMBLED") throw new Error("not assembled");
    const tight = assembleContextPack(input(Math.ceil(generous.recipe.estimatedTokens / 2)));
    if (tight.type !== "ASSEMBLED") throw new Error("not assembled");
    expect(tight.recipe.omitted.length).toBeGreaterThan(0);
    expect(tight.recipe.omitted.map(({ reason }) => reason)).toEqual(
      tight.recipe.omitted.map(() => "CONTEXT_BUDGET" as const),
    );
  });

  it("records per-section provenance as a list of source refs, not a single pair", () => {
    // Spec D7 / task-3 correction: cardinality carries meaning, and DECISIONS/EVIDENCE/ACTIVITY are
    // collections. A recipe entry with a single sourceKind/sourceId/sourceVersion couldn't express that.
    const result = assembleContextPack(input(10_000));
    if (result.type !== "ASSEMBLED") throw new Error("not assembled");
    const evidenceEntry = result.recipe.sections.find(({ id }) => id === "EVIDENCE");
    expect(evidenceEntry).toBeDefined();
    expect(evidenceEntry?.sources).toEqual(
      sampleSources().evidence.map((item) => ({ kind: "EVIDENCE", id: item.id, version: item.version })),
    );
    const workflowPositionEntry = result.recipe.sections.find(({ id }) => id === "WORKFLOW_POSITION");
    // Legitimately empty: templateId/templateVersion are recorded at the recipe's top level.
    expect(workflowPositionEntry?.sources).toEqual([]);
  });

  it("accounts for separator bytes in the floor check", () => {
    // Defect fix: the pack text is produced by joining sections with "\n", which adds (n - 1) bytes
    // the naive sum-of-section-bytes never counts. Set the budget to exactly the sum of section
    // bytes, with zero room for separators, and bytesPerToken = 1 so tokens and bytes align 1:1.
    // If separators weren't counted, this would wrongly report ASSEMBLED.
    const sources = sampleSources();
    const allRequiredSpec = {
      schemaVersion: 1 as const,
      sections: specWithAllSections().sections.map((section) => ({ ...section, required: true })),
    };
    const sumOfSectionBytes = allRequiredSpec.sections.reduce(
      (sum, section) => sum + renderSection(section.id, sources).bytes,
      0,
    );

    const result = assembleContextPack({
      sources,
      spec: allRequiredSpec,
      budgetTokens: sumOfSectionBytes,
      bytesPerToken: 1,
    });

    expect(result.type).toBe("FLOOR_EXCEEDED");
    if (result.type !== "FLOOR_EXCEEDED") throw new Error("expected FLOOR_EXCEEDED");
    // The required bytes figure itself must include the (n - 1) separators, not just the raw sum.
    expect(result.requiredBytes).toBe(sumOfSectionBytes + (allRequiredSpec.sections.length - 1));
  });

  it("estimatedTokens describes the text actually produced, not the sum of its parts", () => {
    const result = assembleContextPack(input(10_000));
    if (result.type !== "ASSEMBLED") throw new Error("not assembled");
    const actualBytes = Buffer.byteLength(result.pack.text, "utf8");
    expect(result.recipe.estimatedTokens).toBe(Math.ceil(actualBytes / 4));
    // The sum of the individual sections' bytes, without separators, must NOT equal the estimate
    // once more than one section is kept -- otherwise this test could pass by accident.
    const sumOfPartBytes = result.recipe.sections.reduce((sum, section) => sum + section.bytes, 0);
    expect(result.recipe.sections.length).toBeGreaterThan(1);
    expect(actualBytes).toBeGreaterThan(sumOfPartBytes);
  });

  it("reproduces a truncated pack from its own recipe", () => {
    // This is the executable form of D7: without it, the audit claim is only a promise. A generous
    // budget drops nothing, so replaying it would replay the original spec and prove little -- the
    // first assembly here must actually drop at least one section.
    const generous = assembleContextPack(input(10_000));
    if (generous.type !== "ASSEMBLED") throw new Error("not assembled");
    const tightBudgetTokens = Math.ceil(generous.recipe.estimatedTokens / 2);
    const first = assembleContextPack(input(tightBudgetTokens));
    if (first.type !== "ASSEMBLED") throw new Error("not assembled");

    expect(first.recipe.omitted.length).toBeGreaterThan(0);
    expect(first.recipe.sections.length).toBeLessThan(specWithAllSections().sections.length);

    const replayed = assembleContextPack({
      ...input(10_000),
      spec: {
        schemaVersion: 1,
        sections: first.recipe.sections.map(({ id }, index) => ({
          id,
          ordinal: index,
          required: true,
        })),
      },
    });
    if (replayed.type !== "ASSEMBLED") throw new Error("not assembled");
    expect(replayed.pack.contentHash).toBe(first.pack.contentHash);
  });
});
