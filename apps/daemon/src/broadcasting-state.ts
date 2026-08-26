import type { EventSignal } from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import type { FastifyBaseLogger } from "fastify";

export const SIGNAL_PAGE_LIMIT = 500;

const newestSequence = (state: LocalState): number => {
  const page = state.query({ type: "LIST_EVENTS", direction: "DESC", limit: 1 });
  return page.type === "EVENTS" ? (page.events[0]?.sequence ?? 0) : 0;
};

/**
 * The single seam through which committed events reach the channel.
 *
 * Wrapping `execute` once means every writer downstream -- the request handlers and
 * `runStageAttempt`, which takes `state` as a dependency -- publishes without knowing it does.
 * There is no path to forget, because there is one path. Synchronous throughout: `node:sqlite` is
 * synchronous, so this introduces no new yield point and therefore no new interleaving.
 */
export const broadcastingState = (
  state: LocalState,
  publish: (signal: EventSignal) => void,
  logger: FastifyBaseLogger,
): LocalState => {
  // Seeded from the table, not from zero: otherwise the first command against a database with
  // history would broadcast all of it.
  let lastSequence = newestSequence(state);

  const publishCommitted = (): void => {
    for (;;) {
      const page = state.query({
        type: "LIST_EVENTS",
        direction: "ASC",
        afterSequence: lastSequence,
        limit: SIGNAL_PAGE_LIMIT,
      });
      if (page.type !== "EVENTS" || page.events.length === 0) return;
      for (const event of page.events) {
        publish({
          projectId: event.projectId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
        });
        lastSequence = event.sequence;
      }
      if (!page.hasMore) return;
    }
  };

  return {
    ...state,
    execute: (command) => {
      // A throw here rolls the transaction back, so nothing was committed and nothing is published
      // -- the ordering is the whole guarantee, not a convenience.
      const result = state.execute(command);
      try {
        publishCommitted();
      } catch (error: unknown) {
        // ADR-0002: publication failure does not roll state back. The owner sees the change on the
        // next signal or on reconnect; the command stays applied either way.
        logger.warn(
          { error: error instanceof Error ? error.name : "unknown" },
          "Committed events could not be published to the event channel",
        );
      }
      return result;
    },
  };
};
