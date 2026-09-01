import { describe, expect, it } from "vitest";

import type { AttentionItem } from "@loomrail/contracts";

import { groupAttentionItems, nextAttentionIndex } from "./attentionView";

const item = (id: string, section: AttentionItem["section"]): AttentionItem =>
  ({
    id,
    section,
  }) as AttentionItem;

describe("Attention Inbox view model", () => {
  it("keeps the domain section order and removes empty groups", () => {
    expect(
      groupAttentionItems([
        item("question", "QUESTIONS"),
        item("blocking", "BLOCKING_NOW"),
        item("approval", "APPROVALS"),
      ]).map(({ section, items }) => ({ section, ids: items.map(({ id }) => id) })),
    ).toEqual([
      { section: "BLOCKING_NOW", ids: ["blocking"] },
      { section: "APPROVALS", ids: ["approval"] },
      { section: "QUESTIONS", ids: ["question"] },
    ]);
  });

  it("moves keyboard selection without escaping the bounded list", () => {
    expect(nextAttentionIndex(0, "ArrowUp", 3)).toBe(0);
    expect(nextAttentionIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextAttentionIndex(1, "End", 3)).toBe(2);
    expect(nextAttentionIndex(2, "ArrowDown", 3)).toBe(2);
    expect(nextAttentionIndex(2, "Home", 3)).toBe(0);
    expect(nextAttentionIndex(0, "Home", 0)).toBe(-1);
  });
});
