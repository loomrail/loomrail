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
  "SOFT_PAUSED",
  "HARD_PAUSED",
  "INTERRUPTED",
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
export const usageQualitySchema = z.enum(["ACTUAL", "PROVIDER_ESTIMATE", "LOOMRAIL_ESTIMATE"]);
export const usageKindSchema = z.literal("ESTIMATED_TOKENS");
export const budgetPauseKindSchema = z.enum(["SOFT", "HARD"]);
export const recoveryReasonSchema = z.literal("DAEMON_RESTART");
export const evidenceArtifactKindSchema = z.enum(["REVIEW_REPORT", "QA_REPORT"]);
export const evidenceArtifactStatusSchema = z.literal("PASSED");
export const acceptanceStatusSchema = z.enum(["PENDING", "ACCEPTED", "RETURNED", "REJECTED"]);
export const acceptanceActionSchema = z.enum(["ACCEPT", "RETURN_TO_WORK", "REJECT"]);
export const providerSessionStatusSchema = z.enum(["RUNNING", "ENDED"]);
export const providerSessionEndReasonSchema = z.enum([
  "COMPLETED",
  "HANDOFF",
  "CONTEXT_EXHAUSTED",
  "INTERRUPTED",
  "CANCELLED",
]);
// The kinds a context-pack section's provenance can point at (packages/context-assembly's
// render.ts is the only producer today). WORKFLOW_POSITION carries no source: templateId and
// templateVersion are recorded at the recipe's top level instead (spec §4.2).
export const contextSourceKindSchema = z.enum([
  "WORK_ITEM",
  "DECISION",
  "CHECKPOINT",
  "EVIDENCE",
  "ACTIVITY",
]);
export const contextPackSpecSourceSchema = z.literal("WORKFLOW_TEMPLATE"); // A3 adds ROLE_PLAYBOOK
export const contextPackOmittedReasonSchema = z.literal("CONTEXT_BUDGET");

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().min(1).max(4_000);
const budgetThresholdSchema = z.number().positive().max(1);

export const contextSectionIdSchema = z.enum([
  "WORK_ITEM_BRIEF",
  "WORKFLOW_POSITION",
  "DECISIONS",
  "LATEST_CHECKPOINT",
  "EVIDENCE",
  "ACTIVITY",
]);

export const contextPackSectionSchema = z
  .object({
    id: contextSectionIdSchema,
    ordinal: z.number().int().nonnegative(),
    required: z.boolean(),
  })
  .strict();

export const contextPackSpecSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sections: z.array(contextPackSectionSchema).min(1).max(20),
  })
  .strict();

export type ContextSectionId = z.infer<typeof contextSectionIdSchema>;
export type ContextPackSpec = z.infer<typeof contextPackSpecSchema>;

// The assembled pack that crosses the provider-adapter boundary (A2). Declared here rather than
// in @loomrail/context-assembly so that provider-core can depend on the type without depending on
// an assembly implementation package for it.
export const contextPackSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    text: z.string(),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export type ContextPack = z.infer<typeof contextPackSchema>;

// Per-section provenance is a list, not a single { kind, id, version } pair: cardinality carries
// meaning (0 = a genuinely derived section, 1 = one durable entity, N = a collection), and
// DECISIONS/EVIDENCE/ACTIVITY are collections of records, each with its own id and version. A
// single pair cannot express N of them. This mirrors ContextPackRecipeDraft in
// packages/context-assembly/src/assemble.ts, which is the only producer of this shape today.
export const contextPackRecipeSourceSchema = z
  .object({
    kind: contextSourceKindSchema,
    id: opaqueIdSchema,
    version: z.number().int().positive(),
  })
  .strict();

// The cap on how many source records one section of a recipe may cite. Exported rather than
// inlined because the persistence layer's collection reads (READ_CONTEXT_SOURCES) have to be
// bounded by the *same* number: a work item with more decisions than this used to produce a recipe
// that `contextPackRecipeInputSchema.parse` rejected, which threw out of the session loop -- and out
// of daemon startup, if the attempt was picked up by the boot drain. A narrower pack is a degraded
// session; an unparseable recipe is no session at all.
export const maxContextPackRecipeSources = 200;

export const contextPackRecipeSectionSchema = z
  .object({
    id: contextSectionIdSchema,
    sources: z.array(contextPackRecipeSourceSchema).max(maxContextPackRecipeSources),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const contextPackRecipeOmittedSectionSchema = z
  .object({
    id: contextSectionIdSchema,
    reason: contextPackOmittedReasonSchema,
  })
  .strict();

// Persisted alongside the assembled pack (spec §4.2). `sections`/`omitted`/`estimatedTokens`/
// `budgetTokens` are exactly what the assembler's ContextPackRecipeDraft emits; the remaining
// fields (id, providerSessionId, templateId, templateVersion, specSource, contentHash,
// estimateQuality, createdAt) are added by the persistence layer that writes the recipe alongside
// the session and the PROVIDER_SESSION_STARTED event.
export const contextPackRecipeSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    providerSessionId: opaqueIdSchema,
    templateId: opaqueIdSchema,
    templateVersion: z.number().int().positive(),
    specSource: contextPackSpecSourceSchema,
    sections: z.array(contextPackRecipeSectionSchema).min(1).max(20),
    omitted: z.array(contextPackRecipeOmittedSectionSchema).max(20),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    estimatedTokens: z.number().int().nonnegative(),
    budgetTokens: z.number().int().positive(),
    estimateQuality: usageQualitySchema,
    createdAt: utcTimestampSchema,
  })
  .strict();

