import { describe, expect, it } from "vitest";

import { decideCorrectionBudget } from "../src/correction-budget.js";

describe("shared correction budget", () => {
  it.each([
    [
      { automaticUsed: 0, totalUsed: 0 },
      { action: "START_AUTOMATIC", position: 1 },
    ],
    [
      { automaticUsed: 1, totalUsed: 1 },
      { action: "START_AUTOMATIC", position: 2 },
    ],
    [
      { automaticUsed: 2, totalUsed: 2 },
      { action: "WAIT_FOR_OWNER", position: 3 },
    ],
    [{ automaticUsed: 2, totalUsed: 3 }, { action: "EXHAUSTED" }],
  ] as const)("selects the bounded branch for %o", (usage, expected) => {
    expect(decideCorrectionBudget(usage)).toEqual(expected);
  });

  it.each([
    { automaticUsed: -1, totalUsed: 0 },
    { automaticUsed: 2, totalUsed: 1 },
    { automaticUsed: 0, totalUsed: 1 },
    { automaticUsed: 1, totalUsed: 2 },
    { automaticUsed: 3, totalUsed: 3 },
    { automaticUsed: 2, totalUsed: 4 },
  ])("rejects contradictory or unbounded usage %o", (usage) => {
    expect(() => decideCorrectionBudget(usage)).toThrow(expect.objectContaining({ code: "INVALID_USAGE" }));
  });
});
