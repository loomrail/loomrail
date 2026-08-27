import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContextSources } from "@loomrail/context-assembly";
import {
  acceptancePackageSchema,
  budgetPolicySchema,
  checkpointSchema,
  contextPackRecipeSchema,
  contextWindowUsageSchema,
  decisionSchema,
  domainEventSchema,
  eventPageDirectionSchema,
  evidenceArtifactSchema,
  humanRequestSchema,
  humanRequestStatusSchema,
  maxContextPackRecipeSources,
  opaqueIdSchema,
  pipelineRunSchema,
  projectSchema,
  providerSessionSchema,
  recoveryReportSchema,
  stageAttemptSchema,
  stateCommandResultSchema,
  stateCommandSchema,
  usageRecordSchema,
  workflowDispatchSchema,
  workflowSnapshotSchema,
  workflowTemplateSchema,
  workItemSchema,
  workItemStateSchema,
  type BudgetPolicy,
  type Actor,
  type AcceptancePackage,
  type Checkpoint,
  type ContextPackRecipe,
  type ContextWindowUsage,
  type Decision,
  type DomainEvent,
  type EvidenceArtifact,
  type HumanRequest,
  type PipelineRun,
  type Project,
  type ProviderSession,
  type RecoveryReport,
  type RegisterProjectCommand,
  type StageAttempt,
  type StartMockPipelineCommand,
  type StateCommand,
  type StateCommandResult,
  type UsageRecord,
  type WorkItem,
  type WorkflowDispatch,
  type WorkflowSnapshot,
} from "@loomrail/contracts";
import {
  decideApproveBudgetOverride,
  decideAnswerHumanRequest,
  decideApplyProviderOutcome,
  decideCancelPipeline,
  decideContextWindowReported,
  decideMarkWorkflowDispatchStarted,
  decidePausePipeline,
  decideRecoverInterruptedWorkflow,
  decideResolveAcceptance,
  decideResumePipeline,
  decideSessionEnded,
  decideStageAttemptHardPause,
  decideStartMockPipeline,
  decideWorkItemCommand,
  WorkflowDomainError,
  WorkItemDomainError,
  type BudgetOverrideDecision,
  type AcceptanceResolutionDecision,
  type AnswerHumanRequestDecision,
  type ApplyProviderOutcomeDecision,
  type MarkDispatchStartedDecision,
  type PipelineControlDecision,
  type RecoveryDecision,
  type StageAttemptPauseDecision,
  type StartWorkflowDecision,
  type WorkItemCommand,
  type WorkItemDecision,
  type WorkItemEventIntent,
} from "@loomrail/domain";
import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";
import { applyMigrations, databaseWasNonEmpty } from "./migrations.js";
import {
  StateStoreError,
  type LocalState,
  type OpenLocalStateOptions,
  type OrphanProcessEvent,
  type StateQuery,
  type StateQueryResult,
} from "./types.js";

export * from "./types.js";

const DEFAULT_WORKSPACE_ID = "workspace-local";
const DEFAULT_WORKSPACE_NAME = "Local workspace";

const projectRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  fixture_id: z.string(),
  name: z.string(),
  repository_path: z.string(),
  status: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const workItemRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable(),
  type: z.string(),
  title: z.string(),
  description: z.string(),
  state: z.string(),
  current_stage: z.string().nullable(),
  priority: z.string(),
  risk: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const criterionRowSchema = z.object({ criterion: z.string() });

const eventRowSchema = z.object({
  sequence: z.number().int(),
  id: z.string(),
  schema_version: z.number().int(),
  type: z.string(),
  aggregate_type: z.string(),
  aggregate_id: z.string(),
  project_id: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  occurred_at: z.string(),
  correlation_id: z.string(),
  data_json: z.string(),
});

const commandReceiptRowSchema = z.object({
  command_type: z.string(),
  input_hash: z.string(),
  result_json: z.string(),
});

const pipelineRunRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  workflow_template_id: z.string(),
  workflow_version: z.number().int(),
  status: z.string(),
  orchestration_status: z.string().nullable(),
  current_stage_attempt_id: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
});

const budgetPolicyRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  revision: z.number().int(),
  max_estimated_tokens: z.number().int(),
  warning_thresholds_json: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  created_at: z.string(),
});

const usageRecordRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  budget_policy_id: z.string(),
  kind: z.string(),
  amount: z.number().int(),
  quality: z.string(),
  recorded_at: z.string(),
});

const recoveryReportRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  previous_status: z.string(),
  recovered_status: z.string(),
  reason: z.string(),
  created_at: z.string(),
});

const evidenceArtifactRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  stage: z.string(),
  kind: z.string(),
  status: z.string(),
  provider: z.string(),
  title: z.string(),
  summary: z.string(),
  checks_json: z.string(),
  created_at: z.string(),
});

const acceptancePackageRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  human_request_id: z.string(),
  status: z.string(),
  criteria_json: z.string(),
  artifact_ids_json: z.string(),
  release_note: z.string(),
  verify_instructions_json: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  resolved_by_type: z.string().nullable(),
  resolved_by_id: z.string().nullable(),
  resolution_reason: z.string().nullable(),
});

const stageAttemptRowSchema = z.object({
  id: z.string(),
  pipeline_run_id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  stage: z.string(),
  attempt: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  failure_code: z.string().nullable(),
  unproductive_sessions: z.number().int(),
  pack_share_backoffs: z.number().int(),
});

const humanRequestRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  stage_attempt_id: z.string(),
  kind: z.string(),
  blocking: z.number().int(),
  title: z.string(),
  context: z.string(),
  recommendation: z.string().nullable(),
  allow_other: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});

const humanRequestOptionRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  consequence: z.string(),
  recommended: z.number().int(),
});

const decisionRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  human_request_id: z.string(),
  answer_json: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

const providerSessionRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  stage_attempt_id: z.string(),
  ordinal: z.number().int(),
  status: z.string(),
  end_reason: z.string().nullable(),
  handoff_requested_at: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  version: z.number().int(),
  // Migration 0009: the highest occupancy this session has been observed at. Null together or
  // present together -- the table CHECK says so, and `peakContextWindowUsageFromRow` reads them as
  // the one value they are.
  context_used_tokens: z.number().int().nullable(),
  context_window_tokens: z.number().int().nullable(),
  context_usage_quality: z.string().nullable(),
  context_usage_reported_at: z.string().nullable(),
  // Migration 0010: the OS pid of the child process a RUNNING session is driving, or null if none
  // was ever recorded for it.
  process_pid: z.number().int().nullable(),
});

type ProviderSessionRow = z.infer<typeof providerSessionRowSchema>;

const contextPackRecipeRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  provider_session_id: z.string(),
  template_id: z.string(),
  template_version: z.number().int(),
  spec_source: z.string(),
  sections_json: z.string(),
  omitted_json: z.string(),
  content_hash: z.string(),
  estimated_tokens: z.number().int(),
  budget_tokens: z.number().int(),
  estimate_quality: z.string(),
  created_at: z.string(),
});

const checkpointRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  stage_attempt_id: z.string(),
  provider_session_id: z.string(),
  ordinal: z.number().int(),
  summary: z.string(),
  completed_json: z.string(),
  remaining_json: z.string(),
  dead_ends_json: z.string(),
  open_questions_json: z.string(),
  created_at: z.string(),
});

const maxOrdinalRowSchema = z.object({ max_ordinal: z.number().int() });
const countRowSchema = z.object({ count: z.number().int() });

const workflowDispatchRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  mode: z.string(),
  status: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

const stateQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("LIST_PROJECTS") }).strict(),
  z.object({ type: z.literal("GET_PROJECT"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_WORK_ITEM"), workItemId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_WORKFLOW_SNAPSHOT"), workItemId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("LIST_HUMAN_REQUESTS"),
      projectId: opaqueIdSchema.optional(),
      status: humanRequestStatusSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("LIST_PENDING_DISPATCHES") }).strict(),
  z
    .object({
      type: z.literal("LIST_WORK_ITEMS"),
      projectId: opaqueIdSchema,
      state: workItemStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_EVENTS"),
      direction: eventPageDirectionSchema.default("ASC"),
      afterSequence: z.number().int().nonnegative().default(0),
      beforeSequence: z.number().int().positive().optional(),
      projectId: opaqueIdSchema.optional(),
      aggregateId: opaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("READ_CONTEXT_SOURCES"),
      stageAttemptId: opaqueIdSchema,
      sessionOrdinal: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("LIST_PROVIDER_SESSIONS"), stageAttemptId: opaqueIdSchema }).strict(),
]);

// `ORDER BY` direction is structure rather than a value, so it cannot be bound. The two statements are
// spelled out in full so that every dynamic value stays a placeholder.
const listEventsWhereClause = `WHERE sequence > ?
     AND (? IS NULL OR sequence < ?)
     AND (? IS NULL OR project_id = ?)
     AND (? IS NULL OR aggregate_id = ?)`;

const listEventsAscendingSql = `SELECT * FROM events
   ${listEventsWhereClause}
   ORDER BY sequence ASC
   LIMIT ?`;

const listEventsDescendingSql = `SELECT * FROM events
   ${listEventsWhereClause}
   ORDER BY sequence DESC
   LIMIT ?`;

const parseJson = (value: string): unknown => JSON.parse(value) as unknown;

const projectFromRow = (value: unknown): Project => {
  const row = projectRowSchema.parse(value);
  return projectSchema.parse({
    schemaVersion: 1,
    id: row.id,
    workspaceId: row.workspace_id,
    fixtureId: row.fixture_id,
    name: row.name,
    repositoryPath: row.repository_path,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
};

const budgetPolicyFromRow = (value: unknown): BudgetPolicy => {
  const row = budgetPolicyRowSchema.parse(value);
  return budgetPolicySchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    revision: row.revision,
    maxEstimatedTokens: row.max_estimated_tokens,
    warningThresholds: parseJson(row.warning_thresholds_json),
    createdBy: { type: row.actor_type, id: row.actor_id },
    createdAt: row.created_at,
  });
};

const usageRecordFromRow = (value: unknown): UsageRecord => {
  const row = usageRecordRowSchema.parse(value);
  return usageRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    budgetPolicyId: row.budget_policy_id,
    kind: row.kind,
    amount: row.amount,
    quality: row.quality,
    recordedAt: row.recorded_at,
  });
};

const recoveryReportFromRow = (value: unknown): RecoveryReport => {
  const row = recoveryReportRowSchema.parse(value);
  return recoveryReportSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    previousStatus: row.previous_status,
    recoveredStatus: row.recovered_status,
    reason: row.reason,
    createdAt: row.created_at,
  });
};

const evidenceArtifactFromRow = (value: unknown): EvidenceArtifact => {
  const row = evidenceArtifactRowSchema.parse(value);
  return evidenceArtifactSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    stage: row.stage,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    title: row.title,
    summary: row.summary,
    checks: parseJson(row.checks_json),
    createdAt: row.created_at,
  });
};

const acceptancePackageFromRow = (value: unknown): AcceptancePackage => {
  const row = acceptancePackageRowSchema.parse(value);
  return acceptancePackageSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    humanRequestId: row.human_request_id,
    status: row.status,
    criteria: parseJson(row.criteria_json),
    artifactIds: parseJson(row.artifact_ids_json),
    releaseNote: row.release_note,
    verifyInstructions: parseJson(row.verify_instructions_json),
    version: row.version,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy:
      row.resolved_by_type === null || row.resolved_by_id === null
        ? null
        : { type: row.resolved_by_type, id: row.resolved_by_id },
    resolutionReason: row.resolution_reason,
  });
};

const eventFromRow = (value: unknown): DomainEvent => {
  const row = eventRowSchema.parse(value);
  return domainEventSchema.parse({
    schemaVersion: row.schema_version,
    sequence: row.sequence,
    id: row.id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    projectId: row.project_id,
    actor: { type: row.actor_type, id: row.actor_id },
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    data: parseJson(row.data_json),
  });
};

const pipelineRunFromRow = (value: unknown): PipelineRun => {
  const row = pipelineRunRowSchema.parse(value);
  return pipelineRunSchema.parse({
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    workflowTemplateId: row.workflow_template_id,
    workflowVersion: row.workflow_version,
    status: row.orchestration_status ?? row.status,
    currentStageAttemptId: row.current_stage_attempt_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  });
};

const stageAttemptFromRow = (value: unknown): StageAttempt => {
  const row = stageAttemptRowSchema.parse(value);
  return stageAttemptSchema.parse({
    schemaVersion: 1,
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    stage: row.stage,
    attempt: row.attempt,
    status: row.status,
    version: row.version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureCode: row.failure_code,
    unproductiveSessions: row.unproductive_sessions,
    packShareBackoffs: row.pack_share_backoffs,
  });
};

const decisionFromRow = (value: unknown): Decision => {
  const row = decisionRowSchema.parse(value);
  return decisionSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    humanRequestId: row.human_request_id,
    answer: parseJson(row.answer_json),
    actor: { type: row.actor_type, id: row.actor_id },
    reason: row.reason,
    createdAt: row.created_at,
  });
};

