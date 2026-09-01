import { z } from "zod";

import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";

const absolutePathPattern = /^(?:[/\\]|[A-Za-z]:[/\\])/;
const canonicalDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const mcpProfileNameSchema = z.string().trim().min(1).max(80);
export const mcpToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const mcpExecutablePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(absolutePathPattern, "An MCP executable path must be absolute");
export const mcpArgumentSchema = z.string().min(1).max(2_048);

/**
 * The exact launch recipe an owner is being asked to consent to.
 *
 * It is an argv vector, never a shell string. The structural schema deliberately does not decide
 * whether an executable is safe for C1: a syntactically valid `/bin/sh` must reach the policy
 * layer so the UI can answer "shell launchers are forbidden", rather than collapsing that fact
 * into a generic invalid-request response.
 */
export const mcpProfileCandidateSchema = z
  .object({
    profileId: opaqueIdSchema.nullable(),
    name: mcpProfileNameSchema,
    executable: mcpExecutablePathSchema,
    args: z.array(mcpArgumentSchema).max(32),
    declaredTools: z.array(mcpToolNameSchema).min(1).max(64),
  })
  .strict()
  .superRefine((candidate, context) => {
    const renderedLength =
      candidate.executable.length + candidate.args.reduce((total, argument) => total + argument.length, 0);
    if (renderedLength > 16_384) {
      context.addIssue({ code: "custom", message: "The MCP launch recipe exceeds 16 KiB" });
    }
    if (new Set(candidate.declaredTools).size !== candidate.declaredTools.length) {
      context.addIssue({ code: "custom", message: "Declared MCP tool names must be unique" });
    }
  });

export const mcpProfileProposalSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    challengeId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    candidate: mcpProfileCandidateSchema,
    canonicalDigest: canonicalDigestSchema,
    createdAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
  })
  .strict();

export const mcpProfileRevisionSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    profileId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    revision: z.number().int().positive(),
    name: mcpProfileNameSchema,
    executable: mcpExecutablePathSchema,
    args: z.array(mcpArgumentSchema).max(32),
    declaredTools: z.array(mcpToolNameSchema).min(1).max(64),
    canonicalDigest: canonicalDigestSchema,
    createdAt: utcTimestampSchema,
  })
  .strict();

export const mcpConsentSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    profileRevisionId: opaqueIdSchema,
    canonicalDigest: canonicalDigestSchema,
    ownerId: opaqueIdSchema,
    consentedAt: utcTimestampSchema,
  })
  .strict();

export const mcpCapabilityProbeStateSchema = z.enum([
  "READY",
  "SPAWN_FAILED",
  "TIMED_OUT",
  "INVALID_RESPONSE",
  "OUTPUT_LIMIT_REACHED",
  "UNSUPPORTED_PROTOCOL",
  "PROCESS_EXITED",
]);

export const mcpCapabilitySnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    profileRevisionId: opaqueIdSchema,
    state: mcpCapabilityProbeStateSchema,
    protocolVersion: z.string().min(1).max(80).nullable(),
    tools: z.array(mcpToolNameSchema).max(64),
    resources: z.array(z.string().min(1).max(256)).max(64),
    prompts: z.array(z.string().min(1).max(256)).max(64),
    observedAt: utcTimestampSchema,
  })
  .strict();

export const mcpGrantSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    profileRevisionId: opaqueIdSchema,
    tools: z.array(mcpToolNameSchema).min(1).max(64),
    enabled: z.boolean(),
    version: z.number().int().positive(),
    grantedBy: opaqueIdSchema,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    revokedAt: utcTimestampSchema.nullable(),
  })
  .strict();

export const mcpSessionSnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    providerSessionId: opaqueIdSchema,
    profileRevisionId: opaqueIdSchema,
    profileDigest: canonicalDigestSchema,
    grantId: opaqueIdSchema,
    grantVersion: z.number().int().positive(),
    tools: z.array(mcpToolNameSchema).min(1).max(64),
    createdAt: utcTimestampSchema,
  })
  .strict();

export const mcpToolCallStatusSchema = z.enum(["STARTED", "SUCCEEDED", "FAILED", "UNKNOWN_OUTCOME"]);
export const mcpToolCallFailureCodeSchema = z.enum([
  "TOOL_NOT_GRANTED",
  "GRANT_REVOKED",
  "ARGUMENTS_INVALID",
  "SERVER_UNAVAILABLE",
  "SERVER_ERROR",
  "PROTOCOL_ERROR",
  "DEADLINE_EXCEEDED",
  "OUTPUT_LIMIT_REACHED",
  "CONNECTION_LOST",
]);

