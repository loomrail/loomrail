import { describe, expect, it } from "vitest";

import { boundActivityText } from "../src/activity-text.js";

describe("boundActivityText", () => {
  it("keeps a short value and reports no truncation", () => {
    expect(boundActivityText("pnpm test", 500)).toEqual({ text: "pnpm test", truncated: false });
  });

  it("cuts a long value and says that it did", () => {
    const result = boundActivityText("x".repeat(600), 500);
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBeLessThanOrEqual(500);
  });

  it("returns null for a value that is empty once trimmed", () => {
    expect(boundActivityText("   \n  ", 500)).toEqual({ text: null, truncated: false });
  });

  it("does not split a surrogate pair", () => {
    const result = boundActivityText("😀".repeat(400), 500);
    expect(result.text === null || Array.from(result.text).every((ch) => ch.codePointAt(0) !== 0xfffd)).toBe(true);
  });
});
