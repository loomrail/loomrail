import { describe, expect, it } from "vitest";
import type { AgentRunActivityPage, WorkItem } from "@loomrail/contracts";

import { anyPageHasGap, hasStartedWorkflow } from "./runActivityPaging";

// Fix round 1: `gap` is per-page -- set on the page that ran into one of its two causes (a cursor
// naming a position no longer held, or a source returning its whole read-ahead onto a page that
// still ended) -- not task-level like `degraded`/`omittedCount`. Reading only the most recently
// loaded page's `gap` made an announced gap vanish the moment the owner loaded one more page -- the
// exact silent hole the flag exists to prevent. This is the one-line rule that fixes it, tested on
// its own.

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
    // Page 1: no gap (a first page can trip neither cause). Page 2: flagged -- the cursor from page
    // 1 landed on a position no longer held, or the page ended on a source's full read-ahead.
    // Page 3: fetched afterwards, itself not a gap -- but the announcement must not disappear
    // because of it.
    expect(anyPageHasGap([page({ gap: false }), page({ gap: true }), page({ gap: false })])).toBe(true);
  });
});

// Fix round 1 on Task 3: this predicate is the whole of RunActivitySection's "never started"
// gate (`if (!hasStartedWorkflow(item)) return null;`), pulled out so the boolean logic itself has
// a test. The container that wires it in is covered too, by fix round 2 on Task 3: the two
// `describe("RunActivitySection")` cases in RunActivitySection.test.tsx render the real container
// through a hoisted `vi.mock("../workspace")`, so neither half of the gate rests on a live e2e run
// any more.
describe("hasStartedWorkflow", () => {
  const item = (currentStage: WorkItem["currentStage"]): Pick<WorkItem, "currentStage"> => ({
    currentStage,
  });

  it("is false for a WorkItem that has never started its pipeline", () => {
    expect(hasStartedWorkflow(item(null))).toBe(false);
  });

  it("is true once currentStage is set, including a stage this WorkItem has since moved past", () => {
    // The gate does not care WHICH stage -- only that the pipeline has started at all -- so a
    // fixture with a non-initial stage ("QA", not "DISCOVERY") proves this isn't accidentally
    // checking for one specific stage value.
    expect(hasStartedWorkflow(item("QA"))).toBe(true);
  });
});
