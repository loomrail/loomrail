import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
};

export const workspaceToolDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const workspaceToolOperationSchema = z.enum([
  "LIST_DIRECTORY",
  "READ_FILE",
  "WRITE_FILE",
  "EDIT_FILE",
  "DELETE_FILE",
  "RUN_RECIPE",
]);
export const workspaceToolTargetSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !hasControlCharacters(value), "Tool target cannot contain controls");
export const workspaceToolCallStatusSchema = z.enum([
  "STARTED",
  "SUCCEEDED",
  "DENIED",
  "FAILED",
  "UNKNOWN_OUTCOME",
]);
export const workspaceToolFailureCodeSchema = z.enum([
  "WORKSPACE_ACCESS_DENIED",
  "PATH_INVALID",
  "PATH_FORBIDDEN",
  "PATH_OUTSIDE_WORKSPACE",
  "SYMLINK_FORBIDDEN",
  "TARGET_NOT_FOUND",
  "TARGET_TYPE_FORBIDDEN",
  "CONTENT_CONFLICT",
  "CONTENT_INVALID",
  "SIZE_LIMIT_REACHED",
  "RECIPE_NOT_APPROVED",
  "RECIPE_AUTHORITY_CHANGED",
  "NETWORK_POLICY_UNAVAILABLE",
  "RECIPE_EXITED_NONZERO",
  "DEADLINE_EXCEEDED",
  "OUTPUT_LIMIT_REACHED",
  "CANCELLED",
  "PROCESS_TERMINATION_FAILED",
  "PROCESS_FAILED",
  "REPLAYED_WITHOUT_OUTPUT",
  "DAEMON_RESTART",
  "INTERNAL_ERROR",
]);

export const workspaceToolCallRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    agentRunId: opaqueIdSchema,
    providerSessionId: opaqueIdSchema,
    providerCallKey: workspaceToolDigestSchema,
    operation: workspaceToolOperationSchema,
    target: workspaceToolTargetSchema,
    policyDigest: workspaceToolDigestSchema,
    inputDigest: workspaceToolDigestSchema,
    status: workspaceToolCallStatusSchema,
    failureCode: workspaceToolFailureCodeSchema.nullable(),
    outputDigest: workspaceToolDigestSchema.nullable(),
    outputBytes: z.number().int().nonnegative().max(262_144).nullable(),
    exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
    startedAt: utcTimestampSchema,
    finishedAt: utcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((call, context) => {
    if ((call.status === "STARTED") !== (call.finishedAt === null)) {
      context.addIssue({ code: "custom", message: "Only a started workspace tool call is unfinished" });
    }
    if ((call.status === "SUCCEEDED") !== (call.failureCode === null)) {
      if (call.status !== "STARTED") {
        context.addIssue({
          code: "custom",
          message: "A successful workspace tool call has no failure code and every terminal failure has one",
        });
      }
    }
    if (call.status === "STARTED" && call.failureCode !== null) {
      context.addIssue({ code: "custom", message: "A started workspace tool call has no failure code" });
    }
  });

const eventBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sequence: z.number().int().positive(),
    id: opaqueIdSchema,
    aggregateType: z.literal("WORK_ITEM"),
    aggregateId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const workspaceToolCallChangedEventSchema = eventBaseSchema.extend({
  type: z.literal("WORKSPACE_TOOL_CALL_CHANGED"),
  data: z.object({ call: workspaceToolCallRecordSchema }).strict(),
});

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

export const startWorkspaceToolCallCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_WORKSPACE_TOOL_CALL"),
  payload: z
    .object({
      providerSessionId: opaqueIdSchema,
      providerCallKey: workspaceToolDigestSchema,
      operation: workspaceToolOperationSchema,
      target: workspaceToolTargetSchema,
      policyDigest: workspaceToolDigestSchema,
      inputDigest: workspaceToolDigestSchema,
    })
    .strict(),
});

export const workspaceToolTerminalOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("SUCCEEDED"),
      outputDigest: workspaceToolDigestSchema.nullable(),
      outputBytes: z.number().int().nonnegative().max(262_144).nullable(),
      exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.enum(["DENIED", "FAILED", "UNKNOWN_OUTCOME"]),
      failureCode: workspaceToolFailureCodeSchema,
      outputDigest: workspaceToolDigestSchema.nullable(),
      outputBytes: z.number().int().nonnegative().max(262_144).nullable(),
      exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
    })
    .strict(),
]);

export const finishWorkspaceToolCallCommandSchema = commandBaseSchema.extend({
  type: z.literal("FINISH_WORKSPACE_TOOL_CALL"),
  payload: z.object({ callId: opaqueIdSchema, outcome: workspaceToolTerminalOutcomeSchema }).strict(),
});

export const workspaceToolCallChangedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("WORKSPACE_TOOL_CALL_CHANGED"),
    replayed: z.boolean(),
    call: workspaceToolCallRecordSchema,
    events: z.array(workspaceToolCallChangedEventSchema).max(1),
  })
  .strict();

export type WorkspaceToolOperation = z.infer<typeof workspaceToolOperationSchema>;
export type WorkspaceToolCallStatus = z.infer<typeof workspaceToolCallStatusSchema>;
export type WorkspaceToolFailureCode = z.infer<typeof workspaceToolFailureCodeSchema>;
export type WorkspaceToolCallRecord = z.infer<typeof workspaceToolCallRecordSchema>;
export type WorkspaceToolCallChangedEvent = z.infer<typeof workspaceToolCallChangedEventSchema>;
export type WorkspaceToolTerminalOutcome = z.infer<typeof workspaceToolTerminalOutcomeSchema>;
export type StartWorkspaceToolCallCommand = z.infer<typeof startWorkspaceToolCallCommandSchema>;
export type FinishWorkspaceToolCallCommand = z.infer<typeof finishWorkspaceToolCallCommandSchema>;
export type WorkspaceToolCallChangedResult = z.infer<typeof workspaceToolCallChangedResultSchema>;