export const providerSessionSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    ordinal: z.number().int().positive(),
    status: providerSessionStatusSchema,
    endReason: providerSessionEndReasonSchema.nullable(),
    handoffRequestedAt: utcTimestampSchema.nullable(),
    startedAt: utcTimestampSchema,
    endedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
    // Task 10 / spec §8: the OS pid of the child process this RUNNING session is driving, so a
    // daemon that dies without killing it can still find and kill that process on the next start.
    // Nullable, not defaulted to 0 -- "no process was ever started" and "a process whose pid is 0"
    // are different facts, and a defaulted column could not tell them apart. Set once, at start;
    // nothing here updates it later.
    pid: z.number().int().positive().nullable(),
  })
  .strict()
  .refine(
    (session) => (session.status === "ENDED") === (session.endReason !== null),
    "An ended session must carry an end reason and a running one must not",
  )
  .refine(
    (session) => (session.status === "ENDED") === (session.endedAt !== null),
    "An ended session must carry an end timestamp and a running one must not",
  );

// What the agent publishes mid-session (spec §5.1's onCheckpoint). Empty completed/remaining/
// deadEnds/openQuestions lists are legitimate -- a session may genuinely have hit no dead ends --
// but a checkpoint with no summary carries nothing forward to the next session's context pack.
export const checkpointDraftSchema = z
  .object({
    summary: descriptionSchema,
    completed: z.array(z.string().trim().min(1).max(500)).max(50),
    remaining: z.array(z.string().trim().min(1).max(500)).max(50),
    deadEnds: z.array(z.string().trim().min(1).max(500)).max(50),
    openQuestions: z.array(z.string().trim().min(1).max(500)).max(50),
  })
  .strict();

// Checkpoint is append-only and never edited (D7): unlike the other entities in this file it
// carries no optimistic-concurrency `version` field, matching evidenceArtifactSchema's pattern.
export const checkpointSchema = checkpointDraftSchema
  .extend({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    providerSessionId: opaqueIdSchema,
    ordinal: z.number().int().positive(),
    createdAt: utcTimestampSchema,
  })
  .strict();

export const contextWindowUsageSchema = z
  .object({
    usedTokens: z.number().int().nonnegative(),
    windowTokens: z.number().int().positive(),
    quality: usageQualitySchema,
  })
  .strict()
  .refine((usage) => usage.usedTokens <= usage.windowTokens, "Usage cannot exceed the window");

// A separate channel from ContextWindowUsage on purpose (spec BD-001). Window occupancy drives
// session handoff; spend drives budget thresholds and the HARD pause. They are different
// quantities with different consumers, and folding one into the other would oblige the consumer
// of one to parse the other. `costUsd` is optional because not every provider prices its own
// usage; the token fields are the figures every provider can report. `.strict()` matters here more
// than on most schemas: this is the one channel a provider could otherwise use to smuggle
// arbitrary content (e.g. a `transcript` field) past the contract as though it were spend.
export const providerUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    quality: usageQualitySchema,
  })
  .strict();

export type ContextSourceKind = z.infer<typeof contextSourceKindSchema>;
export type ContextPackRecipeSource = z.infer<typeof contextPackRecipeSourceSchema>;
export type ContextPackRecipeSection = z.infer<typeof contextPackRecipeSectionSchema>;
export type ContextPackRecipeOmittedSection = z.infer<typeof contextPackRecipeOmittedSectionSchema>;
export type ContextPackRecipe = z.infer<typeof contextPackRecipeSchema>;
export type ProviderSessionStatus = z.infer<typeof providerSessionStatusSchema>;
export type ProviderSessionEndReason = z.infer<typeof providerSessionEndReasonSchema>;
export type ProviderSession = z.infer<typeof providerSessionSchema>;
export type CheckpointDraft = z.infer<typeof checkpointDraftSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type ContextWindowUsage = z.infer<typeof contextWindowUsageSchema>;
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const workflowTemplateStageSchema = z
  .object({
    stage: workflowStageSchema,
    ordinal: z.number().int().nonnegative(),
    contextPack: contextPackSpecSchema,
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
    // §6.5: a session that publishes no checkpoint is unproductive; two in a row trigger a
    // HARD-pause. Lives on the StageAttempt (not in daemon memory) so a daemon restart -- itself
    // a normal end of a session -- cannot reset the very guard meant to catch that scenario.
    unproductiveSessions: z.number().int().nonnegative(),
    // §7: how many times the pack share has been stepped down after a provider rejected a pack
    // Loomrail judged as fitting. Durable for exactly the reason `unproductiveSessions` is: §6.4
    // makes a daemon restart an ordinary end of a session, so a counter held in daemon memory
    // would be cleared by the very event the "one automatic retry, then ask" rule must survive.
    packShareBackoffs: z.number().int().nonnegative(),
  })
  .strict();

// The `StageAttempt.failureCode` values that mark a HARD pause as raised by the session loop
// (spec §6.5, §D8, §7) rather than by the token budget. Lives here, not in @loomrail/domain,
// because it has two consumers on either side of the apps/web boundary: `decideAnswerHumanRequest`
// and `decideApproveBudgetOverride` (packages/domain) decide behaviour from it, and the Task
// Cockpit (apps/web) decides display from it -- apps/web depends on @loomrail/contracts and
// @loomrail/ui only, never on @loomrail/domain, so a single shared list here is what keeps the two
// readings of "is this a session pause" from drifting apart. That drift is exactly what shipped as
// a defect once already: the cockpit read every HARD_PAUSED attempt as a budget pause and offered
// an "approve budget override" action that decideApproveBudgetOverride throws on for these codes.
export const sessionPauseFailureCodes = [
  "NO_PROGRESS",
  "CONTEXT_FLOOR_EXCEEDED",
  "PROVIDER_REJECTED_PACK",
  "PROVIDER_START_FAILED",
  "SESSION_LIMIT_REACHED",
] as const;

