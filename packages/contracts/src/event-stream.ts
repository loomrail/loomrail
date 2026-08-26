import { z } from "zod";

import { opaqueIdSchema } from "./shared.js";

/**
 * One frame of the event channel.
 *
 * Spec §5.2: three opaque identifiers, nothing else. The client learns *that* something changed at
 * a scope, never *what* changed -- so the channel carries no WorkItem text and no provider output,
 * and therefore cannot widen the untrusted-checkpoint threat A1 §8 records. `.strict()` is what
 * keeps that true over time: a field added later fails to parse instead of riding along.
 */
export const eventSignalSchema = z
  .object({
    projectId: opaqueIdSchema,
    aggregateType: z.enum(["PROJECT", "WORK_ITEM"]),
    aggregateId: opaqueIdSchema,
  })
  .strict();

export type EventSignal = z.infer<typeof eventSignalSchema>;
