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

  it("cuts on a code-point boundary when the bound falls inside a surrogate pair", () => {
    // Every character here is a 2-unit surrogate pair, and 301 is an odd code-point bound, so a
    // naive `slice(0, maxChars)` over UTF-16 units lands inside the 151st pair instead of after the
    // 301st code point. A boundary-safe cut must still land on a whole code point: exactly 301 of
    // them, none of them a stray surrogate half.
    const result = boundActivityText("😀".repeat(400), 301);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toBeNull();
    const text = result.text ?? "";
    expect(Array.from(text)).toHaveLength(301);
    // A UTF-16 slice through the middle of a pair leaves a lone (unpaired) surrogate behind -- not
    // U+FFFD, which JS string slicing never produces. This matches a low surrogate with no high
    // surrogate before it, or a high surrogate with no low surrogate after it.
    const loneSurrogate = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;
    expect(loneSurrogate.test(text)).toBe(false);
  });
});