export type SessionPauseFailureCode = (typeof sessionPauseFailureCodes)[number];

export const isSessionPauseFailureCode = (code: string | null): code is SessionPauseFailureCode =>
  code !== null && (sessionPauseFailureCodes as readonly string[]).includes(code);

export const budgetPolicySchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    revision: z.number().int().positive(),
    maxEstimatedTokens: z.number().int().positive(),
    warningThresholds: z.array(budgetThresholdSchema).min(1).max(10),
    createdBy: actorSchema,
    createdAt: utcTimestampSchema,
  })
  .strict();

export const usageRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    budgetPolicyId: opaqueIdSchema,
    kind: usageKindSchema,
    amount: z.number().int().positive(),
    quality: usageQualitySchema,
    recordedAt: utcTimestampSchema,
  })
  .strict();

export const recoveryReportSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    previousStatus: z.literal("RUNNING"),
    recoveredStatus: z.literal("INTERRUPTED"),
    reason: recoveryReasonSchema,
    createdAt: utcTimestampSchema,
  })
  .strict();

export const providerArtifactDraftSchema = z
  .object({
    kind: evidenceArtifactKindSchema,
    title: titleSchema,
    summary: descriptionSchema,
    checks: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  })
  .strict();

export const evidenceArtifactSchema = providerArtifactDraftSchema
  .extend({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    stage: z.enum(["REVIEW", "QA"]),
    status: evidenceArtifactStatusSchema,
    provider: z.literal("MOCK"),
    createdAt: utcTimestampSchema,
  })
  .strict();

export const acceptanceCriterionEvidenceSchema = z
  .object({
    criterion: z.string().trim().min(1).max(500),
    implementation: descriptionSchema,
    reviewArtifactId: opaqueIdSchema,
    qaArtifactId: opaqueIdSchema,
    verification: descriptionSchema,
    knownRisk: descriptionSchema.nullable(),
  })
  .strict();

export const acceptancePackageSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    humanRequestId: opaqueIdSchema,
    status: acceptanceStatusSchema,
    criteria: z.array(acceptanceCriterionEvidenceSchema).max(50),
    artifactIds: z.array(opaqueIdSchema).min(2).max(20),
    releaseNote: descriptionSchema,
    verifyInstructions: z.array(descriptionSchema).min(1).max(20),
    version: z.number().int().positive(),
    createdAt: utcTimestampSchema,
    resolvedAt: utcTimestampSchema.nullable(),
    resolvedBy: actorSchema.nullable(),
    resolutionReason: descriptionSchema.nullable(),
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

export const providerOutcomeSchema = z.discriminatedUnion("type", [
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
      artifacts: z.array(providerArtifactDraftSchema).max(5).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("READY_FOR_ACCEPTANCE"),
      releaseNote: descriptionSchema,
      verifyInstructions: z.array(descriptionSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("BUDGET_LIMIT_REACHED"),
      usageIncrements: z.array(z.number().int().positive()).min(1).max(100),
      quality: usageQualitySchema,
    })
    .strict(),
  // Session-level results (spec §5.2, §6.3): the session wound down before the stage finished.
  // HANDED_OFF always carries the checkpoint it wound down with; CONTEXT_EXHAUSTED may not --
  // the adapter hit the wall before it could publish one, which is exactly the unproductive-
  // session case spec §6.5 guards against. Both are handled by the session loop, not by
  // decideApplyProviderOutcome (see the guard there).
  z
    .object({
      type: z.literal("HANDED_OFF"),
      checkpoint: checkpointDraftSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("CONTEXT_EXHAUSTED"),
      checkpoint: checkpointDraftSchema.optional(),
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
  data: z
    .object({ run: pipelineRunSchema, stageAttempt: stageAttemptSchema, budgetPolicy: budgetPolicySchema })
    .strict(),
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

export const usageRecordedEventSchema = eventBaseSchema.extend({
  type: z.literal("USAGE_RECORDED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ usageRecord: usageRecordSchema, cumulativeAmount: z.number().int().positive() }).strict(),
});

export const budgetThresholdReachedEventSchema = eventBaseSchema.extend({
  type: z.literal("BUDGET_THRESHOLD_REACHED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      budgetPolicy: budgetPolicySchema,
      threshold: budgetThresholdSchema,
      cumulativeAmount: z.number().int().nonnegative(),
    })
    .strict(),
});

export const pipelinePausedEventSchema = eventBaseSchema.extend({
  type: z.literal("PIPELINE_PAUSED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      run: pipelineRunSchema,
      stageAttempt: stageAttemptSchema,
      kind: budgetPauseKindSchema,
      reason: descriptionSchema,
    })
    .strict(),
});

export const pipelineResumedEventSchema = eventBaseSchema.extend({
  type: z.literal("PIPELINE_RESUMED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ run: pipelineRunSchema, stageAttempt: stageAttemptSchema }).strict(),
});

export const pipelineCancelledEventSchema = eventBaseSchema.extend({
  type: z.literal("PIPELINE_CANCELLED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ run: pipelineRunSchema, stageAttempt: stageAttemptSchema }).strict(),
});

export const budgetOverrideApprovedEventSchema = eventBaseSchema.extend({
  type: z.literal("BUDGET_OVERRIDE_APPROVED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      run: pipelineRunSchema,
      previousStageAttempt: stageAttemptSchema,
      stageAttempt: stageAttemptSchema,
      budgetPolicy: budgetPolicySchema,
    })
    .strict(),
});

export const recoveryReportCreatedEventSchema = eventBaseSchema.extend({
  type: z.literal("RECOVERY_REPORT_CREATED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({ report: recoveryReportSchema, run: pipelineRunSchema, stageAttempt: stageAttemptSchema })
    .strict(),
});

export const evidenceArtifactRecordedEventSchema = eventBaseSchema.extend({
  type: z.literal("EVIDENCE_ARTIFACT_RECORDED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ artifact: evidenceArtifactSchema }).strict(),
});

export const acceptanceRequestedEventSchema = eventBaseSchema.extend({
  type: z.literal("ACCEPTANCE_REQUESTED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      acceptancePackage: acceptancePackageSchema,
      request: humanRequestSchema,
      run: pipelineRunSchema,
      stageAttempt: stageAttemptSchema,
    })
    .strict(),
});

export const acceptanceResolvedEventSchema = eventBaseSchema.extend({
  type: z.literal("ACCEPTANCE_RESOLVED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      action: acceptanceActionSchema,
      acceptancePackage: acceptancePackageSchema,
      request: humanRequestSchema,
      decision: decisionSchema,
      run: pipelineRunSchema,
      stageAttempt: stageAttemptSchema,
    })
    .strict(),
});

export const pipelineCompletedEventSchema = eventBaseSchema.extend({
  type: z.literal("PIPELINE_COMPLETED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ run: pipelineRunSchema, stageAttempt: stageAttemptSchema }).strict(),
});

// Spec §4.4: PROVIDER_SESSION_STARTED must carry the recipe's contentHash and the list of omitted
// section ids, so a reader of the audit log can see what the agent was and was not given without
// loading the recipe row. Embedding the full recipe -- which contentHash and omitted are already
// fields of -- satisfies that without inventing a second, narrower shape to keep in sync with it.
export const providerSessionStartedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROVIDER_SESSION_STARTED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ session: providerSessionSchema, recipe: contextPackRecipeSchema }).strict(),
});

