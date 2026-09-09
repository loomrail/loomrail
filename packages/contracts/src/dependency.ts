import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const MAX_WORK_ITEM_BLOCKERS = 50;
export const MAX_DEPENDENCY_GRAPH_WORK_ITEMS = 10_000;
export const MAX_DEPENDENCY_GRAPH_EDGES = 50_000;

export const workItemDependencyKindSchema = z.literal("BLOCKS");

export const workItemDependencySchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    kind: workItemDependencyKindSchema,
    blockerWorkItemId: opaqueIdSchema,
    blockedWorkItemId: opaqueIdSchema,
    createdAt: utcTimestampSchema,
  })
  .strict();

export const setWorkItemDependenciesCommandSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
    type: z.literal("SET_WORK_ITEM_DEPENDENCIES"),
    payload: z
      .object({
        workItemId: opaqueIdSchema,
        expectedVersion: z.number().int().positive(),
        // One over the domain limit reaches the decision as a typed refusal; larger bodies are
        // rejected at the HTTP contract before they can become a graph-validation allocation.
        blockerWorkItemIds: z.array(opaqueIdSchema).max(MAX_WORK_ITEM_BLOCKERS + 1),
      })
      .strict(),
  })
  .strict();

const dependencyEventBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sequence: z.number().int().positive(),
    id: opaqueIdSchema,
    aggregateId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const workItemDependenciesSetEventSchema = dependencyEventBaseSchema.extend({
  type: z.literal("WORK_ITEM_DEPENDENCIES_SET"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      blockedWorkItemId: opaqueIdSchema,
      previousBlockerWorkItemIds: z.array(opaqueIdSchema).max(MAX_WORK_ITEM_BLOCKERS),
      blockerWorkItemIds: z.array(opaqueIdSchema).max(MAX_WORK_ITEM_BLOCKERS),
      workItemVersion: z.number().int().positive(),
    })
    .strict(),
});

export const workItemDependenciesSetResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("WORK_ITEM_DEPENDENCIES_SET"),
    blockedWorkItemId: opaqueIdSchema,
    workItemVersion: z.number().int().positive(),
    dependencies: z.array(workItemDependencySchema).max(MAX_WORK_ITEM_BLOCKERS),
    event: workItemDependenciesSetEventSchema,
  })
  .strict();

export const setWorkItemDependenciesRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    blockerWorkItemIds: z.array(opaqueIdSchema).max(MAX_WORK_ITEM_BLOCKERS + 1),
  })
  .strict();

export const workItemDependenciesResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    dependencies: z.array(workItemDependencySchema).max(MAX_DEPENDENCY_GRAPH_EDGES),
  })
  .strict();

export type WorkItemDependencyKind = z.infer<typeof workItemDependencyKindSchema>;
export type WorkItemDependency = z.infer<typeof workItemDependencySchema>;
export type SetWorkItemDependenciesCommand = z.infer<typeof setWorkItemDependenciesCommandSchema>;
export type WorkItemDependenciesSetEvent = z.infer<typeof workItemDependenciesSetEventSchema>;
export type WorkItemDependenciesSetResult = z.infer<typeof workItemDependenciesSetResultSchema>;
export type WorkItemDependenciesResponse = z.infer<typeof workItemDependenciesResponseSchema>;
