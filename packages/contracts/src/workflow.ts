import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

export const workflowStageSchema = z.enum(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"]);
export const pipelineRunStatusSchema = z.enum([
  "RUNNING",
  "WAITING_HUMAN",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export const stageAttemptStatusSchema = z.enum([
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING_HUMAN",
  "SOFT_PAUSED",
  "HARD_PAUSED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
  "RECOVERING",
  "STALE",
]);
export const humanRequestKindSchema = z.enum([
  "SINGLE_CHOICE",
  "MULTIPLE_CHOICE",
  "CONFIRMATION",
  "FREE_TEXT",
]);
export const humanRequestStatusSchema = z.enum([
  "OPEN",
  "CLAIMED",
  "SNOOZED",
  "RESOLVED",
  "EXPIRED",
  "CANCELLED",
]);
export const workflowDispatchModeSchema = z.enum(["START", "RESUME"]);
export const workflowDispatchStatusSchema = z.enum(["PENDING", "COMPLETED", "FAILED"]);

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().min(1).max(4_000);

export const workflowTemplateStageSchema = z
  .object({
    stage: workflowStageSchema,
    ordinal: z.number().int().nonnegative(),
  })
  .strict();

export const workflowTemplateSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    version: z.number().int().positive(),
    name: titleSchema,
    stages: z.array(workflowTemplateStageSchema).min(1).max(20),
  })
  .strict();

export const pipelineRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    workflowTemplateId: opaqueIdSchema,
    workflowVersion: z.number().int().positive(),
    status: pipelineRunStatusSchema,
    currentStageAttemptId: opaqueIdSchema,
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    finishedAt: utcTimestampSchema.nullable(),
  })
  .strict();

export const stageAttemptSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    stage: workflowStageSchema,
    attempt: z.number().int().positive(),
    status: stageAttemptStatusSchema,
    version: z.number().int().positive(),
    startedAt: utcTimestampSchema.nullable(),
    finishedAt: utcTimestampSchema.nullable(),
    failureCode: z.string().trim().min(1).max(100).nullable(),
  })
  .strict();

export const humanRequestOptionSchema = z
  .object({
    id: opaqueIdSchema,
    label: titleSchema,
    consequence: descriptionSchema,
    recommended: z.boolean(),
  })
  .strict();

export const humanRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    kind: humanRequestKindSchema,
    blocking: z.boolean(),
    title: titleSchema,
    context: descriptionSchema,
    recommendation: descriptionSchema.nullable(),
    options: z.array(humanRequestOptionSchema).max(20),
    allowOther: z.boolean(),
    status: humanRequestStatusSchema,
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    resolvedAt: utcTimestampSchema.nullable(),
  })
  .strict();

export const humanRequestAnswerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("OPTION"),
      optionIds: z.array(opaqueIdSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("OTHER"),
      text: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

export const decisionSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    humanRequestId: opaqueIdSchema,
    answer: humanRequestAnswerSchema,
    actor: actorSchema,
    reason: z.string().trim().min(1).max(2_000).nullable(),
    createdAt: utcTimestampSchema,
  })
  .strict();

export const workflowDispatchSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    mode: workflowDispatchModeSchema,
    status: workflowDispatchStatusSchema,
    createdAt: utcTimestampSchema,
    completedAt: utcTimestampSchema.nullable(),
  })
  .strict();

export const humanRequestDraftSchema = humanRequestSchema
  .pick({
    kind: true,
    blocking: true,
    title: true,
    context: true,
    recommendation: true,
    options: true,
    allowOther: true,
  })
  .strict();

export const mockProviderOutcomeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("NEEDS_HUMAN"),
      request: humanRequestDraftSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("COMPLETED"),
      summary: z.string().trim().min(1).max(4_000),
    })
    .strict(),
]);

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

export const pipelineStartedEventSchema = eventBaseSchema.extend({
  type: z.literal("PIPELINE_STARTED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ run: pipelineRunSchema, stageAttempt: stageAttemptSchema }).strict(),
});

export const stageAttemptChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("STAGE_ATTEMPT_CHANGED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      run: pipelineRunSchema,
      stageAttempt: stageAttemptSchema,
      previousStatus: stageAttemptStatusSchema,
    })
    .strict(),
});

