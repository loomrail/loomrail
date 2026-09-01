import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

const absolutePathPattern = /^(?:[/\\]|[A-Za-z]:[/\\])/;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const scaffoldRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/)
  .refine(
    (path) =>
      path !== ".loomrail/scaffold.json" && path.split("/").every((part) => part !== "." && part !== ".."),
    "A scaffold file path must be portable and cannot replace the system marker",
  );

export const scaffoldRecipeIdSchema = z.literal("typescript-node");

export const scaffoldFileManifestSchema = z
  .object({
    path: scaffoldRelativePathSchema,
    bytes: z.number().int().positive().max(65_536),
    contentDigest: sha256Schema,
  })
  .strict();

export const scaffoldProposalSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    recipeId: scaffoldRecipeIdSchema,
    recipeVersion: z.literal(1),
    targetPath: z.string().min(1).max(4_096).regex(absolutePathPattern),
    projectName: z.string().min(1).max(80),
    packageName: z.string().min(1).max(80),
    files: z.array(scaffoldFileManifestSchema).min(1).max(32),
    systemFiles: z.tuple([z.literal(".loomrail/scaffold.json")]),
    proposalDigest: sha256Schema,
  })
  .strict();

export const scaffoldOperationStatusSchema = z.enum(["PENDING", "COMPLETED", "FAILED"]);
export const scaffoldOperationErrorCodeSchema = z.enum([
  "TARGET_CONFLICT",
  "TARGET_PARENT_UNAVAILABLE",
  "RECIPE_CHANGED",
  "SCAFFOLD_FILE_CONFLICT",
  "GIT_UNAVAILABLE",
  "GIT_INIT_FAILED",
  "REPOSITORY_INVALID",
  "SCAFFOLD_WRITE_FAILED",
]);

export const scaffoldOperationSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    proposal: scaffoldProposalSchema,
    status: scaffoldOperationStatusSchema,
    attempts: z.number().int().nonnegative(),
    lastErrorCode: scaffoldOperationErrorCodeSchema.nullable(),
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    completedAt: utcTimestampSchema.nullable(),
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

export const projectScaffoldRequestedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_SCAFFOLD_REQUESTED"),
  data: z.object({ operation: scaffoldOperationSchema }).strict(),
});

export const projectScaffoldCompletedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_SCAFFOLD_COMPLETED"),
  data: z.object({ operation: scaffoldOperationSchema }).strict(),
});

export const projectScaffoldFailedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROJECT_SCAFFOLD_FAILED"),
  data: z.object({ operation: scaffoldOperationSchema }).strict(),
});

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const requestProjectScaffoldCommandSchema = commandBaseSchema.extend({
  type: z.literal("REQUEST_PROJECT_SCAFFOLD"),
  payload: z.object({ proposal: scaffoldProposalSchema }).strict(),
});

export const completeProjectScaffoldCommandSchema = commandBaseSchema.extend({
  type: z.literal("COMPLETE_PROJECT_SCAFFOLD"),
  payload: z
    .object({
      operationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

export const failProjectScaffoldCommandSchema = commandBaseSchema.extend({
  type: z.literal("FAIL_PROJECT_SCAFFOLD"),
  payload: z
    .object({
      operationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      errorCode: scaffoldOperationErrorCodeSchema,
    })
    .strict(),
});

export const retryProjectScaffoldCommandSchema = commandBaseSchema.extend({
  type: z.literal("RETRY_PROJECT_SCAFFOLD"),
  payload: z
    .object({
      operationId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
});

const resultBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    replayed: z.boolean(),
  })
  .strict();

export const projectScaffoldRequestedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_SCAFFOLD_REQUESTED"),
  operation: scaffoldOperationSchema,
  event: projectScaffoldRequestedEventSchema,
});

export const projectScaffoldCompletedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_SCAFFOLD_COMPLETED"),
  operation: scaffoldOperationSchema,
  event: projectScaffoldCompletedEventSchema,
});

export const projectScaffoldFailedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_SCAFFOLD_FAILED"),
  operation: scaffoldOperationSchema,
  event: projectScaffoldFailedEventSchema,
});

export const projectScaffoldRetriedResultSchema = resultBaseSchema.extend({
  type: z.literal("PROJECT_SCAFFOLD_RETRIED"),
  operation: scaffoldOperationSchema,
  event: projectScaffoldRequestedEventSchema,
});

export const proposeProjectScaffoldRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    recipeId: scaffoldRecipeIdSchema,
    targetPath: z.string().min(1).max(4_096),
  })
  .strict();

export const proposeProjectScaffoldResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, proposal: scaffoldProposalSchema })
  .strict();

export const publishProjectScaffoldRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    proposal: scaffoldProposalSchema,
  })
  .strict();

export const retryProjectScaffoldRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const scaffoldOperationResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, operation: scaffoldOperationSchema.nullable() })
  .strict();

export const scaffoldOperationsResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, operations: z.array(scaffoldOperationSchema) })
  .strict();

export type ScaffoldFileManifest = z.infer<typeof scaffoldFileManifestSchema>;
export type ScaffoldProposal = z.infer<typeof scaffoldProposalSchema>;
export type ScaffoldOperation = z.infer<typeof scaffoldOperationSchema>;
export type ScaffoldOperationErrorCode = z.infer<typeof scaffoldOperationErrorCodeSchema>;
export type RequestProjectScaffoldCommand = z.infer<typeof requestProjectScaffoldCommandSchema>;
export type CompleteProjectScaffoldCommand = z.infer<typeof completeProjectScaffoldCommandSchema>;
export type FailProjectScaffoldCommand = z.infer<typeof failProjectScaffoldCommandSchema>;
export type RetryProjectScaffoldCommand = z.infer<typeof retryProjectScaffoldCommandSchema>;
export type ProjectScaffoldRequestedEvent = z.infer<typeof projectScaffoldRequestedEventSchema>;
export type ProjectScaffoldCompletedEvent = z.infer<typeof projectScaffoldCompletedEventSchema>;
export type ProjectScaffoldFailedEvent = z.infer<typeof projectScaffoldFailedEventSchema>;
