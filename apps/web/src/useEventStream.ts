import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { makeSummaryRefresher, SUMMARY_REFRESH_DEBOUNCE_MS, type SummaryRefresher } from "./changesView";
import { connectEventStream, type EventSourceLike } from "./eventStream";

type QueryScope = readonly string[];

const queryStartsWith = (queryKey: readonly unknown[], scope: QueryScope): boolean =>
  scope.every((part, index) => queryKey[index] === part);

const isChangesQuery = (queryKey: readonly unknown[], workItemId: string): boolean =>
  queryKey[0] === "work-items" && queryKey[1] === workItemId && queryKey[2] === "changes";

/** The predicate used for the immediate half of a WORK_ITEM invalidation, exported for mutation tests. */
export const shouldInvalidateImmediately = (queryKey: readonly unknown[], scope: QueryScope): boolean => {
  if (!queryStartsWith(queryKey, scope)) return false;
  const workItemId = scope.length === 2 && scope[0] === "work-items" ? scope[1] : undefined;
  return workItemId === undefined || !isChangesQuery(queryKey, workItemId);
};

/**
 * Turns channel scopes into query invalidations while giving expensive change reads their own
 * measured cadence.
 *
 * A WORK_ITEM signal still invalidates workflow, workspace and every other card query immediately.
 * Summary and file-diff queries are excluded from that pass and invalidated together after the
 * measured window. React Query refetches active queries only: the summary is active while its card
 * is open, and a body is active only for the one expanded file. A closed card therefore performs no
 * read at all.
 */
export const createEventQueryInvalidator = (
  queryClient: QueryClient,
  summaryWindowMs: number = SUMMARY_REFRESH_DEBOUNCE_MS,
): {
  invalidateAll: () => void;
  invalidateScopes: (scopes: readonly QueryScope[]) => void;
  dispose: () => void;
} => {
  const summaryRefreshers = new Map<string, SummaryRefresher>();

  const dispose = (): void => {
    for (const refresher of summaryRefreshers.values()) refresher.dispose();
    summaryRefreshers.clear();
  };

  const scheduleChanges = (workItemId: string): void => {
    let refresher = summaryRefreshers.get(workItemId);
    if (!refresher) {
      refresher = makeSummaryRefresher(async () => {
        summaryRefreshers.delete(workItemId);
        await queryClient.invalidateQueries({
          queryKey: ["work-items", workItemId, "changes"],
          refetchType: "active",
        });
      }, summaryWindowMs);
      summaryRefreshers.set(workItemId, refresher);
    }
    refresher();
  };

  return {
    invalidateAll: () => {
      // Reconnect is a full catch-up read (ADR-0002), so an older delayed change read would only
      // duplicate it. Cancel the delayed work before invalidating the complete cache.
      dispose();
      void queryClient.invalidateQueries();
    },
    invalidateScopes: (scopes) => {
      for (const scope of scopes) {
        const workItemId = scope.length === 2 && scope[0] === "work-items" ? scope[1] : undefined;
        if (workItemId !== undefined) {
          void queryClient.invalidateQueries({
            predicate: (query) => shouldInvalidateImmediately(query.queryKey, scope),
          });
          scheduleChanges(workItemId);
          continue;
        }
        void queryClient.invalidateQueries({ queryKey: scope });
      }
    },
    dispose,
  };
};

/**
 * Follows the daemon's SSE channel while `enabled`.
 *
 * All decision logic lives in `connectEventStream` and `scopesForChannelStatus`, both tested
 * against an injected source double -- see eventStream.test.ts. This hook is deliberately thin: it
 * owns only the real `EventSource`. In particular, what a closed channel means (the session is gone;
 * invalidate the same connection query the app already uses to detect and explain an unreachable
 * daemon) is decided by `scopesForChannelStatus` and reaches the query client through the
 * `invalidateScopes` callback below -- not through a branch here, so that decision stays covered by
 * connectEventStream's tests instead of living only in an untestable effect.
 *
 * Returns nothing on purpose. It used to return a status that the workspace context carried and no
 * component ever read; a value with no reader cannot be told from a broken one by any test, so it
 * is gone rather than left as a wire waiting for an end. Reinstating it is a change to make
 * alongside the component that renders it.
 */
export const useEventStream = (enabled: boolean): void => {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    // `EventSource`'s handler properties are typed against the DOM `Event`, narrower than the
    // `unknown` `connectEventStream` accepts so it can be driven by a plain-object double in
    // tests (EventSource has no jsdom implementation). The real browser type is a structural
    // superset of EventSourceLike, so this bridges an interop mismatch, not an unsafe widening.
    const source = new EventSource("/api/v1/stream") as unknown as EventSourceLike;
    const invalidator = createEventQueryInvalidator(queryClient);
    const disconnect = connectEventStream({
      source,
      invalidateAll: invalidator.invalidateAll,
      invalidateScopes: invalidator.invalidateScopes,
    });
    return () => {
      disconnect();
      invalidator.dispose();
    };
  }, [enabled, queryClient]);
};
