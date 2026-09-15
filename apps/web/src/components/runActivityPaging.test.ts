import { describe, expect, it } from "vitest";
import type { AgentRunActivityPage } from "@loomrail/contracts";

import { anyPageHasGap } from "./runActivityPaging";

// Fix round 1: `gap` is per-page (true only on the page whose cursor landed on pruned data), not
// run-level like `degraded`/`omittedCount`. Reading only the most recently loaded page's `gap`
// made an announced gap vanish the moment the owner loaded one more page -- the exact silent hole
// the flag exists to prevent. This is the one-line rule that fixes it, tested on its own.

const page = (overrides: Partial<AgentRunActivityPage> = {}): AgentRunActivityPage => ({
  entries: [],
  nextCursor: null,
  omittedCount: 0,
  degraded: false,
  gap: false,
  ...overrides,
});

describe("anyPageHasGap", () => {
  it("is false with no pages loaded", () => {
    expect(anyPageHasGap([])).toBe(false);
  });

  it("is false when no loaded page reported a gap", () => {
    expect(anyPageHasGap([page(), page(), page()])).toBe(false);
  });

  it("stays true once any loaded page reported a gap, even pages fetched after it", () => {
    // Page 1: no gap (a first page is never a gap). Page 2: the cursor from page 1 landed on
    // pruned data, so this page restarted from the window start and is flagged. Page 3: fetched
    // afterwards, itself not a gap -- but the announcement must not disappear because of it.
    expect(anyPageHasGap([page({ gap: false }), page({ gap: true }), page({ gap: false })])).toBe(true);
  });
});