export const mcpToolCallRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    providerSessionId: opaqueIdSchema,
    sessionSnapshotId: opaqueIdSchema,
    profileRevisionId: opaqueIdSchema,
    toolName: mcpToolNameSchema,
    inputDigest: canonicalDigestSchema,
    status: mcpToolCallStatusSchema,
    failureCode: mcpToolCallFailureCodeSchema.nullable(),
    startedAt: utcTimestampSchema,
    finishedAt: utcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((call, context) => {
    const started = call.status === "STARTED";
    if (started !== (call.finishedAt === null)) {
      context.addIssue({ code: "custom", message: "Only a started MCP call has no finish time" });
    }
    const failed = call.status === "FAILED" || call.status === "UNKNOWN_OUTCOME";
    if (failed !== (call.failureCode !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only failed or uncertain MCP calls carry a failure code",
      });
    }
  });

const projectEventBaseSchema = z
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

export const mcpProfileConsentedEventSchema = projectEventBaseSchema.extend({
  type: z.literal("MCP_PROFILE_CONSENTED"),
  data: z.object({ revision: mcpProfileRevisionSchema, consent: mcpConsentSchema }).strict(),
});

export const mcpGrantChangedEventSchema = projectEventBaseSchema.extend({
  type: z.literal("MCP_GRANT_CHANGED"),
  data: z.object({ grant: mcpGrantSchema }).strict(),
});

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

/** Internal durable command produced only after the daemon has consumed a proposal challenge. */
export const confirmMcpProfileCommandSchema = commandBaseSchema.extend({
  type: z.literal("CONFIRM_MCP_PROFILE"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      candidate: mcpProfileCandidateSchema,
      canonicalDigest: canonicalDigestSchema,
    })
    .strict(),
});

export const setMcpProfileGrantCommandSchema = commandBaseSchema.extend({
  type: z.literal("SET_MCP_PROFILE_GRANT"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      profileRevisionId: opaqueIdSchema,
      expectedGrantVersion: z.number().int().positive().nullable(),
      tools: z.array(mcpToolNameSchema).min(1).max(64),
      ownerAttestsReadOnly: z.literal(true),
    })
    .strict()
    .superRefine((payload, context) => {
      if (new Set(payload.tools).size !== payload.tools.length) {
        context.addIssue({ code: "custom", message: "Granted MCP tool names must be unique" });
      }
    }),
});

export const revokeMcpProfileGrantCommandSchema = commandBaseSchema.extend({
  type: z.literal("REVOKE_MCP_PROFILE_GRANT"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      expectedProjectVersion: z.number().int().positive(),
      profileRevisionId: opaqueIdSchema,
      expectedGrantVersion: z.number().int().positive(),
    })
    .strict(),
});

/** Internal observation command emitted after the bounded gateway probe has closed its process. */
export const recordMcpCapabilitySnapshotCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECORD_MCP_CAPABILITY_SNAPSHOT"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      profileRevisionId: opaqueIdSchema,
      state: mcpCapabilityProbeStateSchema,
      protocolVersion: z.string().min(1).max(80).nullable(),
      tools: z.array(mcpToolNameSchema).max(64),
      resources: z.array(z.string().min(1).max(256)).max(64),
      prompts: z.array(z.string().min(1).max(256)).max(64),
    })
    .strict(),
});

export const startMcpToolCallCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_MCP_TOOL_CALL"),
  payload: z
    .object({
      sessionSnapshotId: opaqueIdSchema,
      toolName: mcpToolNameSchema,
      inputDigest: canonicalDigestSchema,
    })
    .strict(),
});

const mcpToolCallTerminalOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("SUCCEEDED") }).strict(),
  z.object({ status: z.literal("FAILED"), failureCode: mcpToolCallFailureCodeSchema }).strict(),
  z.object({ status: z.literal("UNKNOWN_OUTCOME"), failureCode: z.literal("CONNECTION_LOST") }).strict(),
]);

export const finishMcpToolCallCommandSchema = commandBaseSchema.extend({
  type: z.literal("FINISH_MCP_TOOL_CALL"),
  payload: z.object({ callId: opaqueIdSchema, outcome: mcpToolCallTerminalOutcomeSchema }).strict(),
});

const commandResultBaseSchema = z
  .object({ schemaVersion: schemaVersionSchema, replayed: z.boolean() })
  .strict();

export const mcpProfileConsentedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("MCP_PROFILE_CONSENTED"),
  revision: mcpProfileRevisionSchema,
  consent: mcpConsentSchema,
  projectVersion: z.number().int().positive(),
  event: mcpProfileConsentedEventSchema,
});

