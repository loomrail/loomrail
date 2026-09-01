import type { AttentionItem, AttentionSection } from "@loomrail/contracts";

export const attentionSectionOrder: readonly AttentionSection[] = [
  "BLOCKING_NOW",
  "APPROVALS",
  "QUESTIONS",
  "MANUAL_ACTIONS",
  "SOON",
];

export const groupAttentionItems = (
  items: readonly AttentionItem[],
): readonly { section: AttentionSection; items: readonly AttentionItem[] }[] =>
  attentionSectionOrder.flatMap((section) => {
    const sectionItems = items.filter((item) => item.section === section);
    return sectionItems.length === 0 ? [] : [{ section, items: sectionItems }];
  });

export type AttentionNavigationKey = "ArrowDown" | "ArrowUp" | "End" | "Home";

export const nextAttentionIndex = (
  currentIndex: number,
  key: AttentionNavigationKey,
  itemCount: number,
): number => {
  if (itemCount <= 0) return -1;
  switch (key) {
    case "ArrowDown":
      return Math.min(itemCount - 1, currentIndex + 1);
    case "ArrowUp":
      return Math.max(0, currentIndex - 1);
    case "Home":
      return 0;
    case "End":
      return itemCount - 1;
  }
};
