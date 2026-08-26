import type { EventSignal } from "@loomrail/contracts";

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
