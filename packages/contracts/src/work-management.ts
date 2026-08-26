import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import {
  acceptanceRequestedEventSchema,
  acceptanceResolvedEventSchema,
  acceptanceResolvedResultSchema,
  approveBudgetOverrideCommandSchema,
  answerHumanRequestCommandSchema,
  applyProviderOutcomeCommandSchema,
  legacyApplyMockProviderOutcomeCommandSchema,
  budgetOverrideApprovedEventSchema,
  budgetOverrideApprovedResultSchema,
  budgetThresholdReachedEventSchema,
  cancelPipelineCommandSchema,
  checkpointPublishedEventSchema,
  checkpointPublishedResultSchema,
  contextFloorExceededEventSchema,
  contextHandoffRequestedEventSchema,
  contextHandoffRequestedResultSchema,
  endProviderSessionCommandSchema,
  hardPauseStageAttemptCommandSchema,
  humanRequestAnsweredResultSchema,
  humanRequestOpenedEventSchema,
  humanRequestResolvedEventSchema,
  evidenceArtifactRecordedEventSchema,
  markWorkflowDispatchStartedCommandSchema,
  mockProviderOutcomeAppliedResultSchema,
  pausePipelineCommandSchema,
  pipelineCancelledEventSchema,
  pipelineCompletedEventSchema,
  pipelineControlAppliedResultSchema,
  pipelinePausedEventSchema,
  pipelineResumedEventSchema,
  pipelineStartedEventSchema,
  pipelineStartedResultSchema,
  providerSessionEndedEventSchema,
  providerSessionEndedResultSchema,
  providerSessionStartedEventSchema,
  providerSessionStartedResultSchema,
  publishCheckpointCommandSchema,
  reconcileWorkflowsCommandSchema,
  recoveryReportCreatedEventSchema,
  resolveAcceptanceCommandSchema,
  resumePipelineCommandSchema,
  requestContextHandoffCommandSchema,
  stageAttemptChangedEventSchema,
  stageAttemptHardPausedResultSchema,
  startMockPipelineCommandSchema,
  startProviderSessionCommandSchema,
  usageRecordedEventSchema,
  workflowDispatchStartedResultSchema,
  workflowStageSchema,
  workflowsReconciledResultSchema,
} from "./workflow.js";

export const fixtureProjectIdSchema = z.enum(["web-app-a", "api-service-b"]);
export const projectStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export const workItemTypeSchema = z.enum(["EPIC", "FEATURE", "TASK", "BUG", "SPIKE", "SUBTASK"]);
export const workItemStateSchema = z.enum([
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
  "CANCELLED",
]);
export const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
export const riskSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().max(20_000);
const repositoryPathSchema = z.string().min(1).max(4_096);
const acceptanceCriteriaSchema = z.array(z.string().trim().min(1).max(500)).max(50);

export const projectSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    workspaceId: opaqueIdSchema,
    fixtureId: fixtureProjectIdSchema,
    name: titleSchema,
    repositoryPath: repositoryPathSchema,
    status: projectStatusSchema,
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .strict();

export const workItemSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    parentId: opaqueIdSchema.nullable(),
    type: workItemTypeSchema,
    title: titleSchema,
    description: descriptionSchema,
    state: workItemStateSchema,
    currentStage: workflowStageSchema.nullable(),
    priority: prioritySchema,
    risk: riskSchema,
    acceptanceCriteria: acceptanceCriteriaSchema,
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .strict();

const eventBaseSchema = z
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

export const projectRegisteredEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_REGISTERED"),
  aggregateType: z.literal("PROJECT"),
  data: z.object({ project: projectSchema }).strict(),
});

