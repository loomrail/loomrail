import type { ServerResponse } from "node:http";

import type { EventSignal } from "@loomrail/contracts";
import type { FastifyBaseLogger } from "fastify";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const MAX_OPEN_STREAMS = 8;

export type EventStreamSubscriber = {
  response: ServerResponse;
  // Re-read on every heartbeat rather than captured once: a held stream must not outlive the
  // session that opened it, or the channel becomes a way to hold authenticated access forever.
  isAuthorized: () => boolean;
};

export type EventStreamRegistry = {
  open: (subscriber: EventStreamSubscriber) => (() => void) | null;
  publish: (signal: EventSignal) => void;
  tick: () => void;
  closeAll: () => void;
  openCount: () => number;
  stopHeartbeat: () => void;
};

export const createEventStreamRegistry = (options: {
  logger: FastifyBaseLogger;
  // Test-only, and injected in exactly the same spirit as `startDaemon`'s `providerAdapter`: this
  // is the only behaviour in the module that a test cannot reach through a request, so leaving it
  // on the real fifteen-second interval means the timer is the one link in "a held stream cannot
  // outlive its session" that no test drives. Production passes nothing.
  intervalMs?: number;
}): EventStreamRegistry => {
  const subscribers = new Set<EventStreamSubscriber>();

  const drop = (subscriber: EventStreamSubscriber): void => {
    subscribers.delete(subscriber);
    subscriber.response.end();
  };

  const write = (subscriber: EventStreamSubscriber, frame: string): void => {
    try {
      subscriber.response.write(frame);
    } catch (error: unknown) {
      // A dead socket is the ordinary end of a stream, not a daemon fault: drop it and carry on
      // rather than letting one closed browser tab throw into the caller of `execute`.
      options.logger.debug(
        { error: error instanceof Error ? error.name : "unknown" },
        "An event stream could not be written to and was dropped",
      );
      drop(subscriber);
    }
  };

  const registry: EventStreamRegistry = {
    open: (subscriber) => {
      if (subscribers.size >= MAX_OPEN_STREAMS) return null;
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    publish: (signal) => {
      const frame = `data: ${JSON.stringify(signal)}\n\n`;
      for (const subscriber of [...subscribers]) write(subscriber, frame);
    },
    tick: () => {
      for (const subscriber of [...subscribers]) {
        if (!subscriber.isAuthorized()) {
          drop(subscriber);
          continue;
        }
        write(subscriber, ": ping\n\n");
      }
    },
    closeAll: () => {
      for (const subscriber of [...subscribers]) drop(subscriber);
      subscribers.clear();
    },
    openCount: () => subscribers.size,
    stopHeartbeat: () => {
      clearInterval(heartbeat);
    },
  };

  // The timer does nothing but call `tick`. That one line is the link between the clock and the
  // session recheck, so it is driven end to end by "closes a real stream once its session expires"
  // through `intervalMs` above, not only by the tests that call `tick()` themselves. `unref` keeps
  // an idle daemon from being held alive by its own heartbeat.
  const heartbeat = setInterval(() => {
    registry.tick();
  }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return registry;
};