export const checkpointPublishedEventSchema = eventBaseSchema.extend({
  type: z.literal("CHECKPOINT_PUBLISHED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ checkpoint: checkpointSchema }).strict(),
});

// Emitted once per ProviderSession, on the first occupancy report that crosses
// handoffThreshold (spec §6.2). Carries the usage that triggered it so the audit trail shows why
// the session started winding down, not just that it did.
export const contextHandoffRequestedEventSchema = eventBaseSchema.extend({
  type: z.literal("CONTEXT_HANDOFF_REQUESTED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ session: providerSessionSchema, usage: contextWindowUsageSchema }).strict(),
});

export const providerSessionEndedEventSchema = eventBaseSchema.extend({
  type: z.literal("PROVIDER_SESSION_ENDED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ session: providerSessionSchema }).strict(),
});

// Spec §D8 and §6.1 step 3: the required sections did not fit the pack budget, so no session was
// started at all. The byte figures are on the event rather than only in a log line because "the
// required core does not fit" is only actionable to an owner who can see by how much -- and because
// no ContextPackRecipe exists to carry them: the assembly stopped before producing one.
export const contextFloorExceededEventSchema = eventBaseSchema.extend({
  type: z.literal("CONTEXT_FLOOR_EXCEEDED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z
    .object({
      run: pipelineRunSchema,
      stageAttempt: stageAttemptSchema,
      sessionOrdinal: z.number().int().positive(),
      requiredBytes: z.number().int().nonnegative(),
      budgetBytes: z.number().int().nonnegative(),
      budgetTokens: z.number().int().positive(),
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

export const startMockPipelineCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_MOCK_PIPELINE"),
  payload: z
    .object({
      workItemId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      template: workflowTemplateSchema,
      budget: z
        .object({
          maxEstimatedTokens: z.number().int().positive(),
          warningThresholds: z.array(budgetThresholdSchema).min(1).max(10),
        })
        .strict(),
    })
    .strict(),
});

export const markWorkflowDispatchStartedCommandSchema = commandBaseSchema.extend({
  type: z.literal("MARK_WORKFLOW_DISPATCH_STARTED"),
  payload: z.object({ dispatchId: opaqueIdSchema }).strict(),
});

const applyProviderOutcomePayloadSchema = z
  .object({
    dispatchId: opaqueIdSchema,
    outcome: providerOutcomeSchema,
    template: workflowTemplateSchema,
  })
  .strict();

export const applyProviderOutcomeCommandSchema = commandBaseSchema.extend({
  type: z.literal("APPLY_PROVIDER_OUTCOME"),
  payload: applyProviderOutcomePayloadSchema,
});

// "APPLY_MOCK_PROVIDER_OUTCOME" is the historical discriminant: commands already recorded under
// that name (the commands table is append-only audit history and is not rewritten) must still
// parse when the same commandId is resubmitted, so the receipt cache can return the cached
// result. Kept as a distinct single-literal schema (rather than folded into
// applyProviderOutcomeCommandSchema's type as a two-value literal) so every member of
// stateCommandSchema keeps a single-literal discriminant and TypeScript can still narrow it away
// completely once handled. Nothing constructs a fresh command with this type going forward.
export const legacyApplyMockProviderOutcomeCommandSchema = commandBaseSchema.extend({
  type: z.literal("APPLY_MOCK_PROVIDER_OUTCOME"),
  payload: applyProviderOutcomePayloadSchema,
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

const pipelineControlPayloadSchema = z
  .object({
    pipelineRunId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const pausePipelineCommandSchema = commandBaseSchema.extend({
  type: z.literal("PAUSE_PIPELINE"),
  payload: pipelineControlPayloadSchema,
});

export const resumePipelineCommandSchema = commandBaseSchema.extend({
  type: z.literal("RESUME_PIPELINE"),
  payload: pipelineControlPayloadSchema,
});

export const cancelPipelineCommandSchema = commandBaseSchema.extend({
  type: z.literal("CANCEL_PIPELINE"),
  payload: pipelineControlPayloadSchema,
});

export const approveBudgetOverrideCommandSchema = commandBaseSchema.extend({
  type: z.literal("APPROVE_BUDGET_OVERRIDE"),
  payload: pipelineControlPayloadSchema.extend({
    maxEstimatedTokens: z.number().int().positive(),
  }),
});

export const reconcileWorkflowsCommandSchema = commandBaseSchema.extend({
  type: z.literal("RECONCILE_WORKFLOWS"),
  payload: z.object({}).strict(),
});

export const resolveAcceptanceCommandSchema = commandBaseSchema.extend({
  type: z.literal("RESOLVE_ACCEPTANCE"),
  payload: z
    .object({
      acceptancePackageId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      expectedRunVersion: z.number().int().positive(),
      action: acceptanceActionSchema,
      reason: descriptionSchema.nullable(),
    })
    .strict(),
});

// What START_PROVIDER_SESSION's caller submits for the recipe: context-assembly's
// ContextPackRecipeDraft (sections/omitted/estimatedTokens/budgetTokens, the assembler's own
// output) plus the fields the assembler cannot know -- templateId/templateVersion/specSource come
// from the stage's ContextPackSpec, contentHash from the assembled ContextPack, estimateQuality
// from the caller's window-size source. Everything else (id, providerSessionId, createdAt) is
// assigned by the persistence layer that writes this alongside the ProviderSession (spec §6.1 step
// 4). Named distinctly from context-assembly's ContextPackRecipeDraft -- the two are different
// shapes sharing a concept (10 fields here vs. 4 there), and collapsing the names would send a
// reader through StartProviderSessionCommand["payload"]["recipe"] to find this instead of
// importing it directly.
export const contextPackRecipeInputSchema = contextPackRecipeSchema.omit({
  id: true,
  providerSessionId: true,
  createdAt: true,
});

export const startProviderSessionCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_PROVIDER_SESSION"),
  payload: z
    .object({
      stageAttemptId: opaqueIdSchema,
      recipe: contextPackRecipeInputSchema,
      // Optional, not required: no live adapter today has a channel to report its child's pid
      // back to the caller before `ProviderAdapter.start()` resolves (it spawns the process deep
      // inside its own `start()` call and only returns once the session has already ended), so
      // every existing caller omits it and the session is recorded with no known process. A
      // caller that does know a pid up front -- a test, or a future adapter with a real channel --
      // can still record it here. Omitted and `null` are treated identically by the command
      // handler; the ProviderSession itself always carries `pid` as `null`, not absent.
      pid: z.number().int().positive().nullable().optional(),
    })
    .strict(),
});

export const publishCheckpointCommandSchema = commandBaseSchema.extend({
  type: z.literal("PUBLISH_CHECKPOINT"),
  payload: z
    .object({
      providerSessionId: opaqueIdSchema,
      checkpoint: checkpointDraftSchema,
    })
    .strict(),
});

export const endProviderSessionCommandSchema = commandBaseSchema.extend({
  type: z.literal("END_PROVIDER_SESSION"),
  payload: z
    .object({
      providerSessionId: opaqueIdSchema,
      endReason: providerSessionEndReasonSchema,
      // Whether the provider actually began running this session. Spec §6.5's unproductive-session
      // guard is about an agent that ran and published nothing; a session the adapter refused to
      // start never had the chance, and §7's pack-size branch owns that case instead. Recording the
      // fact rather than the rule keeps `endReason` truthful in the audit log: the session really
      // was interrupted, it just was not the agent's silence that interrupted it.
      providerStarted: z.boolean(),
    })
    .strict()
    .refine(
      (payload) => payload.providerStarted || payload.endReason === "INTERRUPTED",
      "A session the provider never started can only have ended as INTERRUPTED",
    ),
});

// Spec §6.2. The caller supplies the occupancy report and the threshold it is judged against;
// whether this is the first crossing (and therefore whether a handoff is requested at all) is
// decided from the stored session, not from the caller, so a repeated report is a safe no-op.
export const requestContextHandoffCommandSchema = commandBaseSchema.extend({
  type: z.literal("REQUEST_CONTEXT_HANDOFF"),
  payload: z
    .object({
      providerSessionId: opaqueIdSchema,
      usage: contextWindowUsageSchema,
      handoffThreshold: budgetThresholdSchema,
    })
    .strict(),
});

// The two ways a session fails to happen at all, both of which spec §D8/§7 resolve the same way:
// a HARD pause plus a question to the owner. Kept as one command with a discriminated reason
// rather than two near-identical commands, because everything except the wording of the question
// and one event is shared.
export const stageAttemptHardPauseReasonSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("CONTEXT_FLOOR_EXCEEDED"),
      sessionOrdinal: z.number().int().positive(),
      requiredBytes: z.number().int().nonnegative(),
      budgetBytes: z.number().int().nonnegative(),
      budgetTokens: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("PROVIDER_REJECTED_PACK"),
      sessionOrdinal: z.number().int().positive(),
    })
    .strict(),
  // A provider failure that is not a size rejection. Kept apart from PROVIDER_REJECTED_PACK so a
  // transient error is never answered by shrinking the pack, and so the owner is not asked about
  // a context size that had nothing to do with it (spec §6.3 routes failures to existing handling).
  z
    .object({
      type: z.literal("PROVIDER_START_FAILED"),
      sessionOrdinal: z.number().int().positive(),
    })
    .strict(),
  // The session loop's own backstop (spec §6.5). Not a way a session fails to happen, but the one
  // way the attempt stops without any session having failed: the provider kept handing off
  // productively and the attempt never finished. It resolves the same way as the others -- pause,
  // withdraw the dispatch, ask the owner -- because the alternative is a loop that logs and leaves
  // its dispatch PENDING for the drain to pick up again.
  z
    .object({
      type: z.literal("SESSION_LIMIT_REACHED"),
      sessionOrdinal: z.number().int().positive(),
      maxSessions: z.number().int().positive(),
    })
    .strict(),
]);

// Spec §7's one automatic retry after a rejected pack. A command of its own rather than a flag on
// END_PROVIDER_SESSION: the reduction is a durable state change on the StageAttempt with its own
// audit event, and folding it into the session's end would hide it inside a command about
// something else.
export const reduceContextPackShareCommandSchema = commandBaseSchema.extend({
  type: z.literal("REDUCE_CONTEXT_PACK_SHARE"),
  payload: z.object({ stageAttemptId: opaqueIdSchema }).strict(),
});

export const hardPauseStageAttemptCommandSchema = commandBaseSchema.extend({
  type: z.literal("HARD_PAUSE_STAGE_ATTEMPT"),
  payload: z
    .object({
      stageAttemptId: opaqueIdSchema,
      reason: stageAttemptHardPauseReasonSchema,
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
    budgetPolicy: budgetPolicySchema,
    dispatch: workflowDispatchSchema,
    events: z.array(pipelineStartedEventSchema),
  })
  .strict();

export const workflowDispatchStartedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("WORKFLOW_DISPATCH_STARTED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    stageAttempt: stageAttemptSchema,
    dispatch: workflowDispatchSchema,
    events: z.array(stageAttemptChangedEventSchema),
  })
  .strict();

const providerOutcomeEventSchema = z.discriminatedUnion("type", [
  stageAttemptChangedEventSchema,
  humanRequestOpenedEventSchema,
  usageRecordedEventSchema,
  budgetThresholdReachedEventSchema,
  pipelinePausedEventSchema,
  evidenceArtifactRecordedEventSchema,
  acceptanceRequestedEventSchema,
  pipelineCompletedEventSchema,
]);

export const mockProviderOutcomeAppliedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("MOCK_PROVIDER_OUTCOME_APPLIED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    stageAttempt: stageAttemptSchema,
    usageRecords: z.array(usageRecordSchema),
    artifacts: z.array(evidenceArtifactSchema),
    acceptancePackage: acceptancePackageSchema.nullable(),
    events: z.array(providerOutcomeEventSchema),
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

const pipelineControlEventSchema = z.discriminatedUnion("type", [
  pipelinePausedEventSchema,
  pipelineResumedEventSchema,
  pipelineCancelledEventSchema,
]);

export const pipelineControlAppliedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("PIPELINE_CONTROL_APPLIED"),
    replayed: z.boolean(),
    action: z.enum(["PAUSE", "RESUME", "CANCEL"]),
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    stageAttempt: stageAttemptSchema,
    dispatch: workflowDispatchSchema.nullable(),
    events: z.array(pipelineControlEventSchema),
  })
  .strict();

export const budgetOverrideApprovedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("BUDGET_OVERRIDE_APPROVED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    previousStageAttempt: stageAttemptSchema,
    stageAttempt: stageAttemptSchema,
    budgetPolicy: budgetPolicySchema,
    dispatch: workflowDispatchSchema,
    events: z.array(budgetOverrideApprovedEventSchema),
  })
  .strict();

export const workflowsReconciledResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("WORKFLOWS_RECONCILED"),
    replayed: z.boolean(),
    recoveryReports: z.array(recoveryReportSchema),
    // Spec §6.4 makes a daemon restart the ordinary end of a ProviderSession, so reconciliation
    // now closes orphaned sessions as well as orphaned dispatches and reports both kinds of event.
    interruptedSessions: z.array(providerSessionSchema),
    events: z.array(
      z.discriminatedUnion("type", [recoveryReportCreatedEventSchema, providerSessionEndedEventSchema]),
    ),
  })
  .strict();

const acceptanceResolutionEventSchema = z.discriminatedUnion("type", [
  humanRequestResolvedEventSchema,
  acceptanceResolvedEventSchema,
  pipelineCompletedEventSchema,
]);

export const acceptanceResolvedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("ACCEPTANCE_RESOLVED"),
    replayed: z.boolean(),
    action: acceptanceActionSchema,
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    stageAttempt: stageAttemptSchema,
    acceptancePackage: acceptancePackageSchema,
    request: humanRequestSchema,
    decision: decisionSchema,
    events: z.array(acceptanceResolutionEventSchema),
  })
  .strict();

