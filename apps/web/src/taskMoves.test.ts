import type { WorkItemState } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { moveShortcutsFor, transitionTargets } from "./taskMoves";

const states: readonly WorkItemState[] = ["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];

describe("task move shortcuts", () => {
  it("emphasises the forward move rather than the first allowed transition", () => {
    // READY allows BACKLOG before IN_PROGRESS; the emphasised action must still carry work forward.
    expect(transitionTargets.READY[0]).toBe("BACKLOG");
    expect(moveShortcutsFor("READY", false)).toEqual({ primary: "IN_PROGRESS", secondary: "BACKLOG" });
    expect(moveShortcutsFor("BACKLOG", false)).toEqual({ primary: "READY", secondary: null });
    expect(moveShortcutsFor("BLOCKED", false)).toEqual({ primary: "IN_PROGRESS", secondary: "READY" });
  });

  it("offers no forward shortcut where only owner acceptance can complete the work", () => {
    expect(moveShortcutsFor("IN_PROGRESS", false)).toEqual({ primary: null, secondary: "BLOCKED" });
  });

  it("offers no shortcut for terminal states", () => {
    expect(moveShortcutsFor("DONE", false)).toEqual({ primary: null, secondary: null });
    expect(moveShortcutsFor("CANCELLED", false)).toEqual({ primary: null, secondary: null });
  });

  it("yields to the workflow run while it owns the item", () => {
    for (const state of states) {
      expect(moveShortcutsFor(state, true)).toEqual({ primary: null, secondary: null });
    }
  });

  it("only ever proposes an allowed, non-destructive transition", () => {
    for (const state of states) {
      const { primary, secondary } = moveShortcutsFor(state, false);
      for (const target of [primary, secondary]) {
        if (target === null) continue;
        expect(transitionTargets[state]).toContain(target);
        expect(target).not.toBe("CANCELLED");
      }
      expect(primary === null || primary !== secondary).toBe(true);
    }
  });
});
