import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const workspaceStrategySchema = z.enum(["ISOLATED_WORKTREE", "SHARED_CURRENT_DIRECTORY"]);

export const projectWorkspaceStrategySelectionSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    strategy: workspaceStrategySchema,
    projectVersion: z.number().int().positive(),
    updatedAt: utcTimestampSchema,
  })
  .strict();

export const projectWorkspaceStrategyResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    selection: projectWorkspaceStrategySelectionSchema,
  })
  .strict();

const eventBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sequence: z.number().int().positive(),
    id: opaqueIdSchema,
    aggregateType: z.literal("PROJECT"),
    aggregateId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const projectWorkspaceStrategyChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_WORKSPACE_STRATEGY_CHANGED"),
  data: z
    .object({
      selection: projectWorkspaceStrategySelectionSchema,
      previousStrategy: workspaceStrategySchema,
    })
    .strict(),
});

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const setProjectWorkspaceStrategyCommandSchema = commandBaseSchema.extend({
  type: z.literal("SET_PROJECT_WORKSPACE_STRATEGY"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      strategy: workspaceStrategySchema,
    })
    .strict(),
});

export const projectWorkspaceStrategyChangedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
    type: z.literal("PROJECT_WORKSPACE_STRATEGY_CHANGED"),
    selection: projectWorkspaceStrategySelectionSchema,
    event: projectWorkspaceStrategyChangedEventSchema,
  })
  .strict();

export const setProjectWorkspaceStrategyRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    strategy: workspaceStrategySchema,
  })
  .strict();

export type WorkspaceStrategy = z.infer<typeof workspaceStrategySchema>;
export type ProjectWorkspaceStrategySelection = z.infer<typeof projectWorkspaceStrategySelectionSchema>;
export type ProjectWorkspaceStrategyChangedEvent = z.infer<typeof projectWorkspaceStrategyChangedEventSchema>;
export type SetProjectWorkspaceStrategyCommand = z.infer<typeof setProjectWorkspaceStrategyCommandSchema>;
export type ProjectWorkspaceStrategyChangedResult = z.infer<
  typeof projectWorkspaceStrategyChangedResultSchema
>;
