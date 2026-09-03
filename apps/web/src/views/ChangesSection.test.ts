import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeSummaryRefresher, SUMMARY_REFRESH_DEBOUNCE_MS } from "../changesView";
import { createEventQueryInvalidator, shouldInvalidateImmediately } from "../useEventStream";

afterEach(() => {
  vi.useRealTimers();
});

describe("ChangesSection event refresh", () => {
  it("reads the summary once for a burst of events, not once per event", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(undefined);
    const refresh = makeSummaryRefresher(read, SUMMARY_REFRESH_DEBOUNCE_MS);

    refresh();
    refresh();
    refresh();
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_DEBOUNCE_MS);

    expect(read).toHaveBeenCalledTimes(1);
    refresh.dispose();
  });

  it("keeps ordinary work-item queries immediate while changes wait for their measured window", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const invalidator = createEventQueryInvalidator(queryClient, SUMMARY_REFRESH_DEBOUNCE_MS);

    invalidator.invalidateScopes([["work-items", "work-item-1"]]);
    invalidator.invalidateScopes([["work-items", "work-item-1"]]);
    invalidator.invalidateScopes([["work-items", "work-item-1"]]);

    expect(invalidate).toHaveBeenCalledTimes(3);
    const immediateFilter = invalidate.mock.calls[0]?.[0];
    const predicate = immediateFilter?.predicate;
    expect(predicate).toBeTypeOf("function");
    expect(
      shouldInvalidateImmediately(["work-items", "work-item-1", "workflow"], ["work-items", "work-item-1"]),
    ).toBe(true);
    expect(
      shouldInvalidateImmediately(["work-items", "work-item-1", "changes"], ["work-items", "work-item-1"]),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_DEBOUNCE_MS);

    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate.mock.calls[3]?.[0]).toMatchObject({
      queryKey: ["work-items", "work-item-1", "changes"],
      refetchType: "active",
    });
    invalidator.dispose();
  });

  it("does not reread changes for a card that is closed", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const read = vi.fn().mockResolvedValue({ changes: null });
    await queryClient.query({
      queryKey: ["work-items", "work-item-1", "changes"],
      queryFn: read,
    });
    const invalidator = createEventQueryInvalidator(queryClient, SUMMARY_REFRESH_DEBOUNCE_MS);

    invalidator.invalidateScopes([["work-items", "work-item-1"]]);
    await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_DEBOUNCE_MS);

    expect(read).toHaveBeenCalledTimes(1);
    invalidator.dispose();
  });
});