export const providerSessionStartedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("PROVIDER_SESSION_STARTED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    session: providerSessionSchema,
    recipe: contextPackRecipeSchema,
    events: z.array(providerSessionStartedEventSchema),
  })
  .strict();

export const checkpointPublishedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("CHECKPOINT_PUBLISHED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    checkpoint: checkpointSchema,
    events: z.array(checkpointPublishedEventSchema),
  })
  .strict();

// Ending a session is never only a session-level write: spec §6.5 makes the unproductive-session
// counter part of the same transaction, and the second unproductive session in a row also pauses
// the run and opens a question to the owner. `nextSessionOrdinal` is the caller-facing answer to
// "does another session follow?" -- null covers both "the stage finished" and "the attempt was
// hard-paused", which the caller distinguishes by `stageAttempt.status`.
export const providerSessionEndedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("PROVIDER_SESSION_ENDED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    session: providerSessionSchema,
    stageAttempt: stageAttemptSchema,
    request: humanRequestSchema.nullable(),
    nextSessionOrdinal: z.number().int().positive().nullable(),
    events: z.array(
      z.discriminatedUnion("type", [
        providerSessionEndedEventSchema,
        stageAttemptChangedEventSchema,
        pipelinePausedEventSchema,
        humanRequestOpenedEventSchema,
      ]),
    ),
  })
  .strict();