export const mcpGrantChangedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("MCP_GRANT_CHANGED"),
  grant: mcpGrantSchema,
  projectVersion: z.number().int().positive(),
  event: mcpGrantChangedEventSchema,
});

export const mcpCapabilityRecordedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("MCP_CAPABILITY_RECORDED"),
  snapshot: mcpCapabilitySnapshotSchema,
});

export const mcpToolCallChangedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("MCP_TOOL_CALL_CHANGED"),
  call: mcpToolCallRecordSchema,
});

export const proposeMcpProfileRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    expectedProjectVersion: z.number().int().positive(),
    candidate: mcpProfileCandidateSchema,
  })
  .strict();

export const proposeContext7PresetRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    expectedProjectVersion: z.number().int().positive(),
  })
  .strict();

export const confirmMcpProfileRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    challengeId: opaqueIdSchema,
    canonicalDigest: canonicalDigestSchema,
  })
  .strict();

export const probeMcpProfileRequestSchema = z
  .object({ schemaVersion: schemaVersionSchema, commandId: opaqueIdSchema })
  .strict();

export const setMcpProfileGrantRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    expectedGrantVersion: z.number().int().positive().nullable(),
    tools: z.array(mcpToolNameSchema).min(1).max(64),
    ownerAttestsReadOnly: z.literal(true),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.tools).size !== request.tools.length) {
      context.addIssue({ code: "custom", message: "Granted MCP tool names must be unique" });
    }
  });

export const revokeMcpProfileGrantRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedProjectVersion: z.number().int().positive(),
    expectedGrantVersion: z.number().int().positive(),
  })
  .strict();

export const mcpProfileViewSchema = z
  .object({
    revision: mcpProfileRevisionSchema,
    consent: mcpConsentSchema,
    capability: mcpCapabilitySnapshotSchema.nullable(),
    grant: mcpGrantSchema.nullable(),
  })
  .strict();

export const mcpProfilesResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: opaqueIdSchema,
    projectVersion: z.number().int().positive(),
    profiles: z.array(mcpProfileViewSchema),
  })
  .strict();

export type McpProfileCandidate = z.infer<typeof mcpProfileCandidateSchema>;
export type McpProfileProposal = z.infer<typeof mcpProfileProposalSchema>;
export type McpProfileRevision = z.infer<typeof mcpProfileRevisionSchema>;
export type McpConsent = z.infer<typeof mcpConsentSchema>;
export type McpCapabilityProbeState = z.infer<typeof mcpCapabilityProbeStateSchema>;
export type McpCapabilitySnapshot = z.infer<typeof mcpCapabilitySnapshotSchema>;
export type McpGrant = z.infer<typeof mcpGrantSchema>;
export type McpSessionSnapshot = z.infer<typeof mcpSessionSnapshotSchema>;
export type McpToolCallStatus = z.infer<typeof mcpToolCallStatusSchema>;
export type McpToolCallFailureCode = z.infer<typeof mcpToolCallFailureCodeSchema>;
export type McpToolCallRecord = z.infer<typeof mcpToolCallRecordSchema>;
export type McpProfileConsentedEvent = z.infer<typeof mcpProfileConsentedEventSchema>;
export type McpGrantChangedEvent = z.infer<typeof mcpGrantChangedEventSchema>;
export type ConfirmMcpProfileCommand = z.infer<typeof confirmMcpProfileCommandSchema>;
export type SetMcpProfileGrantCommand = z.infer<typeof setMcpProfileGrantCommandSchema>;
export type RevokeMcpProfileGrantCommand = z.infer<typeof revokeMcpProfileGrantCommandSchema>;
export type RecordMcpCapabilitySnapshotCommand = z.infer<typeof recordMcpCapabilitySnapshotCommandSchema>;
export type StartMcpToolCallCommand = z.infer<typeof startMcpToolCallCommandSchema>;
export type FinishMcpToolCallCommand = z.infer<typeof finishMcpToolCallCommandSchema>;
export type McpProfileConsentedResult = z.infer<typeof mcpProfileConsentedResultSchema>;
export type McpGrantChangedResult = z.infer<typeof mcpGrantChangedResultSchema>;
export type McpCapabilityRecordedResult = z.infer<typeof mcpCapabilityRecordedResultSchema>;
export type McpToolCallChangedResult = z.infer<typeof mcpToolCallChangedResultSchema>;
export type McpProfileView = z.infer<typeof mcpProfileViewSchema>;
export type McpProfilesResponse = z.infer<typeof mcpProfilesResponseSchema>;
