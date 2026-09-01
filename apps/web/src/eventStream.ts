import { eventSignalSchema, type EventSignal } from "@loomrail/contracts";

export const COALESCE_WINDOW_MS = 50;

type QueryScope = readonly string[];

/**
 * Which cached scopes a signal makes stale.
 *
 * Query keys are prefix-shaped (workspace.tsx:39-48), so one entry per scope covers everything
 * nested under it. The stage-attempt scope is invalidated whole because events carry no attempt
 * id -- the client holds one or two attempts, so the cost is one refetch.
 *
 * A switch with a `never` check rather than a ternary on `=== "WORK_ITEM"`, because a third
 * `aggregateType` would otherwise degrade in silence: `eventSignalSchema` would accept the frame,
 * and everything that is not WORK_ITEM would quietly take the PROJECT branch and invalidate the
 * wrong keys. The daemon side of the same widening is caught by the compiler already -- publishing
 * a `DomainEvent`'s `aggregateType` (broadcasting-state.ts) is an assignment to `EventSignal`, so
 * an event type the frame schema does not list fails to compile there. This closes the other door:
 * widen the schema to match and this function stops compiling until its mapping is decided.
 */
export const scopesForSignal = (signal: EventSignal): readonly QueryScope[] => {
  switch (signal.aggregateType) {
    case "WORK_ITEM":
      return [
        ["attention"],
        ["projects", signal.projectId],
        ["work-items", signal.aggregateId],
        ["stage-attempts"],
      ];
    case "PROJECT":
      return [["attention"], ["projects", signal.projectId], ["projects"]];
    default: {
      const unhandled: never = signal.aggregateType;
      throw new Error(`Unhandled event signal aggregate type: ${String(unhandled)}`);
    }
  }
};

/**
 * Collects signals arriving inside one window and flushes their union once.
 *
 * A running stage publishes in bursts -- session started, checkpoint, wind-down asked, session
 * ended -- and invalidating per signal would mean a refetch storm and a jumpy board. The deadline
 * is set by the first signal of a burst and never postponed by later ones, so a steadily
 * publishing stage still refreshes on schedule instead of starving.
 */
export const createSignalCoalescer = (
  flush: (scopes: readonly QueryScope[]) => void,
  windowMs: number = COALESCE_WINDOW_MS,
): { push: (signal: EventSignal) => void; dispose: () => void } => {
  const pending = new Map<string, QueryScope>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (): void => {
    timer = undefined;
    const scopes = [...pending.values()];
    pending.clear();
    if (scopes.length > 0) flush(scopes);
  };

  return {
    push: (signal) => {
      for (const scope of scopesForSignal(signal)) pending.set(scope.join("/"), scope);
      timer ??= setTimeout(run, windowMs);
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
};

export type EventChannelStatus = "connecting" | "live" | "closed";

const EVENT_SOURCE_CLOSED = 2;

// The connection query's key, named here rather than imported from session.ts so this module stays
// free of app wiring. That duplication is only safe because eventStream.test.ts asserts this
// mapping against `localConnectionQuery.queryKey` itself -- the test file is free to import
// session.ts, so the drift this literal would otherwise invite is caught there.
const LOCAL_CONNECTION_SCOPE: QueryScope = ["local-daemon", "connection"];

/**
 * Which cached scopes a change in channel status makes stale.
 *
 * A permanently closed channel means a non-200 response, which on this route means the session is
 * gone -- the condition the connection query already detects and the recovery panel already
 * explains. A reconnecting channel means nothing yet: the browser is retrying on its own and the
 * board's data is still good.
 */
export const scopesForChannelStatus = (status: EventChannelStatus): readonly QueryScope[] =>
  status === "closed" ? [LOCAL_CONNECTION_SCOPE] : [];

/**
 * The subset of `EventSource` this module relies on.
 *
 * `EventSource` has no jsdom implementation, so tests drive this shape with a plain object double
 * instead of a real browser API -- keeping the milestone's no-new-dependencies rule intact.
 */
export type EventSourceLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close: () => void;
};

/**
 * Wires an `EventSourceLike` to the coalescer, and turns a change of connection status into the
 * invalidation it implies.
 *
 * Three things here are load bearing (spec D3/D4). `invalidateAll()` on every `open` -- including
 * every reconnect, not only the first -- is what makes a dropped signal harmless: the channel
 * carries no sequence number and never replays, so catching up after any gap is done entirely by
 * refetching. Parsing each frame inside a `try` means a malformed or non-signal frame is dropped
 * rather than thrown, which would otherwise leave the channel silently mute after one bad frame.
 * And `announce` below is the entire mechanism by which a permanently closed channel becomes
 * visible to the app: the status is consumed here, by `scopesForChannelStatus`, and is not reported
 * outward. It used to be handed to the caller as well, threaded through the workspace context and
 * rendered by nothing -- a wire with nothing on the far end, which no test could tell from a broken
 * one. Anything that wants to *show* channel status should start from this function, not from a
 * status value some caller is already receiving.
 */
export const connectEventStream = (options: {
  source: EventSourceLike;
  invalidateAll: () => void;
  invalidateScopes: (scopes: readonly (readonly string[])[]) => void;
  windowMs?: number;
}): (() => void) => {
  const coalescer = createSignalCoalescer(options.invalidateScopes, options.windowMs);

  const announce = (status: EventChannelStatus): void => {
    const scopes = scopesForChannelStatus(status);
    if (scopes.length > 0) options.invalidateScopes(scopes);
  };

  options.source.onopen = () => {
    announce("live");
    options.invalidateAll();
  };

  options.source.onmessage = (message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    const signal = eventSignalSchema.safeParse(parsed);
    if (!signal.success) return;
    coalescer.push(signal.data);
  };

  options.source.onerror = () => {
    // Routed through the same invalidateScopes callback the coalescer uses, rather than a branch in
    // the hook: this makes the closed -> "session is gone" decision reachable through the
    // injected-double tests in this file, not only by hand-tracing a useEffect.
    announce(options.source.readyState === EVENT_SOURCE_CLOSED ? "closed" : "connecting");
  };

  return () => {
    coalescer.dispose();
    options.source.close();
  };
};