export const workItemCreatedEventSchema = eventBaseSchema.extend({
  type: z.literal("WORK_ITEM_CREATED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ workItem: workItemSchema }).strict(),
});

export const workItemChangedFieldSchema = z.enum([
  "title",
  "description",
  "priority",
  "risk",
  "acceptanceCriteria",
]);

export const workItemUpdatedEventSchema = eventBaseSchema.extend({
  type: z.literal("WORK_ITEM_UPDATED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      workItem: workItemSchema,
      changedFields: z.array(workItemChangedFieldSchema).min(1),
    })
    .strict(),
});

export const workItemStateChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("WORK_ITEM_STATE_CHANGED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      workItem: workItemSchema,
      previousState: workItemStateSchema,
    })
    .strict(),
});

export const domainEventSchema = z.discriminatedUnion("type", [
  projectRegisteredEventSchema,
  workItemCreatedEventSchema,
  workItemUpdatedEventSchema,
  workItemStateChangedEventSchema,
  pipelineStartedEventSchema,
  stageAttemptChangedEventSchema,
  humanRequestOpenedEventSchema,
  humanRequestResolvedEventSchema,
  usageRecordedEventSchema,
  budgetThresholdReachedEventSchema,
  pipelinePausedEventSchema,
  pipelineResumedEventSchema,
  pipelineCancelledEventSchema,
  budgetOverrideApprovedEventSchema,
  recoveryReportCreatedEventSchema,
  evidenceArtifactRecordedEventSchema,
  acceptanceRequestedEventSchema,
  acceptanceResolvedEventSchema,
  pipelineCompletedEventSchema,
  providerSessionStartedEventSchema,
  checkpointPublishedEventSchema,
  contextHandoffRequestedEventSchema,
  providerSessionEndedEventSchema,
  contextFloorExceededEventSchema,
]);

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const registerProjectCommandSchema = commandBaseSchema.extend({
  type: z.literal("REGISTER_FIXTURE_PROJECT"),
  payload: z
    .object({
      id: opaqueIdSchema,
      fixtureId: fixtureProjectIdSchema,
      name: titleSchema,
      repositoryPath: repositoryPathSchema,
    })
    .strict(),
});

export const createWorkItemCommandSchema = commandBaseSchema.extend({
  type: z.literal("CREATE_WORK_ITEM"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      parentId: opaqueIdSchema.nullable().default(null),
      type: workItemTypeSchema,
      title: titleSchema,
      description: descriptionSchema.default(""),
      priority: prioritySchema.default("MEDIUM"),
      risk: riskSchema.default("MEDIUM"),
      acceptanceCriteria: acceptanceCriteriaSchema.default([]),
    })
    .strict(),
});

export const workItemPatchSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    priority: prioritySchema.optional(),
    risk: riskSchema.optional(),
    acceptanceCriteria: acceptanceCriteriaSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "At least one field must be updated" });

export const updateWorkItemCommandSchema = commandBaseSchema.extend({
  type: z.literal("UPDATE_WORK_ITEM"),
  payload: z
    .object({
      workItemId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      patch: workItemPatchSchema,
    })
    .strict(),
});

export const moveWorkItemCommandSchema = commandBaseSchema.extend({
  type: z.literal("MOVE_WORK_ITEM"),
  payload: z
    .object({
      workItemId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      targetState: workItemStateSchema,
    })
    .strict(),
});

export const stateCommandSchema = z.discriminatedUnion("type", [
  registerProjectCommandSchema,
  createWorkItemCommandSchema,
  updateWorkItemCommandSchema,
  moveWorkItemCommandSchema,
  startMockPipelineCommandSchema,
  markWorkflowDispatchStartedCommandSchema,
  applyProviderOutcomeCommandSchema,
  legacyApplyMockProviderOutcomeCommandSchema,
  answerHumanRequestCommandSchema,
  pausePipelineCommandSchema,
  resumePipelineCommandSchema,
  cancelPipelineCommandSchema,
  approveBudgetOverrideCommandSchema,
  reconcileWorkflowsCommandSchema,
  resolveAcceptanceCommandSchema,
  startProviderSessionCommandSchema,
  publishCheckpointCommandSchema,
  endProviderSessionCommandSchema,
  requestContextHandoffCommandSchema,
  hardPauseStageAttemptCommandSchema,
]);

const commandResultBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
  })
  .strict();

export const projectRegisteredResultSchema = commandResultBaseSchema.extend({
  type: z.literal("PROJECT_REGISTERED"),
  project: projectSchema,
  event: projectRegisteredEventSchema,
});

export const workItemCreatedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("WORK_ITEM_CREATED"),
  workItem: workItemSchema,
  event: workItemCreatedEventSchema,
});

export const workItemUpdatedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("WORK_ITEM_UPDATED"),
  workItem: workItemSchema,
  event: workItemUpdatedEventSchema,
});

export const workItemMovedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("WORK_ITEM_MOVED"),
  workItem: workItemSchema,
  event: workItemStateChangedEventSchema,
});

export const stateCommandResultSchema = z.discriminatedUnion("type", [
  projectRegisteredResultSchema,
  workItemCreatedResultSchema,
  workItemUpdatedResultSchema,
  workItemMovedResultSchema,
  pipelineStartedResultSchema,
  workflowDispatchStartedResultSchema,
  mockProviderOutcomeAppliedResultSchema,
  humanRequestAnsweredResultSchema,
  pipelineControlAppliedResultSchema,
  budgetOverrideApprovedResultSchema,
  workflowsReconciledResultSchema,
  acceptanceResolvedResultSchema,
  providerSessionStartedResultSchema,
  checkpointPublishedResultSchema,
  providerSessionEndedResultSchema,
  contextHandoffRequestedResultSchema,
  stageAttemptHardPausedResultSchema,
]);

export const registerFixtureProjectRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    fixtureId: fixtureProjectIdSchema,
  })
  .strict();

export const createWorkItemRequestSchema = createWorkItemCommandSchema.shape.payload
  .omit({ projectId: true })
  .extend({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    projectId: opaqueIdSchema,
  })
  .strict();

export const updateWorkItemRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    patch: workItemPatchSchema,
  })
  .strict();

export const moveWorkItemRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    targetState: workItemStateSchema,
  })
  .strict();

export const projectsResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, projects: z.array(projectSchema) })
  .strict();
export const workItemResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, workItem: workItemSchema })
  .strict();
export const workItemsResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, workItems: z.array(workItemSchema) })
  .strict();
export const eventPageDirectionSchema = z.enum(["ASC", "DESC"]);
export const eventsResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    events: z.array(domainEventSchema),
    nextSequence: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

export type FixtureProjectId = z.infer<typeof fixtureProjectIdSchema>;
export type Project = z.infer<typeof projectSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkItemType = z.infer<typeof workItemTypeSchema>;
export type WorkItemState = z.infer<typeof workItemStateSchema>;
export type WorkItemChangedField = z.infer<typeof workItemChangedFieldSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;
export type EventPageDirection = z.infer<typeof eventPageDirectionSchema>;
export type ProjectRegisteredEvent = z.infer<typeof projectRegisteredEventSchema>;
export type WorkItemCreatedEvent = z.infer<typeof workItemCreatedEventSchema>;
export type WorkItemUpdatedEvent = z.infer<typeof workItemUpdatedEventSchema>;
export type WorkItemStateChangedEvent = z.infer<typeof workItemStateChangedEventSchema>;
export type RegisterProjectCommand = z.infer<typeof registerProjectCommandSchema>;
export type CreateWorkItemCommand = z.infer<typeof createWorkItemCommandSchema>;
export type UpdateWorkItemCommand = z.infer<typeof updateWorkItemCommandSchema>;
export type MoveWorkItemCommand = z.infer<typeof moveWorkItemCommandSchema>;
export type StateCommand = z.infer<typeof stateCommandSchema>;
export type StateCommandResult = z.infer<typeof stateCommandResultSchema>;