export const contextHandoffRequestedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("CONTEXT_HANDOFF_REQUESTED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    session: providerSessionSchema,
    // False when the threshold had already been crossed, or the session had already ended: the
    // caller uses it to decide whether to actually ask the adapter to wind down and to arm the
    // deadline, so a repeated occupancy report does neither twice.
    requested: z.boolean(),
    events: z.array(contextHandoffRequestedEventSchema),
  })
  .strict();

export const contextPackShareReducedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("CONTEXT_PACK_SHARE_REDUCED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    stageAttempt: stageAttemptSchema,
    events: z.array(stageAttemptChangedEventSchema),
  })
  .strict();

export const stageAttemptHardPausedResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    type: z.literal("STAGE_ATTEMPT_HARD_PAUSED"),
    replayed: z.boolean(),
    workItemId: opaqueIdSchema,
    run: pipelineRunSchema,
    stageAttempt: stageAttemptSchema,
    request: humanRequestSchema,
    events: z.array(
      z.discriminatedUnion("type", [
        contextFloorExceededEventSchema,
        stageAttemptChangedEventSchema,
        pipelinePausedEventSchema,
        humanRequestOpenedEventSchema,
      ]),
    ),
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

export const pipelineControlRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const budgetOverrideRequestSchema = pipelineControlRequestSchema.extend({
  maxEstimatedTokens: z.number().int().positive(),
});

