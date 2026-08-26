import { describe, expect, it, vi } from "vitest";

import { createSignalCoalescer, scopesForSignal } from "./eventStream";

const workItemSignal = {
  projectId: "p1",
  aggregateType: "WORK_ITEM",
  aggregateId: "w1",
} as const;

describe("scopesForSignal", () => {
  it("invalidates the project scope and the work item's own workflow", () => {
    expect(scopesForSignal(workItemSignal)).toEqual([
      ["projects", "p1"],
      ["work-items", "w1"],
      ["stage-attempts"],
    ]);
  });

  it("invalidates the project list for a project-scoped signal, without a work item scope", () => {
    expect(scopesForSignal({ projectId: "p1", aggregateType: "PROJECT", aggregateId: "p1" })).toEqual([
      ["projects", "p1"],
      ["projects"],
    ]);
  });
});

describe("createSignalCoalescer", () => {
  it("flushes a burst as one call with each scope present once", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const coalescer = createSignalCoalescer(flush, 50);

    coalescer.push(workItemSignal);
    coalescer.push(workItemSignal);
    coalescer.push({ ...workItemSignal, aggregateId: "w2" });
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]?.[0]).toEqual([
      ["projects", "p1"],
      ["work-items", "w1"],
      ["stage-attempts"],
      ["work-items", "w2"],
    ]);
    vi.useRealTimers();
  });

  // Without this, a stage that publishes steadily would keep pushing the deadline out and the board
  // would never refresh while anything was happening -- the exact opposite of the point.
  it("does not postpone a pending flush when more signals arrive inside the window", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const coalescer = createSignalCoalescer(flush, 50);

    coalescer.push(workItemSignal);
    vi.advanceTimersByTime(40);
    coalescer.push({ ...workItemSignal, aggregateId: "w2" });
    vi.advanceTimersByTime(10);

    expect(flush).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("drops a pending flush when disposed", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const coalescer = createSignalCoalescer(flush, 50);
    coalescer.push(workItemSignal);
    coalescer.dispose();
    vi.advanceTimersByTime(50);
    expect(flush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
