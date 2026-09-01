import { describe, expect, it, vi } from "vitest";

import {
  connectEventStream,
  createSignalCoalescer,
  scopesForChannelStatus,
  scopesForSignal,
} from "./eventStream";
import { localConnectionQuery } from "./session";

const workItemSignal = {
  projectId: "p1",
  aggregateType: "WORK_ITEM",
  aggregateId: "w1",
} as const;

describe("scopesForSignal", () => {
  it("invalidates the project scope and the work item's own workflow", () => {
    expect(scopesForSignal(workItemSignal)).toEqual([
      ["attention"],
      ["agent-fleet"],
      ["projects", "p1"],
      ["work-items", "w1"],
      ["stage-attempts"],
    ]);
  });

  it("invalidates the project list for a project-scoped signal, without a work item scope", () => {
    expect(scopesForSignal({ projectId: "p1", aggregateType: "PROJECT", aggregateId: "p1" })).toEqual([
      ["attention"],
      ["agent-fleet"],
      ["projects", "p1"],
      ["projects"],
    ]);
  });
});

describe("scopesForChannelStatus", () => {
  // Asserted against the query's own key, not against a second copy of the literal.
  // `eventStream.ts` names the scope inline to stay free of app wiring, so this is the only thing
  // that would notice `localConnectionQuery`'s key being renamed: without it the channel would go
  // on invalidating a key nothing uses, and a dead session would stop being detected at all.
  it("yields the connection scope for a closed channel", () => {
    expect(scopesForChannelStatus("closed")).toEqual([localConnectionQuery.queryKey]);
  });

  // A transient blip must not present as a dead session -- the browser is retrying on its own and
  // the board's cached data is still good, so nothing should be invalidated yet.
  it("yields nothing for a connecting channel", () => {
    expect(scopesForChannelStatus("connecting")).toEqual([]);
  });

  it("yields nothing for a live channel", () => {
    expect(scopesForChannelStatus("live")).toEqual([]);
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
      ["attention"],
      ["agent-fleet"],
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

const fakeSource = () => {
  const source = {
    readyState: 0,
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  return source;
};

describe("connectEventStream", () => {
  it("invalidates everything on open, which is what makes a lost signal harmless", () => {
    const invalidateAll = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll, invalidateScopes: vi.fn() });

    source.onopen?.({});

    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates everything again on every reconnect, not only the first connection", () => {
    const invalidateAll = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll, invalidateScopes: vi.fn() });

    source.onopen?.({});
    source.onerror?.({});
    source.onopen?.({});

    expect(invalidateAll).toHaveBeenCalledTimes(2);
  });

  it("invalidates the signalled scopes once the window closes", () => {
    vi.useFakeTimers();
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes, windowMs: 50 });

    source.onmessage?.({
      data: JSON.stringify({ projectId: "p1", aggregateType: "WORK_ITEM", aggregateId: "w1" }),
    });
    vi.advanceTimersByTime(50);

    expect(invalidateScopes).toHaveBeenCalledWith([
      ["attention"],
      ["agent-fleet"],
      ["projects", "p1"],
      ["work-items", "w1"],
      ["stage-attempts"],
    ]);
    vi.useRealTimers();
  });

  // A frame that is not JSON, and a frame that is JSON but not a signal, are both provider-adjacent
  // untrusted input. Either one throwing out of the handler would leave the channel silently mute.
  it("drops a malformed frame without throwing and keeps working afterwards", () => {
    vi.useFakeTimers();
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes, windowMs: 50 });

    expect(() => source.onmessage?.({ data: "{not json" })).not.toThrow();
    expect(() => source.onmessage?.({ data: JSON.stringify({ projectId: "p1" }) })).not.toThrow();
    vi.advanceTimersByTime(50);
    expect(invalidateScopes).not.toHaveBeenCalled();

    source.onmessage?.({
      data: JSON.stringify({ projectId: "p1", aggregateType: "WORK_ITEM", aggregateId: "w1" }),
    });
    vi.advanceTimersByTime(50);
    expect(invalidateScopes).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // Per the HTML spec EventSource reconnects itself on a network error but closes permanently on a
  // non-200 response. So CLOSED means "the session is gone", and the app must not keep looking live.
  // That distinction is asserted by this test and the one after it together -- the same `onerror`
  // handler, the same two readyStates, opposite expectations -- rather than by watching a reported
  // status, because the invalidation *is* the whole visible consequence of the distinction.
  it("invalidates the connection scope once the channel closes for good", () => {
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes });

    source.readyState = 2; // CLOSED
    source.onerror?.({});

    expect(invalidateScopes).toHaveBeenCalledWith([["local-daemon", "connection"]]);
  });

  it("does not invalidate the connection scope while merely reconnecting", () => {
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes });

    source.readyState = 0; // CONNECTING
    source.onerror?.({});

    expect(invalidateScopes).not.toHaveBeenCalled();
  });

  // The third status. `announce("live")` on open has to map to no scopes: invalidating the
  // connection query here would refetch the session on every reconnect and, worse, make a healthy
  // channel indistinguishable from a dead one at the only place that difference is observable.
  it("does not invalidate the connection scope when the channel opens", () => {
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    connectEventStream({ source, invalidateAll: vi.fn(), invalidateScopes });

    source.onopen?.({});

    expect(invalidateScopes).not.toHaveBeenCalled();
  });

  it("closes the source and drops pending work when disconnected", () => {
    vi.useFakeTimers();
    const invalidateScopes = vi.fn();
    const source = fakeSource();
    const disconnect = connectEventStream({
      source,
      invalidateAll: vi.fn(),
      invalidateScopes,
      windowMs: 50,
    });

    source.onmessage?.({
      data: JSON.stringify({ projectId: "p1", aggregateType: "WORK_ITEM", aggregateId: "w1" }),
    });
    disconnect();
    vi.advanceTimersByTime(50);

    expect(source.closed).toBe(true);
    expect(invalidateScopes).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
