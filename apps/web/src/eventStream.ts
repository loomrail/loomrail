import { eventSignalSchema, type EventSignal } from "@loomrail/contracts";

export const COALESCE_WINDOW_MS = 50;

type QueryScope = readonly string[];

/**
 * Which cached scopes a signal makes stale.
 *
 * Query keys are prefix-shaped (workspace.tsx:39-48), so one entry per scope covers everything
 * nested under it. The stage-attempt scope is invalidated whole because events carry no attempt
 * id -- the client holds one or two attempts, so the cost is one refetch.
 */
export const scopesForSignal = (signal: EventSignal): readonly QueryScope[] =>
  signal.aggregateType === "WORK_ITEM"
    ? [["projects", signal.projectId], ["work-items", signal.aggregateId], ["stage-attempts"]]
    : [["projects", signal.projectId], ["projects"]];

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
 * Wires an `EventSourceLike` to the coalescer and reports connection status.
 *
 * Two lines here are load bearing (spec D3/D4). `invalidateAll()` on every `open` -- including every
 * reconnect, not only the first -- is what makes a dropped signal harmless: the channel carries no
 * sequence number and never replays, so catching up after any gap is done entirely by refetching.
 * And parsing each frame inside a `try` means a malformed or non-signal frame is dropped rather than
 * thrown, which would otherwise leave the channel silently mute after one bad frame.
 */
export const connectEventStream = (options: {
  source: EventSourceLike;
  invalidateAll: () => void;
  invalidateScopes: (scopes: readonly (readonly string[])[]) => void;
  onStatus: (status: EventChannelStatus) => void;
  windowMs?: number;
}): (() => void) => {
  const coalescer = createSignalCoalescer(options.invalidateScopes, options.windowMs);

  options.source.onopen = () => {
    options.onStatus("live");
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
    options.onStatus(options.source.readyState === EVENT_SOURCE_CLOSED ? "closed" : "connecting");
  };

  return () => {
    coalescer.dispose();
    options.source.close();
  };
};
