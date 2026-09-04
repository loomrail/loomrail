import { z } from "zod";

import { opaqueIdSchema, schemaVersionSchema } from "./shared.js";
import { prioritySchema, workItemStateSchema } from "./work-management.js";
import { humanRequestSchema, stageAttemptStatusSchema, workflowStageSchema } from "./workflow.js";

export const maxAttentionItems = 200;
export const maxAttentionProjectionSources = maxAttentionItems + 1;

export const attentionSectionSchema = z.enum([
  "BLOCKING_NOW",
  "APPROVALS",
  "QUESTIONS",
  "MANUAL_ACTIONS",
  "SOON",
]);

export const attentionCategorySchema = z.enum(["APPROVAL", "QUESTION", "MANUAL_ACTION"]);
export const attentionActionSchema = z.enum(["ANSWER_REQUEST", "REVIEW_ACCEPTANCE"]);
export const attentionReasonSchema = z.enum(["PROVIDER_RATE_LIMITED"]);

export const attentionItemSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    request: humanRequestSchema,
    project: z
      .object({
        id: opaqueIdSchema,
        name: z.string().trim().min(1).max(200),
      })
      .strict(),
    workItem: z
      .object({
        id: opaqueIdSchema,
        title: z.string().trim().min(1).max(200),
        priority: prioritySchema,
        state: workItemStateSchema,
      })
      .strict(),
    stage: z
      .object({
        id: opaqueIdSchema,
        name: workflowStageSchema,
        status: stageAttemptStatusSchema,
      })
      .strict(),
    section: attentionSectionSchema,
    category: attentionCategorySchema,
    reason: attentionReasonSchema.nullable(),
    action: attentionActionSchema,
    acceptancePackageId: opaqueIdSchema.nullable(),
    affectedStages: z.array(workflowStageSchema).min(1).max(20),
  })
  .strict();

export const attentionInboxResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    items: z.array(attentionItemSchema).max(maxAttentionItems),
    hasMore: z.boolean(),
  })
  .strict();

export type AttentionSection = z.infer<typeof attentionSectionSchema>;
export type AttentionCategory = z.infer<typeof attentionCategorySchema>;
export type AttentionAction = z.infer<typeof attentionActionSchema>;
export type AttentionReason = z.infer<typeof attentionReasonSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;
export type AttentionInboxResponse = z.infer<typeof attentionInboxResponseSchema>;