export const humanRequestOpenedEventSchema = eventBaseSchema.extend({
  type: z.literal("HUMAN_REQUEST_OPENED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ request: humanRequestSchema }).strict(),
});

export const humanRequestResolvedEventSchema = eventBaseSchema.extend({
  type: z.literal("HUMAN_REQUEST_RESOLVED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ request: humanRequestSchema, decision: decisionSchema }).strict(),
});

export const pipelineCompletedEventSchema = eventBaseSchema.extend({
  type: z.literal("PIPELINE_COMPLETED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ run: pipelineRunSchema, stageAttempt: stageAttemptSchema }).strict(),
});

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const startMockPipelineCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_MOCK_PIPELINE"),
  payload: z
    .object({
      workItemId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      template: workflowTemplateSchema,
    })
    .strict(),
});

export const applyMockProviderOutcomeCommandSchema = commandBaseSchema.extend({
  type: z.literal("APPLY_MOCK_PROVIDER_OUTCOME"),
  payload: z
    .object({
      dispatchId: opaqueIdSchema,
      outcome: mockProviderOutcomeSchema,
      template: workflowTemplateSchema,
    })
    .strict(),
});

export const answerHumanRequestCommandSchema = commandBaseSchema.extend({
  type: z.literal("ANSWER_HUMAN_REQUEST"),
  payload: z
    .object({
      humanRequestId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      answer: humanRequestAnswerSchema,
    })
    .strict(),
});

export const pipelineStartedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("PIPELINE_STARTED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    stageAttempt: stageAttemptSchema,
    dispatch: workflowDispatchSchema,
    events: z.array(pipelineStartedEventSchema),
  })
  .strict();

export const mockProviderOutcomeAppliedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("MOCK_PROVIDER_OUTCOME_APPLIED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    stageAttempt: stageAttemptSchema,
    events: z.array(
      z.discriminatedUnion("type", [
        stageAttemptChangedEventSchema,
        humanRequestOpenedEventSchema,
        pipelineCompletedEventSchema,
      ]),
    ),
  })
  .strict();

export const humanRequestAnsweredResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("HUMAN_REQUEST_ANSWERED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    request: humanRequestSchema,
    decision: decisionSchema,
    dispatch: workflowDispatchSchema,
    events: z.array(humanRequestResolvedEventSchema),
  })
  .strict();

export const startMockPipelineRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const answerHumanRequestRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    answer: humanRequestAnswerSchema,
  })
  .strict();

export const workflowSnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    run: pipelineRunSchema.nullable(),
    stageAttempts: z.array(stageAttemptSchema),
    humanRequests: z.array(humanRequestSchema),
    decisions: z.array(decisionSchema),
  })
  .strict();

export const humanRequestsResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, humanRequests: z.array(humanRequestSchema) })
  .strict();

export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type PipelineRun = z.infer<typeof pipelineRunSchema>;
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;
export type StageAttempt = z.infer<typeof stageAttemptSchema>;
export type StageAttemptStatus = z.infer<typeof stageAttemptStatusSchema>;
export type HumanRequest = z.infer<typeof humanRequestSchema>;
export type HumanRequestStatus = z.infer<typeof humanRequestStatusSchema>;
export type HumanRequestAnswer = z.infer<typeof humanRequestAnswerSchema>;
export type HumanRequestDraft = z.infer<typeof humanRequestDraftSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type WorkflowDispatch = z.infer<typeof workflowDispatchSchema>;
export type MockProviderOutcome = z.infer<typeof mockProviderOutcomeSchema>;
export type PipelineStartedEvent = z.infer<typeof pipelineStartedEventSchema>;
export type StageAttemptChangedEvent = z.infer<typeof stageAttemptChangedEventSchema>;
export type HumanRequestOpenedEvent = z.infer<typeof humanRequestOpenedEventSchema>;
export type HumanRequestResolvedEvent = z.infer<typeof humanRequestResolvedEventSchema>;
export type PipelineCompletedEvent = z.infer<typeof pipelineCompletedEventSchema>;
export type StartMockPipelineCommand = z.infer<typeof startMockPipelineCommandSchema>;
export type ApplyMockProviderOutcomeCommand = z.infer<typeof applyMockProviderOutcomeCommandSchema>;
export type AnswerHumanRequestCommand = z.infer<typeof answerHumanRequestCommandSchema>;
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;