export const resolveAcceptanceRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    expectedVersion: z.number().int().positive(),
    expectedRunVersion: z.number().int().positive(),
    action: acceptanceActionSchema,
    reason: descriptionSchema.nullable().default(null),
  })
  .strict();

export const workflowSnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    run: pipelineRunSchema.nullable(),
    stageAttempts: z.array(stageAttemptSchema),
    humanRequests: z.array(humanRequestSchema),
    decisions: z.array(decisionSchema),
    budgetPolicies: z.array(budgetPolicySchema),
    usageRecords: z.array(usageRecordSchema),
    recoveryReports: z.array(recoveryReportSchema),
    artifacts: z.array(evidenceArtifactSchema),
    acceptancePackage: acceptancePackageSchema.nullable(),
  })
  .strict();

export const humanRequestsResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, humanRequests: z.array(humanRequestSchema) })
  .strict();

// Spec §D5's nesting, read back for the Task Cockpit (Task 12). Kept out of workflowSnapshotSchema
// deliberately, matching persistence-sqlite's LIST_PROVIDER_SESSIONS: the snapshot is fetched on
// every board render, and an attempt's session history grows without bound.
// `peakContextWindowUsage` is keyed by ProviderSession id and carries the highest occupancy each
// session has been observed at (spec §6.2 -- occupancy is saved on every report, not only the one
// that crosses the handoff threshold, and the highest of them is what is kept). Deliberately the
// peak and not the current reading: it answers "how full did this session get", which is what
// explains a cut, and it does not move under a provider that compacts its own window. A session
// with no entry has never had its window measured, which is not the same as one measured at zero.
// For a session that asked to wind down the figure is the reading at handoff rather than the true
// peak, because reporting stops there -- see the note in packages/persistence-sqlite/src/types.ts.
// The cockpit labels that case "at handoff" and never as a peak, so the wording stays honest.
export const providerSessionsResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sessions: z.array(providerSessionSchema),
    checkpoints: z.array(checkpointSchema),
    peakContextWindowUsage: z.record(opaqueIdSchema, contextWindowUsageSchema),
  })
  .strict();

// The daemon runs a single provider adapter for its whole lifetime (A2 has not landed live
// adapters yet), so this describes "the provider a session would run on right now" rather than a
// per-session fact. Trimmed to what the cockpit needs to explain a lost checkpoint tail (spec §7):
// not the full ProviderCapabilities shape provider-core owns, which apps/web has no reason to
// depend on.
export const providerCapabilitiesResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    provider: z.string().trim().min(1).max(50),
    checkpointOnRequest: z.boolean(),
    contextWindowReporting: z.boolean(),
  })
  .strict();

