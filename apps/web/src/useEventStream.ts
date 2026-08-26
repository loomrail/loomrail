import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { connectEventStream, type EventChannelStatus, type EventSourceLike } from "./eventStream";

/**
 * Follows the daemon's SSE channel while `enabled`, reporting its live status.
 *
 * All decision logic lives in `connectEventStream` and `scopesForChannelStatus`, both tested
 * against an injected source double -- see eventStream.test.ts. This hook is deliberately thin: it
 * owns only the real `EventSource` and the React state box. In particular, what a closed channel
 * means (the session is gone; invalidate the same connection query the app already uses to detect
 * and explain an unreachable daemon) is decided by `scopesForChannelStatus` and reaches the query
 * client through the `invalidateScopes` callback below -- not through a branch here, so that
 * decision stays covered by connectEventStream's tests instead of living only in an untestable
 * effect.
 */
export const useEventStream = (enabled: boolean): EventChannelStatus => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EventChannelStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    // `EventSource`'s handler properties are typed against the DOM `Event`, narrower than the
    // `unknown` `connectEventStream` accepts so it can be driven by a plain-object double in
    // tests (EventSource has no jsdom implementation). The real browser type is a structural
    // superset of EventSourceLike, so this bridges an interop mismatch, not an unsafe widening.
    const source = new EventSource("/api/v1/stream") as unknown as EventSourceLike;
    return connectEventStream({
      source,
      invalidateAll: () => {
        void queryClient.invalidateQueries();
      },
      invalidateScopes: (scopes) => {
        for (const queryKey of scopes) void queryClient.invalidateQueries({ queryKey });
      },
      onStatus: setStatus,
    });
  }, [enabled, queryClient]);

  return status;
};