const workflowDispatchFromRow = (value: unknown): WorkflowDispatch => {
  const row = workflowDispatchRowSchema.parse(value);
  return workflowDispatchSchema.parse({
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
};

const providerSessionFromRow = (value: unknown): ProviderSession =>
  providerSessionFromParsedRow(providerSessionRowSchema.parse(value));

const providerSessionFromParsedRow = (row: ProviderSessionRow): ProviderSession => {
  return providerSessionSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    stageAttemptId: row.stage_attempt_id,
    ordinal: row.ordinal,
    status: row.status,
    endReason: row.end_reason,
    handoffRequestedAt: row.handoff_requested_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    version: row.version,
    pid: row.process_pid,
  });
};

// The highest window occupancy this session has been observed at, or null if it has never been
// measured. Read off the session's own row rather than reconstructed from
// CONTEXT_HANDOFF_REQUESTED: current state and audit are separate, and only one of them is allowed
// to be the source here.
const peakContextWindowUsageFromRow = (row: ProviderSessionRow): ContextWindowUsage | null => {
  if (
    row.context_used_tokens === null ||
    row.context_window_tokens === null ||
    row.context_usage_quality === null
  ) {
    return null;
  }
  return contextWindowUsageSchema.parse({
    usedTokens: row.context_used_tokens,
    windowTokens: row.context_window_tokens,
    quality: row.context_usage_quality,
  });
};

const contextPackRecipeFromRow = (value: unknown): ContextPackRecipe => {
  const row = contextPackRecipeRowSchema.parse(value);
  return contextPackRecipeSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    providerSessionId: row.provider_session_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    specSource: row.spec_source,
    sections: parseJson(row.sections_json),
    omitted: parseJson(row.omitted_json),
    contentHash: row.content_hash,
    estimatedTokens: row.estimated_tokens,
    budgetTokens: row.budget_tokens,
    estimateQuality: row.estimate_quality,
    createdAt: row.created_at,
  });
};

const checkpointFromRow = (value: unknown): Checkpoint => {
  const row = checkpointRowSchema.parse(value);
  return checkpointSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    stageAttemptId: row.stage_attempt_id,
    providerSessionId: row.provider_session_id,
    ordinal: row.ordinal,
    summary: row.summary,
    completed: parseJson(row.completed_json),
    remaining: parseJson(row.remaining_json),
    deadEnds: parseJson(row.dead_ends_json),
    openQuestions: parseJson(row.open_questions_json),
    createdAt: row.created_at,
  });
};

// Turns a raw Event type into an ACTIVITY-section label, e.g. "STAGE_ATTEMPT_CHANGED" ->
// "Stage attempt changed". ACTIVITY has no dedicated table -- spec §4.1 restricts v1 sections to
// "only what state already owns", and the append-only Event log is exactly that for "what
// happened" without inventing a second record of it.
const humanizeEventType = (type: string): string =>
  type
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");

const MAX_ACTIVITY_EVENTS = 20;

// How many records one collection section of a context pack may cite. Taken from
// @loomrail/contracts rather than restated, because it is the same number that
// `contextPackRecipeSectionSchema` enforces on the recipe written from these sources: a work item
// with more decisions than this once produced a recipe the contract rejected, which threw out of
// the session loop instead of narrowing the pack.
const MAX_CONTEXT_SOURCE_RECORDS = maxContextPackRecipeSources;

const describeDecisionAnswer = (
  answer: Decision["answer"],
  options: readonly { id: string; label: string }[],
): string => {
  if (answer.type === "OTHER") return answer.text;
  const labels = answer.optionIds
    .map((optionId) => options.find((option) => option.id === optionId)?.label)
    .filter((label): label is string => label !== undefined);
  return labels.length > 0 ? labels.join(", ") : answer.optionIds.join(", ");
};

const commandHash = (command: StateCommand): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: command.schemaVersion,
        type: command.type,
        actor: command.actor,
        payload: command.payload,
      }),
    )
    .digest("hex");

const lastInsertSequence = (value: number | bigint): number => {
  const sequence = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new StateStoreError("PERSISTENCE_FAILURE", "SQLite returned an invalid Event sequence");
  }
  return sequence;
};

const asReplayed = (result: StateCommandResult): StateCommandResult =>
  stateCommandResultSchema.parse({ ...result, replayed: true });

const legacyCompatibleRunStatus = (status: PipelineRun["status"]): string =>
  ["SOFT_PAUSED", "HARD_PAUSED", "INTERRUPTED"].includes(status) ? "RUNNING" : status;

const assertNever = (value: never): never => {
  throw new StateStoreError("PERSISTENCE_FAILURE", "Unknown local-state operation", {
    value: String(value),
  });
};

// `process.kill(pid, 0)` sends no signal at all -- it only asks the kernel whether a process with
// this pid exists, throwing ESRCH when it does not. This is the same check RECONCILE_WORKFLOWS
// uses below to decide whether an orphaned ProviderSession's recorded pid is still worth acting on,
// so both agree on what "alive" means.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The `errno` string Node hangs on the errors `process.kill` throws (ESRCH, EPERM, EINVAL). Read
// through a guard rather than a cast: `unknown` from a `catch` is exactly the value that is not
// guaranteed to be an Error at all.
const errorCodeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

// How much later than its own ProviderSession a process may have started and still be believed to
// be that session's child. `ps` reports elapsed time to the second, and the pid is recorded a beat
// after the child is spawned, so a strict comparison would reject the very processes this guard
// exists to let through. Two seconds is far shorter than the interval that makes a reused pid
// plausible (a crash, a reboot, and enough new processes to walk the pid space back around).
const PID_IDENTITY_TOLERANCE_MS = 2_000;