export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type PipelineRun = z.infer<typeof pipelineRunSchema>;
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;
export type StageAttempt = z.infer<typeof stageAttemptSchema>;
export type StageAttemptStatus = z.infer<typeof stageAttemptStatusSchema>;
export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;
export type RecoveryReport = z.infer<typeof recoveryReportSchema>;
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;
export type ProviderArtifactDraft = z.infer<typeof providerArtifactDraftSchema>;
export type AcceptancePackage = z.infer<typeof acceptancePackageSchema>;
export type AcceptanceAction = z.infer<typeof acceptanceActionSchema>;
export type HumanRequest = z.infer<typeof humanRequestSchema>;
export type HumanRequestStatus = z.infer<typeof humanRequestStatusSchema>;
export type HumanRequestAnswer = z.infer<typeof humanRequestAnswerSchema>;
export type HumanRequestDraft = z.infer<typeof humanRequestDraftSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type WorkflowDispatch = z.infer<typeof workflowDispatchSchema>;
export type ProviderOutcome = z.infer<typeof providerOutcomeSchema>;
export type PipelineStartedEvent = z.infer<typeof pipelineStartedEventSchema>;
export type StageAttemptChangedEvent = z.infer<typeof stageAttemptChangedEventSchema>;
export type HumanRequestOpenedEvent = z.infer<typeof humanRequestOpenedEventSchema>;
export type HumanRequestResolvedEvent = z.infer<typeof humanRequestResolvedEventSchema>;
export type UsageRecordedEvent = z.infer<typeof usageRecordedEventSchema>;
export type BudgetThresholdReachedEvent = z.infer<typeof budgetThresholdReachedEventSchema>;
export type PipelinePausedEvent = z.infer<typeof pipelinePausedEventSchema>;
export type PipelineResumedEvent = z.infer<typeof pipelineResumedEventSchema>;
export type PipelineCancelledEvent = z.infer<typeof pipelineCancelledEventSchema>;
export type BudgetOverrideApprovedEvent = z.infer<typeof budgetOverrideApprovedEventSchema>;
export type RecoveryReportCreatedEvent = z.infer<typeof recoveryReportCreatedEventSchema>;
export type EvidenceArtifactRecordedEvent = z.infer<typeof evidenceArtifactRecordedEventSchema>;
export type AcceptanceRequestedEvent = z.infer<typeof acceptanceRequestedEventSchema>;
export type AcceptanceResolvedEvent = z.infer<typeof acceptanceResolvedEventSchema>;
export type PipelineCompletedEvent = z.infer<typeof pipelineCompletedEventSchema>;
export type StartMockPipelineCommand = z.infer<typeof startMockPipelineCommandSchema>;
export type MarkWorkflowDispatchStartedCommand = z.infer<typeof markWorkflowDispatchStartedCommandSchema>;
export type ApplyProviderOutcomeCommand = z.infer<typeof applyProviderOutcomeCommandSchema>;
export type LegacyApplyMockProviderOutcomeCommand = z.infer<
  typeof legacyApplyMockProviderOutcomeCommandSchema
>;
export type AnswerHumanRequestCommand = z.infer<typeof answerHumanRequestCommandSchema>;
export type PausePipelineCommand = z.infer<typeof pausePipelineCommandSchema>;
export type ResumePipelineCommand = z.infer<typeof resumePipelineCommandSchema>;
export type CancelPipelineCommand = z.infer<typeof cancelPipelineCommandSchema>;
export type ApproveBudgetOverrideCommand = z.infer<typeof approveBudgetOverrideCommandSchema>;
export type ReconcileWorkflowsCommand = z.infer<typeof reconcileWorkflowsCommandSchema>;
export type ResolveAcceptanceCommand = z.infer<typeof resolveAcceptanceCommandSchema>;
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;
export type ProviderSessionsResponse = z.infer<typeof providerSessionsResponseSchema>;
export type ProviderCapabilitiesResponse = z.infer<typeof providerCapabilitiesResponseSchema>;
export type ContextPackRecipeInput = z.infer<typeof contextPackRecipeInputSchema>;
export type StartProviderSessionCommand = z.infer<typeof startProviderSessionCommandSchema>;
export type PublishCheckpointCommand = z.infer<typeof publishCheckpointCommandSchema>;
export type EndProviderSessionCommand = z.infer<typeof endProviderSessionCommandSchema>;
export type ProviderSessionStartedEvent = z.infer<typeof providerSessionStartedEventSchema>;
export type CheckpointPublishedEvent = z.infer<typeof checkpointPublishedEventSchema>;
export type ContextHandoffRequestedEvent = z.infer<typeof contextHandoffRequestedEventSchema>;
export type ProviderSessionEndedEvent = z.infer<typeof providerSessionEndedEventSchema>;
export type ProviderSessionStartedResult = z.infer<typeof providerSessionStartedResultSchema>;
export type CheckpointPublishedResult = z.infer<typeof checkpointPublishedResultSchema>;
export type ProviderSessionEndedResult = z.infer<typeof providerSessionEndedResultSchema>;
export type ContextFloorExceededEvent = z.infer<typeof contextFloorExceededEventSchema>;
export type RequestContextHandoffCommand = z.infer<typeof requestContextHandoffCommandSchema>;
export type HardPauseStageAttemptCommand = z.infer<typeof hardPauseStageAttemptCommandSchema>;
export type StageAttemptHardPauseReason = z.infer<typeof stageAttemptHardPauseReasonSchema>;
export type ContextHandoffRequestedResult = z.infer<typeof contextHandoffRequestedResultSchema>;
export type StageAttemptHardPausedResult = z.infer<typeof stageAttemptHardPausedResultSchema>;
export type ReduceContextPackShareCommand = z.infer<typeof reduceContextPackShareCommandSchema>;
export type ContextPackShareReducedResult = z.infer<typeof contextPackShareReducedResultSchema>;