// Reads when the process with this pid started, synchronously -- `execute` is synchronous end to
// end, so there is no room here for an async probe.
//
// `etime` (elapsed time), not `etimes`: BSD `ps` on macOS has no `etimes` keyword at all ("ps:
// etimes: keyword not found"), and `lstart`'s absolute timestamp is formatted with locale-dependent
// month names. `etime` is `[[dd-]hh:]mm:ss`, numeric and locale-free, and subtracting it from now
// gives the start time. Returns `null` -- never a guess -- when the probe cannot answer: `ps` is
// absent (Windows), it exits non-zero, or its output does not parse. The caller treats `null` as
// "do not kill".
const readProcessStartTime = (pid: number, now: Date): Date | null => {
  if (process.platform === "win32") return null;
  let output: string;
  try {
    output = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const match = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(output);
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  const elapsedSeconds =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return new Date(now.getTime() - elapsedSeconds * 1_000);
};

// Spec §8: kills the process an orphaned ProviderSession was driving, if it is still alive. Called
// before that session is marked ENDED (see the RECONCILE_WORKFLOWS handler below) -- the reverse
// order would let a crash between the two steps commit a session that reads as "ended" while its
// process is still running and still spending the owner's money, and reconciliation's own query
// only ever looks for a pid on a session it still considers RUNNING, so a session already marked
// ENDED is a process the next start will never look for again.
//
// SIGKILL, not the graceful terminate-then-wait `runProcess`'s `stop()` uses: `execute` is
// synchronous end to end, so there is no way to await a termination grace period here, and an
// orphan with no daemon left watching it has no stdout listener or checkpoint write to let finish
// anyway.
//
// TWO guards, not one, and both matter:
//
//   liveness -- `process.kill(pid, 0)` first, so a retry after a crash (the pid already dead, the
//   ENDED write never having committed) does not signal anything;
//
//   identity -- the process must have started no later than the session that recorded it. The only
//   way an orphan exists at all is a crash or a power-off, which usually means a reboot, and after
//   a reboot pid allocation restarts and walks back up through the recorded range. A reused pid
//   necessarily started LATER than the session that recorded the original, so this is the fact that
//   separates our dead child from the owner's editor. FAIL SAFE: if the start time cannot be
//   determined for any reason, the kill is skipped. An orphan that survives is self-healing at the
//   next start; a SIGKILL to the wrong process is not.
//
// Every decision -- kill or skip, and why -- goes to `report`. An unrecorded SIGKILL on the owner's
// machine is the defect this signature exists to close.
//
// FAIL SAFE ALL THE WAY OUT, and this is the part that is easy to get wrong: this runs inside
// `execute`, which the daemon calls -- unwrapped -- BEFORE `app.listen`. Anything thrown here is
// re-wrapped as a `StateStoreError` and stops Loomrail from starting at all, which is a strictly
// worse failure than the orphan the kill exists to prevent. The liveness check and the signal are
// not one atomic act (the identity probe between them is a real `ps` fork, measured at ~2 ms), so
// an orphan that exits inside that window makes `process.kill` throw ESRCH. Nothing in here may
// escape -- and nothing in here may go quiet either: every ending, including the ones that failed,
// is a line the owner can find.
const killOrphanedSessionProcess = (context: {
  pid: number;
  sessionId: string;
  sessionStartedAt: string;
  now: Date;
  processStartedAt: (pid: number) => Date | null;
  report: (event: OrphanProcessEvent) => void;
}): void => {
  const { pid, sessionId } = context;
  // Even the reporting is contained: a logger that throws must not be the thing that stops the
  // daemon from starting, having been installed to make this very code observable.
  const report = (event: OrphanProcessEvent): void => {
    try {
      context.report(event);
    } catch {
      // Nothing left to report it to.
    }
  };
  try {
    if (!isProcessAlive(pid)) {
      report({ pid, sessionId, action: "SKIPPED", reason: "ALREADY_GONE" });
      return;
    }
    const startedAt = context.processStartedAt(pid);
    if (startedAt === null) {
      report({ pid, sessionId, action: "SKIPPED", reason: "START_TIME_UNKNOWN" });
      return;
    }
    const sessionStartedAtMs = Date.parse(context.sessionStartedAt);
    if (
      Number.isNaN(sessionStartedAtMs) ||
      startedAt.getTime() > sessionStartedAtMs + PID_IDENTITY_TOLERANCE_MS
    ) {
      report({ pid, sessionId, action: "SKIPPED", reason: "STARTED_AFTER_SESSION" });
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (cause) {
      // ESRCH is the window this whole comment is about: the process was alive at the check and
      // gone by the signal. Nothing went wrong -- but a kill that did not happen must not be
      // recorded as one, and a pid that vanished mid-probe is worth the one line it costs.
      // Anything else (EPERM above all) says the pid now belongs to a process this daemon may not
      // signal, i.e. the identity guard was wrong, which is louder still.
      report({
        pid,
        sessionId,
        action: "FAILED",
        reason: errorCodeOf(cause) === "ESRCH" ? "VANISHED_BEFORE_SIGNAL" : "SIGNAL_REFUSED",
      });
      return;
    }
    // Reported after the signal landed, never before it: the previous version announced the kill
    // and then attempted it, so a kill that threw was logged as a kill that happened.
    report({ pid, sessionId, action: "KILLED", reason: "IDENTITY_CONFIRMED" });
  } catch {
    // The liveness check and the default start-time probe both contain their own failures, so this
    // is only reachable through an injected probe -- but "only reachable through" is not "cannot
    // happen", and the cost of being wrong about that is a daemon that will not start.
    report({ pid, sessionId, action: "FAILED", reason: "PROBE_FAILED" });
  }
};

export const openLocalState = async (options: OpenLocalStateOptions): Promise<LocalState> => {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  const processStartedAt = options.processStartedAt ?? ((pid: number) => readProcessStartTime(pid, now()));
  // The default of last resort. A SIGKILL to a process on the owner's machine that nothing recorded
  // is exactly the defect this callback closes, so an uninjected caller still gets a durable line
  // rather than silence. `apps/daemon` injects its own structured logger over this.
  const reportOrphanProcess =
    options.onOrphanProcess ??
    ((event: OrphanProcessEvent) => {
      process.stderr.write(`${JSON.stringify({ event: "orphanProcess", ...event })}\n`);
    });
  const wasNonEmpty = await databaseWasNonEmpty(options.databasePath);
  if (options.databasePath !== ":memory:") {
    await mkdir(dirname(options.databasePath), { recursive: true });
  }

  const database = new DatabaseSync(options.databasePath, {
    defensive: true,
    timeout: 5_000,
  });
  let closed = false;

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");

    const startup = await applyMigrations(database, {
      databasePath: options.databasePath,
      ...(options.backupsDirectory === undefined ? {} : { backupsDirectory: options.backupsDirectory }),
      ...(options.migrationsDirectory === undefined
        ? {}
        : { migrationsDirectory: options.migrationsDirectory }),
      now,
      databaseWasNonEmpty: wasNonEmpty,
    });

    const openedAt = now().toISOString();
    database
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, openedAt, openedAt);

    const selectProjectById = database.prepare("SELECT * FROM projects WHERE id = ?");
    const selectWorkItemById = database.prepare("SELECT * FROM work_items WHERE id = ?");
    const selectCriteria = database.prepare(
      `SELECT criterion FROM work_item_acceptance_criteria
       WHERE work_item_id = ? ORDER BY ordinal`,
    );
    const insertCriterion = database.prepare(
      `INSERT INTO work_item_acceptance_criteria (work_item_id, ordinal, criterion)
       VALUES (?, ?, ?)`,
    );
    const deleteCriteria = database.prepare(
      "DELETE FROM work_item_acceptance_criteria WHERE work_item_id = ?",
    );
    const selectCommandReceipt = database.prepare(
      "SELECT command_type, input_hash, result_json FROM commands WHERE command_id = ?",
    );
    const insertCommandReceipt = database.prepare(
      `INSERT INTO commands (command_id, command_type, input_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertEvent = database.prepare(
      `INSERT INTO events (
        id, schema_version, type, aggregate_type, aggregate_id, project_id,
        actor_type, actor_id, occurred_at, correlation_id, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectPipelineRunById = database.prepare("SELECT * FROM pipeline_runs WHERE id = ?");
    const selectLatestPipelineRun = database.prepare(
      "SELECT * FROM pipeline_runs WHERE work_item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const selectActivePipelineRun = database.prepare(
      `SELECT * FROM pipeline_runs
       WHERE work_item_id = ?
         AND COALESCE(orchestration_status, status) IN (
           'RUNNING', 'WAITING_HUMAN', 'SOFT_PAUSED', 'HARD_PAUSED', 'INTERRUPTED'
         )
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const selectStageAttemptById = database.prepare("SELECT * FROM stage_attempts WHERE id = ?");
    const selectHumanRequestById = database.prepare("SELECT * FROM human_requests WHERE id = ?");
    const selectHumanRequestOptions = database.prepare(
      `SELECT id, label, consequence, recommended FROM human_request_options
       WHERE human_request_id = ? ORDER BY ordinal`,
    );
    const selectWorkflowDispatchById = database.prepare("SELECT * FROM workflow_dispatches WHERE id = ?");
    const selectPendingDispatchByStageAttempt = database.prepare(
      "SELECT * FROM workflow_dispatches WHERE stage_attempt_id = ? AND status = 'PENDING' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const selectCurrentBudgetPolicy = database.prepare(
      "SELECT * FROM budget_policies WHERE pipeline_run_id = ? ORDER BY revision DESC LIMIT 1",
    );
    const selectAcceptancePackageById = database.prepare("SELECT * FROM acceptance_packages WHERE id = ?");
    const selectAcceptancePackageByRun = database.prepare(
      "SELECT * FROM acceptance_packages WHERE pipeline_run_id = ?",
    );
    const selectProviderSessionById = database.prepare("SELECT * FROM provider_sessions WHERE id = ?");
    const selectRunningProviderSession = database.prepare(
      "SELECT id FROM provider_sessions WHERE stage_attempt_id = ? AND status = 'RUNNING' LIMIT 1",
    );
    const selectMaxProviderSessionOrdinal = database.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM provider_sessions WHERE stage_attempt_id = ?",
    );
    const insertProviderSession = database.prepare(
      `INSERT INTO provider_sessions (
        id, schema_version, stage_attempt_id, ordinal, status, end_reason, handoff_requested_at,
        started_at, ended_at, version, process_pid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateProviderSession = database.prepare(
      `UPDATE provider_sessions
       SET status = ?, end_reason = ?, handoff_requested_at = ?, ended_at = ?, version = ?
       WHERE id = ? AND version = ?`,
    );
    // Migration 0009. Deliberately no `version` guard and no `version` bump: the peak occupancy is
    // not part of providerSessionSchema, so no reader holds a version of it that this write could
    // invalidate, and bumping the column here would make the optimistic update above fail for the
    // very report that is about to request the handoff.
    const recordPeakProviderSessionUsage = database.prepare(
      `UPDATE provider_sessions
       SET context_used_tokens = ?, context_window_tokens = ?, context_usage_quality = ?,
           context_usage_reported_at = ?
       WHERE id = ?`,
    );
    // Unlike the peak-occupancy write above, `pid` IS part of providerSessionSchema -- but still no
    // `version` guard and no bump. It is written at most once, from null to a real pid, and every
    // reader that matters (RECONCILE_WORKFLOWS, END_PROVIDER_SESSION) re-reads the row fresh
    // immediately before its own version-guarded update rather than holding a copy across time, so
    // there is no stale-version window for a pid write to invalidate.
    const recordProviderSessionProcessPid = database.prepare(
      `UPDATE provider_sessions SET process_pid = ? WHERE id = ?`,
    );
    const insertContextPackRecipe = database.prepare(
      `INSERT INTO context_pack_recipes (
        id, schema_version, provider_session_id, template_id, template_version, spec_source,
        sections_json, omitted_json, content_hash, estimated_tokens, budget_tokens,
        estimate_quality, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectProviderSessionsForAttempt = database.prepare(
      "SELECT * FROM provider_sessions WHERE stage_attempt_id = ? ORDER BY ordinal",
    );
    const selectRecipesForAttempt = database.prepare(
      `SELECT context_pack_recipes.* FROM context_pack_recipes
       INNER JOIN provider_sessions ON provider_sessions.id = context_pack_recipes.provider_session_id
       WHERE provider_sessions.stage_attempt_id = ?
       ORDER BY provider_sessions.ordinal`,
    );
    const selectCheckpointsForAttempt = database.prepare(
      "SELECT * FROM checkpoints WHERE stage_attempt_id = ? ORDER BY created_at, ordinal, id",
    );
    const countCheckpointsForSession = database.prepare(
      "SELECT COUNT(*) AS count FROM checkpoints WHERE provider_session_id = ?",
    );
    const selectOrphanedRunningSessions = database.prepare(
      `SELECT provider_sessions.* FROM provider_sessions
       WHERE provider_sessions.status = 'RUNNING'
       ORDER BY provider_sessions.stage_attempt_id, provider_sessions.ordinal`,
    );
    const selectMaxCheckpointOrdinal = database.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM checkpoints WHERE provider_session_id = ?",
    );
    const insertCheckpoint = database.prepare(
      `INSERT INTO checkpoints (
        id, schema_version, stage_attempt_id, provider_session_id, ordinal, summary,
        completed_json, remaining_json, dead_ends_json, open_questions_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectLatestCheckpointForAttempt = database.prepare(
      `SELECT * FROM checkpoints WHERE stage_attempt_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const selectDecisionsForWorkItem = database.prepare(
      "SELECT * FROM decisions WHERE work_item_id = ? ORDER BY created_at, id",
    );
    // The context-pack variant of the read above. Newest-first with a LIMIT, then reversed by the
    // caller, exactly as ACTIVITY is read: the cap has to bind on the end that would be dropped, and
    // the most recent decisions are the ones the next session needs. See MAX_CONTEXT_SOURCE_RECORDS.
    const selectRecentDecisionsForWorkItem = database.prepare(
      "SELECT * FROM decisions WHERE work_item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    const selectRecentEventsForAggregate = database.prepare(
      "SELECT * FROM events WHERE aggregate_id = ? ORDER BY sequence DESC LIMIT ?",
    );

    const assertOpen = (): void => {
      if (closed) throw new StateStoreError("STATE_CLOSED", "The local state module is closed");
    };

    const readProject = (projectId: string): Project | null => {
      const row = selectProjectById.get(projectId);
      return row === undefined ? null : projectFromRow(row);
    };

    const readWorkItem = (workItemId: string): WorkItem | null => {
      const value = selectWorkItemById.get(workItemId);
      if (value === undefined) return null;
      const row = workItemRowSchema.parse(value);
      const acceptanceCriteria = criterionRowSchema
        .array()
        .parse(selectCriteria.all(workItemId))
        .map(({ criterion }) => criterion);
      return workItemSchema.parse({
        schemaVersion: 1,
        id: row.id,
        projectId: row.project_id,
        parentId: row.parent_id,
        type: row.type,
        title: row.title,
        description: row.description,
        state: row.state,
        currentStage: row.current_stage,
        priority: row.priority,
        risk: row.risk,
        acceptanceCriteria,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    };

    const readPipelineRun = (pipelineRunId: string): PipelineRun | null => {
      const value = selectPipelineRunById.get(pipelineRunId);
      return value === undefined ? null : pipelineRunFromRow(value);
    };

    const readLatestPipelineRun = (workItemId: string): PipelineRun | null => {
      const value = selectLatestPipelineRun.get(workItemId);
      return value === undefined ? null : pipelineRunFromRow(value);
    };

    const readPendingDispatchForAttempt = (stageAttemptId: string): WorkflowDispatch | null => {
      const row = selectPendingDispatchByStageAttempt.get(stageAttemptId);
      return row === undefined ? null : workflowDispatchFromRow(row);
    };

    const readStageAttempt = (stageAttemptId: string): StageAttempt | null => {
      const value = selectStageAttemptById.get(stageAttemptId);
      return value === undefined ? null : stageAttemptFromRow(value);
    };

    const readCurrentBudgetPolicy = (pipelineRunId: string): BudgetPolicy | null => {
      const value = selectCurrentBudgetPolicy.get(pipelineRunId);
      return value === undefined ? null : budgetPolicyFromRow(value);
    };

    const readUsageRecords = (pipelineRunId: string): UsageRecord[] =>
      database
        .prepare("SELECT * FROM usage_records WHERE pipeline_run_id = ? ORDER BY rowid")
        .all(pipelineRunId)
        .map(usageRecordFromRow);

    const readEvidenceArtifacts = (pipelineRunId: string): EvidenceArtifact[] =>
      database
        .prepare("SELECT * FROM evidence_artifacts WHERE pipeline_run_id = ? ORDER BY created_at, id")
        .all(pipelineRunId)
        .map(evidenceArtifactFromRow);

    // The context-pack variant, bounded for the same reason as the decisions read. Today the
    // UNIQUE (pipeline_run_id, kind) constraint on evidence_artifacts already holds this to two rows
    // per run, so the LIMIT never binds -- it is here so that the bound belongs to the section that
    // has to satisfy MAX_CONTEXT_SOURCE_RECORDS rather than to a uniqueness rule that exists for an
    // unrelated reason and could be widened by a later evidence kind.
    const readRecentEvidenceArtifacts = (pipelineRunId: string, limit: number): EvidenceArtifact[] =>
      database
        .prepare(
          "SELECT * FROM evidence_artifacts WHERE pipeline_run_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(pipelineRunId, limit)
        .map(evidenceArtifactFromRow)
        .reverse();

    const readAcceptancePackage = (acceptancePackageId: string): AcceptancePackage | null => {
      const value = selectAcceptancePackageById.get(acceptancePackageId);
      return value === undefined ? null : acceptancePackageFromRow(value);
    };

    const readAcceptancePackageForRun = (pipelineRunId: string): AcceptancePackage | null => {
      const value = selectAcceptancePackageByRun.get(pipelineRunId);
      return value === undefined ? null : acceptancePackageFromRow(value);
    };

    const readPendingDispatch = (stageAttemptId: string): WorkflowDispatch | null => {
      const value = selectPendingDispatchByStageAttempt.get(stageAttemptId);
      return value === undefined ? null : workflowDispatchFromRow(value);
    };

    const readHumanRequest = (humanRequestId: string): HumanRequest | null => {
      const value = selectHumanRequestById.get(humanRequestId);
      if (value === undefined) return null;
      const row = humanRequestRowSchema.parse(value);
      const options = humanRequestOptionRowSchema
        .array()
        .parse(selectHumanRequestOptions.all(humanRequestId))
        .map((option) => ({
          id: option.id,
          label: option.label,
          consequence: option.consequence,
          recommended: option.recommended === 1,
        }));
      return humanRequestSchema.parse({
        schemaVersion: 1,
        id: row.id,
        projectId: row.project_id,
        workItemId: row.work_item_id,
        stageAttemptId: row.stage_attempt_id,
        kind: row.kind,
        blocking: row.blocking === 1,
        title: row.title,
        context: row.context,
        recommendation: row.recommendation,
        options,
        allowOther: row.allow_other === 1,
        status: row.status,
        version: row.version,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      });
    };

    const readWorkflowDispatch = (dispatchId: string): WorkflowDispatch | null => {
      const value = selectWorkflowDispatchById.get(dispatchId);
      return value === undefined ? null : workflowDispatchFromRow(value);
    };

    const readWorkflowSnapshot = (workItemId: string): WorkflowSnapshot => {
      const run = readLatestPipelineRun(workItemId);
      if (!run) {
        return workflowSnapshotSchema.parse({
          schemaVersion: 1,
          run: null,
          stageAttempts: [],
          humanRequests: [],
          decisions: [],
          budgetPolicies: [],
          usageRecords: [],
          recoveryReports: [],
          artifacts: [],
          acceptancePackage: null,
        });
      }
      const stageAttempts = database
        .prepare("SELECT * FROM stage_attempts WHERE pipeline_run_id = ? ORDER BY rowid")
        .all(run.id)
        .map(stageAttemptFromRow);
      const humanRequests = database
        .prepare("SELECT * FROM human_requests WHERE work_item_id = ? ORDER BY created_at, id")
        .all(workItemId)
        .map((row) => {
          const request = readHumanRequest(humanRequestRowSchema.parse(row).id);
          if (!request) {
            throw new StateStoreError("PERSISTENCE_FAILURE", "A listed HumanRequest could not be reloaded");
          }
          return request;
        });
      const decisions = selectDecisionsForWorkItem.all(workItemId).map(decisionFromRow);
      const budgetPolicies = database
        .prepare("SELECT * FROM budget_policies WHERE pipeline_run_id = ? ORDER BY revision")
        .all(run.id)
        .map(budgetPolicyFromRow);
      const usageRecords = readUsageRecords(run.id);
      const recoveryReports = database
        .prepare("SELECT * FROM recovery_reports WHERE pipeline_run_id = ? ORDER BY created_at, id")
        .all(run.id)
        .map(recoveryReportFromRow);
      const artifacts = readEvidenceArtifacts(run.id);
      const acceptancePackage = readAcceptancePackageForRun(run.id);
      return workflowSnapshotSchema.parse({
        schemaVersion: 1,
        run,
        stageAttempts,
        humanRequests,
        decisions,
        budgetPolicies,
        usageRecords,
        recoveryReports,
        artifacts,
        acceptancePackage,
      });
    };

    // Spec §6.1 step 1: every context source read together, as one consistent snapshot. Wrapped in
    // its own transaction (distinct from `execute`'s BEGIN IMMEDIATE, which is for writes) so a
    // concurrent writer's commit landing partway through cannot make one source describe a
    // different moment than another -- the recipe records a per-section sourceVersion, and a
    // torn read would make that provenance describe a pack that never existed.
    const readContextSourcesSnapshot = (stageAttemptId: string, sessionOrdinal: number): ContextSources => {
      let transactionStarted = false;
      try {
        database.exec("BEGIN");
        transactionStarted = true;

        const stageAttempt = readStageAttempt(stageAttemptId);
        // Test-only: lets a test commit a write through a second connection right here, then
        // assert the reads below still see the pre-write snapshot. See OpenLocalStateOptions.
        options.onContextSourcesSnapshotStarted?.();
        if (!stageAttempt) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The StageAttempt does not exist");
        }
        const workItem = readWorkItem(stageAttempt.workItemId);
        const run = readPipelineRun(stageAttempt.pipelineRunId);
        if (!workItem || !run) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The workflow state backing this StageAttempt is incomplete",
          );
        }

        const decisions = decisionRowSchema
          .array()
          .parse(selectRecentDecisionsForWorkItem.all(workItem.id, MAX_CONTEXT_SOURCE_RECORDS))
          .reverse()
          .map(decisionFromRow)
          .map((decision) => {
            const request = readHumanRequest(decision.humanRequestId);
            return {
              id: decision.id,
              version: 1,
              question: request?.title ?? decision.humanRequestId,
              answer: describeDecisionAnswer(decision.answer, request?.options ?? []),
            };
          });

        const latestCheckpointRow = selectLatestCheckpointForAttempt.get(stageAttemptId);
        const latestCheckpointEntity =
          latestCheckpointRow === undefined ? null : checkpointFromRow(latestCheckpointRow);
        const latestCheckpoint =
          latestCheckpointEntity === null
            ? null
            : {
                id: latestCheckpointEntity.id,
                version: 1,
                summary: latestCheckpointEntity.summary,
                completed: latestCheckpointEntity.completed,
                remaining: latestCheckpointEntity.remaining,
                deadEnds: latestCheckpointEntity.deadEnds,
                openQuestions: latestCheckpointEntity.openQuestions,
              };

        const evidence = readRecentEvidenceArtifacts(run.id, MAX_CONTEXT_SOURCE_RECORDS).map((artifact) => ({
          id: artifact.id,
          version: 1,
          kind: artifact.kind,
          title: artifact.title,
          summary: artifact.summary,
        }));

        // Reads id/type/occurred_at straight off the row -- NOT through eventFromRow, which runs
        // domainEventSchema.parse over the full row including data_json. The events CHECK
        // constraint (migration 0006) already admits CONTEXT_HANDOFF_REQUESTED and
        // CONTEXT_FLOOR_EXCEEDED, neither of which domainEventSchema models yet (deliberately --
        // Task 8 emits them). The moment either lands in a work item's recent history, parsing it
        // here would throw PERSISTENCE_FAILURE and block every future session from starting for
        // that work item. ACTIVITY only ever needs these three fields, so it never needs the parse.
        const activity = eventRowSchema
          .array()
          .parse(selectRecentEventsForAggregate.all(workItem.id, MAX_ACTIVITY_EVENTS))
          .reverse()
          .map((row) => ({
            id: row.id,
            version: 1,
            occurredAt: row.occurred_at,
            description: humanizeEventType(row.type),
          }));

        const sources: ContextSources = {
          workItemBrief: {
            id: workItem.id,
            version: workItem.version,
            title: workItem.title,
            description: workItem.description,
            acceptanceCriteria: workItem.acceptanceCriteria,
            priority: workItem.priority,
            risk: workItem.risk,
          },
          workflowPosition: {
            templateId: run.workflowTemplateId,
            templateVersion: run.workflowVersion,
            stage: stageAttempt.stage,
            attempt: stageAttempt.attempt,
            sessionOrdinal,
          },
          decisions,
          latestCheckpoint,
          evidence,
          activity,
        };

        database.exec("COMMIT");
        transactionStarted = false;
        return sources;
      } catch (error: unknown) {
        if (transactionStarted) database.exec("ROLLBACK");
        if (error instanceof WorkflowDomainError || error instanceof StateStoreError) throw error;
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The context sources snapshot could not be read",
          {},
          { cause: error },
        );
      }
    };

    const writeCriteria = (workItem: WorkItem): void => {
      deleteCriteria.run(workItem.id);
      workItem.acceptanceCriteria.forEach((criterion, ordinal) => {
        insertCriterion.run(workItem.id, ordinal, criterion);
      });
    };

    const appendEvent = (
      intent: WorkItemEventIntent,
      metadata: {
        aggregateId: string;
        projectId: string;
        actor: Actor;
        occurredAt: string;
        correlationId: string;
      },
    ): DomainEvent => {
      const eventId = createId("event");
      const result = insertEvent.run(
        eventId,
        1,
        intent.type,
        "WORK_ITEM",
        metadata.aggregateId,
        metadata.projectId,
        metadata.actor.type,
        metadata.actor.id,
        metadata.occurredAt,
        metadata.correlationId,
        JSON.stringify(intent.data),
      );
      return domainEventSchema.parse({
        schemaVersion: 1,
        sequence: lastInsertSequence(result.lastInsertRowid),
        id: eventId,
        type: intent.type,
        aggregateType: "WORK_ITEM",
        aggregateId: metadata.aggregateId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
      });
    };

    const appendProjectEvent = (
      project: Project,
      command: RegisterProjectCommand,
      occurredAt: string,
    ): DomainEvent => {
      const eventId = createId("event");
      const data = { project };
      const result = insertEvent.run(
        eventId,
        1,
        "PROJECT_REGISTERED",
        "PROJECT",
        project.id,
        project.id,
        command.actor.type,
        command.actor.id,
        occurredAt,
        command.correlationId,
        JSON.stringify(data),
      );
      return domainEventSchema.parse({
        schemaVersion: 1,
        sequence: lastInsertSequence(result.lastInsertRowid),
        id: eventId,
        type: "PROJECT_REGISTERED",
        aggregateType: "PROJECT",
        aggregateId: project.id,
        projectId: project.id,
        actor: command.actor,
        occurredAt,
        correlationId: command.correlationId,
        data,
      });
    };

    type WorkflowEventIntent =
      | StartWorkflowDecision["events"][number]
      | MarkDispatchStartedDecision["events"][number]
      | ApplyProviderOutcomeDecision["events"][number]
      | AnswerHumanRequestDecision["events"][number]
      | PipelineControlDecision["events"][number]
      | BudgetOverrideDecision["events"][number]
      | RecoveryDecision["events"][number]
      | AcceptanceResolutionDecision["events"][number]
      | StageAttemptPauseDecision["events"][number];

    const appendWorkflowEvents = (
      intents: readonly WorkflowEventIntent[],
      metadata: {
        workItemId: string;
        projectId: string;
        actor: Actor;
        occurredAt: string;
        correlationId: string;
      },
    ): DomainEvent[] =>
      intents.map((intent) => {
        const eventId = createId("event");
        const result = insertEvent.run(
          eventId,
          1,
          intent.type,
          "WORK_ITEM",
          metadata.workItemId,
          metadata.projectId,
          metadata.actor.type,
          metadata.actor.id,
          metadata.occurredAt,
          metadata.correlationId,
          JSON.stringify(intent.data),
        );
        return domainEventSchema.parse({
          schemaVersion: 1,
          sequence: lastInsertSequence(result.lastInsertRowid),
          id: eventId,
          type: intent.type,
          aggregateType: "WORK_ITEM",
          aggregateId: metadata.workItemId,
          projectId: metadata.projectId,
          actor: metadata.actor,
          occurredAt: metadata.occurredAt,
          correlationId: metadata.correlationId,
          data: intent.data,
        });
      });

    type SessionEventIntent =
      | { type: "PROVIDER_SESSION_STARTED"; data: { session: ProviderSession; recipe: ContextPackRecipe } }
      | { type: "CHECKPOINT_PUBLISHED"; data: { checkpoint: Checkpoint } }
      | { type: "PROVIDER_SESSION_ENDED"; data: { session: ProviderSession } }
      | {
          type: "CONTEXT_HANDOFF_REQUESTED";
          data: { session: ProviderSession; usage: ContextWindowUsage };
        };

    const appendSessionEvent = (
      intent: SessionEventIntent,
      metadata: {
        workItemId: string;
        projectId: string;
        actor: Actor;
        occurredAt: string;
        correlationId: string;
      },
    ): DomainEvent => {
      const eventId = createId("event");
      const result = insertEvent.run(
        eventId,
        1,
        intent.type,
        "WORK_ITEM",
        metadata.workItemId,
        metadata.projectId,
        metadata.actor.type,
        metadata.actor.id,
        metadata.occurredAt,
        metadata.correlationId,
        JSON.stringify(intent.data),
      );
      return domainEventSchema.parse({
        schemaVersion: 1,
        sequence: lastInsertSequence(result.lastInsertRowid),
        id: eventId,
        type: intent.type,
        aggregateType: "WORK_ITEM",
        aggregateId: metadata.workItemId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
      });
    };

    const persistWorkflowTemplate = (
      templateInput: StartMockPipelineCommand["payload"]["template"],
      createdAt: string,
    ): void => {
      const template = workflowTemplateSchema.parse(templateInput);
      const templateJson = canonicalJson(template);
      database
        .prepare(
          `INSERT OR IGNORE INTO workflow_templates
           (id, version, schema_version, name, template_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(template.id, template.version, template.schemaVersion, template.name, templateJson, createdAt);
      const stored = z
        .object({ template_json: z.string() })
        .parse(
          database
            .prepare("SELECT template_json FROM workflow_templates WHERE id = ? AND version = ?")
            .get(template.id, template.version),
        );
      if (stored.template_json !== templateJson) {
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "A workflow template version cannot be changed after it is persisted",
        );
      }
    };

    const updateWorkflowWorkItem = (workItem: WorkItem): void => {
      const update = database
        .prepare(
          `UPDATE work_items SET state = ?, current_stage = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          workItem.state,
          workItem.currentStage,
          workItem.version,
          workItem.updatedAt,
          workItem.id,
          workItem.version - 1,
        );
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The WorkItem changed while the workflow command was being applied",
        );
      }
    };

    const insertPipelineRun = (run: PipelineRun): void => {
      database
        .prepare(
          `INSERT INTO pipeline_runs (
            id, project_id, work_item_id, workflow_template_id, workflow_version, status,
            current_stage_attempt_id, version, created_at, updated_at, finished_at, orchestration_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.projectId,
          run.workItemId,
          run.workflowTemplateId,
          run.workflowVersion,
          legacyCompatibleRunStatus(run.status),
          run.currentStageAttemptId,
          run.version,
          run.createdAt,
          run.updatedAt,
          run.finishedAt,
          run.status,
        );
    };

    const updatePipelineRun = (run: PipelineRun): void => {
      const update = database
        .prepare(
          `UPDATE pipeline_runs SET status = ?, orchestration_status = ?, current_stage_attempt_id = ?, version = ?,
             updated_at = ?, finished_at = ? WHERE id = ? AND version = ?`,
        )
        .run(
          legacyCompatibleRunStatus(run.status),
          run.status,
          run.currentStageAttemptId,
          run.version,
          run.updatedAt,
          run.finishedAt,
          run.id,
          run.version - 1,
        );
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The PipelineRun changed while the command was being applied",
        );
      }
    };

    const insertStageAttempt = (attempt: StageAttempt): void => {
      database
        .prepare(
          `INSERT INTO stage_attempts (
            id, pipeline_run_id, project_id, work_item_id, stage, attempt, status, version,
            started_at, finished_at, failure_code, unproductive_sessions, pack_share_backoffs
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.id,
          attempt.pipelineRunId,
          attempt.projectId,
          attempt.workItemId,
          attempt.stage,
          attempt.attempt,
          attempt.status,
          attempt.version,
          attempt.startedAt,
          attempt.finishedAt,
          attempt.failureCode,
          attempt.unproductiveSessions,
          attempt.packShareBackoffs,
        );
    };

    const updateStageAttempt = (attempt: StageAttempt): void => {
      const update = database
        .prepare(
          `UPDATE stage_attempts SET status = ?, version = ?, started_at = ?, finished_at = ?,
             failure_code = ?, unproductive_sessions = ?, pack_share_backoffs = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          attempt.status,
          attempt.version,
          attempt.startedAt,
          attempt.finishedAt,
          attempt.failureCode,
          attempt.unproductiveSessions,
          attempt.packShareBackoffs,
          attempt.id,
          attempt.version - 1,
        );
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The StageAttempt changed while the command was being applied",
        );
      }
    };

    const insertWorkflowDispatch = (dispatch: WorkflowDispatch): void => {
      database
        .prepare(
          `INSERT INTO workflow_dispatches (
            id, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            mode, status, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          dispatch.id,
          dispatch.projectId,
          dispatch.workItemId,
          dispatch.pipelineRunId,
          dispatch.stageAttemptId,
          dispatch.mode,
          dispatch.status,
          dispatch.createdAt,
          dispatch.completedAt,
        );
    };

    const updateWorkflowDispatch = (dispatch: WorkflowDispatch): void => {
      const update = database
        .prepare(
          "UPDATE workflow_dispatches SET status = ?, completed_at = ? WHERE id = ? AND status = 'PENDING'",
        )
        .run(dispatch.status, dispatch.completedAt, dispatch.id);
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_DISPATCH_ALREADY_COMPLETED",
          "The workflow dispatch has already been applied",
        );
      }
    };

    const insertBudgetPolicy = (policy: BudgetPolicy): void => {
      database
        .prepare(
          `INSERT INTO budget_policies (
            id, schema_version, project_id, work_item_id, pipeline_run_id, revision,
            max_estimated_tokens, warning_thresholds_json, actor_type, actor_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          policy.id,
          policy.schemaVersion,
          policy.projectId,
          policy.workItemId,
          policy.pipelineRunId,
          policy.revision,
          policy.maxEstimatedTokens,
          JSON.stringify(policy.warningThresholds),
          policy.createdBy.type,
          policy.createdBy.id,
          policy.createdAt,
        );
    };

    const insertUsageRecord = (record: UsageRecord): void => {
      database
        .prepare(
          `INSERT INTO usage_records (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            budget_policy_id, kind, amount, quality, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.schemaVersion,
          record.projectId,
          record.workItemId,
          record.pipelineRunId,
          record.stageAttemptId,
          record.budgetPolicyId,
          record.kind,
          record.amount,
          record.quality,
          record.recordedAt,
        );
    };

    const insertRecoveryReport = (report: RecoveryReport): void => {
      database
        .prepare(
          `INSERT INTO recovery_reports (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            previous_status, recovered_status, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          report.id,
          report.schemaVersion,
          report.projectId,
          report.workItemId,
          report.pipelineRunId,
          report.stageAttemptId,
          report.previousStatus,
          report.recoveredStatus,
          report.reason,
          report.createdAt,
        );
    };

    const insertEvidenceArtifact = (artifact: EvidenceArtifact): void => {
      database
        .prepare(
          `INSERT INTO evidence_artifacts (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            stage, kind, status, provider, title, summary, checks_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.schemaVersion,
          artifact.projectId,
          artifact.workItemId,
          artifact.pipelineRunId,
          artifact.stageAttemptId,
          artifact.stage,
          artifact.kind,
          artifact.status,
          artifact.provider,
          artifact.title,
          artifact.summary,
          JSON.stringify(artifact.checks),
          artifact.createdAt,
        );
    };

    const insertAcceptancePackage = (acceptancePackage: AcceptancePackage): void => {
      database
        .prepare(
          `INSERT INTO acceptance_packages (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            human_request_id, status, criteria_json, artifact_ids_json, release_note,
            verify_instructions_json, version, created_at, resolved_at, resolved_by_type,
            resolved_by_id, resolution_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          acceptancePackage.id,
          acceptancePackage.schemaVersion,
          acceptancePackage.projectId,
          acceptancePackage.workItemId,
          acceptancePackage.pipelineRunId,
          acceptancePackage.stageAttemptId,
          acceptancePackage.humanRequestId,
          acceptancePackage.status,
          JSON.stringify(acceptancePackage.criteria),
          JSON.stringify(acceptancePackage.artifactIds),
          acceptancePackage.releaseNote,
          JSON.stringify(acceptancePackage.verifyInstructions),
          acceptancePackage.version,
          acceptancePackage.createdAt,
          acceptancePackage.resolvedAt,
          acceptancePackage.resolvedBy?.type ?? null,
          acceptancePackage.resolvedBy?.id ?? null,
          acceptancePackage.resolutionReason,
        );
    };

    const updateAcceptancePackage = (acceptancePackage: AcceptancePackage): void => {
      const update = database
        .prepare(
          `UPDATE acceptance_packages SET status = ?, criteria_json = ?, artifact_ids_json = ?,
             release_note = ?, verify_instructions_json = ?, version = ?, resolved_at = ?,
             resolved_by_type = ?, resolved_by_id = ?, resolution_reason = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          acceptancePackage.status,
          JSON.stringify(acceptancePackage.criteria),
          JSON.stringify(acceptancePackage.artifactIds),
          acceptancePackage.releaseNote,
          JSON.stringify(acceptancePackage.verifyInstructions),
          acceptancePackage.version,
          acceptancePackage.resolvedAt,
          acceptancePackage.resolvedBy?.type ?? null,
          acceptancePackage.resolvedBy?.id ?? null,
          acceptancePackage.resolutionReason,
          acceptancePackage.id,
          acceptancePackage.version - 1,
        );
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The AcceptancePackage changed while the resolution was being applied",
        );
      }
    };

    const insertHumanRequest = (request: HumanRequest): void => {
      database
        .prepare(
          `INSERT INTO human_requests (
            id, project_id, work_item_id, stage_attempt_id, kind, blocking, title, context,
            recommendation, allow_other, status, version, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id,
          request.projectId,
          request.workItemId,
          request.stageAttemptId,
          request.kind,
          request.blocking ? 1 : 0,
          request.title,
          request.context,
          request.recommendation,
          request.allowOther ? 1 : 0,
          request.status,
          request.version,
          request.createdAt,
          request.resolvedAt,
        );
      const insertOption = database.prepare(
        `INSERT INTO human_request_options
         (human_request_id, ordinal, id, label, consequence, recommended)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      request.options.forEach((option, ordinal) => {
        insertOption.run(
          request.id,
          ordinal,
          option.id,
          option.label,
          option.consequence,
          option.recommended ? 1 : 0,
        );
      });
    };

    const updateHumanRequest = (request: HumanRequest): void => {
      const update = database
        .prepare(
          `UPDATE human_requests SET status = ?, version = ?, resolved_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(request.status, request.version, request.resolvedAt, request.id, request.version - 1);
      if (update.changes !== 1) {
        throw new WorkflowDomainError(
          "WORKFLOW_VERSION_CONFLICT",
          "The HumanRequest changed while the answer was being applied",
        );
      }
    };

    const insertDecision = (decision: Decision): void => {
      database
        .prepare(
          `INSERT INTO decisions (
            id, schema_version, project_id, work_item_id, human_request_id, answer_json,
            actor_type, actor_id, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          decision.schemaVersion,
          decision.projectId,
          decision.workItemId,
          decision.humanRequestId,
          JSON.stringify(decision.answer),
          decision.actor.type,
          decision.actor.id,
          decision.reason,
          decision.createdAt,
        );
    };

    const persistWorkItemDecision = (command: WorkItemCommand, decision: WorkItemDecision): void => {
      const item = decision.workItem;
      if (command.type === "CREATE_WORK_ITEM") {
        database
          .prepare(
            `INSERT INTO work_items (
              id, project_id, parent_id, type, title, description, state, current_stage,
              priority, risk, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.id,
            item.projectId,
            item.parentId,
            item.type,
            item.title,
            item.description,
            item.state,
            item.currentStage,
            item.priority,
            item.risk,
            item.version,
            item.createdAt,
            item.updatedAt,
          );
      } else {
        const update = database
          .prepare(
            `UPDATE work_items SET
              title = ?, description = ?, state = ?, current_stage = ?, priority = ?, risk = ?,
              version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            item.title,
            item.description,
            item.state,
            item.currentStage,
            item.priority,
            item.risk,
            item.version,
            item.updatedAt,
            item.id,
            item.version - 1,
          );
        if (update.changes !== 1) {
          throw new WorkItemDomainError(
            "VERSION_CONFLICT",
            "The WorkItem changed while the command was being applied",
          );
        }
      }
      writeCriteria(item);
    };

    const executeFresh = (command: StateCommand, occurredAt: string): StateCommandResult => {
      if (command.type === "REGISTER_FIXTURE_PROJECT") {
        const existing = database
          .prepare(
            `SELECT id FROM projects
             WHERE id = ? OR fixture_id = ? OR repository_path = ? LIMIT 1`,
          )
          .get(command.payload.id, command.payload.fixtureId, command.payload.repositoryPath);
        if (existing !== undefined) {
          throw new StateStoreError(
            "PROJECT_ALREADY_REGISTERED",
            "The fixture Project is already registered",
          );
        }
        const project = projectSchema.parse({
          schemaVersion: 1,
          id: command.payload.id,
          workspaceId: DEFAULT_WORKSPACE_ID,
          fixtureId: command.payload.fixtureId,
          name: command.payload.name,
          repositoryPath: command.payload.repositoryPath,
          status: "ACTIVE",
          version: 1,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        database
          .prepare(
            `INSERT INTO projects (
              id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            project.id,
            project.workspaceId,
            project.fixtureId,
            project.name,
            project.repositoryPath,
            project.status,
            project.version,
            project.createdAt,
            project.updatedAt,
          );
        const event = appendProjectEvent(project, command, occurredAt);
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_REGISTERED",
          replayed: false,
          project,
          event,
        });
      }

      if (command.type === "START_MOCK_PIPELINE") {
        const workItem = readWorkItem(command.payload.workItemId);
        if (!workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        const activeRunValue = selectActivePipelineRun.get(workItem.id);
        const activeRun = activeRunValue === undefined ? null : pipelineRunFromRow(activeRunValue);
        const hasChildren =
          database
            .prepare("SELECT 1 AS present FROM work_items WHERE parent_id = ? LIMIT 1")
            .get(workItem.id) !== undefined;
        const decision = decideStartMockPipeline(command, {
          now: occurredAt,
          workItem,
          activeRun,
          hasChildren,
          ids: {
            pipelineRunId: createId("pipelineRun"),
            stageAttemptId: createId("stageAttempt"),
            budgetPolicyId: createId("budgetPolicy"),
            dispatchId: createId("workflowDispatch"),
          },
        });
        persistWorkflowTemplate(command.payload.template, occurredAt);
        updateWorkflowWorkItem(decision.workItem);
        insertPipelineRun(decision.run);
        insertStageAttempt(decision.stageAttempt);
        insertBudgetPolicy(decision.budgetPolicy);
        insertWorkflowDispatch(decision.dispatch);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PIPELINE_STARTED",
          replayed: false,
          workItemId: decision.workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          budgetPolicy: decision.budgetPolicy,
          dispatch: decision.dispatch,
          events,
        });
      }

      if (command.type === "MARK_WORKFLOW_DISPATCH_STARTED") {
        const dispatch = readWorkflowDispatch(command.payload.dispatchId);
        if (!dispatch) {
          throw new WorkflowDomainError(
            "WORKFLOW_DISPATCH_NOT_FOUND",
            "The workflow dispatch does not exist",
          );
        }
        const run = readPipelineRun(dispatch.pipelineRunId);
        const stageAttempt = readStageAttempt(dispatch.stageAttemptId);
        const workItem = readWorkItem(dispatch.workItemId);
        if (!run || !stageAttempt || !workItem) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        const decision = decideMarkWorkflowDispatchStarted(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          dispatch,
        });
        updateStageAttempt(decision.stageAttempt);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "WORKFLOW_DISPATCH_STARTED",
          replayed: false,
          workItemId: workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          dispatch: decision.dispatch,
          events,
        });
      }

      if (command.type === "APPLY_MOCK_PROVIDER_OUTCOME" || command.type === "APPLY_PROVIDER_OUTCOME") {
        const dispatch = readWorkflowDispatch(command.payload.dispatchId);
        if (!dispatch) {
          throw new WorkflowDomainError(
            "WORKFLOW_DISPATCH_NOT_FOUND",
            "The workflow dispatch does not exist",
          );
        }
        const run = readPipelineRun(dispatch.pipelineRunId);
        const stageAttempt = readStageAttempt(dispatch.stageAttemptId);
        const workItem = readWorkItem(dispatch.workItemId);
        if (!run || !stageAttempt || !workItem) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        // decideApplyProviderOutcome never reads command.type; normalizing it here keeps the
        // domain function's parameter type single-literal (so it, in turn, narrows cleanly)
        // without weakening what actually gets persisted as this command's command_type below.
        const decision = decideApplyProviderOutcome(
          { ...command, type: "APPLY_PROVIDER_OUTCOME" },
          {
            now: occurredAt,
            workItem,
            run,
            stageAttempt,
            dispatch,
            budgetPolicy: readCurrentBudgetPolicy(run.id),
            existingUsageRecords: readUsageRecords(run.id),
            existingArtifacts: readEvidenceArtifacts(run.id),
            usageRecordIds:
              command.payload.outcome.type === "BUDGET_LIMIT_REACHED"
                ? command.payload.outcome.usageIncrements.map(() => createId("usageRecord"))
                : [],
            artifactIds:
              command.payload.outcome.type === "COMPLETED"
                ? (command.payload.outcome.artifacts ?? []).map(() => createId("evidenceArtifact"))
                : [],
            humanRequestId: createId("humanRequest"),
            acceptancePackageId: createId("acceptancePackage"),
            nextStageAttemptId: createId("stageAttempt"),
            nextDispatchId: createId("workflowDispatch"),
          },
        );
        persistWorkflowTemplate(command.payload.template, occurredAt);
        updateWorkflowDispatch(decision.dispatch);
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        if (decision.workItem.version !== workItem.version) updateWorkflowWorkItem(decision.workItem);
        if (decision.request) insertHumanRequest(decision.request);
        decision.artifacts.forEach(insertEvidenceArtifact);
        if (decision.acceptancePackage) insertAcceptancePackage(decision.acceptancePackage);
        if (decision.nextStageAttempt) insertStageAttempt(decision.nextStageAttempt);
        if (decision.nextDispatch) insertWorkflowDispatch(decision.nextDispatch);
        decision.usageRecords.forEach(insertUsageRecord);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MOCK_PROVIDER_OUTCOME_APPLIED",
          replayed: false,
          workItemId: decision.workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          usageRecords: decision.usageRecords,
          artifacts: decision.artifacts,
          acceptancePackage: decision.acceptancePackage,
          events,
        });
      }

      if (command.type === "RESOLVE_ACCEPTANCE") {
        const acceptancePackage = readAcceptancePackage(command.payload.acceptancePackageId);
        const run = acceptancePackage ? readPipelineRun(acceptancePackage.pipelineRunId) : null;
        const stageAttempt = acceptancePackage ? readStageAttempt(acceptancePackage.stageAttemptId) : null;
        const workItem = acceptancePackage ? readWorkItem(acceptancePackage.workItemId) : null;
        const request = acceptancePackage ? readHumanRequest(acceptancePackage.humanRequestId) : null;
        if (!acceptancePackage) {
          throw new WorkflowDomainError("ACCEPTANCE_NOT_FOUND", "The AcceptancePackage does not exist");
        }
        if (!run || !stageAttempt || !workItem || !request) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The acceptance workflow state is incomplete");
        }
        const decision = decideResolveAcceptance(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          acceptancePackage,
          request,
          decisionId: createId("decision"),
        });
        updateHumanRequest(decision.request);
        insertDecision(decision.decision);
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        updateAcceptancePackage(decision.acceptancePackage);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "ACCEPTANCE_RESOLVED",
          replayed: false,
          action: decision.action,
          workItemId: decision.workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          acceptancePackage: decision.acceptancePackage,
          request: decision.request,
          decision: decision.decision,
          events,
        });
      }

      if (command.type === "ANSWER_HUMAN_REQUEST") {
        const request = readHumanRequest(command.payload.humanRequestId);
        if (!request) {
          throw new WorkflowDomainError("HUMAN_REQUEST_NOT_FOUND", "The HumanRequest does not exist");
        }
        const stageAttempt = readStageAttempt(request.stageAttemptId);
        const run = stageAttempt ? readPipelineRun(stageAttempt.pipelineRunId) : null;
        const workItem = readWorkItem(request.workItemId);
        if (!stageAttempt || !run || !workItem) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        const decision = decideAnswerHumanRequest(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          request,
          decisionId: createId("decision"),
          dispatchId: createId("workflowDispatch"),
        });
        updateHumanRequest(decision.request);
        insertDecision(decision.decision);
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        insertWorkflowDispatch(decision.dispatch);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "HUMAN_REQUEST_ANSWERED",
          replayed: false,
          workItemId: decision.workItem.id,
          request: decision.request,
          decision: decision.decision,
          dispatch: decision.dispatch,
          events,
        });
      }

      if (
        command.type === "PAUSE_PIPELINE" ||
        command.type === "RESUME_PIPELINE" ||
        command.type === "CANCEL_PIPELINE"
      ) {
        const run = readPipelineRun(command.payload.pipelineRunId);
        const stageAttempt = run ? readStageAttempt(run.currentStageAttemptId) : null;
        const workItem = run ? readWorkItem(run.workItemId) : null;
        if (!run || !stageAttempt || !workItem) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        const pendingDispatch = readPendingDispatch(stageAttempt.id);
        const decision =
          command.type === "PAUSE_PIPELINE"
            ? decidePausePipeline(command, {
                now: occurredAt,
                workItem,
                run,
                stageAttempt,
                pendingDispatch,
              })
            : command.type === "RESUME_PIPELINE"
              ? decideResumePipeline(command, {
                  now: occurredAt,
                  workItem,
                  run,
                  stageAttempt,
                  dispatchId: createId("workflowDispatch"),
                })
              : decideCancelPipeline(command, {
                  now: occurredAt,
                  workItem,
                  run,
                  stageAttempt,
                  pendingDispatch,
                  acceptancePending: readAcceptancePackageForRun(run.id)?.status === "PENDING",
                });
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        if (decision.previousDispatch && decision.previousDispatch.status !== pendingDispatch?.status) {
          updateWorkflowDispatch(decision.previousDispatch);
        }
        if (decision.dispatch) insertWorkflowDispatch(decision.dispatch);
        if (decision.action === "CANCEL") {
          database
            .prepare(
              `UPDATE human_requests SET status = 'CANCELLED', version = version + 1, resolved_at = ?
               WHERE work_item_id = ? AND status IN ('OPEN', 'CLAIMED', 'SNOOZED')`,
            )
            .run(occurredAt, workItem.id);
        }
        const events = appendWorkflowEvents(decision.events, {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PIPELINE_CONTROL_APPLIED",
          replayed: false,
          action: decision.action,
          workItemId: workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          dispatch: decision.dispatch,
          events,
        });
      }

      if (command.type === "APPROVE_BUDGET_OVERRIDE") {
        const run = readPipelineRun(command.payload.pipelineRunId);
        const stageAttempt = run ? readStageAttempt(run.currentStageAttemptId) : null;
        const workItem = run ? readWorkItem(run.workItemId) : null;
        const currentBudgetPolicy = run ? readCurrentBudgetPolicy(run.id) : null;
        if (!run || !stageAttempt || !workItem || !currentBudgetPolicy) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        const decision = decideApproveBudgetOverride(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          currentBudgetPolicy,
          cumulativeUsage: readUsageRecords(run.id).reduce((total, record) => total + record.amount, 0),
          ids: {
            budgetPolicyId: createId("budgetPolicy"),
            stageAttemptId: createId("stageAttempt"),
            dispatchId: createId("workflowDispatch"),
          },
        });
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        insertBudgetPolicy(decision.budgetPolicy);
        insertStageAttempt(decision.stageAttempt);
        insertWorkflowDispatch(decision.dispatch);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "BUDGET_OVERRIDE_APPROVED",
          replayed: false,
          workItemId: workItem.id,
          run: decision.run,
          previousStageAttempt: decision.previousStageAttempt,
          stageAttempt: decision.stageAttempt,
          budgetPolicy: decision.budgetPolicy,
          dispatch: decision.dispatch,
          events,
        });
      }

      if (command.type === "RECONCILE_WORKFLOWS") {
        const interruptedSessions: ProviderSession[] = [];
        const orphanedDispatches = database
          .prepare(
            `SELECT workflow_dispatches.* FROM workflow_dispatches
             INNER JOIN stage_attempts ON stage_attempts.id = workflow_dispatches.stage_attempt_id
             INNER JOIN pipeline_runs ON pipeline_runs.id = workflow_dispatches.pipeline_run_id
             WHERE workflow_dispatches.status = 'PENDING'
               AND stage_attempts.status = 'RUNNING'
               AND COALESCE(pipeline_runs.orchestration_status, pipeline_runs.status) = 'RUNNING'
             ORDER BY workflow_dispatches.created_at, workflow_dispatches.id`,
          )
          .all()
          .map(workflowDispatchFromRow);
        const recoveryReports: RecoveryReport[] = [];
        const events: DomainEvent[] = [];

        // Spec §6.4: a daemon restart is the ordinary end of a ProviderSession, not a failed
        // StageAttempt. A session still marked RUNNING at startup is orphaned by definition -- the
        // process that ran it is gone -- so it ends as ENDED/INTERRUPTED and the attempt keeps its
        // pending dispatch, which the session loop picks up and continues from the last checkpoint.
        // Attempts recovered this way are therefore excluded from the dispatch-level recovery
        // below, which exists for the case where no session ever started.
        const attemptsWithInterruptedSession = new Set<string>();
        for (const sessionRow of selectOrphanedRunningSessions.all()) {
          const current = providerSessionFromRow(sessionRow);
          const sessionAttempt = readStageAttempt(current.stageAttemptId);
          if (!sessionAttempt) {
            throw new WorkflowDomainError(
              "WORKFLOW_NOT_FOUND",
              "The StageAttempt backing an orphaned ProviderSession is missing",
            );
          }
          // Kill first, mark second (see killOrphanedSessionProcess): a session with no recorded
          // pid never reached the point of having a process to kill, and is simply marked ENDED.
          if (current.pid !== null) {
            killOrphanedSessionProcess({
              pid: current.pid,
              sessionId: current.id,
              sessionStartedAt: current.startedAt,
              now: new Date(occurredAt),
              processStartedAt,
              report: reportOrphanProcess,
            });
          }
          const session = providerSessionSchema.parse({
            ...current,
            status: "ENDED",
            endReason: "INTERRUPTED",
            endedAt: occurredAt,
            version: current.version + 1,
          });
          const sessionUpdate = updateProviderSession.run(
            session.status,
            session.endReason,
            session.handoffRequestedAt,
            session.endedAt,
            session.version,
            session.id,
            current.version,
          );
          if (sessionUpdate.changes !== 1) {
            throw new WorkflowDomainError(
              "WORKFLOW_VERSION_CONFLICT",
              "An orphaned ProviderSession changed while it was being interrupted",
            );
          }
          interruptedSessions.push(session);
          attemptsWithInterruptedSession.add(session.stageAttemptId);
          events.push(
            appendSessionEvent(
              { type: "PROVIDER_SESSION_ENDED", data: { session } },
              {
                workItemId: sessionAttempt.workItemId,
                projectId: sessionAttempt.projectId,
                actor: command.actor,
                occurredAt,
                correlationId: command.correlationId,
              },
            ),
          );
        }

        for (const dispatch of orphanedDispatches) {
          if (attemptsWithInterruptedSession.has(dispatch.stageAttemptId)) continue;
          const run = readPipelineRun(dispatch.pipelineRunId);
          const stageAttempt = readStageAttempt(dispatch.stageAttemptId);
          const workItem = readWorkItem(dispatch.workItemId);
          if (!run || !stageAttempt || !workItem) {
            throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
          }
          const decision = decideRecoverInterruptedWorkflow({
            now: occurredAt,
            workItem,
            run,
            stageAttempt,
            dispatch,
            recoveryReportId: createId("recoveryReport"),
          });
          updateWorkflowDispatch(decision.dispatch);
          updateStageAttempt(decision.stageAttempt);
          updatePipelineRun(decision.run);
          updateWorkflowWorkItem(decision.workItem);
          insertRecoveryReport(decision.report);
          recoveryReports.push(decision.report);
          events.push(
            ...appendWorkflowEvents(decision.events, {
              workItemId: workItem.id,
              projectId: workItem.projectId,
              actor: command.actor,
              occurredAt,
              correlationId: command.correlationId,
            }),
          );
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "WORKFLOWS_RECONCILED",
          replayed: false,
          recoveryReports,
          interruptedSessions,
          events,
        });
      }

      if (command.type === "START_PROVIDER_SESSION") {
        if (selectRunningProviderSession.get(command.payload.stageAttemptId) !== undefined) {
          throw new StateStoreError(
            "PROVIDER_SESSION_ALREADY_RUNNING",
            "The StageAttempt already has a running ProviderSession",
          );
        }
        const maxOrdinal = maxOrdinalRowSchema.parse(
          selectMaxProviderSessionOrdinal.get(command.payload.stageAttemptId),
        ).max_ordinal;
        const session = providerSessionSchema.parse({
          schemaVersion: 1,
          id: createId("providerSession"),
          stageAttemptId: command.payload.stageAttemptId,
          ordinal: maxOrdinal + 1,
          status: "RUNNING",
          endReason: null,
          handoffRequestedAt: null,
          startedAt: occurredAt,
          endedAt: null,
          version: 1,
          // Undefined and null both mean "no process known yet" -- every caller today omits this
          // (see startProviderSessionCommandSchema), so this normalises the absent case to the same
          // `null` a caller who knows there is no process would pass explicitly.
          pid: command.payload.pid ?? null,
        });
        // No existence pre-check on stageAttemptId: the FK on provider_sessions.stage_attempt_id
        // rejects a non-existent StageAttempt right here, inside this command's transaction, which
        // is what makes "the write rolls back completely" provable rather than merely asserted.
        insertProviderSession.run(
          session.id,
          session.schemaVersion,
          session.stageAttemptId,
          session.ordinal,
          session.status,
          session.endReason,
          session.handoffRequestedAt,
          session.startedAt,
          session.endedAt,
          session.version,
          session.pid,
        );
        const recipe = contextPackRecipeSchema.parse({
          ...command.payload.recipe,
          id: createId("contextPackRecipe"),
          providerSessionId: session.id,
          createdAt: occurredAt,
        });
        insertContextPackRecipe.run(
          recipe.id,
          recipe.schemaVersion,
          recipe.providerSessionId,
          recipe.templateId,
          recipe.templateVersion,
          recipe.specSource,
          JSON.stringify(recipe.sections),
          JSON.stringify(recipe.omitted),
          recipe.contentHash,
          recipe.estimatedTokens,
          recipe.budgetTokens,
          recipe.estimateQuality,
          recipe.createdAt,
        );
        const stageAttempt = readStageAttempt(session.stageAttemptId);
        if (!stageAttempt) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The StageAttempt disappeared after its ProviderSession was inserted",
          );
        }
        const event = appendSessionEvent(
          { type: "PROVIDER_SESSION_STARTED", data: { session, recipe } },
          {
            workItemId: stageAttempt.workItemId,
            projectId: stageAttempt.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROVIDER_SESSION_STARTED",
          replayed: false,
          workItemId: stageAttempt.workItemId,
          session,
          recipe,
          events: [event],
        });
      }

      // Spec §8 follow-up: the durable side of `ProviderSessionListener.onProcessStarted`
      // (@loomrail/provider-core) -- a live adapter's own report of the pid it just spawned,
      // arriving well after START_PROVIDER_SESSION already created this session. No event: a pid is
      // current state for reconciliation to act on, not something the audit log or the owner needs
      // to see (see providerSessionProcessRecordedResultSchema's comment in @loomrail/contracts).
      if (command.type === "RECORD_PROVIDER_SESSION_PROCESS") {
        const sessionRow = selectProviderSessionById.get(command.payload.providerSessionId);
        if (sessionRow === undefined) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The ProviderSession does not exist");
        }
        const current = providerSessionFromRow(sessionRow);
        if (current.status !== "RUNNING") {
          throw new StateStoreError(
            "PROVIDER_SESSION_NOT_RUNNING",
            "A process cannot be recorded for a ProviderSession that has already ended",
          );
        }
        const stageAttempt = readStageAttempt(current.stageAttemptId);
        if (!stageAttempt) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The StageAttempt backing this ProviderSession is missing",
          );
        }
        recordProviderSessionProcessPid.run(command.payload.pid, current.id);
        const session = providerSessionSchema.parse({ ...current, pid: command.payload.pid });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROVIDER_SESSION_PROCESS_RECORDED",
          replayed: false,
          workItemId: stageAttempt.workItemId,
          session,
          events: [],
        });
      }

      if (command.type === "PUBLISH_CHECKPOINT") {
        const sessionRow = selectProviderSessionById.get(command.payload.providerSessionId);
        if (sessionRow === undefined) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The ProviderSession does not exist");
        }
        const session = providerSessionFromRow(sessionRow);
        if (session.status !== "RUNNING") {
          throw new StateStoreError(
            "PROVIDER_SESSION_NOT_RUNNING",
            "A checkpoint cannot be published to a ProviderSession that has already ended",
          );
        }
        const stageAttempt = readStageAttempt(session.stageAttemptId);
        if (!stageAttempt) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The StageAttempt backing this ProviderSession is missing",
          );
        }
        const maxOrdinal = maxOrdinalRowSchema.parse(selectMaxCheckpointOrdinal.get(session.id)).max_ordinal;
        const checkpoint = checkpointSchema.parse({
          schemaVersion: 1,
          id: createId("checkpoint"),
          stageAttemptId: session.stageAttemptId,
          providerSessionId: session.id,
          ordinal: maxOrdinal + 1,
          summary: command.payload.checkpoint.summary,
          completed: command.payload.checkpoint.completed,
          remaining: command.payload.checkpoint.remaining,
          deadEnds: command.payload.checkpoint.deadEnds,
          openQuestions: command.payload.checkpoint.openQuestions,
          createdAt: occurredAt,
        });
        insertCheckpoint.run(
          checkpoint.id,
          checkpoint.schemaVersion,
          checkpoint.stageAttemptId,
          checkpoint.providerSessionId,
          checkpoint.ordinal,
          checkpoint.summary,
          JSON.stringify(checkpoint.completed),
          JSON.stringify(checkpoint.remaining),
          JSON.stringify(checkpoint.deadEnds),
          JSON.stringify(checkpoint.openQuestions),
          checkpoint.createdAt,
        );
        const event = appendSessionEvent(
          { type: "CHECKPOINT_PUBLISHED", data: { checkpoint } },
          {
            workItemId: stageAttempt.workItemId,
            projectId: stageAttempt.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "CHECKPOINT_PUBLISHED",
          replayed: false,
          workItemId: stageAttempt.workItemId,
          checkpoint,
          events: [event],
        });
      }

      if (command.type === "END_PROVIDER_SESSION") {
        const sessionRow = selectProviderSessionById.get(command.payload.providerSessionId);
        if (sessionRow === undefined) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The ProviderSession does not exist");
        }
        const current = providerSessionFromRow(sessionRow);
        if (current.status !== "RUNNING") {
          throw new StateStoreError("PROVIDER_SESSION_NOT_RUNNING", "The ProviderSession has already ended");
        }
        const stageAttempt = readStageAttempt(current.stageAttemptId);
        if (!stageAttempt) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The StageAttempt backing this ProviderSession is missing",
          );
        }
        const session = providerSessionSchema.parse({
          ...current,
          status: "ENDED",
          endReason: command.payload.endReason,
          endedAt: occurredAt,
          version: current.version + 1,
        });
        const update = updateProviderSession.run(
          session.status,
          session.endReason,
          session.handoffRequestedAt,
          session.endedAt,
          session.version,
          session.id,
          current.version,
        );
        if (update.changes !== 1) {
          throw new WorkflowDomainError(
            "WORKFLOW_VERSION_CONFLICT",
            "The ProviderSession changed while it was being ended",
          );
        }
        const eventMetadata = {
          workItemId: stageAttempt.workItemId,
          projectId: stageAttempt.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const events: DomainEvent[] = [
          appendSessionEvent({ type: "PROVIDER_SESSION_ENDED", data: { session } }, eventMetadata),
        ];

        // Spec §6.5: the unproductive-session counter, and the pause plus question that the second
        // unproductive session in a row triggers, belong to this same transaction. Every end that
        // reaches this command came from the session loop, INTERRUPTED included -- a session cut
        // because its checkpoint write failed (§6.2) counts as unproductive exactly like one that
        // ran into the wall. Recovery after a restart never arrives here: RECONCILE_WORKFLOWS ends
        // orphaned sessions itself, without this decision, so a dead daemon cannot advance the
        // counter. CANCELLED is refused by decideSessionEnded and skipped here to match, and so is
        // a session the provider never started -- see `providerStarted` on the command.
        let attemptAfterEnd = stageAttempt;
        let request: HumanRequest | null = null;
        let nextSessionOrdinal: number | null = null;
        if (session.endReason !== "CANCELLED" && command.payload.providerStarted) {
          const checkpointsPublished = countRowSchema.parse(countCheckpointsForSession.get(session.id)).count;
          const decision = decideSessionEnded({
            session,
            attempt: stageAttempt,
            endReason: command.payload.endReason,
            checkpointsPublished,
            now: occurredAt,
          });
          switch (decision.type) {
            case "STAGE_FINISHED":
              break;
            case "START_NEXT_SESSION": {
              attemptAfterEnd = decision.attempt;
              updateStageAttempt(decision.attempt);
              nextSessionOrdinal = decision.nextOrdinal;
              break;
            }
            case "HARD_PAUSE": {
              const run = readPipelineRun(stageAttempt.pipelineRunId);
              const workItem = readWorkItem(stageAttempt.workItemId);
              if (!run || !workItem) {
                throw new WorkflowDomainError(
                  "WORKFLOW_NOT_FOUND",
                  "The workflow state backing this ProviderSession is incomplete",
                );
              }
              // The stored attempt carrying the decision's new counter, not the decision's own
              // attempt: decideStageAttemptHardPause performs the HARD_PAUSED transition itself and
              // bumps the version once, and a pre-bumped attempt would not match the stored row.
              const paused = decideStageAttemptHardPause({
                now: occurredAt,
                workItem,
                run,
                stageAttempt: {
                  ...stageAttempt,
                  unproductiveSessions: decision.attempt.unproductiveSessions,
                },
                previousStatus: stageAttempt.status,
                pendingDispatch: readPendingDispatchForAttempt(stageAttempt.id),
                humanRequestId: createId("humanRequest"),
                reason: { type: "NO_PROGRESS" },
              });
              attemptAfterEnd = paused.stageAttempt;
              request = paused.request;
              updateStageAttempt(paused.stageAttempt);
              updatePipelineRun(paused.run);
              updateWorkflowWorkItem(paused.workItem);
              if (paused.dispatch) updateWorkflowDispatch(paused.dispatch);
              insertHumanRequest(paused.request);
              events.push(...appendWorkflowEvents(paused.events, eventMetadata));
              break;
            }
          }
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROVIDER_SESSION_ENDED",
          replayed: false,
          workItemId: stageAttempt.workItemId,
          session,
          stageAttempt: attemptAfterEnd,
          request,
          nextSessionOrdinal,
          events,
        });
      }

      if (command.type === "REQUEST_CONTEXT_HANDOFF") {
        const sessionRow = selectProviderSessionById.get(command.payload.providerSessionId);
        if (sessionRow === undefined) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The ProviderSession does not exist");
        }
        // Parsed once: this branch needs both the ProviderSession the row describes and the peak
        // occupancy stored alongside it, and the row schema is the same for both.
        const sessionRowParsed = providerSessionRowSchema.parse(sessionRow);
        const current = providerSessionFromParsedRow(sessionRowParsed);
        const stageAttempt = readStageAttempt(current.stageAttemptId);
        if (!stageAttempt) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The StageAttempt backing this ProviderSession is missing",
          );
        }
        // Spec §6.2 says occupancy is saved, so the reading lands in current state before any
        // handoff decision is taken -- below the threshold just as much as above it. What is kept
        // is the highest occupancy the session has been observed at, which is what "how full did
        // this session get" asks and what explains a cut after the fact. Enforced here rather than
        // assumed from the order reports arrive in: occupancy is not monotonic for a provider that
        // compacts its own window, and a column named for the peak has to hold the peak whatever
        // the caller sends.
        //
        // Only reports the session can still act on are written at all: one arriving for an ENDED
        // session, or for one that has already asked for a handoff, is the race §6.2 calls a safe
        // no-op, and must not disturb what that session recorded while the number still mattered.
        //
        // "Higher" is a larger share of the window, not a larger token count. These columns are
        // per-session, so a provider swap between sessions can never put two window sizes in one
        // row -- what makes the unit matter is a window that changes WITHIN a session, which is
        // exactly what an adapter that compacts its own context does. More tokens against a bigger
        // window can be less of it.
        const reported = command.payload.usage;
        const storedPeak = peakContextWindowUsageFromRow(sessionRowParsed);
        const isNewPeak =
          storedPeak === null ||
          reported.usedTokens / reported.windowTokens > storedPeak.usedTokens / storedPeak.windowTokens;
        if (current.status === "RUNNING" && current.handoffRequestedAt === null && isNewPeak) {
          recordPeakProviderSessionUsage.run(
            reported.usedTokens,
            reported.windowTokens,
            reported.quality,
            occurredAt,
            current.id,
          );
        }
        // Whether this crossing is the first one is read off the stored session, never taken from
        // the caller: spec §6.2 requires a repeated occupancy report -- including one racing the
        // session's own end -- to be a safe no-op rather than a second request.
        const decision = decideContextWindowReported({
          session: current,
          usage: command.payload.usage,
          handoffThreshold: command.payload.handoffThreshold,
          now: occurredAt,
        });
        if (decision.type === "NO_ACTION") {
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "CONTEXT_HANDOFF_REQUESTED",
            replayed: false,
            workItemId: stageAttempt.workItemId,
            session: current,
            requested: false,
            events: [],
          });
        }
        const update = updateProviderSession.run(
          decision.session.status,
          decision.session.endReason,
          decision.session.handoffRequestedAt,
          decision.session.endedAt,
          decision.session.version,
          decision.session.id,
          current.version,
        );
        if (update.changes !== 1) {
          throw new WorkflowDomainError(
            "WORKFLOW_VERSION_CONFLICT",
            "The ProviderSession changed while a handoff was being requested",
          );
        }
        const event = appendSessionEvent(decision.event, {
          workItemId: stageAttempt.workItemId,
          projectId: stageAttempt.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "CONTEXT_HANDOFF_REQUESTED",
          replayed: false,
          workItemId: stageAttempt.workItemId,
          session: decision.session,
          requested: true,
          events: [event],
        });
      }

      if (command.type === "REDUCE_CONTEXT_PACK_SHARE") {
        const stageAttempt = readStageAttempt(command.payload.stageAttemptId);
        if (!stageAttempt) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The StageAttempt does not exist");
        }
        const run = readPipelineRun(stageAttempt.pipelineRunId);
        if (!run) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The PipelineRun backing this StageAttempt is missing",
          );
        }
        // Spec §7. The reduction is durable state, not a log line: the counter survives the restart
        // that §6.4 makes an ordinary end of a session, and STAGE_ATTEMPT_CHANGED records that it
        // moved. The next session's ContextPackRecipe then carries the smaller budgetTokens the
        // reduction produced, so the audit trail shows both the decision and its effect.
        const reduced = stageAttemptSchema.parse({
          ...stageAttempt,
          packShareBackoffs: stageAttempt.packShareBackoffs + 1,
          version: stageAttempt.version + 1,
        });
        updateStageAttempt(reduced);
        const events = appendWorkflowEvents(
          [
            {
              type: "STAGE_ATTEMPT_CHANGED",
              data: { run, stageAttempt: reduced, previousStatus: stageAttempt.status },
            },
          ],
          {
            workItemId: stageAttempt.workItemId,
            projectId: stageAttempt.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "CONTEXT_PACK_SHARE_REDUCED",
          replayed: false,
          workItemId: stageAttempt.workItemId,
          stageAttempt: reduced,
          events,
        });
      }

      if (command.type === "HARD_PAUSE_STAGE_ATTEMPT") {
        const stageAttempt = readStageAttempt(command.payload.stageAttemptId);
        if (!stageAttempt) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The StageAttempt does not exist");
        }
        const run = readPipelineRun(stageAttempt.pipelineRunId);
        const workItem = readWorkItem(stageAttempt.workItemId);
        if (!run || !workItem) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The workflow state backing this StageAttempt is incomplete",
          );
        }
        const decision = decideStageAttemptHardPause({
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          previousStatus: stageAttempt.status,
          pendingDispatch: readPendingDispatchForAttempt(stageAttempt.id),
          humanRequestId: createId("humanRequest"),
          reason: command.payload.reason,
        });
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        if (decision.dispatch) updateWorkflowDispatch(decision.dispatch);
        insertHumanRequest(decision.request);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "STAGE_ATTEMPT_HARD_PAUSED",
          replayed: false,
          workItemId: workItem.id,
          run: decision.run,
          stageAttempt: decision.stageAttempt,
          request: decision.request,
          events,
        });
      }

      const projectId =
        command.type === "CREATE_WORK_ITEM"
          ? command.payload.projectId
          : readWorkItem(command.payload.workItemId)?.projectId;
      if (!projectId || !readProject(projectId)) {
        throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
      }

      const current =
        command.type === "CREATE_WORK_ITEM"
          ? undefined
          : (readWorkItem(command.payload.workItemId) ?? undefined);
      const parent =
        command.type === "CREATE_WORK_ITEM" && command.payload.parentId !== null
          ? (readWorkItem(command.payload.parentId) ?? undefined)
          : undefined;
      if (
        command.type === "MOVE_WORK_ITEM" &&
        current &&
        selectActivePipelineRun.get(current.id) !== undefined
      ) {
        throw new WorkItemDomainError(
          "ACTIVE_WORKFLOW_CONTROLS_STATE",
          "The active workflow controls this WorkItem state until it stops",
        );
      }
      const hasChildren =
        current === undefined
          ? false
          : database
              .prepare("SELECT 1 AS present FROM work_items WHERE parent_id = ? LIMIT 1")
              .get(current.id) !== undefined;
      const decision = decideWorkItemCommand(command, {
        now: occurredAt,
        ...(command.type === "CREATE_WORK_ITEM" ? { newWorkItemId: createId("workItem") } : {}),
        ...(current === undefined ? {} : { current }),
        ...(parent === undefined ? {} : { parent }),
        hasChildren,
      });
      persistWorkItemDecision(command, decision);
      const event = appendEvent(decision.event, {
        aggregateId: decision.workItem.id,
        projectId: decision.workItem.projectId,
        actor: command.actor,
        occurredAt,
        correlationId: command.correlationId,
      });

      switch (decision.event.type) {
        case "WORK_ITEM_CREATED":
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "WORK_ITEM_CREATED",
            replayed: false,
            workItem: decision.workItem,
            event,
          });
        case "WORK_ITEM_UPDATED":
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "WORK_ITEM_UPDATED",
            replayed: false,
            workItem: decision.workItem,
            event,
          });
        case "WORK_ITEM_STATE_CHANGED":
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "WORK_ITEM_MOVED",
            replayed: false,
            workItem: decision.workItem,
            event,
          });
      }
    };

    const execute = (input: StateCommand): StateCommandResult => {
      assertOpen();
      const command = stateCommandSchema.parse(input);
      const inputHash = commandHash(command);
      let transactionStarted = false;
      try {
        database.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        const receiptValue = selectCommandReceipt.get(command.commandId);
        if (receiptValue !== undefined) {
          const receipt = commandReceiptRowSchema.parse(receiptValue);
          if (receipt.command_type !== command.type || receipt.input_hash !== inputHash) {
            throw new StateStoreError(
              "COMMAND_ID_REUSED",
              "The command ID was already used for different input",
            );
          }
          const replayed = asReplayed(stateCommandResultSchema.parse(parseJson(receipt.result_json)));
          database.exec("COMMIT");
          transactionStarted = false;
          return replayed;
        }

        const occurredAt = now().toISOString();
        const result = executeFresh(command, occurredAt);
        insertCommandReceipt.run(
          command.commandId,
          command.type,
          inputHash,
          JSON.stringify(result),
          occurredAt,
        );
        database.exec("COMMIT");
        transactionStarted = false;
        return result;
      } catch (error: unknown) {
        if (transactionStarted) database.exec("ROLLBACK");
        if (
          error instanceof WorkItemDomainError ||
          error instanceof WorkflowDomainError ||
          error instanceof StateStoreError
        )
          throw error;
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The local state command could not be applied",
          {},
          { cause: error },
        );
      }
    };

    const runQuery = (queryValue: z.output<typeof stateQuerySchema>): StateQueryResult => {
      switch (queryValue.type) {
        case "LIST_PROJECTS":
          return {
            type: "PROJECTS",
            projects: database
              .prepare("SELECT * FROM projects ORDER BY created_at, id")
              .all()
              .map(projectFromRow),
          };
        case "GET_PROJECT":
          return { type: "PROJECT", project: readProject(queryValue.projectId) };
        case "GET_WORK_ITEM":
          return { type: "WORK_ITEM", workItem: readWorkItem(queryValue.workItemId) };
        case "GET_WORKFLOW_SNAPSHOT":
          return { type: "WORKFLOW_SNAPSHOT", snapshot: readWorkflowSnapshot(queryValue.workItemId) };
        case "LIST_HUMAN_REQUESTS": {
          const rows = database
            .prepare(
              `SELECT * FROM human_requests
               WHERE (? IS NULL OR project_id = ?)
                 AND (? IS NULL OR status = ?)
               ORDER BY blocking DESC, created_at, id`,
            )
            .all(
              queryValue.projectId ?? null,
              queryValue.projectId ?? null,
              queryValue.status ?? null,
              queryValue.status ?? null,
            );
          return {
            type: "HUMAN_REQUESTS",
            humanRequests: humanRequestRowSchema
              .array()
              .parse(rows)
              .map((row) => {
                const request = readHumanRequest(row.id);
                if (!request) {
                  throw new StateStoreError(
                    "PERSISTENCE_FAILURE",
                    "A listed HumanRequest could not be reloaded",
                  );
                }
                return request;
              }),
          };
        }
        case "LIST_PENDING_DISPATCHES":
          return {
            type: "WORKFLOW_DISPATCHES",
            dispatches: database
              .prepare("SELECT * FROM workflow_dispatches WHERE status = 'PENDING' ORDER BY created_at, id")
              .all()
              .map(workflowDispatchFromRow),
          };
        case "LIST_WORK_ITEMS": {
          const rows =
            queryValue.state === undefined
              ? database
                  .prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at, id")
                  .all(queryValue.projectId)
              : database
                  .prepare(
                    "SELECT * FROM work_items WHERE project_id = ? AND state = ? ORDER BY created_at, id",
                  )
                  .all(queryValue.projectId, queryValue.state);
          return {
            type: "WORK_ITEMS",
            workItems: workItemRowSchema
              .array()
              .parse(rows)
              .map((row) => {
                const item = readWorkItem(row.id);
                if (!item) {
                  throw new StateStoreError("PERSISTENCE_FAILURE", "A listed WorkItem could not be reloaded");
                }
                return item;
              }),
          };
        }
        case "LIST_EVENTS": {
          const descending = queryValue.direction === "DESC";
          // Read one row past the page so `hasMore` is exact instead of "the page came back full".
          const rows = database
            .prepare(descending ? listEventsDescendingSql : listEventsAscendingSql)
            .all(
              queryValue.afterSequence,
              queryValue.beforeSequence ?? null,
              queryValue.beforeSequence ?? null,
              queryValue.projectId ?? null,
              queryValue.projectId ?? null,
              queryValue.aggregateId ?? null,
              queryValue.aggregateId ?? null,
              queryValue.limit + 1,
            );
          const events = rows.slice(0, queryValue.limit).map(eventFromRow);
          // The cursor for the following page: the newest sequence read ascending, the oldest descending.
          const exhaustedCursor = descending ? (queryValue.beforeSequence ?? 0) : queryValue.afterSequence;
          return {
            type: "EVENTS",
            events,
            hasMore: rows.length > queryValue.limit,
            nextSequence: events.at(-1)?.sequence ?? exhaustedCursor,
          };
        }
        case "READ_CONTEXT_SOURCES":
          return {
            type: "CONTEXT_SOURCES",
            sources: readContextSourcesSnapshot(queryValue.stageAttemptId, queryValue.sessionOrdinal),
          };
        // The nesting spec §D5 introduces, read back in one place: the attempt's sessions in
        // ordinal order, the recipe each one was assembled from, and every checkpoint published
        // under the attempt. Kept out of GET_WORKFLOW_SNAPSHOT deliberately -- the snapshot is
        // fetched on every board render, and session history grows without bound within an attempt.
        case "LIST_PROVIDER_SESSIONS": {
          // Peak occupancy comes off these same rows (migration 0009), parsed once and read twice.
          // It used to be rebuilt by scanning CONTEXT_HANDOFF_REQUESTED out of the event log, which
          // both collapsed the separation between current state and audit and could only ever show
          // the reading that crossed the threshold -- a session below it had nothing to show.
          const sessionRows = selectProviderSessionsForAttempt
            .all(queryValue.stageAttemptId)
            .map((value) => providerSessionRowSchema.parse(value));
          const peakContextWindowUsage: Record<string, ContextWindowUsage> = {};
          for (const row of sessionRows) {
            const usage = peakContextWindowUsageFromRow(row);
            if (usage !== null) peakContextWindowUsage[row.id] = usage;
          }
          return {
            type: "PROVIDER_SESSIONS",
            sessions: sessionRows.map(providerSessionFromParsedRow),
            recipes: selectRecipesForAttempt.all(queryValue.stageAttemptId).map(contextPackRecipeFromRow),
            checkpoints: selectCheckpointsForAttempt.all(queryValue.stageAttemptId).map(checkpointFromRow),
            peakContextWindowUsage,
          };
        }
        default:
          return assertNever(queryValue);
      }
    };

    // The request is validated outside the try below on purpose: a malformed StateQuery really is
    // the caller's fault and stays a ZodError, which apps/daemon maps to 400 INVALID_REQUEST.
    // Everything past that point is reading what this database already holds, and a parse failure
    // there is a storage fault, not a request fault -- an Event payload written by an older build
    // that a schema has since made stricter is exactly the shape migration 0008 exists to repair.
    // Left raw, that ZodError reached the owner as "The request payload is invalid" with a 400,
    // which no log filter treats as a server fault, so an unreadable history would be triaged as
    // owner error. Mapped to the typed PERSISTENCE_FAILURE the rest of this module already uses,
    // it becomes a 500 with a code callers can branch on instead of a message they must parse.
    const query = (input: StateQuery): StateQueryResult => {
      assertOpen();
      const queryValue = stateQuerySchema.parse(input);
      try {
        return runQuery(queryValue);
      } catch (error: unknown) {
        if (
          error instanceof WorkItemDomainError ||
          error instanceof WorkflowDomainError ||
          error instanceof StateStoreError
        )
          throw error;
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The stored state could not be read",
          { query: queryValue.type },
          { cause: error },
        );
      }
    };

    return {
      startup,
      execute,
      query,
      close: () => {
        if (closed) return;
        database.close();
        closed = true;
      },
    };
  } catch (error: unknown) {
    database.close();
    throw error;
  }
};
