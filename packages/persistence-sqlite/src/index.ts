import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContextSources } from "@loomrail/context-assembly";
import {
  acceptancePackageSchema,
  agentRunSchema,
  agentRunStatusSchema,
  maxAttentionProjectionSources,
  budgetPolicySchema,
  checkpointSchema,
  constitutionProposalSchema,
  constitutionPublicationSchema,
  contextPackRecipeSchema,
  contextWindowUsageSchema,
  decisionSchema,
  domainEventSchema,
  eventPageDirectionSchema,
  evidenceArtifactSchema,
  humanRequestSchema,
  humanRequestStatusSchema,
  maxContextPackRecipeSources,
  mcpCapabilitySnapshotSchema,
  mcpConsentSchema,
  mcpGrantSchema,
  mcpProfileRevisionSchema,
  mcpSessionSnapshotSchema,
  mcpToolCallRecordSchema,
  opaqueIdSchema,
  pipelineRunSchema,
  projectSchema,
  projectConstitutionSnapshotSchema,
  projectConstitutionVersionSchema,
  projectReadinessRunSchema,
  projectReadinessSnapshotSchema,
  projectProviderSelectionSchema,
  qaAttachmentRefSchema,
  qaDefectSchema,
  qaEvidenceBundleSchema,
  qaRunSchema,
  readinessAttestationSchema,
  readinessCheckSchema,
  sessionPauseFailureCodes,
  providerSessionSchema,
  recoveryReportSchema,
  reviewFindingSchema,
  reviewFindingStatusSchema,
  reviewReportSchema,
  scaffoldOperationSchema,
  securityFindingSchema,
  stageAttemptSchema,
  squadAssignmentSchema,
  stateCommandResultSchema,
  stateCommandSchema,
  usageRecordSchema,
  utcTimestampSchema,
  workflowDispatchSchema,
  workflowSnapshotSchema,
  workflowTemplateSchema,
  workItemSchema,
  workItemStateSchema,
  workItemWorkspaceSchema,
  type BudgetPolicy,
  type Actor,
  type AcceptancePackage,
  type AgentRun,
  type AgentRunStatus,
  type Checkpoint,
  type ConstitutionProposal,
  type ConstitutionPublication,
  type ContextPackRecipe,
  type ContextWindowUsage,
  type Decision,
  type DomainEvent,
  type EvidenceArtifact,
  type HumanRequest,
  type McpCapabilitySnapshot,
  type McpConsent,
  type McpGrant,
  type McpProfileRevision,
  type McpProfileView,
  type McpSessionSnapshot,
  type McpToolCallRecord,
  type PipelineRun,
  type Project,
  type ProjectConstitutionVersion,
  type ProjectReadinessRun,
  type QAAttachmentRef,
  type QADefect,
  type QAEvidenceBundle,
  type QARun,
  type ReadinessAttestation,
  type ReadinessCheck,
  type ProviderSession,
  type RecoveryReport,
  type ReviewFinding,
  type ReviewReport,
  type ScaffoldOperation,
  type SecurityFinding,
  type RegisterProjectCommand,
  type RepointFixtureProjectCommand,
  type StageAttempt,
  type SquadAssignment,
  type StartMockPipelineCommand,
  type StateCommand,
  type StateCommandResult,
  type UsageRecord,
  type WorkItem,
  type WorkflowDispatch,
  type WorkflowSnapshot,
  type WorkItemWorkspace,
} from "@loomrail/contracts";
import {
  ConstitutionDomainError,
  buildAttentionInbox,
  builtinAgentProfiles,
  canonicalMcpProfileSource,
  decideProjectReadinessAssessment,
  decideProjectReadinessAttestation,
  decideReviewFindingDisposition,
  decideQACompletion,
  decideQAReservation,
  qaWorkflowOutcome,
  decideProjectProviderPreference,
  decideApproveBudgetOverride,
  decideAnswerHumanRequest,
  decideApplyProviderOutcome,
  decideCancelPipeline,
  decideContextWindowReported,
  decideProjectConstitutionAdoption,
  decideProjectConstitutionPublicationCompleted,
  decideProjectConstitutionPublicationFailed,
  decideProjectConstitutionPublicationRetry,
  decideProjectConstitutionProposal,
  decideProjectScaffoldCompleted,
  decideProjectScaffoldFailed,
  decideProjectScaffoldRequested,
  decideProjectScaffoldRetry,
  createAgentRun,
  createStandardSquadAssignment,
  finishAgentRun,
  decideMarkWorkflowDispatchStarted,
  decideMcpCapabilitySnapshot,
  decideMcpProfileConfirmation,
  decideMcpProfileGrant,
  decideMcpProfileGrantRevocation,
  decideMcpSessionSnapshots,
  decideMcpToolCallFinished,
  decideMcpToolCallStart,
  decidePausePipeline,
  decideRecoverInterruptedWorkflow,
  decideResolveAcceptance,
  decideResumePipeline,
  decideSessionEnded,
  decideStageAttemptHardPause,
  decideStartMockPipeline,
  decideWorkItemCommand,
  stageAttemptIsTerminal,
  WorkflowDomainError,
  ReadinessDomainError,
  McpDomainError,
  ProviderSelectionDomainError,
  QACompletionError,
  QAReservationError,
  ReviewFindingDispositionError,
  ScaffoldDomainError,
  WorkItemDomainError,
  type BudgetOverrideDecision,
  type ConstitutionActivatedIntent,
  type ConstitutionProposedIntent,
  type ConstitutionPublicationFailedIntent,
  type ConstitutionPublicationRequestedIntent,
  type ProjectReadinessAssessedIntent,
  type ProjectReadinessAttestedIntent,
  type ProjectProviderPreferenceChangedIntent,
  type ScaffoldCompletedIntent,
  type ScaffoldFailedIntent,
  type ScaffoldRequestedIntent,
  type AcceptanceResolutionDecision,
  type AnswerHumanRequestDecision,
  type ApplyProviderOutcomeDecision,
  type MarkDispatchStartedDecision,
  type McpGrantChangedIntent,
  type McpProfileConsentedIntent,
  type PipelineControlDecision,
  type RecoveryDecision,
  type ReviewFindingDispositionDecision,
  type StageAttemptPauseDecision,
  type StartWorkflowDecision,
  type WorkItemCommand,
  type WorkItemDecision,
  type WorkItemEventIntent,
} from "@loomrail/domain";
import { parseWorktreeListPorcelain, type WorktreeEntry } from "@loomrail/workspace";
import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";
import { applyMigrations, databaseWasNonEmpty } from "./migrations.js";
import {
  StateStoreError,
  type LocalState,
  type OpenLocalStateOptions,
  type OrphanProcessEvent,
  type OrphanWorkspaceEvent,
  type StateQuery,
  type StateQueryResult,
} from "./types.js";

export * from "./types.js";

const DEFAULT_WORKSPACE_ID = "workspace-local";
const DEFAULT_WORKSPACE_NAME = "Local workspace";

const projectRowSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  // Nullable since migration 0012: a Project registered by path has no bundled fixture behind it.
  fixture_id: z.string().nullable(),
  name: z.string(),
  repository_path: z.string(),
  provider_preference: z.string(),
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

const squadAssignmentRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  revision: z.number().int(),
  stages_json: z.string(),
  created_at: z.string(),
});

const agentRunRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  ordinal: z.number().int(),
  squad_assignment_id: z.string(),
  profile_id: z.string(),
  profile_revision: z.number().int(),
  profile_role: z.string(),
  provider: z.string(),
  status: z.string(),
  policy_snapshot_hash: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  version: z.number().int(),
});

const criterionRowSchema = z.object({ criterion: z.string() });

// Migration 0011. `lease_holder` stays a bare nullable string here (not opaqueIdSchema) the same
// way every other _row schema in this file leaves ids untyped -- workItemWorkspaceSchema.parse
// below is what actually validates the shape a reader gets back.
const workItemWorkspaceRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  branch: z.string(),
  worktree_path: z.string(),
  base_commit: z.string().nullable(),
  snapshot_commit: z.string().nullable(),
  status: z.string(),
  lease_holder: z.string().nullable(),
  created_at: z.string(),
  version: z.number().int(),
});

const constitutionProposalRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  project_version: z.number().int(),
  status: z.string(),
  preset_id: z.string(),
  preset_version: z.number().int(),
  recommended_preset_id: z.string(),
  scan_json: z.string(),
  sections_json: z.string(),
  rendered_markdown: z.string(),
  content_digest: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  adopted_at: z.string().nullable(),
});

const projectConstitutionVersionRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  proposal_id: z.string(),
  ordinal: z.number().int(),
  preset_id: z.string(),
  preset_version: z.number().int(),
  source_digest: z.string(),
  content_digest: z.string(),
  rendered_markdown: z.string(),
  status: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  activated_at: z.string().nullable(),
});

const constitutionPublicationRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  constitution_version_id: z.string(),
  target_path: z.string(),
  expected_target_digest: z.string().nullable(),
  content_digest: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  last_error_code: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  applied_at: z.string().nullable(),
});

const scaffoldOperationRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  proposal_json: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  last_error_code: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

const mcpProfileRevisionRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  profile_id: z.string(),
  project_id: z.string(),
  revision: z.number().int(),
  name: z.string(),
  executable: z.string(),
  args_json: z.string(),
  declared_tools_json: z.string(),
  canonical_digest: z.string(),
  created_at: z.string(),
});

const mcpConsentRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  profile_revision_id: z.string(),
  canonical_digest: z.string(),
  owner_id: z.string(),
  consented_at: z.string(),
});

const mcpCapabilitySnapshotRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  profile_revision_id: z.string(),
  state: z.string(),
  protocol_version: z.string().nullable(),
  tools_json: z.string(),
  resources_json: z.string(),
  prompts_json: z.string(),
  observed_at: z.string(),
});

const mcpGrantRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  profile_revision_id: z.string(),
  tools_json: z.string(),
  enabled: z.number().int(),
  version: z.number().int(),
  granted_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  revoked_at: z.string().nullable(),
});

const mcpSessionSnapshotRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  provider_session_id: z.string(),
  profile_revision_id: z.string(),
  profile_digest: z.string(),
  grant_id: z.string(),
  grant_version: z.number().int(),
  tools_json: z.string(),
  created_at: z.string(),
});

const mcpToolCallRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  provider_session_id: z.string(),
  session_snapshot_id: z.string(),
  profile_revision_id: z.string(),
  tool_name: z.string(),
  input_digest: z.string(),
  status: z.string(),
  failure_code: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

const projectReadinessRunRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  repository_head: z.string().nullable(),
  source_digest: z.string(),
  working_tree_dirty: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

const readinessCheckRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  run_id: z.string(),
  project_id: z.string(),
  check_key: z.string(),
  category: z.string(),
  mode: z.string(),
  status: z.string(),
  summary: z.string(),
  version: z.number().int(),
});

const securityFindingRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  run_id: z.string(),
  check_id: z.string(),
  project_id: z.string(),
  code: z.string(),
  severity: z.string(),
  path: z.string().nullable(),
  message: z.string(),
});

const readinessAttestationRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  run_id: z.string(),
  check_id: z.string(),
  project_id: z.string(),
  outcome: z.string(),
  rationale: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  created_at: z.string(),
});

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
  correction_run_id: z.string().nullable(),
  stage: z.string(),
  kind: z.string(),
  status: z.string(),
  provider: z.string(),
  title: z.string(),
  summary: z.string(),
  checks_json: z.string(),
  review_report_id: z.string().nullable(),
  qa_run_id: z.string().nullable(),
  qa_evidence_bundle_id: z.string().nullable(),
  tested_tree: z.string().nullable(),
  created_at: z.string(),
});

const reviewReportRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  correction_run_id: z.string().nullable(),
  author_agent_run_id: z.string(),
  reviewer_agent_run_id: z.string(),
  provider_relation: z.string(),
  reviewed_tree: z.string(),
  round: z.number().int(),
  title: z.string(),
  summary: z.string(),
  checks_json: z.string(),
  verdict: z.string(),
  finding_ids_json: z.string(),
  created_at: z.string(),
});

const reviewFindingRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  correction_run_id: z.string().nullable(),
  review_artifact_id: z.string(),
  reviewed_tree: z.string(),
  ordinal: z.number().int(),
  severity: z.string(),
  status: z.string(),
  title: z.string(),
  description: z.string(),
  path: z.string().nullable(),
  start_line: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
  reproduction: z.string(),
  criterion: z.string().nullable(),
  suggested_fix: z.string().nullable(),
  resolution_reason: z.string().nullable(),
  resolved_by_type: z.string().nullable(),
  resolved_by_id: z.string().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  version: z.number().int(),
});

const qaRunRowSchema = z
  .object({
    id: z.string(),
    schema_version: z.number().int(),
    project_id: z.string(),
    work_item_id: z.string(),
    pipeline_run_id: z.string(),
    stage_attempt_id: z.string(),
    agent_run_id: z.string(),
    driver_id: z.string(),
    tested_tree: z.string(),
    target_origin: z.string(),
    plan_json: z.string(),
    correction_run_id: z.string().nullable(),
    retest_plan_id: z.string().nullable(),
    status: z.string(),
    error_code: z.string().nullable(),
    error_summary: z.string().nullable(),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    version: z.number().int(),
  })
  .refine(
    (row) => (row.correction_run_id === null) === (row.retest_plan_id === null),
    "Stored QA correction scope lineage must be complete",
  );

const qaEvidenceBundleRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  qa_run_id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  tested_tree: z.string(),
  verdict: z.string(),
  environment_json: z.string(),
  executions_json: z.string(),
  observations_json: z.string(),
  attachment_ids_json: z.string(),
  defect_ids_json: z.string(),
  created_at: z.string(),
});

const qaAttachmentRefRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  qa_run_id: z.string(),
  kind: z.string(),
  content_hash: z.string(),
  byte_size: z.number().int(),
  target_id: z.string(),
  scenario_id: z.string(),
  captured_at: z.string(),
  retention_class: z.string(),
  storage_key: z.string(),
});

const qaAttachmentRetentionRowSchema = z.object({
  attachment_id: z.string(),
  outcome: z.enum(["DELETED", "ALREADY_ABSENT"]),
  recorded_at: z.string(),
});

const qaDefectRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  qa_run_id: z.string(),
  project_id: z.string(),
  work_item_id: z.string(),
  tested_tree: z.string(),
  ordinal: z.number().int(),
  severity: z.string(),
  status: z.string(),
  title: z.string(),
  description: z.string(),
  reproduction_json: z.string(),
  target_id: z.string(),
  scenario_id: z.string(),
  resolution_reason: z.string().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  version: z.number().int(),
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
  correction_run_id: z.string().nullable(),
  stage: z.string(),
  attempt: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  failure_code: z.string().nullable(),
  unproductive_sessions: z.number().int(),
  pack_share_backoffs: z.number().int(),
  // Migration 0013. Nullable in the column and nullable here: `null` is "no tree was measured for
  // this stage", which is what every StageAttempt written before that migration will say forever.
  result_tree: z.string().nullable(),
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
  agent_run_id: z.string().nullable(),
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
const resultTreeRowSchema = z.object({ result_tree: z.string() });

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
  z
    .object({
      type: z.literal("GET_PROJECT_BY_REPOSITORY_PATH"),
      repositoryPath: z.string().min(1).max(4_096),
    })
    .strict(),
  z.object({ type: z.literal("GET_PROJECT_CONSTITUTION_SNAPSHOT"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_PROJECT_READINESS_SNAPSHOT"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_PROJECT_MCP_PROFILES"), projectId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("LIST_PROVIDER_SESSION_MCP_SNAPSHOTS"),
      providerSessionId: opaqueIdSchema,
    })
    .strict(),
  z.object({ type: z.literal("LIST_MCP_TOOL_CALLS"), providerSessionId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("LIST_PENDING_CONSTITUTION_PUBLICATIONS") }).strict(),
  z.object({ type: z.literal("GET_SCAFFOLD_OPERATION"), operationId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("LIST_PENDING_SCAFFOLD_OPERATIONS") }).strict(),
  z.object({ type: z.literal("LIST_OPEN_SCAFFOLD_OPERATIONS") }).strict(),
  z.object({ type: z.literal("GET_WORK_ITEM"), workItemId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_WORKFLOW_SNAPSHOT"), workItemId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_ATTENTION_INBOX") }).strict(),
  z
    .object({
      type: z.literal("LIST_HUMAN_REQUESTS"),
      projectId: opaqueIdSchema.optional(),
      status: humanRequestStatusSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("LIST_PENDING_DISPATCHES") }).strict(),
  z.object({ type: z.literal("GET_SQUAD_ASSIGNMENT"), pipelineRunId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_AGENT_RUN"), agentRunId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_QA_RUN"), qaRunId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_QA_STATE"), pipelineRunId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("LIST_EXPIRED_QA_ATTACHMENTS"),
      closedBefore: utcTimestampSchema,
      limit: z.number().int().min(1).max(1_000).default(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("GET_LATEST_SUCCEEDED_DEVELOPER_AGENT_RUN"),
      pipelineRunId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_AGENT_RUNS"),
      status: agentRunStatusSchema.optional(),
      limit: z.number().int().min(1).max(200).default(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_REVIEW_REPORTS"),
      pipelineRunId: opaqueIdSchema,
      limit: z.number().int().min(1).max(200).default(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_REVIEW_FINDINGS"),
      pipelineRunId: opaqueIdSchema,
      status: reviewFindingStatusSchema.optional(),
      limit: z.number().int().min(1).max(200).default(200),
    })
    .strict(),
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
  z.object({ type: z.literal("GET_WORKSPACE_BY_WORK_ITEM"), workItemId: opaqueIdSchema }).strict(),
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
    providerPreference: row.provider_preference,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
};

const constitutionProposalFromRow = (value: unknown): ConstitutionProposal => {
  const row = constitutionProposalRowSchema.parse(value);
  return constitutionProposalSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    projectVersion: row.project_version,
    status: row.status,
    presetId: row.preset_id,
    presetVersion: row.preset_version,
    recommendedPresetId: row.recommended_preset_id,
    scan: parseJson(row.scan_json),
    sections: parseJson(row.sections_json),
    renderedMarkdown: row.rendered_markdown,
    contentDigest: row.content_digest,
    version: row.version,
    createdAt: row.created_at,
    adoptedAt: row.adopted_at,
  });
};

const projectConstitutionVersionFromRow = (value: unknown): ProjectConstitutionVersion => {
  const row = projectConstitutionVersionRowSchema.parse(value);
  return projectConstitutionVersionSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    proposalId: row.proposal_id,
    ordinal: row.ordinal,
    presetId: row.preset_id,
    presetVersion: row.preset_version,
    sourceDigest: row.source_digest,
    contentDigest: row.content_digest,
    renderedMarkdown: row.rendered_markdown,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  });
};

const constitutionPublicationFromRow = (value: unknown): ConstitutionPublication => {
  const row = constitutionPublicationRowSchema.parse(value);
  return constitutionPublicationSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    constitutionVersionId: row.constitution_version_id,
    targetPath: row.target_path,
    expectedTargetDigest: row.expected_target_digest,
    contentDigest: row.content_digest,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
  });
};

const scaffoldOperationFromRow = (value: unknown): ScaffoldOperation => {
  const row = scaffoldOperationRowSchema.parse(value);
  return scaffoldOperationSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    proposal: parseJson(row.proposal_json),
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });
};

const mcpProfileRevisionFromRow = (value: unknown): McpProfileRevision => {
  const row = mcpProfileRevisionRowSchema.parse(value);
  return mcpProfileRevisionSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    profileId: row.profile_id,
    projectId: row.project_id,
    revision: row.revision,
    name: row.name,
    executable: row.executable,
    args: parseJson(row.args_json),
    declaredTools: parseJson(row.declared_tools_json),
    canonicalDigest: row.canonical_digest,
    createdAt: row.created_at,
  });
};

const mcpConsentFromRow = (value: unknown): McpConsent => {
  const row = mcpConsentRowSchema.parse(value);
  return mcpConsentSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    profileRevisionId: row.profile_revision_id,
    canonicalDigest: row.canonical_digest,
    ownerId: row.owner_id,
    consentedAt: row.consented_at,
  });
};

const mcpCapabilitySnapshotFromRow = (value: unknown): McpCapabilitySnapshot => {
  const row = mcpCapabilitySnapshotRowSchema.parse(value);
  return mcpCapabilitySnapshotSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    profileRevisionId: row.profile_revision_id,
    state: row.state,
    protocolVersion: row.protocol_version,
    tools: parseJson(row.tools_json),
    resources: parseJson(row.resources_json),
    prompts: parseJson(row.prompts_json),
    observedAt: row.observed_at,
  });
};

const mcpGrantFromRow = (value: unknown): McpGrant => {
  const row = mcpGrantRowSchema.parse(value);
  return mcpGrantSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    profileRevisionId: row.profile_revision_id,
    tools: parseJson(row.tools_json),
    enabled: row.enabled === 1,
    version: row.version,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  });
};

const mcpSessionSnapshotFromRow = (value: unknown): McpSessionSnapshot => {
  const row = mcpSessionSnapshotRowSchema.parse(value);
  return mcpSessionSnapshotSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    providerSessionId: row.provider_session_id,
    profileRevisionId: row.profile_revision_id,
    profileDigest: row.profile_digest,
    grantId: row.grant_id,
    grantVersion: row.grant_version,
    tools: parseJson(row.tools_json),
    createdAt: row.created_at,
  });
};

const mcpToolCallFromRow = (value: unknown): McpToolCallRecord => {
  const row = mcpToolCallRowSchema.parse(value);
  return mcpToolCallRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    providerSessionId: row.provider_session_id,
    sessionSnapshotId: row.session_snapshot_id,
    profileRevisionId: row.profile_revision_id,
    toolName: row.tool_name,
    inputDigest: row.input_digest,
    status: row.status,
    failureCode: row.failure_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
};

const projectReadinessRunFromRow = (value: unknown): ProjectReadinessRun => {
  const row = projectReadinessRunRowSchema.parse(value);
  return projectReadinessRunSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    repositoryHead: row.repository_head,
    sourceDigest: row.source_digest,
    workingTreeDirty: row.working_tree_dirty === 1,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
};

const readinessCheckFromRow = (value: unknown): ReadinessCheck => {
  const row = readinessCheckRowSchema.parse(value);
  return readinessCheckSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    key: row.check_key,
    category: row.category,
    mode: row.mode,
    status: row.status,
    summary: row.summary,
    version: row.version,
  });
};

const securityFindingFromRow = (value: unknown): SecurityFinding => {
  const row = securityFindingRowSchema.parse(value);
  return securityFindingSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    runId: row.run_id,
    checkId: row.check_id,
    projectId: row.project_id,
    code: row.code,
    severity: row.severity,
    path: row.path,
    message: row.message,
  });
};

const readinessAttestationFromRow = (value: unknown): ReadinessAttestation => {
  const row = readinessAttestationRowSchema.parse(value);
  return readinessAttestationSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    runId: row.run_id,
    checkId: row.check_id,
    projectId: row.project_id,
    outcome: row.outcome,
    rationale: row.rationale,
    actor: { type: row.actor_type, id: row.actor_id },
    createdAt: row.created_at,
  });
};

const workItemWorkspaceFromRow = (value: unknown): WorkItemWorkspace => {
  const row = workItemWorkspaceRowSchema.parse(value);
  return workItemWorkspaceSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    snapshotCommit: row.snapshot_commit,
    status: row.status,
    leaseHolder: row.lease_holder,
    createdAt: row.created_at,
    version: row.version,
  });
};

const squadAssignmentFromRow = (value: unknown): SquadAssignment => {
  const row = squadAssignmentRowSchema.parse(value);
  return squadAssignmentSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    revision: row.revision,
    stages: parseJson(row.stages_json),
    createdAt: row.created_at,
  });
};

const agentRunFromRow = (value: unknown): AgentRun => {
  const row = agentRunRowSchema.parse(value);
  return agentRunSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    ordinal: row.ordinal,
    squadAssignmentId: row.squad_assignment_id,
    profile: {
      id: row.profile_id,
      revision: row.profile_revision,
      role: row.profile_role,
    },
    provider: row.provider,
    status: row.status,
    policySnapshotHash: row.policy_snapshot_hash,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    version: row.version,
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
    correctionRunId: row.correction_run_id,
    stage: row.stage,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    title: row.title,
    summary: row.summary,
    checks: parseJson(row.checks_json),
    ...(row.review_report_id === null ? {} : { reviewReportId: row.review_report_id }),
    ...(row.qa_run_id === null ? {} : { qaRunId: row.qa_run_id }),
    ...(row.qa_evidence_bundle_id === null ? {} : { qaEvidenceBundleId: row.qa_evidence_bundle_id }),
    ...(row.tested_tree === null ? {} : { testedTree: row.tested_tree }),
    createdAt: row.created_at,
  });
};

const reviewReportFromRow = (value: unknown): ReviewReport => {
  const row = reviewReportRowSchema.parse(value);
  return reviewReportSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    correctionRunId: row.correction_run_id,
    authorAgentRunId: row.author_agent_run_id,
    reviewerAgentRunId: row.reviewer_agent_run_id,
    providerRelation: row.provider_relation,
    reviewedTree: row.reviewed_tree,
    round: row.round,
    title: row.title,
    summary: row.summary,
    checks: parseJson(row.checks_json),
    verdict: row.verdict,
    findingIds: parseJson(row.finding_ids_json),
    createdAt: row.created_at,
  });
};

const reviewFindingFromRow = (value: unknown): ReviewFinding => {
  const row = reviewFindingRowSchema.parse(value);
  return reviewFindingSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    correctionRunId: row.correction_run_id,
    reviewArtifactId: row.review_artifact_id,
    reviewedTree: row.reviewed_tree,
    ordinal: row.ordinal,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    reproduction: row.reproduction,
    criterion: row.criterion,
    suggestedFix: row.suggested_fix,
    resolutionReason: row.resolution_reason,
    resolvedBy:
      row.resolved_by_type === null || row.resolved_by_id === null
        ? null
        : { type: row.resolved_by_type, id: row.resolved_by_id },
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    version: row.version,
  });
};

const qaRunFromRow = (value: unknown): QARun => {
  const row = qaRunRowSchema.parse(value);
  return qaRunSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    agentRunId: row.agent_run_id,
    driverId: row.driver_id,
    testedTree: row.tested_tree,
    targetOrigin: row.target_origin,
    plan: parseJson(row.plan_json),
    scope:
      row.correction_run_id === null && row.retest_plan_id === null
        ? { type: "FULL" }
        : {
            type: "RETEST",
            correctionRunId: row.correction_run_id,
            retestPlanId: row.retest_plan_id,
          },
    status: row.status,
    error:
      row.error_code === null || row.error_summary === null
        ? null
        : { code: row.error_code, summary: row.error_summary },
    startedAt: row.started_at,
    completedAt: row.completed_at,
    version: row.version,
  });
};

const qaEvidenceBundleFromRow = (value: unknown): QAEvidenceBundle => {
  const row = qaEvidenceBundleRowSchema.parse(value);
  return qaEvidenceBundleSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    qaRunId: row.qa_run_id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    testedTree: row.tested_tree,
    verdict: row.verdict,
    environment: parseJson(row.environment_json),
    executions: parseJson(row.executions_json),
    observations: parseJson(row.observations_json),
    attachmentIds: parseJson(row.attachment_ids_json),
    defectIds: parseJson(row.defect_ids_json),
    createdAt: row.created_at,
  });
};

const qaAttachmentRefFromRow = (value: unknown): QAAttachmentRef => {
  const row = qaAttachmentRefRowSchema.parse(value);
  return qaAttachmentRefSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    qaRunId: row.qa_run_id,
    kind: row.kind,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    targetId: row.target_id,
    scenarioId: row.scenario_id,
    capturedAt: row.captured_at,
    retentionClass: row.retention_class,
    storageKey: row.storage_key,
  });
};

const qaDefectFromRow = (value: unknown): QADefect => {
  const row = qaDefectRowSchema.parse(value);
  return qaDefectSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    qaRunId: row.qa_run_id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    testedTree: row.tested_tree,
    ordinal: row.ordinal,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    reproduction: parseJson(row.reproduction_json),
    targetId: row.target_id,
    scenarioId: row.scenario_id,
    resolutionReason: row.resolution_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    version: row.version,
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
    correctionRunId: row.correction_run_id,
    stage: row.stage,
    attempt: row.attempt,
    status: row.status,
    version: row.version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    failureCode: row.failure_code,
    unproductiveSessions: row.unproductive_sessions,
    packShareBackoffs: row.pack_share_backoffs,
    resultTree: row.result_tree,
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
    agentRunId: row.agent_run_id,
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
// absent, it exits non-zero, or its output does not parse. The caller treats `null` as "do not
// kill".
const readProcessStartTime = (pid: number, now: Date): Date | null => {
  if (process.platform === "win32") {
    let output: string;
    try {
      // Win32_Process.CreationDate is the Windows source of truth for when a process began. Return
      // elapsed milliseconds rather than the absolute timestamp so an injected clock behaves the
      // same way here as it does with POSIX `ps -o etime` below. The pid is a validated number and
      // the command is passed as one argv value, never interpolated through a shell.
      const pidText = String(pid);
      output = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$candidate = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pidText}' -Property CreationDate; if ($null -ne $candidate) { [int64](([DateTime]::UtcNow - $candidate.CreationDate.ToUniversalTime()).TotalMilliseconds) }`,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch {
      return null;
    }
    const elapsedMilliseconds = Number(output.trim());
    if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) return null;
    return new Date(now.getTime() - elapsedMilliseconds);
  }
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
  processStartedAt: (pid: number) => Date | null;
  signalProcess: (pid: number, signal: "SIGKILL") => void;
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
      context.signalProcess(pid, "SIGKILL");
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

// The default `listProjectWorktrees`: runs `git worktree list --porcelain` synchronously (`execute`
// runs its whole transaction without ever awaiting anything, so `@loomrail/workspace`'s own async
// `listWorktrees` cannot be called from here) and hands its stdout to the same parser that function
// uses, so this reads the identical `prunable` signal rather than inventing a second interpretation
// of git's porcelain format. FAIL SAFE: `execFileSync` throws on a missing `git`, a non-zero exit,
// a repository path that does not resolve, or a permissions problem -- every one of those becomes
// `null` here, never a thrown error, because the caller's only correct response to "the check
// failed" must never be reachable through the same code path as "the repository has no worktrees".
const listProjectWorktreesWithGit = (topLevel: string): readonly WorktreeEntry[] | null => {
  try {
    const stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: topLevel,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseWorktreeListPorcelain(stdout);
  } catch {
    return null;
  }
};

// Best-effort realpath of a WorkItemWorkspace's own `worktreePath`, which -- unlike the entries
// `git worktree list --porcelain` reports -- was never itself resolved through the filesystem's
// symlinks (session-loop.ts's `createWorkspace` joins it from `workspacesRoot` directly). On macOS
// the OS temp directory is `/var/...`, a symlink to `/private/var/...`, so comparing the stored path
// against git's own (always-canonical) output by string equality alone would report a perfectly
// healthy workspace as gone every time a symlinked prefix is in play.
//
// `realpathSync` cannot resolve a path whose own leaf no longer exists -- which is exactly the
// case this check exists to find -- so this walks up to the nearest existing ancestor, resolves
// that, and reattaches whatever tail could not be resolved literally (the tail is exact filesystem
// path segments this process itself created, not attacker-controlled input, so a literal rejoin is
// safe). Returns the original, uncanonicalised path if even the filesystem root cannot be
// resolved: a degraded comparison that simply will not match any entry, rather than a thrown error
// on this fail-safe path.
const canonicalizeWorktreePath = (path: string): string => {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const resolved = process.platform === "win32" ? realpathSync.native(current) : realpathSync(current);
      return tail.length === 0 ? resolved : join(resolved, ...tail.reverse());
    } catch (cause) {
      if (errorCodeOf(cause) !== "ENOENT") return path;
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
};

// Both sides are canonicalised. Git for Windows may preserve an 8.3 alias or the original drive
// letter casing where Node reports the long path (or vice versa), while the filesystem considers
// all of those names identical. `realpathSync.native` asks Windows to resolve those aliases; case
// folding then matches the platform's case-insensitive path semantics. POSIX keeps exact case.
const worktreePathComparisonKey = (path: string): string => {
  const canonical = canonicalizeWorktreePath(normalize(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
};

export const openLocalState = async (options: OpenLocalStateOptions): Promise<LocalState> => {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  const processStartedAt = options.processStartedAt ?? ((pid: number) => readProcessStartTime(pid, now()));
  const signalProcess =
    options.signalProcess ?? ((pid: number, signal: "SIGKILL") => process.kill(pid, signal));
  // The default of last resort. A SIGKILL to a process on the owner's machine that nothing recorded
  // is exactly the defect this callback closes, so an uninjected caller still gets a durable line
  // rather than silence. `apps/daemon` injects its own structured logger over this.
  const reportOrphanProcess =
    options.onOrphanProcess ??
    ((event: OrphanProcessEvent) => {
      process.stderr.write(`${JSON.stringify({ event: "orphanProcess", ...event })}\n`);
    });
  const listProjectWorktrees = options.listProjectWorktrees ?? listProjectWorktreesWithGit;
  // Same default-of-last-resort reasoning as `reportOrphanProcess` above: a workspace quietly
  // orphaned, or a worktree check that quietly failed, is exactly the defect this closes.
  const reportOrphanWorkspace =
    options.onOrphanWorkspace ??
    ((event: OrphanWorkspaceEvent) => {
      process.stderr.write(`${JSON.stringify({ event: "orphanWorkspace", ...event })}\n`);
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
    const selectProjectByRepositoryPath = database.prepare(
      "SELECT * FROM projects WHERE repository_path = ? LIMIT 1",
    );
    const selectConstitutionProposalById = database.prepare(
      "SELECT * FROM constitution_proposals WHERE id = ?",
    );
    const selectLatestConstitutionProposal = database.prepare(
      `SELECT * FROM constitution_proposals
       WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`,
    );
    const selectProjectConstitutionById = database.prepare(
      "SELECT * FROM project_constitution_versions WHERE id = ?",
    );
    const selectActiveProjectConstitution = database.prepare(
      `SELECT * FROM project_constitution_versions
       WHERE project_id = ? AND status = 'ACTIVE' LIMIT 1`,
    );
    const selectPendingProjectConstitution = database.prepare(
      `SELECT * FROM project_constitution_versions
       WHERE project_id = ? AND status IN ('PUBLISHING', 'FAILED')
       ORDER BY ordinal DESC LIMIT 1`,
    );
    const selectMaxProjectConstitutionOrdinal = database.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM project_constitution_versions WHERE project_id = ?",
    );
    const selectConstitutionPublicationById = database.prepare(
      "SELECT * FROM constitution_publications WHERE id = ?",
    );
    const selectLatestConstitutionPublication = database.prepare(
      `SELECT publication.* FROM constitution_publications AS publication
       INNER JOIN project_constitution_versions AS constitution
         ON constitution.id = publication.constitution_version_id
       WHERE publication.project_id = ?
       ORDER BY constitution.ordinal DESC LIMIT 1`,
    );
    const selectPendingConstitutionPublications = database.prepare(
      "SELECT * FROM constitution_publications WHERE status = 'PENDING' ORDER BY created_at, id",
    );
    const insertConstitutionProposal = database.prepare(
      `INSERT INTO constitution_proposals (
        id, schema_version, project_id, project_version, status, preset_id, preset_version,
        recommended_preset_id, scan_json, sections_json, rendered_markdown, content_digest,
        version, created_at, adopted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateConstitutionProposal = database.prepare(
      `UPDATE constitution_proposals SET status = ?, version = ?, adopted_at = ?
       WHERE id = ? AND version = ?`,
    );
    const insertProjectConstitutionVersion = database.prepare(
      `INSERT INTO project_constitution_versions (
        id, schema_version, project_id, proposal_id, ordinal, preset_id, preset_version,
        source_digest, content_digest, rendered_markdown, status, version, created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateProjectConstitutionVersion = database.prepare(
      `UPDATE project_constitution_versions SET status = ?, version = ?, activated_at = ?
       WHERE id = ? AND version = ?`,
    );
    const insertConstitutionPublication = database.prepare(
      `INSERT INTO constitution_publications (
        id, schema_version, project_id, constitution_version_id, target_path,
        expected_target_digest, content_digest, status, attempts, last_error_code,
        version, created_at, updated_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateConstitutionPublication = database.prepare(
      `UPDATE constitution_publications SET
        status = ?, attempts = ?, last_error_code = ?, version = ?, updated_at = ?, applied_at = ?
       WHERE id = ? AND version = ?`,
    );
    const selectScaffoldOperationById = database.prepare("SELECT * FROM scaffold_operations WHERE id = ?");
    const selectPendingScaffoldOperations = database.prepare(
      "SELECT * FROM scaffold_operations WHERE status = 'PENDING' ORDER BY created_at, id",
    );
    const selectOpenScaffoldOperations = database.prepare(
      "SELECT * FROM scaffold_operations WHERE status != 'COMPLETED' ORDER BY updated_at DESC, id",
    );
    const insertScaffoldOperation = database.prepare(
      `INSERT INTO scaffold_operations (
        id, schema_version, project_id, proposal_json, status, attempts, last_error_code,
        version, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateScaffoldOperation = database.prepare(
      `UPDATE scaffold_operations SET
        status = ?, attempts = ?, last_error_code = ?, version = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND version = ?`,
    );
    const selectProjectReadinessRunById = database.prepare(
      "SELECT * FROM project_readiness_runs WHERE id = ?",
    );
    const selectLatestProjectReadinessRun = database.prepare(
      `SELECT * FROM project_readiness_runs
       WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const selectReadinessCheckById = database.prepare("SELECT * FROM project_readiness_checks WHERE id = ?");
    const selectReadinessChecksForRun = database.prepare(
      "SELECT * FROM project_readiness_checks WHERE run_id = ? ORDER BY check_key, id",
    );
    const selectReadinessFindingsForRun = database.prepare(
      "SELECT * FROM project_readiness_findings WHERE run_id = ? ORDER BY check_id, id",
    );
    const selectReadinessAttestationsForRun = database.prepare(
      `SELECT * FROM project_readiness_attestations
       WHERE run_id = ? ORDER BY created_at, id`,
    );
    const insertProjectReadinessRun = database.prepare(
      `INSERT INTO project_readiness_runs (
        id, schema_version, project_id, repository_head, source_digest, working_tree_dirty,
        status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateProjectReadinessRun = database.prepare(
      `UPDATE project_readiness_runs SET status = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
    );
    const insertReadinessCheck = database.prepare(
      `INSERT INTO project_readiness_checks (
        id, schema_version, run_id, project_id, check_key, category, mode, status, summary, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateReadinessCheck = database.prepare(
      `UPDATE project_readiness_checks SET status = ?, version = ? WHERE id = ? AND version = ?`,
    );
    const insertSecurityFinding = database.prepare(
      `INSERT INTO project_readiness_findings (
        id, schema_version, run_id, check_id, project_id, code, severity, path, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertReadinessAttestation = database.prepare(
      `INSERT INTO project_readiness_attestations (
        id, schema_version, run_id, check_id, project_id, outcome, rationale,
        actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectMcpProfileRevisionById = database.prepare("SELECT * FROM mcp_profile_revisions WHERE id = ?");
    const selectLatestMcpProfileRevision = database.prepare(
      `SELECT * FROM mcp_profile_revisions
       WHERE profile_id = ? ORDER BY revision DESC LIMIT 1`,
    );
    const selectLatestMcpProfileRevisionsForProject = database.prepare(
      `SELECT revision.* FROM mcp_profile_revisions AS revision
       WHERE revision.project_id = ?
         AND revision.revision = (
           SELECT MAX(latest.revision) FROM mcp_profile_revisions AS latest
           WHERE latest.profile_id = revision.profile_id
         )
       ORDER BY revision.created_at, revision.profile_id`,
    );
    const selectMcpConsentByRevision = database.prepare(
      "SELECT * FROM mcp_consents WHERE profile_revision_id = ?",
    );
    const selectLatestMcpCapabilityByRevision = database.prepare(
      `SELECT * FROM mcp_capability_snapshots
       WHERE profile_revision_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1`,
    );
    const selectMcpGrantByRevision = database.prepare(
      "SELECT * FROM mcp_grants WHERE profile_revision_id = ?",
    );
    const insertMcpProfileRevision = database.prepare(
      `INSERT INTO mcp_profile_revisions (
        id, schema_version, profile_id, project_id, revision, name, executable,
        args_json, declared_tools_json, canonical_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMcpConsent = database.prepare(
      `INSERT INTO mcp_consents (
        id, schema_version, project_id, profile_revision_id, canonical_digest, owner_id, consented_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMcpCapabilitySnapshot = database.prepare(
      `INSERT INTO mcp_capability_snapshots (
        id, schema_version, project_id, profile_revision_id, state, protocol_version,
        tools_json, resources_json, prompts_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMcpGrant = database.prepare(
      `INSERT INTO mcp_grants (
        id, schema_version, project_id, profile_revision_id, tools_json, enabled, version,
        granted_by, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateMcpGrant = database.prepare(
      `UPDATE mcp_grants SET
        tools_json = ?, enabled = ?, version = ?, granted_by = ?, updated_at = ?, revoked_at = ?
       WHERE id = ? AND version = ?`,
    );
    const updateProjectForMcp = database.prepare(
      "UPDATE projects SET version = ?, updated_at = ? WHERE id = ? AND version = ?",
    );
    const selectEnabledLatestMcpGrantsForProject = database.prepare(
      `SELECT grant_row.* FROM mcp_grants AS grant_row
       INNER JOIN mcp_profile_revisions AS revision
         ON revision.id = grant_row.profile_revision_id
       WHERE grant_row.project_id = ? AND grant_row.enabled = 1
         AND revision.revision = (
           SELECT MAX(latest.revision) FROM mcp_profile_revisions AS latest
           WHERE latest.profile_id = revision.profile_id
         )
       ORDER BY revision.profile_id, grant_row.id`,
    );
    const insertMcpSessionSnapshot = database.prepare(
      `INSERT INTO provider_session_mcp_snapshots (
        id, schema_version, project_id, provider_session_id, profile_revision_id,
        profile_digest, grant_id, grant_version, tools_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectMcpSessionSnapshotById = database.prepare(
      "SELECT * FROM provider_session_mcp_snapshots WHERE id = ?",
    );
    const selectMcpSessionSnapshotsForSession = database.prepare(
      `SELECT * FROM provider_session_mcp_snapshots
       WHERE provider_session_id = ? ORDER BY created_at, id`,
    );
    const insertMcpToolCall = database.prepare(
      `INSERT INTO mcp_tool_calls (
        id, schema_version, project_id, provider_session_id, session_snapshot_id,
        profile_revision_id, tool_name, input_digest, status, failure_code, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectMcpToolCallById = database.prepare("SELECT * FROM mcp_tool_calls WHERE id = ?");
    const selectMcpToolCallsForSession = database.prepare(
      "SELECT * FROM mcp_tool_calls WHERE provider_session_id = ? ORDER BY started_at, id",
    );
    const selectStartedMcpToolCalls = database.prepare(
      "SELECT * FROM mcp_tool_calls WHERE status = 'STARTED' ORDER BY started_at, id",
    );
    const updateMcpToolCall = database.prepare(
      `UPDATE mcp_tool_calls SET status = ?, failure_code = ?, finished_at = ?
       WHERE id = ? AND status = 'STARTED'`,
    );
    const selectWorkItemById = database.prepare("SELECT * FROM work_items WHERE id = ?");
    // Migration 0011. Named `WorkItemWorkspace`, not `Workspace`, throughout this file to keep it
    // apart from the pre-existing `workspaces` table (DEFAULT_WORKSPACE_ID above) -- an unrelated,
    // older multi-tenant concept that a Project points at, not the Git worktree a WorkItem is
    // edited in.
    const selectWorkItemWorkspaceById = database.prepare("SELECT * FROM work_item_workspaces WHERE id = ?");
    const selectWorkItemWorkspaceByWorkItemId = database.prepare(
      "SELECT * FROM work_item_workspaces WHERE work_item_id = ?",
    );
    const insertWorkItemWorkspace = database.prepare(
      `INSERT INTO work_item_workspaces (
        id, schema_version, project_id, work_item_id, branch, worktree_path, base_commit,
        snapshot_commit, status, lease_holder, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // The lease is taken by a single comparison-and-claim UPDATE, not a read followed by a write:
    // `lease_holder IS NULL` in the WHERE clause is what decides success, so the decision is one
    // atomic statement rather than something this code recomputes in JS after an earlier read.
    const acquireWorkItemWorkspaceLease = database.prepare(
      `UPDATE work_item_workspaces
       SET lease_holder = ?, version = version + 1
       WHERE id = ? AND version = ? AND lease_holder IS NULL`,
    );
    // Symmetric with the acquire above: `lease_holder = ?` in the WHERE clause is what makes a
    // release from anyone but the current holder a no-op the caller sees as a refusal, not
    // something trusted from the payload alone (spec D6).
    const releaseWorkItemWorkspaceLease = database.prepare(
      `UPDATE work_item_workspaces
       SET lease_holder = NULL, version = version + 1
       WHERE id = ? AND version = ? AND lease_holder = ?`,
    );
    // Clears `lease_holder` in the same statement, not a separate one: an ORPHANED workspace's
    // worktree is gone, so whatever StageAttempt held the lease can no longer write to it either,
    // and the 0011 migration's UNIQUE on work_item_id means this WorkItem will never get a second
    // workspace to hand a fresh lease acquire to -- a lease left dangling here would sit forever.
    const markWorkItemWorkspaceOrphaned = database.prepare(
      `UPDATE work_item_workspaces
       SET status = 'ORPHANED', lease_holder = NULL, version = version + 1
       WHERE id = ? AND version = ? AND status = 'READY'`,
    );
    // Startup reconciliation's own read (Task 10, spec §6 "Восстановление"): every workspace whose
    // worktree might have gone missing while nothing was watching it. ORPHANED and REMOVED rows are
    // already-settled facts this check has nothing left to say about.
    const selectReadyWorkItemWorkspaces = database.prepare(
      "SELECT * FROM work_item_workspaces WHERE status = 'READY' ORDER BY created_at, id",
    );
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
    const selectOpenHumanRequestsForAttention = database.prepare(
      `SELECT human_requests.*
       FROM human_requests
       LEFT JOIN work_items ON work_items.id = human_requests.work_item_id
       LEFT JOIN stage_attempts ON stage_attempts.id = human_requests.stage_attempt_id
       LEFT JOIN acceptance_packages
         ON acceptance_packages.human_request_id = human_requests.id
        AND acceptance_packages.status = 'PENDING'
       WHERE human_requests.status = 'OPEN'
       ORDER BY
         CASE
           WHEN human_requests.blocking = 1 THEN 0
           WHEN acceptance_packages.id IS NOT NULL THEN 1
           WHEN stage_attempts.status = 'HARD_PAUSED'
             AND stage_attempts.failure_code IN (?, ?, ?, ?, ?) THEN 3
           ELSE 2
         END,
         CASE work_items.priority
           WHEN 'URGENT' THEN 0
           WHEN 'HIGH' THEN 1
           WHEN 'MEDIUM' THEN 2
           ELSE 3
         END,
         human_requests.created_at,
         human_requests.id
       LIMIT ?`,
    );
    const selectWorkflowDispatchById = database.prepare("SELECT * FROM workflow_dispatches WHERE id = ?");
    const selectPendingDispatchByStageAttempt = database.prepare(
      "SELECT * FROM workflow_dispatches WHERE stage_attempt_id = ? AND status = 'PENDING' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const selectCurrentBudgetPolicy = database.prepare(
      "SELECT * FROM budget_policies WHERE pipeline_run_id = ? ORDER BY revision DESC LIMIT 1",
    );
    const selectLatestSquadAssignment = database.prepare(
      "SELECT * FROM squad_assignments WHERE pipeline_run_id = ? ORDER BY revision DESC LIMIT 1",
    );
    const insertSquadAssignment = database.prepare(
      `INSERT INTO squad_assignments (
        id, schema_version, project_id, work_item_id, pipeline_run_id, revision, stages_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectRunningAgentRunForStageAttempt = database.prepare(
      "SELECT * FROM agent_runs WHERE stage_attempt_id = ? AND status = 'RUNNING' LIMIT 1",
    );
    const selectAgentRunById = database.prepare("SELECT * FROM agent_runs WHERE id = ?");
    const selectLatestSucceededDeveloperAgentRun = database.prepare(
      `SELECT * FROM agent_runs
       WHERE pipeline_run_id = ? AND profile_role = 'DEVELOPER' AND status = 'SUCCEEDED'
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    );
    const selectLatestSucceededImplementTree = database.prepare(
      `SELECT result_tree FROM stage_attempts
       WHERE pipeline_run_id = ? AND stage = 'IMPLEMENT' AND status = 'SUCCEEDED'
         AND result_tree IS NOT NULL
       ORDER BY attempt DESC, finished_at DESC, id DESC LIMIT 1`,
    );
    const selectLatestSucceededImplementAttempt = database.prepare(
      `SELECT * FROM stage_attempts
       WHERE pipeline_run_id = ? AND stage = 'IMPLEMENT' AND status = 'SUCCEEDED'
         AND result_tree IS NOT NULL
       ORDER BY attempt DESC, finished_at DESC, id DESC LIMIT 1`,
    );
    const selectOpenReviewFindings = database.prepare(
      `SELECT * FROM review_findings
       WHERE pipeline_run_id = ? AND status = 'OPEN' ORDER BY created_at, id LIMIT 200`,
    );
    const selectReviewFindingById = database.prepare("SELECT * FROM review_findings WHERE id = ?");
    const selectRunningAgentRuns = database.prepare(
      "SELECT * FROM agent_runs WHERE status = 'RUNNING' ORDER BY started_at, id",
    );
    const selectRunningAgentRunForWorkItem = database.prepare(
      "SELECT id FROM agent_runs WHERE work_item_id = ? AND status = 'RUNNING' LIMIT 1",
    );
    const countRunningAgentRuns = database.prepare(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'RUNNING'",
    );
    const countRunningAgentRunsForProject = database.prepare(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'RUNNING' AND project_id = ?",
    );
    const countRunningAgentRunsForProvider = database.prepare(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'RUNNING' AND provider = ?",
    );
    const selectMaxAgentRunOrdinal = database.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM agent_runs WHERE stage_attempt_id = ?",
    );
    const insertAgentRun = database.prepare(
      `INSERT INTO agent_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id, ordinal,
        squad_assignment_id, profile_id, profile_revision, profile_role, provider, status,
        policy_snapshot_hash, started_at, finished_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateAgentRunStatus = database.prepare(
      `UPDATE agent_runs SET status = ?, finished_at = ?, version = ?
       WHERE id = ? AND version = ? AND status = 'RUNNING'`,
    );
    const selectQARunById = database.prepare("SELECT * FROM qa_runs WHERE id = ?");
    const selectQARunByAgentRun = database.prepare("SELECT * FROM qa_runs WHERE agent_run_id = ?");
    const insertQARun = database.prepare(
      `INSERT INTO qa_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        agent_run_id, driver_id, tested_tree, target_origin, plan_json, correction_run_id,
        retest_plan_id, status, error_code, error_summary, started_at, completed_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const completeQARun = database.prepare(
      `UPDATE qa_runs SET status = ?, error_code = ?, error_summary = ?, completed_at = ?, version = ?
       WHERE id = ? AND version = ? AND status = 'RUNNING'`,
    );
    const insertQAEvidenceBundle = database.prepare(
      `INSERT INTO qa_evidence_bundles (
        id, schema_version, qa_run_id, project_id, work_item_id, pipeline_run_id,
        stage_attempt_id, tested_tree, verdict, environment_json, executions_json,
        observations_json, attachment_ids_json, defect_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectQAEvidenceBundleById = database.prepare("SELECT * FROM qa_evidence_bundles WHERE id = ?");
    const insertQAAttachmentRef = database.prepare(
      `INSERT INTO qa_attachment_refs (
        id, schema_version, qa_run_id, kind, content_hash, byte_size, target_id,
        scenario_id, captured_at, retention_class, storage_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectQAAttachmentRefById = database.prepare("SELECT * FROM qa_attachment_refs WHERE id = ?");
    const selectQAAttachmentRetentionById = database.prepare(
      "SELECT * FROM qa_attachment_retention_log WHERE attachment_id = ?",
    );
    const insertQAAttachmentRetention = database.prepare(
      `INSERT INTO qa_attachment_retention_log (attachment_id, outcome, recorded_at)
       VALUES (?, ?, ?)`,
    );
    const selectExpiredQAAttachmentRefs = database.prepare(
      `SELECT qa_attachment_refs.* FROM qa_attachment_refs
       INNER JOIN qa_runs ON qa_runs.id = qa_attachment_refs.qa_run_id
       INNER JOIN work_items ON work_items.id = qa_runs.work_item_id
       LEFT JOIN qa_attachment_retention_log
         ON qa_attachment_retention_log.attachment_id = qa_attachment_refs.id
       INNER JOIN events AS closure_event ON closure_event.sequence = (
         SELECT MAX(history.sequence) FROM events AS history
         WHERE history.aggregate_id = work_items.id
           AND (
             history.type IN ('PIPELINE_CANCELLED', 'PIPELINE_COMPLETED')
             OR (
               history.type = 'WORK_ITEM_STATE_CHANGED'
               AND json_extract(history.data_json, '$.workItem.state') IN ('DONE', 'CANCELLED')
             )
           )
       )
       WHERE qa_attachment_refs.retention_class = 'STANDARD_30_DAYS'
         AND qa_attachment_retention_log.attachment_id IS NULL
         AND work_items.state IN ('DONE', 'CANCELLED')
         AND closure_event.occurred_at <= ?
       ORDER BY closure_event.occurred_at, qa_attachment_refs.captured_at, qa_attachment_refs.id
       LIMIT ?`,
    );
    const insertQADefect = database.prepare(
      `INSERT INTO qa_defects (
        id, schema_version, qa_run_id, project_id, work_item_id, tested_tree, ordinal,
        severity, status, title, description, reproduction_json, target_id, scenario_id,
        resolution_reason, created_at, resolved_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectAcceptancePackageById = database.prepare("SELECT * FROM acceptance_packages WHERE id = ?");
    const selectAcceptancePackageByRun = database.prepare(
      "SELECT * FROM acceptance_packages WHERE pipeline_run_id = ?",
    );
    const selectPendingAcceptancePackageByHumanRequest = database.prepare(
      `SELECT * FROM acceptance_packages
       WHERE human_request_id = ? AND status = 'PENDING'
       ORDER BY created_at, id
       LIMIT 1`,
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
        id, schema_version, agent_run_id, stage_attempt_id, ordinal, status, end_reason,
        handoff_requested_at, started_at, ended_at, version, process_pid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    const readConstitutionProposal = (proposalId: string): ConstitutionProposal | null => {
      const row = selectConstitutionProposalById.get(proposalId);
      return row === undefined ? null : constitutionProposalFromRow(row);
    };

    const readLatestConstitutionProposal = (projectId: string): ConstitutionProposal | null => {
      const row = selectLatestConstitutionProposal.get(projectId);
      return row === undefined ? null : constitutionProposalFromRow(row);
    };

    const readProjectConstitutionVersion = (id: string): ProjectConstitutionVersion | null => {
      const row = selectProjectConstitutionById.get(id);
      return row === undefined ? null : projectConstitutionVersionFromRow(row);
    };

    const readActiveProjectConstitution = (projectId: string): ProjectConstitutionVersion | null => {
      const row = selectActiveProjectConstitution.get(projectId);
      return row === undefined ? null : projectConstitutionVersionFromRow(row);
    };

    const readPendingProjectConstitution = (projectId: string): ProjectConstitutionVersion | null => {
      const row = selectPendingProjectConstitution.get(projectId);
      return row === undefined ? null : projectConstitutionVersionFromRow(row);
    };

    const readConstitutionPublication = (id: string): ConstitutionPublication | null => {
      const row = selectConstitutionPublicationById.get(id);
      return row === undefined ? null : constitutionPublicationFromRow(row);
    };

    const readScaffoldOperation = (id: string): ScaffoldOperation | null => {
      const row = selectScaffoldOperationById.get(id);
      return row === undefined ? null : scaffoldOperationFromRow(row);
    };

    const readProjectReadinessRun = (id: string): ProjectReadinessRun | null => {
      const row = selectProjectReadinessRunById.get(id);
      return row === undefined ? null : projectReadinessRunFromRow(row);
    };

    const readLatestProjectReadinessRun = (projectId: string): ProjectReadinessRun | null => {
      const row = selectLatestProjectReadinessRun.get(projectId);
      return row === undefined ? null : projectReadinessRunFromRow(row);
    };

    const readReadinessCheck = (id: string): ReadinessCheck | null => {
      const row = selectReadinessCheckById.get(id);
      return row === undefined ? null : readinessCheckFromRow(row);
    };

    const readReadinessChecks = (runId: string): ReadinessCheck[] =>
      selectReadinessChecksForRun.all(runId).map(readinessCheckFromRow);

    const readMcpProfileRevision = (id: string): McpProfileRevision | null => {
      const row = selectMcpProfileRevisionById.get(id);
      return row === undefined ? null : mcpProfileRevisionFromRow(row);
    };

    const readLatestMcpProfileRevision = (profileId: string): McpProfileRevision | null => {
      const row = selectLatestMcpProfileRevision.get(profileId);
      return row === undefined ? null : mcpProfileRevisionFromRow(row);
    };

    const readMcpConsent = (profileRevisionId: string): McpConsent | null => {
      const row = selectMcpConsentByRevision.get(profileRevisionId);
      return row === undefined ? null : mcpConsentFromRow(row);
    };

    const readLatestMcpCapability = (profileRevisionId: string): McpCapabilitySnapshot | null => {
      const row = selectLatestMcpCapabilityByRevision.get(profileRevisionId);
      return row === undefined ? null : mcpCapabilitySnapshotFromRow(row);
    };

    const readMcpGrant = (profileRevisionId: string): McpGrant | null => {
      const row = selectMcpGrantByRevision.get(profileRevisionId);
      return row === undefined ? null : mcpGrantFromRow(row);
    };

    const readProjectMcpProfiles = (projectId: string): McpProfileView[] =>
      selectLatestMcpProfileRevisionsForProject.all(projectId).map((row) => {
        const revision = mcpProfileRevisionFromRow(row);
        const consent = readMcpConsent(revision.id);
        if (consent === null) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "An MCP profile revision exists without its owner consent",
          );
        }
        return {
          revision,
          consent,
          capability: readLatestMcpCapability(revision.id),
          grant: readMcpGrant(revision.id),
        };
      });

    const readMcpSessionSnapshot = (id: string): McpSessionSnapshot | null => {
      const row = selectMcpSessionSnapshotById.get(id);
      return row === undefined ? null : mcpSessionSnapshotFromRow(row);
    };

    const readMcpSessionSnapshots = (providerSessionId: string): McpSessionSnapshot[] =>
      selectMcpSessionSnapshotsForSession.all(providerSessionId).map(mcpSessionSnapshotFromRow);

    const readMcpToolCall = (id: string): McpToolCallRecord | null => {
      const row = selectMcpToolCallById.get(id);
      return row === undefined ? null : mcpToolCallFromRow(row);
    };

    const readWorkItemWorkspace = (id: string): WorkItemWorkspace | null => {
      const row = selectWorkItemWorkspaceById.get(id);
      return row === undefined ? null : workItemWorkspaceFromRow(row);
    };

    const readWorkItemWorkspaceByWorkItemId = (workItemId: string): WorkItemWorkspace | null => {
      const row = selectWorkItemWorkspaceByWorkItemId.get(workItemId);
      return row === undefined ? null : workItemWorkspaceFromRow(row);
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

    const readMeasuredQAForArtifact = (
      artifact: EvidenceArtifact | undefined,
      currentTree: string,
    ):
      | {
          qaRun: QARun;
          evidence: QAEvidenceBundle;
          currentTree: string;
        }
      | undefined => {
      if (artifact?.qaRunId === undefined || artifact.qaEvidenceBundleId === undefined) return undefined;
      const qaRunValue = selectQARunById.get(artifact.qaRunId);
      const evidenceValue = selectQAEvidenceBundleById.get(artifact.qaEvidenceBundleId);
      if (qaRunValue === undefined || evidenceValue === undefined) return undefined;
      return {
        qaRun: qaRunFromRow(qaRunValue),
        evidence: qaEvidenceBundleFromRow(evidenceValue),
        currentTree,
      };
    };

    const readWorkflowTemplate = (run: PipelineRun) => {
      const value = database
        .prepare("SELECT template_json FROM workflow_templates WHERE id = ? AND version = ?")
        .get(run.workflowTemplateId, run.workflowVersion);
      const row = z.object({ template_json: z.string() }).safeParse(value);
      if (!row.success) {
        throw new StateStoreError("PERSISTENCE_FAILURE", "The PipelineRun workflow template does not exist");
      }
      return workflowTemplateSchema.parse(parseJson(row.data.template_json));
    };

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

        const reviewInput =
          stageAttempt.stage === "REVIEW"
            ? (() => {
                const implementationValue = selectLatestSucceededImplementAttempt.get(run.id);
                const authorValue = selectLatestSucceededDeveloperAgentRun.get(run.id);
                if (implementationValue === undefined || authorValue === undefined) return null;
                const implementationAttempt = stageAttemptFromRow(implementationValue);
                const authorAgentRun = agentRunFromRow(authorValue);
                if (implementationAttempt.resultTree === null) return null;
                return {
                  implementationAttempt: {
                    id: implementationAttempt.id,
                    version: implementationAttempt.version,
                    attempt: implementationAttempt.attempt,
                    resultTree: implementationAttempt.resultTree,
                  },
                  authorAgentRun: {
                    id: authorAgentRun.id,
                    version: authorAgentRun.version,
                    provider: authorAgentRun.provider,
                  },
                  openFindings: selectOpenReviewFindings
                    .all(run.id)
                    .map(reviewFindingFromRow)
                    .map((finding) => ({
                      id: finding.id,
                      version: finding.version,
                      severity: finding.severity,
                      title: finding.title,
                      description: finding.description,
                      path: finding.path,
                      startLine: finding.startLine,
                      endLine: finding.endLine,
                      reproduction: finding.reproduction,
                      criterion: finding.criterion,
                    })),
                };
              })()
            : null;

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
          reviewInput,
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

    const insertProposal = (proposal: ConstitutionProposal): void => {
      insertConstitutionProposal.run(
        proposal.id,
        proposal.schemaVersion,
        proposal.projectId,
        proposal.projectVersion,
        proposal.status,
        proposal.presetId,
        proposal.presetVersion,
        proposal.recommendedPresetId,
        JSON.stringify(proposal.scan),
        JSON.stringify(proposal.sections),
        proposal.renderedMarkdown,
        proposal.contentDigest,
        proposal.version,
        proposal.createdAt,
        proposal.adoptedAt,
      );
    };

    const updateProposal = (proposal: ConstitutionProposal, expectedVersion: number): void => {
      const result = updateConstitutionProposal.run(
        proposal.status,
        proposal.version,
        proposal.adoptedAt,
        proposal.id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        throw new ConstitutionDomainError(
          "PROPOSAL_VERSION_CONFLICT",
          "The Constitution Proposal changed while the command was applied",
        );
      }
    };

    const insertConstitutionVersion = (constitution: ProjectConstitutionVersion): void => {
      insertProjectConstitutionVersion.run(
        constitution.id,
        constitution.schemaVersion,
        constitution.projectId,
        constitution.proposalId,
        constitution.ordinal,
        constitution.presetId,
        constitution.presetVersion,
        constitution.sourceDigest,
        constitution.contentDigest,
        constitution.renderedMarkdown,
        constitution.status,
        constitution.version,
        constitution.createdAt,
        constitution.activatedAt,
      );
    };

    const updateConstitutionVersion = (
      constitution: ProjectConstitutionVersion,
      expectedVersion: number,
    ): void => {
      const result = updateProjectConstitutionVersion.run(
        constitution.status,
        constitution.version,
        constitution.activatedAt,
        constitution.id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        throw new ConstitutionDomainError(
          "CONSTITUTION_STATUS_INVALID",
          "The Constitution version changed while the command was applied",
        );
      }
    };

    const insertPublication = (publication: ConstitutionPublication): void => {
      insertConstitutionPublication.run(
        publication.id,
        publication.schemaVersion,
        publication.projectId,
        publication.constitutionVersionId,
        publication.targetPath,
        publication.expectedTargetDigest,
        publication.contentDigest,
        publication.status,
        publication.attempts,
        publication.lastErrorCode,
        publication.version,
        publication.createdAt,
        publication.updatedAt,
        publication.appliedAt,
      );
    };

    const updatePublication = (publication: ConstitutionPublication, expectedVersion: number): void => {
      const result = updateConstitutionPublication.run(
        publication.status,
        publication.attempts,
        publication.lastErrorCode,
        publication.version,
        publication.updatedAt,
        publication.appliedAt,
        publication.id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        throw new ConstitutionDomainError(
          "PUBLICATION_VERSION_CONFLICT",
          "The Constitution publication changed while the command was applied",
        );
      }
    };

    const insertScaffold = (operation: ScaffoldOperation): void => {
      insertScaffoldOperation.run(
        operation.id,
        operation.schemaVersion,
        operation.projectId,
        JSON.stringify(operation.proposal),
        operation.status,
        operation.attempts,
        operation.lastErrorCode,
        operation.version,
        operation.createdAt,
        operation.updatedAt,
        operation.completedAt,
      );
    };

    const updateScaffold = (operation: ScaffoldOperation, expectedVersion: number): void => {
      const result = updateScaffoldOperation.run(
        operation.status,
        operation.attempts,
        operation.lastErrorCode,
        operation.version,
        operation.updatedAt,
        operation.completedAt,
        operation.id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        throw new ScaffoldDomainError(
          "SCAFFOLD_OPERATION_VERSION_CONFLICT",
          "The scaffold operation changed while the command was applied",
        );
      }
    };

    const insertReadinessRun = (run: ProjectReadinessRun): void => {
      insertProjectReadinessRun.run(
        run.id,
        run.schemaVersion,
        run.projectId,
        run.repositoryHead,
        run.sourceDigest,
        run.workingTreeDirty ? 1 : 0,
        run.status,
        run.version,
        run.createdAt,
        run.updatedAt,
      );
    };

    const insertReadinessChecks = (checks: readonly ReadinessCheck[]): void => {
      for (const check of checks) {
        insertReadinessCheck.run(
          check.id,
          check.schemaVersion,
          check.runId,
          check.projectId,
          check.key,
          check.category,
          check.mode,
          check.status,
          check.summary,
          check.version,
        );
      }
    };

    const insertReadinessFindings = (findings: readonly SecurityFinding[]): void => {
      for (const readinessFinding of findings) {
        insertSecurityFinding.run(
          readinessFinding.id,
          readinessFinding.schemaVersion,
          readinessFinding.runId,
          readinessFinding.checkId,
          readinessFinding.projectId,
          readinessFinding.code,
          readinessFinding.severity,
          readinessFinding.path,
          readinessFinding.message,
        );
      }
    };

    const updateReadinessProjection = (
      run: ProjectReadinessRun,
      expectedRunVersion: number,
      check: ReadinessCheck,
      expectedCheckVersion: number,
    ): void => {
      const checkResult = updateReadinessCheck.run(
        check.status,
        check.version,
        check.id,
        expectedCheckVersion,
      );
      const runResult = updateProjectReadinessRun.run(
        run.status,
        run.version,
        run.updatedAt,
        run.id,
        expectedRunVersion,
      );
      if (checkResult.changes !== 1 || runResult.changes !== 1) {
        throw new ReadinessDomainError(
          "READINESS_RUN_VERSION_CONFLICT",
          "Readiness state changed while the attestation was applied",
        );
      }
    };

    const persistReadinessAttestation = (attestation: ReadinessAttestation): void => {
      insertReadinessAttestation.run(
        attestation.id,
        attestation.schemaVersion,
        attestation.runId,
        attestation.checkId,
        attestation.projectId,
        attestation.outcome,
        attestation.rationale,
        attestation.actor.type,
        attestation.actor.id,
        attestation.createdAt,
      );
    };

    const persistMcpProfileConsent = (revision: McpProfileRevision, consent: McpConsent): void => {
      insertMcpProfileRevision.run(
        revision.id,
        revision.schemaVersion,
        revision.profileId,
        revision.projectId,
        revision.revision,
        revision.name,
        revision.executable,
        JSON.stringify(revision.args),
        JSON.stringify(revision.declaredTools),
        revision.canonicalDigest,
        revision.createdAt,
      );
      insertMcpConsent.run(
        consent.id,
        consent.schemaVersion,
        consent.projectId,
        consent.profileRevisionId,
        consent.canonicalDigest,
        consent.ownerId,
        consent.consentedAt,
      );
    };

    const persistMcpCapabilitySnapshot = (snapshot: McpCapabilitySnapshot): void => {
      insertMcpCapabilitySnapshot.run(
        snapshot.id,
        snapshot.schemaVersion,
        snapshot.projectId,
        snapshot.profileRevisionId,
        snapshot.state,
        snapshot.protocolVersion,
        JSON.stringify(snapshot.tools),
        JSON.stringify(snapshot.resources),
        JSON.stringify(snapshot.prompts),
        snapshot.observedAt,
      );
    };

    const persistMcpGrant = (grant: McpGrant, previousVersion: number | null): void => {
      if (previousVersion === null) {
        insertMcpGrant.run(
          grant.id,
          grant.schemaVersion,
          grant.projectId,
          grant.profileRevisionId,
          JSON.stringify(grant.tools),
          grant.enabled ? 1 : 0,
          grant.version,
          grant.grantedBy,
          grant.createdAt,
          grant.updatedAt,
          grant.revokedAt,
        );
        return;
      }
      const updated = updateMcpGrant.run(
        JSON.stringify(grant.tools),
        grant.enabled ? 1 : 0,
        grant.version,
        grant.grantedBy,
        grant.updatedAt,
        grant.revokedAt,
        grant.id,
        previousVersion,
      );
      if (updated.changes !== 1) {
        throw new McpDomainError(
          "GRANT_VERSION_CONFLICT",
          "The MCP grant changed while the command was being applied",
        );
      }
    };

    const persistMcpProjectVersion = (next: Project, previousVersion: number): void => {
      const updated = updateProjectForMcp.run(next.version, next.updatedAt, next.id, previousVersion);
      if (updated.changes !== 1) {
        throw new McpDomainError(
          "PROJECT_VERSION_CONFLICT",
          "The Project changed while MCP settings were applied",
        );
      }
    };

    const persistMcpSessionSnapshots = (snapshots: readonly McpSessionSnapshot[]): void => {
      snapshots.forEach((snapshot) => {
        insertMcpSessionSnapshot.run(
          snapshot.id,
          snapshot.schemaVersion,
          snapshot.projectId,
          snapshot.providerSessionId,
          snapshot.profileRevisionId,
          snapshot.profileDigest,
          snapshot.grantId,
          snapshot.grantVersion,
          JSON.stringify(snapshot.tools),
          snapshot.createdAt,
        );
      });
    };

    const persistMcpToolCall = (call: McpToolCallRecord): void => {
      insertMcpToolCall.run(
        call.id,
        call.schemaVersion,
        call.projectId,
        call.providerSessionId,
        call.sessionSnapshotId,
        call.profileRevisionId,
        call.toolName,
        call.inputDigest,
        call.status,
        call.failureCode,
        call.startedAt,
        call.finishedAt,
      );
    };

    const persistFinishedMcpToolCall = (call: McpToolCallRecord): void => {
      const updated = updateMcpToolCall.run(call.status, call.failureCode, call.finishedAt, call.id);
      if (updated.changes !== 1) {
        throw new McpDomainError("TOOL_CALL_NOT_STARTED", "The MCP tool call is no longer started");
      }
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

    // Takes either command that leaves a Project registered at a repository path: the first
    // registration, and the repoint that moves a demo Project off the bundled template it still
    // records. Both record the same fact -- see projectRegisteredEventSchema's note on why the
    // repoint reuses this event type rather than introducing one.
    const appendProjectEvent = (
      project: Project,
      command: RegisterProjectCommand | RepointFixtureProjectCommand,
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

    type ConstitutionEventIntent =
      | ConstitutionProposedIntent
      | ConstitutionPublicationRequestedIntent
      | ConstitutionActivatedIntent
      | ConstitutionPublicationFailedIntent;

    const appendConstitutionEvent = (
      intent: ConstitutionEventIntent,
      metadata: {
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
        "PROJECT",
        metadata.projectId,
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
        aggregateType: "PROJECT",
        aggregateId: metadata.projectId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
      });
    };

    const appendScaffoldEvent = (
      intent: ScaffoldRequestedIntent | ScaffoldCompletedIntent | ScaffoldFailedIntent,
      metadata: {
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
        "PROJECT",
        metadata.projectId,
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
        aggregateType: "PROJECT",
        aggregateId: metadata.projectId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
      });
    };

    type ReadinessEventIntent = ProjectReadinessAssessedIntent | ProjectReadinessAttestedIntent;

    const appendReadinessEvent = (
      intent: ReadinessEventIntent,
      metadata: {
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
        "PROJECT",
        metadata.projectId,
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
        aggregateType: "PROJECT",
        aggregateId: metadata.projectId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
      });
    };

    const appendProviderSelectionEvent = (
      intent: ProjectProviderPreferenceChangedIntent,
      metadata: {
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
        "PROJECT",
        metadata.projectId,
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
        aggregateType: "PROJECT",
        aggregateId: metadata.projectId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
      });
    };

    const appendMcpEvent = (
      intent: McpProfileConsentedIntent | McpGrantChangedIntent,
      metadata: {
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
        "PROJECT",
        metadata.projectId,
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
        aggregateType: "PROJECT",
        aggregateId: metadata.projectId,
        projectId: metadata.projectId,
        actor: metadata.actor,
        occurredAt: metadata.occurredAt,
        correlationId: metadata.correlationId,
        data: intent.data,
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
      | ReviewFindingDispositionDecision["events"][number]
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
      | {
          type: "PROVIDER_SESSION_STARTED";
          data: {
            session: ProviderSession;
            recipe: ContextPackRecipe;
            mcpSnapshots: McpSessionSnapshot[];
          };
        }
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

    type AgentEventIntent =
      | { type: "SQUAD_ASSIGNED"; data: { assignment: SquadAssignment } }
      | { type: "AGENT_RUN_STARTED"; data: { run: AgentRun } }
      | { type: "AGENT_RUN_FINISHED"; data: { run: AgentRun } }
      | { type: "QA_RUN_RESERVED"; data: { qaRun: QARun } }
      | {
          type: "QA_RUN_COMPLETED";
          data: { qaRun: QARun; evidenceBundleId: string | null; defectIds: string[] };
        };

    const appendAgentEvent = (
      intent: AgentEventIntent,
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

    const finishActiveAgentRun = (
      stageAttemptId: string,
      status: Exclude<AgentRunStatus, "RUNNING">,
      metadata: {
        workItemId: string;
        projectId: string;
        actor: Actor;
        occurredAt: string;
        correlationId: string;
      },
    ): AgentRun | null => {
      const value = selectRunningAgentRunForStageAttempt.get(stageAttemptId);
      if (value === undefined) return null;
      const current = agentRunFromRow(value);
      const finished = finishAgentRun(current, status, metadata.occurredAt);
      const update = updateAgentRunStatus.run(
        finished.status,
        finished.finishedAt,
        finished.version,
        finished.id,
        current.version,
      );
      if (update.changes !== 1) {
        throw new StateStoreError("PERSISTENCE_FAILURE", "The AgentRun changed while it was being finished");
      }

      const workspace = readWorkItemWorkspaceByWorkItemId(finished.workItemId);
      if (workspace?.leaseHolder === stageAttemptId) {
        const release = releaseWorkItemWorkspaceLease.run(workspace.id, workspace.version, stageAttemptId);
        if (release.changes !== 1) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The AgentRun workspace lease changed while the run was being finished",
          );
        }
      }
      appendAgentEvent({ type: "AGENT_RUN_FINISHED", data: { run: finished } }, metadata);
      return finished;
    };

    const terminalAgentRunStatus = (
      status: StageAttempt["status"],
    ): Exclude<AgentRunStatus, "RUNNING"> | null => {
      switch (status) {
        case "SUCCEEDED":
        case "FAILED":
        case "CANCELLED":
        case "INTERRUPTED":
        case "WAITING_HUMAN":
        case "SOFT_PAUSED":
        case "HARD_PAUSED":
          return status;
        case "RECOVERING":
        case "STALE":
          return "INTERRUPTED";
        case "PENDING":
        case "QUEUED":
        case "RUNNING":
          return null;
      }
    };

    type WorkspaceEventIntent =
      | {
          type: "WORK_ITEM_WORKSPACE_CREATED";
          data: { workspace: WorkItemWorkspace; carriedPaths: string[] };
        }
      | {
          type: "WORK_ITEM_WORKSPACE_ORPHANED";
          data: { workspace: WorkItemWorkspace; previousStatus: WorkItemWorkspace["status"] };
        };

    const appendWorkspaceEvent = (
      intent: WorkspaceEventIntent,
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
            id, pipeline_run_id, project_id, work_item_id, correction_run_id, stage, attempt, status, version,
            started_at, finished_at, failure_code, unproductive_sessions, pack_share_backoffs,
            result_tree
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.id,
          attempt.pipelineRunId,
          attempt.projectId,
          attempt.workItemId,
          attempt.correctionRunId,
          attempt.stage,
          attempt.attempt,
          attempt.status,
          attempt.version,
          attempt.startedAt,
          attempt.finishedAt,
          attempt.failureCode,
          attempt.unproductiveSessions,
          attempt.packShareBackoffs,
          attempt.resultTree,
        );
    };

    const updateStageAttempt = (attempt: StageAttempt): void => {
      const update = database
        .prepare(
          `UPDATE stage_attempts SET status = ?, version = ?, started_at = ?, finished_at = ?,
             failure_code = ?, unproductive_sessions = ?, pack_share_backoffs = ?,
             result_tree = ?
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
          attempt.resultTree,
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
            correction_run_id, stage, kind, status, provider, title, summary, checks_json,
            review_report_id, qa_run_id, qa_evidence_bundle_id, tested_tree, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.schemaVersion,
          artifact.projectId,
          artifact.workItemId,
          artifact.pipelineRunId,
          artifact.stageAttemptId,
          artifact.correctionRunId,
          artifact.stage,
          artifact.kind,
          artifact.status,
          artifact.provider,
          artifact.title,
          artifact.summary,
          JSON.stringify(artifact.checks),
          artifact.reviewReportId ?? null,
          artifact.qaRunId ?? null,
          artifact.qaEvidenceBundleId ?? null,
          artifact.testedTree ?? null,
          artifact.createdAt,
        );
    };

    const insertReviewReport = (report: ReviewReport): void => {
      database
        .prepare(
          `INSERT INTO review_reports (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            correction_run_id, author_agent_run_id, reviewer_agent_run_id, provider_relation,
            reviewed_tree, round, title, summary, checks_json, verdict, finding_ids_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          report.id,
          report.schemaVersion,
          report.projectId,
          report.workItemId,
          report.pipelineRunId,
          report.stageAttemptId,
          report.correctionRunId,
          report.authorAgentRunId,
          report.reviewerAgentRunId,
          report.providerRelation,
          report.reviewedTree,
          report.round,
          report.title,
          report.summary,
          JSON.stringify(report.checks),
          report.verdict,
          JSON.stringify(report.findingIds),
          report.createdAt,
        );
    };

    const insertReviewFinding = (finding: ReviewFinding): void => {
      database
        .prepare(
          `INSERT INTO review_findings (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            correction_run_id, review_artifact_id, reviewed_tree, ordinal, severity, status, title, description,
            path, start_line, end_line, reproduction, criterion, suggested_fix, resolution_reason,
            resolved_by_type, resolved_by_id, created_at, resolved_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          finding.id,
          finding.schemaVersion,
          finding.projectId,
          finding.workItemId,
          finding.pipelineRunId,
          finding.stageAttemptId,
          finding.correctionRunId,
          finding.reviewArtifactId,
          finding.reviewedTree,
          finding.ordinal,
          finding.severity,
          finding.status,
          finding.title,
          finding.description,
          finding.path,
          finding.startLine,
          finding.endLine,
          finding.reproduction,
          finding.criterion,
          finding.suggestedFix,
          finding.resolutionReason,
          finding.resolvedBy?.type ?? null,
          finding.resolvedBy?.id ?? null,
          finding.createdAt,
          finding.resolvedAt,
          finding.version,
        );
    };

    const updateReviewFinding = (finding: ReviewFinding): void => {
      const update = database
        .prepare(
          `UPDATE review_findings SET
            status = ?, resolution_reason = ?, resolved_by_type = ?, resolved_by_id = ?,
            resolved_at = ?, version = ?
           WHERE id = ? AND version = ? AND status = 'OPEN'`,
        )
        .run(
          finding.status,
          finding.resolutionReason,
          finding.resolvedBy?.type ?? null,
          finding.resolvedBy?.id ?? null,
          finding.resolvedAt,
          finding.version,
          finding.id,
          finding.version - 1,
        );
      if (update.changes !== 1) {
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The review Finding changed while its disposition was being recorded",
        );
      }
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
      if (command.type === "REQUEST_PROJECT_SCAFFOLD") {
        const existingRow = selectProjectByRepositoryPath.get(command.payload.proposal.targetPath);
        const decision = decideProjectScaffoldRequested(command, {
          now: occurredAt,
          newOperationId: createId("projectScaffold"),
          newProjectId: createId("project"),
          ...(existingRow === undefined ? {} : { existingProject: projectFromRow(existingRow) }),
        });
        database
          .prepare(
            `INSERT INTO projects (
              id, workspace_id, fixture_id, name, repository_path, provider_preference,
              status, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            decision.project.id,
            decision.project.workspaceId,
            decision.project.fixtureId,
            decision.project.name,
            decision.project.repositoryPath,
            decision.project.providerPreference,
            decision.project.status,
            decision.project.version,
            decision.project.createdAt,
            decision.project.updatedAt,
          );
        insertScaffold(decision.operation);
        const event = appendScaffoldEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_SCAFFOLD_REQUESTED",
          replayed: false,
          operation: decision.operation,
          event,
        });
      }

      if (command.type === "COMPLETE_PROJECT_SCAFFOLD") {
        const currentOperation = readScaffoldOperation(command.payload.operationId);
        const currentProject = currentOperation === null ? null : readProject(currentOperation.projectId);
        const decision = decideProjectScaffoldCompleted(command, {
          now: occurredAt,
          ...(currentOperation === null ? {} : { operation: currentOperation }),
          ...(currentProject === null ? {} : { project: currentProject }),
        });
        updateScaffold(decision.operation, command.payload.expectedVersion);
        const projectUpdate = database
          .prepare(
            `UPDATE projects SET status = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ? AND status = 'PROVISIONING'`,
          )
          .run(
            decision.project.status,
            decision.project.version,
            decision.project.updatedAt,
            decision.project.id,
            decision.project.version - 1,
          );
        if (projectUpdate.changes !== 1) {
          throw new ScaffoldDomainError(
            "PROJECT_STATUS_INVALID",
            "The provisioning Project changed while the scaffold completed",
          );
        }
        const event = appendScaffoldEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_SCAFFOLD_COMPLETED",
          replayed: false,
          operation: decision.operation,
          event,
        });
      }

      if (command.type === "FAIL_PROJECT_SCAFFOLD") {
        const currentOperation = readScaffoldOperation(command.payload.operationId);
        const currentProject = currentOperation === null ? null : readProject(currentOperation.projectId);
        const decision = decideProjectScaffoldFailed(command, {
          now: occurredAt,
          ...(currentOperation === null ? {} : { operation: currentOperation }),
          ...(currentProject === null ? {} : { project: currentProject }),
        });
        updateScaffold(decision.operation, command.payload.expectedVersion);
        const event = appendScaffoldEvent(decision.event, {
          projectId: decision.operation.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_SCAFFOLD_FAILED",
          replayed: false,
          operation: decision.operation,
          event,
        });
      }

      if (command.type === "RETRY_PROJECT_SCAFFOLD") {
        const currentOperation = readScaffoldOperation(command.payload.operationId);
        const currentProject = currentOperation === null ? null : readProject(currentOperation.projectId);
        const decision = decideProjectScaffoldRetry(command, {
          now: occurredAt,
          ...(currentOperation === null ? {} : { operation: currentOperation }),
          ...(currentProject === null ? {} : { project: currentProject }),
        });
        updateScaffold(decision.operation, command.payload.expectedVersion);
        const event = appendScaffoldEvent(decision.event, {
          projectId: decision.operation.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_SCAFFOLD_RETRIED",
          replayed: false,
          operation: decision.operation,
          event,
        });
      }

      if (command.type === "REGISTER_PROJECT") {
        // `fixture_id = ?` with a null `fixtureId` is never true -- SQL's three-valued logic -- so a
        // Project registered by path is deduplicated on its id and its repository path alone, which
        // is the whole of what makes it a duplicate. Two path-registered Projects both carrying a
        // null fixture are not duplicates of each other, and the UNIQUE index agrees: in SQLite
        // every NULL is distinct.
        const existing = database
          .prepare(
            `SELECT id FROM projects
             WHERE id = ? OR fixture_id = ? OR repository_path = ? LIMIT 1`,
          )
          .get(command.payload.id, command.payload.fixtureId, command.payload.repositoryPath);
        if (existing !== undefined) {
          throw new StateStoreError(
            "PROJECT_ALREADY_REGISTERED",
            "A Project is already registered with this id, fixture or repository path",
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

      if (command.type === "REPOINT_FIXTURE_PROJECT") {
        // Four preconditions, each of which is the whole of what makes this write safe. They are
        // checked here rather than in the caller because they have to hold at the moment of the
        // write, inside the same transaction, not at the moment the caller looked.
        const project = readProject(command.payload.projectId);
        if (!project) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist");
        }
        // 1. It is the fixture-backed Project this command names. A Project the owner registered by
        //    path carries a null `fixtureId` and can never satisfy this, which is the guarantee that
        //    this command cannot move a repository the owner chose.
        if (project.fixtureId !== command.payload.fixtureId) {
          throw new StateStoreError(
            "PROJECT_REPOINT_REFUSED",
            "The Project is not backed by the bundled fixture this command names",
          );
        }
        // 2. It still records exactly the path the caller found. Anything else -- a concurrent
        //    registration that already moved it, a path the owner edited -- is left alone.
        if (project.repositoryPath !== command.payload.expectedRepositoryPath) {
          throw new StateStoreError(
            "PROJECT_REPOINT_REFUSED",
            "The Project no longer records the repository path this command expected",
          );
        }
        // 3. Nothing has ever been cut from it. Provisioning refuses a path that is not its own
        //    repository's top level (apps/daemon/src/session-loop.ts), and the bundled template is
        //    a directory inside Loomrail's checkout, so in practice there is nothing to find --
        //    unless an owner ran `git init` in the template themselves, which is the one way a
        //    workspace could exist under a stale path. This check makes the write safe without
        //    depending on that reasoning: a workspace names a branch and a worktree cut from one
        //    specific repository, and moving the Project out from under it would leave every future
        //    stage branching a different repository than the one already holding the work.
        const workspace = database
          .prepare("SELECT 1 AS present FROM work_item_workspaces WHERE project_id = ? LIMIT 1")
          .get(project.id);
        if (workspace !== undefined) {
          throw new StateStoreError(
            "PROJECT_REPOINT_REFUSED",
            "The Project already has a workspace cut from its current repository path",
          );
        }
        // 4. The destination is free. `projects.repository_path` is UNIQUE, so this would otherwise
        //    surface as a raw constraint failure rather than the answer the owner needs.
        const occupant = database
          .prepare("SELECT id FROM projects WHERE repository_path = ? AND id <> ? LIMIT 1")
          .get(command.payload.repositoryPath, project.id);
        if (occupant !== undefined) {
          throw new StateStoreError(
            "PROJECT_ALREADY_REGISTERED",
            "A Project is already registered at this repository path",
          );
        }

        const repointed = projectSchema.parse({
          ...project,
          repositoryPath: command.payload.repositoryPath,
          version: project.version + 1,
          updatedAt: occurredAt,
        });
        const update = database
          .prepare(
            `UPDATE projects SET repository_path = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            repointed.repositoryPath,
            repointed.version,
            repointed.updatedAt,
            repointed.id,
            project.version,
          );
        if (update.changes !== 1) {
          throw new StateStoreError(
            "PROJECT_REPOINT_REFUSED",
            "The Project changed while the repoint was being applied",
          );
        }
        const event = appendProjectEvent(repointed, command, occurredAt);
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_REGISTERED",
          replayed: false,
          project: repointed,
          event,
        });
      }

      if (command.type === "SET_PROJECT_PROVIDER_PREFERENCE") {
        const current = readProject(command.payload.projectId);
        const decision = decideProjectProviderPreference(command, {
          now: occurredAt,
          ...(current === null ? {} : { project: current }),
        });
        const update = database
          .prepare(
            `UPDATE projects SET provider_preference = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            decision.project.providerPreference,
            decision.project.version,
            decision.project.updatedAt,
            decision.project.id,
            decision.project.version - 1,
          );
        if (update.changes !== 1) {
          throw new ProviderSelectionDomainError(
            "PROJECT_VERSION_CONFLICT",
            "The Project changed while provider settings were applied",
          );
        }
        const selection = projectProviderSelectionSchema.parse(decision.selection);
        const event = appendProviderSelectionEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_PROVIDER_PREFERENCE_CHANGED",
          replayed: false,
          selection,
          event,
        });
      }

      if (command.type === "CONFIRM_MCP_PROFILE") {
        const current = readProject(command.payload.projectId);
        const latestRevision =
          command.payload.candidate.profileId === null
            ? null
            : readLatestMcpProfileRevision(command.payload.candidate.profileId);
        const canonicalDigest = createHash("sha256")
          .update(canonicalMcpProfileSource(command.payload.candidate))
          .digest("hex");
        const decision = decideMcpProfileConfirmation(command, {
          now: occurredAt,
          canonicalDigest,
          newProfileId: createId("mcpProfile"),
          newRevisionId: createId("mcpProfileRevision"),
          newConsentId: createId("mcpConsent"),
          ...(current === null ? {} : { project: current }),
          ...(latestRevision === null ? {} : { latestRevision }),
        });
        persistMcpProjectVersion(decision.project, current?.version ?? 0);
        persistMcpProfileConsent(decision.revision, decision.consent);
        const event = appendMcpEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MCP_PROFILE_CONSENTED",
          replayed: false,
          revision: decision.revision,
          consent: decision.consent,
          projectVersion: decision.project.version,
          event,
        });
      }

      if (command.type === "RECORD_MCP_CAPABILITY_SNAPSHOT") {
        const current = readProject(command.payload.projectId);
        const revision = readMcpProfileRevision(command.payload.profileRevisionId);
        const consent = readMcpConsent(command.payload.profileRevisionId);
        const snapshot = decideMcpCapabilitySnapshot(command, {
          now: occurredAt,
          newSnapshotId: createId("mcpCapabilitySnapshot"),
          ...(current === null ? {} : { project: current }),
          ...(revision === null ? {} : { revision }),
          ...(consent === null ? {} : { consent }),
        });
        persistMcpCapabilitySnapshot(snapshot);
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MCP_CAPABILITY_RECORDED",
          replayed: false,
          snapshot,
        });
      }

      if (command.type === "SET_MCP_PROFILE_GRANT") {
        const current = readProject(command.payload.projectId);
        const revision = readMcpProfileRevision(command.payload.profileRevisionId);
        const consent = readMcpConsent(command.payload.profileRevisionId);
        const capability = readLatestMcpCapability(command.payload.profileRevisionId);
        const currentGrant = readMcpGrant(command.payload.profileRevisionId);
        const decision = decideMcpProfileGrant(command, {
          now: occurredAt,
          newGrantId: createId("mcpGrant"),
          ...(current === null ? {} : { project: current }),
          ...(revision === null ? {} : { revision }),
          ...(consent === null ? {} : { consent }),
          ...(capability === null ? {} : { capability }),
          ...(currentGrant === null ? {} : { currentGrant }),
        });
        persistMcpProjectVersion(decision.project, current?.version ?? 0);
        persistMcpGrant(decision.grant, currentGrant?.version ?? null);
        const event = appendMcpEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MCP_GRANT_CHANGED",
          replayed: false,
          grant: decision.grant,
          projectVersion: decision.project.version,
          event,
        });
      }

      if (command.type === "REVOKE_MCP_PROFILE_GRANT") {
        const current = readProject(command.payload.projectId);
        const revision = readMcpProfileRevision(command.payload.profileRevisionId);
        const consent = readMcpConsent(command.payload.profileRevisionId);
        const currentGrant = readMcpGrant(command.payload.profileRevisionId);
        const decision = decideMcpProfileGrantRevocation(command, {
          now: occurredAt,
          ...(current === null ? {} : { project: current }),
          ...(revision === null ? {} : { revision }),
          ...(consent === null ? {} : { consent }),
          ...(currentGrant === null ? {} : { currentGrant }),
        });
        persistMcpProjectVersion(decision.project, current?.version ?? 0);
        persistMcpGrant(decision.grant, currentGrant?.version ?? null);
        const event = appendMcpEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MCP_GRANT_CHANGED",
          replayed: false,
          grant: decision.grant,
          projectVersion: decision.project.version,
          event,
        });
      }

      if (command.type === "START_MCP_TOOL_CALL") {
        if (command.actor.type !== "SYSTEM") {
          throw new McpDomainError("SYSTEM_REQUIRED", "Only the MCP gateway can start a tool call");
        }
        const snapshot = readMcpSessionSnapshot(command.payload.sessionSnapshotId);
        if (!snapshot) {
          throw new McpDomainError("SESSION_SNAPSHOT_MISMATCH", "The MCP session snapshot does not exist");
        }
        const sessionValue = selectProviderSessionById.get(snapshot.providerSessionId);
        const session = sessionValue === undefined ? null : providerSessionFromRow(sessionValue);
        const currentGrant = readMcpGrant(snapshot.profileRevisionId);
        const call = decideMcpToolCallStart({
          now: occurredAt,
          newCallId: createId("mcpToolCall"),
          inputDigest: command.payload.inputDigest,
          toolName: command.payload.toolName,
          snapshot,
          sessionRunning: session?.status === "RUNNING",
          ...(currentGrant === null ? {} : { currentGrant }),
        });
        persistMcpToolCall(call);
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MCP_TOOL_CALL_CHANGED",
          replayed: false,
          call,
        });
      }

      if (command.type === "FINISH_MCP_TOOL_CALL") {
        if (command.actor.type !== "SYSTEM") {
          throw new McpDomainError("SYSTEM_REQUIRED", "Only the MCP gateway can finish a tool call");
        }
        const current = readMcpToolCall(command.payload.callId);
        if (!current) {
          throw new McpDomainError("TOOL_CALL_NOT_STARTED", "The MCP tool call does not exist");
        }
        const call = decideMcpToolCallFinished(current, command.payload.outcome, occurredAt);
        persistFinishedMcpToolCall(call);
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "MCP_TOOL_CALL_CHANGED",
          replayed: false,
          call,
        });
      }

      if (command.type === "PROPOSE_PROJECT_CONSTITUTION") {
        const project = readProject(command.payload.projectId);
        const decision = decideProjectConstitutionProposal(command, {
          now: occurredAt,
          newProposalId: createId("constitutionProposal"),
          ...(project === null ? {} : { project }),
        });
        insertProposal(decision.proposal);
        const event = appendConstitutionEvent(decision.event, {
          projectId: decision.proposal.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_CONSTITUTION_PROPOSED",
          replayed: false,
          proposal: decision.proposal,
          event,
        });
      }

      if (command.type === "REQUEST_PROJECT_CONSTITUTION_ADOPTION") {
        const ordinalRow = maxOrdinalRowSchema.parse(
          selectMaxProjectConstitutionOrdinal.get(command.payload.projectId),
        );
        const currentProposal = readConstitutionProposal(command.payload.proposalId);
        const project = readProject(command.payload.projectId);
        const pendingConstitution = readPendingProjectConstitution(command.payload.projectId);
        const decision = decideProjectConstitutionAdoption(command, {
          now: occurredAt,
          newConstitutionId: createId("projectConstitutionVersion"),
          newPublicationId: createId("constitutionPublication"),
          nextOrdinal: ordinalRow.max_ordinal + 1,
          ...(project === null ? {} : { project }),
          ...(currentProposal === null ? {} : { proposal: currentProposal }),
          ...(pendingConstitution === null ? {} : { pendingConstitution }),
        });
        updateProposal(decision.proposal, currentProposal?.version ?? 0);
        insertConstitutionVersion(decision.constitution);
        insertPublication(decision.publication);
        const event = appendConstitutionEvent(decision.event, {
          projectId: decision.proposal.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED",
          replayed: false,
          proposal: decision.proposal,
          constitution: decision.constitution,
          publication: decision.publication,
          event,
        });
      }

      if (command.type === "COMPLETE_PROJECT_CONSTITUTION_PUBLICATION") {
        const currentPublication = readConstitutionPublication(command.payload.publicationId);
        const currentConstitution = currentPublication
          ? readProjectConstitutionVersion(currentPublication.constitutionVersionId)
          : null;
        const currentProposal = currentConstitution
          ? readConstitutionProposal(currentConstitution.proposalId)
          : null;
        const activeConstitution = currentPublication
          ? readActiveProjectConstitution(currentPublication.projectId)
          : null;
        const decision = decideProjectConstitutionPublicationCompleted(command, {
          now: occurredAt,
          ...(currentPublication === null ? {} : { publication: currentPublication }),
          ...(currentConstitution === null ? {} : { constitution: currentConstitution }),
          ...(currentProposal === null ? {} : { proposal: currentProposal }),
          ...(activeConstitution === null ? {} : { activeConstitution }),
        });
        if (decision.supersededConstitution) {
          updateConstitutionVersion(
            decision.supersededConstitution,
            decision.supersededConstitution.version - 1,
          );
        }
        updateProposal(decision.proposal, currentProposal?.version ?? 0);
        updateConstitutionVersion(decision.constitution, currentConstitution?.version ?? 0);
        updatePublication(decision.publication, currentPublication?.version ?? 0);
        const event = appendConstitutionEvent(decision.event, {
          projectId: decision.publication.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_CONSTITUTION_ACTIVATED",
          replayed: false,
          proposal: decision.proposal,
          constitution: decision.constitution,
          publication: decision.publication,
          event,
        });
      }

      if (command.type === "FAIL_PROJECT_CONSTITUTION_PUBLICATION") {
        const currentPublication = readConstitutionPublication(command.payload.publicationId);
        const currentConstitution = currentPublication
          ? readProjectConstitutionVersion(currentPublication.constitutionVersionId)
          : null;
        const decision = decideProjectConstitutionPublicationFailed(command, {
          now: occurredAt,
          ...(currentPublication === null ? {} : { publication: currentPublication }),
          ...(currentConstitution === null ? {} : { constitution: currentConstitution }),
        });
        updateConstitutionVersion(decision.constitution, currentConstitution?.version ?? 0);
        updatePublication(decision.publication, currentPublication?.version ?? 0);
        const event = appendConstitutionEvent(decision.event, {
          projectId: decision.publication.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_CONSTITUTION_PUBLICATION_FAILED",
          replayed: false,
          constitution: decision.constitution,
          publication: decision.publication,
          event,
        });
      }

      if (command.type === "RETRY_PROJECT_CONSTITUTION_PUBLICATION") {
        const latestOrdinal = maxOrdinalRowSchema.parse(
          selectMaxProjectConstitutionOrdinal.get(command.payload.projectId),
        ).max_ordinal;
        const currentPublication = readConstitutionPublication(command.payload.publicationId);
        const currentConstitution = currentPublication
          ? readProjectConstitutionVersion(currentPublication.constitutionVersionId)
          : null;
        const proposal = currentConstitution
          ? readConstitutionProposal(currentConstitution.proposalId)
          : null;
        const decision = decideProjectConstitutionPublicationRetry(command, {
          now: occurredAt,
          latestConstitutionOrdinal: latestOrdinal,
          ...(currentPublication === null ? {} : { publication: currentPublication }),
          ...(currentConstitution === null ? {} : { constitution: currentConstitution }),
          ...(proposal === null ? {} : { proposal }),
        });
        updateConstitutionVersion(decision.constitution, currentConstitution?.version ?? 0);
        updatePublication(decision.publication, currentPublication?.version ?? 0);
        const event = appendConstitutionEvent(decision.event, {
          projectId: decision.publication.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_CONSTITUTION_PUBLICATION_RETRIED",
          replayed: false,
          constitution: decision.constitution,
          publication: decision.publication,
          event,
        });
      }

      if (command.type === "RECORD_PROJECT_READINESS_ASSESSMENT") {
        const project = readProject(command.payload.projectId);
        const findingCount = command.payload.checks.reduce(
          (count, readinessCheck) => count + readinessCheck.findings.length,
          0,
        );
        const decision = decideProjectReadinessAssessment(command, {
          now: occurredAt,
          newRunId: createId("projectReadinessRun"),
          newCheckIds: Array.from({ length: 8 }, () => createId("readinessCheck")),
          newFindingIds: Array.from({ length: findingCount }, () => createId("securityFinding")),
          ...(project === null ? {} : { project }),
        });
        insertReadinessRun(decision.run);
        insertReadinessChecks(decision.checks);
        insertReadinessFindings(decision.findings);
        appendReadinessEvent(decision.event, {
          projectId: decision.run.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_READINESS_ASSESSED",
          replayed: false,
          run: decision.run,
          checks: decision.checks,
          findings: decision.findings,
        });
      }

      if (command.type === "ATTEST_PROJECT_READINESS_CHECK") {
        const currentRun = readProjectReadinessRun(command.payload.runId);
        const latestRun = readLatestProjectReadinessRun(command.payload.projectId);
        const currentCheck = readReadinessCheck(command.payload.checkId);
        const checks = currentRun === null ? [] : readReadinessChecks(currentRun.id);
        const decision = decideProjectReadinessAttestation(command, {
          now: occurredAt,
          newAttestationId: createId("readinessAttestation"),
          ...(currentRun === null ? {} : { run: currentRun }),
          ...(latestRun === null ? {} : { latestRunId: latestRun.id }),
          ...(currentCheck === null ? {} : { check: currentCheck }),
          checks,
        });
        updateReadinessProjection(
          decision.run,
          currentRun?.version ?? 0,
          decision.check,
          currentCheck?.version ?? 0,
        );
        persistReadinessAttestation(decision.attestation);
        appendReadinessEvent(decision.event, {
          projectId: decision.run.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROJECT_READINESS_ATTESTED",
          replayed: false,
          run: decision.run,
          check: decision.check,
          attestation: decision.attestation,
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
        const assignment = createStandardSquadAssignment({
          id: createId("squadAssignment"),
          projectId: decision.workItem.projectId,
          workItemId: decision.workItem.id,
          pipelineRunId: decision.run.id,
          revision: 1,
          now: occurredAt,
        });
        insertSquadAssignment.run(
          assignment.id,
          assignment.schemaVersion,
          assignment.projectId,
          assignment.workItemId,
          assignment.pipelineRunId,
          assignment.revision,
          JSON.stringify(assignment.stages),
          assignment.createdAt,
        );
        const eventMetadata = {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const events = appendWorkflowEvents(decision.events, eventMetadata);
        appendAgentEvent({ type: "SQUAD_ASSIGNED", data: { assignment } }, eventMetadata);
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

      if (command.type === "START_AGENT_RUN") {
        if (command.actor.type !== "SYSTEM" || command.actor.id !== "local-daemon") {
          throw new StateStoreError(
            "AGENT_RUN_ACTOR_FORBIDDEN",
            "Only the local daemon may reserve an AgentRun",
          );
        }
        const dispatch = readWorkflowDispatch(command.payload.dispatchId);
        if (!dispatch) {
          throw new WorkflowDomainError(
            "WORKFLOW_DISPATCH_NOT_FOUND",
            "The workflow dispatch does not exist",
          );
        }
        const workflowRun = readPipelineRun(dispatch.pipelineRunId);
        const stageAttempt = readStageAttempt(dispatch.stageAttemptId);
        const workItem = readWorkItem(dispatch.workItemId);
        if (!workflowRun || !stageAttempt || !workItem) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The workflow state is incomplete");
        }
        if (selectRunningAgentRunForStageAttempt.get(stageAttempt.id) !== undefined) {
          throw new StateStoreError(
            "AGENT_RUN_ALREADY_ACTIVE",
            "The StageAttempt already has a running AgentRun",
            { scope: "STAGE_ATTEMPT" },
          );
        }
        if (selectRunningAgentRunForWorkItem.get(workItem.id) !== undefined) {
          throw new StateStoreError(
            "AGENT_RUN_ALREADY_ACTIVE",
            "The WorkItem already has a running AgentRun",
            { scope: "WORK_ITEM" },
          );
        }

        const capacityChecks = [
          {
            scope: "GLOBAL",
            active: countRowSchema.parse(countRunningAgentRuns.get()).count,
            limit: command.payload.limits.global,
          },
          {
            scope: "PROJECT",
            active: countRowSchema.parse(countRunningAgentRunsForProject.get(workItem.projectId)).count,
            limit: command.payload.limits.project,
          },
          {
            scope: "PROVIDER",
            active: countRowSchema.parse(countRunningAgentRunsForProvider.get(command.payload.provider))
              .count,
            limit: command.payload.limits.provider,
          },
        ] as const;
        const exhausted = capacityChecks.find(({ active, limit }) => active >= limit);
        if (exhausted) {
          throw new StateStoreError(
            "AGENT_RUN_CAPACITY_EXHAUSTED",
            `${exhausted.scope} AgentRun capacity is exhausted`,
            { scope: exhausted.scope, active: exhausted.active, limit: exhausted.limit },
          );
        }

        const decision = decideMarkWorkflowDispatchStarted(
          {
            schemaVersion: 1,
            commandId: command.commandId,
            correlationId: command.correlationId,
            actor: command.actor,
            type: "MARK_WORKFLOW_DISPATCH_STARTED",
            payload: { dispatchId: dispatch.id },
          },
          { now: occurredAt, workItem, run: workflowRun, stageAttempt, dispatch },
        );

        const storedAssignment = selectLatestSquadAssignment.get(workflowRun.id);
        const assignment =
          storedAssignment === undefined
            ? createStandardSquadAssignment({
                id: createId("squadAssignment"),
                projectId: workItem.projectId,
                workItemId: workItem.id,
                pipelineRunId: workflowRun.id,
                revision: 1,
                now: occurredAt,
              })
            : squadAssignmentFromRow(storedAssignment);
        const assignmentWasCreated = storedAssignment === undefined;
        if (assignmentWasCreated) {
          insertSquadAssignment.run(
            assignment.id,
            assignment.schemaVersion,
            assignment.projectId,
            assignment.workItemId,
            assignment.pipelineRunId,
            assignment.revision,
            JSON.stringify(assignment.stages),
            assignment.createdAt,
          );
        }

        const agentRunOrdinal = maxOrdinalRowSchema.parse(
          selectMaxAgentRunOrdinal.get(stageAttempt.id),
        ).max_ordinal;
        const stageProfile = assignment.stages.find(({ stage }) => stage === stageAttempt.stage)?.profile;
        const profile = stageProfile
          ? builtinAgentProfiles.find(
              (candidate) => candidate.id === stageProfile.id && candidate.revision === stageProfile.revision,
            )
          : undefined;
        if (!profile) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The assigned AgentProfile revision is unavailable",
          );
        }
        const existingWorkspace = readWorkItemWorkspaceByWorkItemId(workItem.id);
        const policySnapshotHash = `sha256:${createHash("sha256")
          .update(
            canonicalJson({
              schemaVersion: 1,
              assignment: {
                id: assignment.id,
                revision: assignment.revision,
                profile: stageProfile,
              },
              provider: command.payload.provider,
              limits: command.payload.limits,
              profilePolicy: {
                allowedCapabilities: profile.allowedCapabilities,
                defaultModelTier: profile.defaultModelTier,
                budgetEnvelope: profile.budgetEnvelope,
              },
              workspace:
                existingWorkspace === null
                  ? null
                  : {
                      id: existingWorkspace.id,
                      baseCommit: existingWorkspace.baseCommit,
                      snapshotCommit: existingWorkspace.snapshotCommit,
                    },
            }),
          )
          .digest("hex")}`;
        const agentRun = createAgentRun({
          id: createId("agentRun"),
          projectId: workItem.projectId,
          workItemId: workItem.id,
          pipelineRunId: workflowRun.id,
          stageAttemptId: stageAttempt.id,
          ordinal: agentRunOrdinal + 1,
          stage: stageAttempt.stage,
          assignment,
          provider: command.payload.provider,
          policySnapshotHash,
          now: occurredAt,
        });
        insertAgentRun.run(
          agentRun.id,
          agentRun.schemaVersion,
          agentRun.projectId,
          agentRun.workItemId,
          agentRun.pipelineRunId,
          agentRun.stageAttemptId,
          agentRun.ordinal,
          agentRun.squadAssignmentId,
          agentRun.profile.id,
          agentRun.profile.revision,
          agentRun.profile.role,
          agentRun.provider,
          agentRun.status,
          agentRun.policySnapshotHash,
          agentRun.startedAt,
          agentRun.finishedAt,
          agentRun.version,
        );

        if (existingWorkspace) {
          if (existingWorkspace.status !== "READY") {
            throw new StateStoreError(
              "WORKSPACE_NOT_READY",
              "The WorkItem workspace is not ready for an AgentRun",
            );
          }
          const lease = acquireWorkItemWorkspaceLease.run(
            stageAttempt.id,
            existingWorkspace.id,
            existingWorkspace.version,
          );
          if (lease.changes !== 1) {
            throw new StateStoreError("WORKSPACE_LEASE_HELD", "The WorkItem workspace lease is already held");
          }
        }

        updateStageAttempt(decision.stageAttempt);
        const metadata = {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const events: DomainEvent[] = [];
        if (assignmentWasCreated) {
          events.push(appendAgentEvent({ type: "SQUAD_ASSIGNED", data: { assignment } }, metadata));
        }
        events.push(...appendWorkflowEvents(decision.events, metadata));
        events.push(appendAgentEvent({ type: "AGENT_RUN_STARTED", data: { run: agentRun } }, metadata));

        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "AGENT_RUN_STARTED",
          replayed: false,
          workItemId: workItem.id,
          assignment,
          run: agentRun,
          events,
        });
      }

      if (command.type === "RECORD_QA_ATTACHMENT_RETENTION") {
        if (command.actor.type !== "SYSTEM" || command.actor.id !== "local-daemon") {
          throw new StateStoreError(
            "QA_RETENTION_ACTOR_FORBIDDEN",
            "Only the local daemon can record Browser QA retention cleanup",
          );
        }
        if (selectQAAttachmentRefById.get(command.payload.attachmentId) === undefined) {
          throw new StateStoreError("QA_ATTACHMENT_NOT_FOUND", "The Browser QA attachment does not exist");
        }
        const existing = selectQAAttachmentRetentionById.get(command.payload.attachmentId);
        const retention =
          existing === undefined
            ? {
                attachment_id: command.payload.attachmentId,
                outcome: command.payload.outcome,
                recorded_at: occurredAt,
              }
            : qaAttachmentRetentionRowSchema.parse(existing);
        if (existing === undefined) {
          insertQAAttachmentRetention.run(retention.attachment_id, retention.outcome, retention.recorded_at);
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "QA_ATTACHMENT_RETENTION_RECORDED",
          replayed: false,
          attachmentId: retention.attachment_id,
          outcome: retention.outcome,
          recordedAt: retention.recorded_at,
        });
      }

      if (command.type === "RESERVE_QA_RUN") {
        const stageAttempt = readStageAttempt(command.payload.stageAttemptId);
        const agentRunValue = selectAgentRunById.get(command.payload.agentRunId);
        if (!stageAttempt || agentRunValue === undefined) {
          throw new StateStoreError(
            "QA_STABLE_TREE_MISSING",
            "The QA StageAttempt or Browser QA AgentRun does not exist",
          );
        }
        if (selectQARunByAgentRun.get(command.payload.agentRunId) !== undefined) {
          throw new StateStoreError(
            "QA_RUN_ALREADY_EXISTS",
            "The Browser QA AgentRun already owns a durable QA run",
          );
        }
        const treeValue = selectLatestSucceededImplementTree.get(stageAttempt.pipelineRunId);
        if (treeValue === undefined) {
          throw new StateStoreError(
            "QA_STABLE_TREE_MISSING",
            "The pipeline has no successful implementation tree to test",
          );
        }
        const currentTree = resultTreeRowSchema.parse(treeValue).result_tree;
        const qaRun = decideQAReservation(command, {
          newQARunId: createId("qaRun"),
          now: occurredAt,
          currentTree,
          stageAttempt,
          agentRun: agentRunFromRow(agentRunValue),
        });
        insertQARun.run(
          qaRun.id,
          qaRun.schemaVersion,
          qaRun.projectId,
          qaRun.workItemId,
          qaRun.pipelineRunId,
          qaRun.stageAttemptId,
          qaRun.agentRunId,
          qaRun.driverId,
          qaRun.testedTree,
          qaRun.targetOrigin,
          JSON.stringify(qaRun.plan),
          qaRun.scope.type === "RETEST" ? qaRun.scope.correctionRunId : null,
          qaRun.scope.type === "RETEST" ? qaRun.scope.retestPlanId : null,
          qaRun.status,
          null,
          null,
          qaRun.startedAt,
          null,
          qaRun.version,
        );
        const event = appendAgentEvent(
          { type: "QA_RUN_RESERVED", data: { qaRun } },
          {
            workItemId: qaRun.workItemId,
            projectId: qaRun.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "QA_RUN_RESERVED",
          replayed: false,
          workItemId: qaRun.workItemId,
          qaRun,
          event,
        });
      }

      if (command.type === "COMPLETE_QA_RUN") {
        if (command.actor.type !== "SYSTEM" || command.actor.id !== "local-daemon") {
          throw new QAReservationError(
            "QA_RUN_ACTOR_FORBIDDEN",
            "Only the local daemon can complete a deterministic browser QA run",
          );
        }
        const qaRunValue = selectQARunById.get(command.payload.qaRunId);
        if (qaRunValue === undefined) {
          throw new StateStoreError("QA_RUN_NOT_FOUND", "The QA run does not exist");
        }
        const current = qaRunFromRow(qaRunValue);
        const agentRunValue = selectAgentRunById.get(current.agentRunId);
        if (agentRunValue === undefined) {
          throw new StateStoreError("QA_STABLE_TREE_MISSING", "The Browser QA AgentRun does not exist");
        }
        const activeAgentRun = agentRunFromRow(agentRunValue);
        const treeValue = selectLatestSucceededImplementTree.get(current.pipelineRunId);
        if (treeValue === undefined) {
          throw new StateStoreError(
            "QA_STABLE_TREE_MISSING",
            "The pipeline no longer has a successful implementation tree",
          );
        }
        const currentTree = resultTreeRowSchema.parse(treeValue).result_tree;
        if (command.payload.currentTree !== currentTree) {
          throw new QACompletionError("STALE_QA_TREE", "The measured current tree is no longer stable", {
            testedTree: command.payload.currentTree,
            currentTree,
          });
        }
        const decision = decideQACompletion({
          qaRun: current,
          agentRun: activeAgentRun,
          expectedVersion: command.payload.expectedVersion,
          currentTree,
          result: command.payload.result,
          finalizedAttachments: command.payload.finalizedAttachments,
          now: occurredAt,
        });
        const update = completeQARun.run(
          decision.qaRun.status,
          decision.qaRun.error?.code ?? null,
          decision.qaRun.error?.summary ?? null,
          decision.qaRun.completedAt,
          decision.qaRun.version,
          decision.qaRun.id,
          current.version,
        );
        if (update.changes !== 1) {
          throw new QACompletionError(
            "QA_RUN_VERSION_CONFLICT",
            "The QA run changed while completion was being recorded",
            { expectedVersion: current.version },
          );
        }
        const attachments = decision.evidence?.attachments ?? [];
        for (const attachment of attachments) {
          insertQAAttachmentRef.run(
            attachment.id,
            attachment.schemaVersion,
            attachment.qaRunId,
            attachment.kind,
            attachment.contentHash,
            attachment.byteSize,
            attachment.targetId,
            attachment.scenarioId,
            attachment.capturedAt,
            attachment.retentionClass,
            attachment.storageKey,
          );
        }
        const defects: QADefect[] =
          decision.evidence?.defects.map((draft, index) =>
            qaDefectSchema.parse({
              ...draft,
              schemaVersion: 1,
              id: createId("qaDefect"),
              qaRunId: decision.qaRun.id,
              projectId: decision.qaRun.projectId,
              workItemId: decision.qaRun.workItemId,
              testedTree: decision.qaRun.testedTree,
              ordinal: index + 1,
              status: "OPEN",
              resolutionReason: null,
              createdAt: occurredAt,
              resolvedAt: null,
              version: 1,
            }),
          ) ?? [];
        for (const defect of defects) {
          insertQADefect.run(
            defect.id,
            defect.schemaVersion,
            defect.qaRunId,
            defect.projectId,
            defect.workItemId,
            defect.testedTree,
            defect.ordinal,
            defect.severity,
            defect.status,
            defect.title,
            defect.description,
            JSON.stringify(defect.reproduction),
            defect.targetId,
            defect.scenarioId,
            null,
            defect.createdAt,
            null,
            defect.version,
          );
        }
        const evidence =
          decision.evidence === null
            ? null
            : qaEvidenceBundleSchema.parse({
                schemaVersion: 1,
                id: createId("qaEvidenceBundle"),
                qaRunId: decision.qaRun.id,
                projectId: decision.qaRun.projectId,
                workItemId: decision.qaRun.workItemId,
                pipelineRunId: decision.qaRun.pipelineRunId,
                stageAttemptId: decision.qaRun.stageAttemptId,
                testedTree: decision.qaRun.testedTree,
                verdict: decision.evidence.verdict,
                environment: decision.evidence.environment,
                executions: decision.evidence.executions,
                observations: decision.evidence.observations,
                attachmentIds: attachments.map(({ id }) => id),
                defectIds: defects.map(({ id }) => id),
                createdAt: occurredAt,
              });
        if (evidence) {
          insertQAEvidenceBundle.run(
            evidence.id,
            evidence.schemaVersion,
            evidence.qaRunId,
            evidence.projectId,
            evidence.workItemId,
            evidence.pipelineRunId,
            evidence.stageAttemptId,
            evidence.testedTree,
            evidence.verdict,
            JSON.stringify(evidence.environment),
            JSON.stringify(evidence.executions),
            JSON.stringify(evidence.observations),
            JSON.stringify(evidence.attachmentIds),
            JSON.stringify(evidence.defectIds),
            evidence.createdAt,
          );
        }
        const pipelineRun = readPipelineRun(decision.qaRun.pipelineRunId);
        const stageAttempt = readStageAttempt(decision.qaRun.stageAttemptId);
        const workItem = readWorkItem(decision.qaRun.workItemId);
        const dispatch = readPendingDispatch(decision.qaRun.stageAttemptId);
        if (!pipelineRun || !stageAttempt || !workItem || !dispatch) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The workflow state backing the Browser QA run is incomplete",
          );
        }
        const template = readWorkflowTemplate(pipelineRun);
        const workflowOutcome = qaWorkflowOutcome(decision);
        const measuredQA =
          decision.status === "PASSED" && evidence !== null
            ? { qaRun: decision.qaRun, evidence, currentTree }
            : undefined;
        const workflowDecision = decideApplyProviderOutcome(
          {
            schemaVersion: 1,
            commandId: command.commandId,
            correlationId: command.correlationId,
            actor: command.actor,
            type: "APPLY_PROVIDER_OUTCOME",
            payload: {
              dispatchId: dispatch.id,
              provider: activeAgentRun.provider,
              template,
              outcome: workflowOutcome,
              resultTree: decision.status === "PASSED" ? decision.qaRun.testedTree : null,
            },
          },
          {
            now: occurredAt,
            workItem,
            run: pipelineRun,
            stageAttempt,
            dispatch,
            budgetPolicy: readCurrentBudgetPolicy(pipelineRun.id),
            existingUsageRecords: readUsageRecords(pipelineRun.id),
            existingArtifacts: readEvidenceArtifacts(pipelineRun.id),
            usageRecordIds: [],
            artifactIds:
              workflowOutcome.type === "COMPLETED"
                ? (workflowOutcome.artifacts ?? []).map(() => createId("evidenceArtifact"))
                : [],
            measuredQA,
            qaRunRequired: true,
            qaRunCompletion: decision.qaRun,
            reviewRequired: false,
            humanRequestId: createId("humanRequest"),
            acceptancePackageId: createId("acceptancePackage"),
            nextStageAttemptId: createId("stageAttempt"),
            nextDispatchId: createId("workflowDispatch"),
          },
        );
        updateWorkflowDispatch(workflowDecision.dispatch);
        updateStageAttempt(workflowDecision.stageAttempt);
        updatePipelineRun(workflowDecision.run);
        if (workflowDecision.workItem.version !== workItem.version) {
          updateWorkflowWorkItem(workflowDecision.workItem);
        }
        if (workflowDecision.request) insertHumanRequest(workflowDecision.request);
        workflowDecision.artifacts.forEach(insertEvidenceArtifact);
        if (workflowDecision.nextStageAttempt) insertStageAttempt(workflowDecision.nextStageAttempt);
        if (workflowDecision.nextDispatch) insertWorkflowDispatch(workflowDecision.nextDispatch);
        const metadata = {
          workItemId: decision.qaRun.workItemId,
          projectId: decision.qaRun.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const event = appendAgentEvent(
          {
            type: "QA_RUN_COMPLETED",
            data: {
              qaRun: decision.qaRun,
              evidenceBundleId: evidence?.id ?? null,
              defectIds: defects.map(({ id }) => id),
            },
          },
          metadata,
        );
        const agentStatus = terminalAgentRunStatus(workflowDecision.stageAttempt.status);
        if (agentStatus) finishActiveAgentRun(workflowDecision.stageAttempt.id, agentStatus, metadata);
        appendWorkflowEvents(workflowDecision.events, metadata);
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "QA_RUN_COMPLETED",
          replayed: false,
          workItemId: decision.qaRun.workItemId,
          qaRun: decision.qaRun,
          evidence,
          attachments,
          defects,
          event,
        });
      }

      if (command.type === "DISPOSE_REVIEW_FINDING") {
        const findingValue = selectReviewFindingById.get(command.payload.findingId);
        const decision = decideReviewFindingDisposition(command, {
          finding: findingValue === undefined ? undefined : reviewFindingFromRow(findingValue),
          now: occurredAt,
        });
        updateReviewFinding(decision.finding);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.finding.workItemId,
          projectId: decision.finding.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "REVIEW_FINDING_DISPOSED",
          replayed: false,
          workItemId: decision.finding.workItemId,
          finding: decision.finding,
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
        const runningAgentRunValue = selectRunningAgentRunForStageAttempt.get(stageAttempt.id) ?? undefined;
        const runningReviewerValue = stageAttempt.stage === "REVIEW" ? runningAgentRunValue : undefined;
        const qaRunRequired =
          stageAttempt.stage === "QA" &&
          runningAgentRunValue !== undefined &&
          agentRunFromRow(runningAgentRunValue).profile.role === "BROWSER_QA";
        const reviewContext =
          stageAttempt.stage === "REVIEW" &&
          command.payload.outcome.type === "COMPLETED" &&
          command.payload.outcome.reviewReport !== undefined
            ? (() => {
                const authorValue = selectLatestSucceededDeveloperAgentRun.get(run.id);
                const treeValue = selectLatestSucceededImplementTree.get(run.id);
                if (
                  authorValue === undefined ||
                  runningReviewerValue === undefined ||
                  treeValue === undefined
                ) {
                  throw new WorkflowDomainError(
                    "REVIEW_RUN_MISMATCH",
                    "The review has no durable implementation author, reviewer, or stable tree",
                  );
                }
                return {
                  authorAgentRun: agentRunFromRow(authorValue),
                  reviewerAgentRun: agentRunFromRow(runningReviewerValue),
                  currentTree: resultTreeRowSchema.parse(treeValue).result_tree,
                  openFindings: selectOpenReviewFindings.all(run.id).map(reviewFindingFromRow),
                  reportId: createId("reviewReport"),
                  findingIds: command.payload.outcome.reviewReport.findings.map(() =>
                    createId("reviewFinding"),
                  ),
                  loopOptionIds: [createId("humanRequestOption"), createId("humanRequestOption")] as const,
                };
              })()
            : undefined;
        const existingArtifacts = readEvidenceArtifacts(run.id);
        const measuredQA =
          command.payload.outcome.type === "READY_FOR_ACCEPTANCE"
            ? (() => {
                const qaArtifact = existingArtifacts.find(({ kind }) => kind === "QA_REPORT");
                const treeValue = selectLatestSucceededImplementTree.get(run.id);
                return treeValue === undefined
                  ? undefined
                  : readMeasuredQAForArtifact(qaArtifact, resultTreeRowSchema.parse(treeValue).result_tree);
              })()
            : undefined;
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
            existingArtifacts,
            usageRecordIds:
              command.payload.outcome.type === "BUDGET_LIMIT_REACHED"
                ? command.payload.outcome.usageIncrements.map(() => createId("usageRecord"))
                : [],
            artifactIds:
              command.payload.outcome.type === "COMPLETED"
                ? (command.payload.outcome.artifacts ?? []).map(() => createId("evidenceArtifact"))
                : [],
            review: reviewContext,
            measuredQA,
            qaRunRequired,
            // Pre-R1 fixture workflows completed Review without AgentRun reservation. Keep those
            // historical migration paths readable, while every scheduled live reviewer is held to
            // the structured independent-review contract.
            reviewRequired: runningReviewerValue !== undefined,
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
        if (decision.reviewReport) insertReviewReport(decision.reviewReport);
        decision.reviewFindings?.forEach(insertReviewFinding);
        decision.resolvedReviewFindings?.forEach(updateReviewFinding);
        decision.artifacts.forEach(insertEvidenceArtifact);
        if (decision.acceptancePackage) insertAcceptancePackage(decision.acceptancePackage);
        if (decision.nextStageAttempt) insertStageAttempt(decision.nextStageAttempt);
        if (decision.nextDispatch) insertWorkflowDispatch(decision.nextDispatch);
        decision.usageRecords.forEach(insertUsageRecord);
        const metadata = {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const agentStatus = terminalAgentRunStatus(decision.stageAttempt.status);
        if (agentStatus) finishActiveAgentRun(decision.stageAttempt.id, agentStatus, metadata);
        const events = appendWorkflowEvents(decision.events, metadata);
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
          nextStageAttemptId: createId("stageAttempt"),
        });
        updateHumanRequest(decision.request);
        insertDecision(decision.decision);
        updateStageAttempt(decision.stageAttempt);
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        if (decision.nextStageAttempt) insertStageAttempt(decision.nextStageAttempt);
        if (decision.dispatch) insertWorkflowDispatch(decision.dispatch);
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
        const metadata = {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const agentStatus = terminalAgentRunStatus(decision.stageAttempt.status);
        if (agentStatus) finishActiveAgentRun(decision.stageAttempt.id, agentStatus, metadata);
        const events = appendWorkflowEvents(decision.events, metadata);
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
        // AgentRun is the A3 concurrency authority. Every RUNNING row at startup is orphaned even
        // when no ProviderSession was created yet; ending all of them first frees capacity and
        // ensures the dispatch-level recovery below never resurrects one implicitly.
        for (const runRow of selectRunningAgentRuns.all()) {
          const current = agentRunFromRow(runRow);
          const interrupted = finishAgentRun(current, "INTERRUPTED", occurredAt);
          const update = updateAgentRunStatus.run(
            interrupted.status,
            interrupted.finishedAt,
            interrupted.version,
            interrupted.id,
            current.version,
          );
          if (update.changes !== 1) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "An orphaned AgentRun changed while it was being interrupted",
            );
          }
          // The existing reconciliation result predates A3 and intentionally remains compatible
          // with old command receipts; the durable Event is the new lifecycle fact.
          appendAgentEvent(
            { type: "AGENT_RUN_FINISHED", data: { run: interrupted } },
            {
              workItemId: interrupted.workItemId,
              projectId: interrupted.projectId,
              actor: command.actor,
              occurredAt,
              correlationId: command.correlationId,
            },
          );
        }
        // A STARTED record means the request may already have crossed the stdio boundary. Recovery
        // records uncertainty before dispatch resumes and never retries it automatically.
        for (const callRow of selectStartedMcpToolCalls.all()) {
          const current = mcpToolCallFromRow(callRow);
          const uncertain = decideMcpToolCallFinished(
            current,
            { status: "UNKNOWN_OUTCOME", failureCode: "CONNECTION_LOST" },
            occurredAt,
          );
          persistFinishedMcpToolCall(uncertain);
        }
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
              processStartedAt,
              signalProcess,
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
          // Historical sessions had no AgentRun and keep A1's continuation semantics. An A3
          // session belongs to a run just interrupted above, so its StageAttempt must follow the
          // ordinary AD-008 dispatch recovery path instead of being silently resumed.
          if (session.agentRunId === null) attemptsWithInterruptedSession.add(session.stageAttemptId);
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

        // A StageAttempt this loop recovers to INTERRUPTED is never coming back to reclaim a
        // workspace lease itself (AD-008: nothing here restarts it): decideRecoverInterruptedWorkflow
        // is the daemon-restart path where no session ever started at all, unlike the loop above,
        // whose attempts stay RUNNING precisely because a resumed session is expected to use the
        // workspace again. Collected here, not derived from a later status re-read, because it is
        // this transaction's own decision that makes an attempt "dead" for lease purposes -- a
        // StageAttempt already WAITING_HUMAN or *_PAUSED before this reconciliation even ran still
        // legitimately owns its lease, and nothing below may release that.
        const attemptsRecoveredToInterrupted = new Set<string>();

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
          attemptsRecoveredToInterrupted.add(decision.stageAttempt.id);
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

        // Task 10 (spec §6, "Восстановление"): every READY workspace's worktree directory might
        // have gone missing while nothing was watching it -- deleted by hand, by a tool that does
        // not know about Loomrail, or by anything else outside its control. Nothing here recreates
        // one: AD-008 forbids resurrecting an interrupted run, and the branch a gone worktree leaves
        // behind is left exactly alone (D12) because it may hold the only copy of whatever the
        // agent did.
        const orphanedWorkspaces: WorkItemWorkspace[] = [];
        for (const initialWorkspace of selectReadyWorkItemWorkspaces.all().map(workItemWorkspaceFromRow)) {
          let workspace = initialWorkspace;

          // A lease whose holder is never coming back to release it: released here, or it sits on
          // this workspace forever -- migration 0011's UNIQUE on work_item_id means this WorkItem
          // can never get a second workspace for the next attempt to lease instead (C9-d).
          //
          // Two ways an attempt is dead, and the second one is why this is not the set alone.
          // `attemptsRecoveredToInterrupted` is this transaction's own decision, taken moments ago
          // (see above). The other is an attempt that was ALREADY finished when this reconciliation
          // started, and it is the one the product actually hits: the session loop applies the
          // provider's outcome and then releases the lease as two separate commands, so a SIGKILL
          // between them leaves a lease held by a StageAttempt that is already SUCCEEDED. Nothing
          // touched that. The dispatch-level recovery above never sees it -- it looks only at
          // PENDING dispatches whose attempt is still RUNNING -- so the lease survived every
          // restart, `acquireWorkspaceLease` answered POSTPONED forever (logged at info, no
          // question to the owner), and because the pending-dispatch queue is strict FIFO and the
          // worker reads only `dispatches[0]`, every newer dispatch in the whole product waited
          // behind that one work item.
          //
          // `stageAttemptIsTerminal` (@loomrail/domain) is what "dead" means, and its own comment
          // says why WAITING_HUMAN and the two paused statuses are NOT on that list: those attempts
          // are expected back, in this same worktree.
          const leaseHolder = workspace.leaseHolder;
          const leaseHolderAttempt = leaseHolder === null ? null : readStageAttempt(leaseHolder);
          const leaseHolderIsDead =
            leaseHolder !== null &&
            (attemptsRecoveredToInterrupted.has(leaseHolder) ||
              (leaseHolderAttempt !== null && stageAttemptIsTerminal(leaseHolderAttempt.status)));
          if (leaseHolder !== null && leaseHolderIsDead) {
            const releasedLease = releaseWorkItemWorkspaceLease.run(
              workspace.id,
              workspace.version,
              leaseHolder,
            );
            if (releasedLease.changes === 1) {
              const afterRelease = readWorkItemWorkspace(workspace.id);
              if (!afterRelease) {
                throw new StateStoreError(
                  "PERSISTENCE_FAILURE",
                  "The workspace disappeared after its dead lease was released",
                );
              }
              workspace = afterRelease;
            }
            // `changes !== 1` is unreachable in the single synchronous transaction RECONCILE_WORKFLOWS
            // runs in -- there is no concurrent writer between the read above and this UPDATE -- so
            // it is left as a silent no-op rather than grown a second, untestable error path for a
            // race this code cannot actually be raced into.
          }

          // FAIL SAFE ALL THE WAY OUT, exactly as killOrphanedSessionProcess is: this runs inside
          // `execute`, which the daemon calls -- unwrapped -- BEFORE `app.listen`. A vanished
          // repository, a `git` that will not run, a path that is no longer readable: none of these
          // may stop Loomrail from starting, so every failure here is caught, reported, and stepped
          // over rather than thrown.
          try {
            const project = readProject(workspace.projectId);
            if (!project) {
              reportOrphanWorkspace({
                workspaceId: workspace.id,
                workItemId: workspace.workItemId,
                worktreePath: workspace.worktreePath,
                action: "SKIPPED",
                reason: "PROJECT_NOT_FOUND",
              });
              continue;
            }
            const entries = listProjectWorktrees(project.repositoryPath);
            if (entries === null) {
              reportOrphanWorkspace({
                workspaceId: workspace.id,
                workItemId: workspace.workItemId,
                worktreePath: workspace.worktreePath,
                action: "SKIPPED",
                reason: "WORKTREE_LIST_FAILED",
              });
              continue;
            }
            // `git worktree list --porcelain` always reports a canonical (symlink-resolved) path
            // (spec: verified against a real `/var` -> `/private/var` macOS repo); the stored
            // `worktreePath` was never itself resolved that way, so it is canonicalised here, on
            // this side of the comparison, rather than trusting a string a healthy workspace would
            // otherwise fail to match by pure accident of where the OS temp directory lives.
            const canonicalWorktreePath = worktreePathComparisonKey(workspace.worktreePath);
            const entry = entries.find(
              (candidate) => worktreePathComparisonKey(candidate.path) === canonicalWorktreePath,
            );
            const isGone = entry === undefined || entry.prunable;
            if (!isGone) continue;

            const mark = markWorkItemWorkspaceOrphaned.run(workspace.id, workspace.version);
            if (mark.changes !== 1) {
              throw new StateStoreError(
                "PERSISTENCE_FAILURE",
                "The READY workspace changed while startup reconciliation was orphaning it",
              );
            }
            const after = readWorkItemWorkspace(workspace.id);
            if (!after) {
              throw new StateStoreError(
                "PERSISTENCE_FAILURE",
                "The workspace disappeared after it was marked orphaned",
              );
            }
            orphanedWorkspaces.push(after);
            reportOrphanWorkspace({
              workspaceId: after.id,
              workItemId: after.workItemId,
              worktreePath: after.worktreePath,
              action: "ORPHANED",
              reason: entry === undefined ? "MISSING_FROM_WORKTREE_LIST" : "PRUNABLE",
            });
            events.push(
              appendWorkspaceEvent(
                { type: "WORK_ITEM_WORKSPACE_ORPHANED", data: { workspace: after, previousStatus: "READY" } },
                {
                  workItemId: after.workItemId,
                  projectId: after.projectId,
                  actor: command.actor,
                  occurredAt,
                  correlationId: command.correlationId,
                },
              ),
            );
          } catch (error: unknown) {
            if (error instanceof StateStoreError) throw error;
            reportOrphanWorkspace({
              workspaceId: workspace.id,
              workItemId: workspace.workItemId,
              worktreePath: workspace.worktreePath,
              action: "SKIPPED",
              reason: "WORKTREE_LIST_FAILED",
            });
          }
        }

        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "WORKFLOWS_RECONCILED",
          replayed: false,
          recoveryReports,
          interruptedSessions,
          orphanedWorkspaces,
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
        const activeAgentRunValue = database
          .prepare("SELECT * FROM agent_runs WHERE stage_attempt_id = ? AND status = 'RUNNING' LIMIT 1")
          .get(command.payload.stageAttemptId);
        const activeAgentRun =
          activeAgentRunValue === undefined ? null : agentRunFromRow(activeAgentRunValue);
        const session = providerSessionSchema.parse({
          schemaVersion: 1,
          id: createId("providerSession"),
          agentRunId: activeAgentRun?.id ?? null,
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
          session.agentRunId,
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
        const enabledGrants = selectEnabledLatestMcpGrantsForProject
          .all(stageAttempt.projectId)
          .map(mcpGrantFromRow);
        const revisions = enabledGrants.map((grant) => {
          const revision = readMcpProfileRevision(grant.profileRevisionId);
          if (!revision) {
            throw new StateStoreError("PERSISTENCE_FAILURE", "An enabled MCP grant has no profile revision");
          }
          return revision;
        });
        const mcpSnapshots = decideMcpSessionSnapshots({
          now: occurredAt,
          projectId: stageAttempt.projectId,
          providerSessionId: session.id,
          revisions,
          grants: enabledGrants,
          newSnapshotIds: enabledGrants.map(() => createId("mcpSessionSnapshot")),
        });
        persistMcpSessionSnapshots(mcpSnapshots);
        const event = appendSessionEvent(
          { type: "PROVIDER_SESSION_STARTED", data: { session, recipe, mcpSnapshots } },
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
          mcpSnapshots,
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
        const agentStatus = terminalAgentRunStatus(attemptAfterEnd.status);
        if (agentStatus) finishActiveAgentRun(attemptAfterEnd.id, agentStatus, eventMetadata);
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
        const metadata = {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        finishActiveAgentRun(decision.stageAttempt.id, "HARD_PAUSED", metadata);
        const events = appendWorkflowEvents(decision.events, metadata);
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

      if (command.type === "CREATE_WORK_ITEM_WORKSPACE") {
        const workItem = readWorkItem(command.payload.workItemId);
        if (!workItem) {
          throw new WorkItemDomainError("WORK_ITEM_NOT_FOUND", "The WorkItem does not exist");
        }
        // Validated against the WorkItem's own projectId, not merely inserted as given: a payload
        // naming the wrong Project would otherwise write a workspace whose FK is internally
        // consistent but points a different Project at this WorkItem's worktree.
        if (workItem.projectId !== command.payload.projectId || !readProject(command.payload.projectId)) {
          throw new StateStoreError("PROJECT_NOT_FOUND", "The Project does not exist for this WorkItem");
        }
        // Pre-check, not the sole guard: migration 0011's UNIQUE on work_item_id is the storage-
        // level backstop (spec D1) that makes a second workspace for this WorkItem impossible even
        // if two callers race past this read, the same relationship REGISTER_PROJECT's own
        // pre-check has with the projects table's own UNIQUE columns above.
        if (selectWorkItemWorkspaceByWorkItemId.get(command.payload.workItemId) !== undefined) {
          throw new StateStoreError("WORKSPACE_ALREADY_EXISTS", "The WorkItem already has a workspace");
        }
        const initialLeaseHolder = command.payload.initialLeaseHolder ?? null;
        if (initialLeaseHolder !== null) {
          const leaseAttempt = readStageAttempt(initialLeaseHolder);
          const activeAgentRun = selectRunningAgentRunForStageAttempt.get(initialLeaseHolder);
          if (
            leaseAttempt?.workItemId !== workItem.id ||
            leaseAttempt.projectId !== workItem.projectId ||
            activeAgentRun === undefined
          ) {
            throw new StateStoreError(
              "AGENT_RUN_NOT_ACTIVE",
              "The initial workspace lease needs an active AgentRun for this WorkItem",
            );
          }
        }
        const workspace = workItemWorkspaceSchema.parse({
          schemaVersion: 1,
          id: createId("workItemWorkspace"),
          projectId: workItem.projectId,
          workItemId: workItem.id,
          branch: command.payload.branch,
          worktreePath: command.payload.worktreePath,
          baseCommit: command.payload.baseCommit,
          snapshotCommit: command.payload.snapshotCommit,
          status: "READY",
          leaseHolder: initialLeaseHolder,
          createdAt: occurredAt,
          version: 1,
        });
        insertWorkItemWorkspace.run(
          workspace.id,
          workspace.schemaVersion,
          workspace.projectId,
          workspace.workItemId,
          workspace.branch,
          workspace.worktreePath,
          workspace.baseCommit,
          workspace.snapshotCommit,
          workspace.status,
          workspace.leaseHolder,
          workspace.createdAt,
          workspace.version,
        );
        const event = appendWorkspaceEvent(
          {
            type: "WORK_ITEM_WORKSPACE_CREATED",
            data: { workspace, carriedPaths: command.payload.carriedPaths },
          },
          {
            workItemId: workItem.id,
            projectId: workItem.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "WORK_ITEM_WORKSPACE_CREATED",
          replayed: false,
          workItemId: workItem.id,
          workspace,
          event,
        });
      }

      if (command.type === "ACQUIRE_WORKSPACE_LEASE") {
        if (!readWorkItemWorkspace(command.payload.workspaceId)) {
          throw new StateStoreError("WORKSPACE_NOT_FOUND", "The workspace does not exist");
        }
        if (!readStageAttempt(command.payload.stageAttemptId)) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The StageAttempt does not exist");
        }
        // The lease is taken by this single UPDATE's WHERE clause -- `lease_holder IS NULL` is the
        // check, and the same statement is the claim, so there is no read-then-write window for a
        // second acquire to land in between (spec D6). The re-reads below only pick which error to
        // report when this update claims 0 rows; they never decide whether it succeeded.
        const claim = acquireWorkItemWorkspaceLease.run(
          command.payload.stageAttemptId,
          command.payload.workspaceId,
          command.payload.expectedVersion,
        );
        if (claim.changes !== 1) {
          const after = readWorkItemWorkspace(command.payload.workspaceId);
          if (!after) {
            throw new StateStoreError("WORKSPACE_NOT_FOUND", "The workspace does not exist");
          }
          // Checked before the version: a lease already held is the actionable fact for the caller,
          // even when the caller's expectedVersion is also stale as a symptom of the same race.
          if (after.leaseHolder !== null) {
            throw new StateStoreError(
              "WORKSPACE_LEASE_HELD",
              "The workspace lease is already held by another StageAttempt",
            );
          }
          throw new StateStoreError(
            "WORKSPACE_VERSION_CONFLICT",
            "The workspace changed while the lease was being acquired",
          );
        }
        const workspace = readWorkItemWorkspace(command.payload.workspaceId);
        if (!workspace) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The workspace disappeared after its lease was acquired",
          );
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "WORKSPACE_LEASE_ACQUIRED",
          replayed: false,
          workItemId: workspace.workItemId,
          workspace,
          events: [],
        });
      }

      if (command.type === "RELEASE_WORKSPACE_LEASE") {
        if (!readWorkItemWorkspace(command.payload.workspaceId)) {
          throw new StateStoreError("WORKSPACE_NOT_FOUND", "The workspace does not exist");
        }
        // `lease_holder = ?` in the WHERE clause is the authoritative check (spec D6): a release
        // from anyone but the current holder claims 0 rows here rather than being trusted from the
        // payload alone.
        const release = releaseWorkItemWorkspaceLease.run(
          command.payload.workspaceId,
          command.payload.expectedVersion,
          command.payload.stageAttemptId,
        );
        if (release.changes !== 1) {
          const after = readWorkItemWorkspace(command.payload.workspaceId);
          if (!after) {
            throw new StateStoreError("WORKSPACE_NOT_FOUND", "The workspace does not exist");
          }
          if (after.leaseHolder !== command.payload.stageAttemptId) {
            throw new StateStoreError(
              "WORKSPACE_LEASE_NOT_OWNED",
              "Only the StageAttempt holding the workspace lease may release it",
            );
          }
          throw new StateStoreError(
            "WORKSPACE_VERSION_CONFLICT",
            "The workspace changed while the lease was being released",
          );
        }
        const workspace = readWorkItemWorkspace(command.payload.workspaceId);
        if (!workspace) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The workspace disappeared after its lease was released",
          );
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "WORKSPACE_LEASE_RELEASED",
          replayed: false,
          workItemId: workspace.workItemId,
          workspace,
          events: [],
        });
      }

      if (command.type === "MARK_WORKSPACE_ORPHANED") {
        const before = readWorkItemWorkspace(command.payload.workspaceId);
        if (!before) {
          throw new StateStoreError("WORKSPACE_NOT_FOUND", "The workspace does not exist");
        }
        // Restricted to the READY -> ORPHANED transition in the WHERE clause itself (spec §6): the
        // only status this transition is ever taken from is READY, so `status = 'READY'` here is
        // what makes that a storage-enforced fact rather than an assumption this code trusts.
        const mark = markWorkItemWorkspaceOrphaned.run(
          command.payload.workspaceId,
          command.payload.expectedVersion,
        );
        if (mark.changes !== 1) {
          const after = readWorkItemWorkspace(command.payload.workspaceId);
          if (!after) {
            throw new StateStoreError("WORKSPACE_NOT_FOUND", "The workspace does not exist");
          }
          if (after.status !== "READY") {
            throw new StateStoreError("WORKSPACE_NOT_READY", "Only a READY workspace can be marked orphaned");
          }
          throw new StateStoreError(
            "WORKSPACE_VERSION_CONFLICT",
            "The workspace changed while it was being marked orphaned",
          );
        }
        const workspace = readWorkItemWorkspace(command.payload.workspaceId);
        if (!workspace) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The workspace disappeared after it was marked orphaned",
          );
        }
        const event = appendWorkspaceEvent(
          {
            type: "WORK_ITEM_WORKSPACE_ORPHANED",
            data: { workspace, previousStatus: before.status },
          },
          {
            workItemId: workspace.workItemId,
            projectId: workspace.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "WORK_ITEM_WORKSPACE_ORPHANED",
          replayed: false,
          workItemId: workspace.workItemId,
          workspace,
          event,
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
          error instanceof ConstitutionDomainError ||
          error instanceof McpDomainError ||
          error instanceof ReadinessDomainError ||
          error instanceof ProviderSelectionDomainError ||
          error instanceof QACompletionError ||
          error instanceof QAReservationError ||
          error instanceof ReviewFindingDispositionError ||
          error instanceof ScaffoldDomainError ||
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
              .prepare("SELECT * FROM projects WHERE status <> 'PROVISIONING' ORDER BY created_at, id")
              .all()
              .map(projectFromRow),
          };
        case "GET_PROJECT":
          return { type: "PROJECT", project: readProject(queryValue.projectId) };
        case "GET_PROJECT_BY_REPOSITORY_PATH": {
          const row = selectProjectByRepositoryPath.get(queryValue.repositoryPath);
          return { type: "PROJECT", project: row === undefined ? null : projectFromRow(row) };
        }
        case "GET_PROJECT_CONSTITUTION_SNAPSHOT": {
          if (!readProject(queryValue.projectId)) {
            throw new ConstitutionDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
          }
          const publicationRow = selectLatestConstitutionPublication.get(queryValue.projectId);
          return {
            type: "PROJECT_CONSTITUTION_SNAPSHOT",
            snapshot: projectConstitutionSnapshotSchema.parse({
              schemaVersion: 1,
              latestProposal: readLatestConstitutionProposal(queryValue.projectId),
              activeConstitution: readActiveProjectConstitution(queryValue.projectId),
              pendingConstitution: readPendingProjectConstitution(queryValue.projectId),
              publication:
                publicationRow === undefined ? null : constitutionPublicationFromRow(publicationRow),
            }),
          };
        }
        case "GET_PROJECT_READINESS_SNAPSHOT": {
          if (!readProject(queryValue.projectId)) {
            throw new ReadinessDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
          }
          const run = readLatestProjectReadinessRun(queryValue.projectId);
          return {
            type: "PROJECT_READINESS_SNAPSHOT",
            snapshot: projectReadinessSnapshotSchema.parse({
              schemaVersion: 1,
              run,
              checks: run === null ? [] : readReadinessChecks(run.id),
              findings:
                run === null ? [] : selectReadinessFindingsForRun.all(run.id).map(securityFindingFromRow),
              attestations:
                run === null
                  ? []
                  : selectReadinessAttestationsForRun.all(run.id).map(readinessAttestationFromRow),
            }),
          };
        }
        case "GET_PROJECT_MCP_PROFILES": {
          const project = readProject(queryValue.projectId);
          if (!project) throw new McpDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
          return { type: "PROJECT_MCP_PROFILES", project, profiles: readProjectMcpProfiles(project.id) };
        }
        case "LIST_PROVIDER_SESSION_MCP_SNAPSHOTS":
          return {
            type: "MCP_SESSION_SNAPSHOTS",
            snapshots: readMcpSessionSnapshots(queryValue.providerSessionId),
          };
        case "LIST_MCP_TOOL_CALLS":
          return {
            type: "MCP_TOOL_CALLS",
            calls: selectMcpToolCallsForSession.all(queryValue.providerSessionId).map(mcpToolCallFromRow),
          };
        case "LIST_PENDING_CONSTITUTION_PUBLICATIONS":
          return {
            type: "CONSTITUTION_PUBLICATIONS",
            publications: selectPendingConstitutionPublications.all().map((row) => {
              const publication = constitutionPublicationFromRow(row);
              const constitution = readProjectConstitutionVersion(publication.constitutionVersionId);
              const proposal = constitution ? readConstitutionProposal(constitution.proposalId) : null;
              if (!constitution || !proposal) {
                throw new StateStoreError(
                  "PERSISTENCE_FAILURE",
                  "A pending Constitution publication has incomplete durable state",
                );
              }
              return { proposal, constitution, publication };
            }),
          };
        case "GET_SCAFFOLD_OPERATION":
          return {
            type: "SCAFFOLD_OPERATION",
            operation: readScaffoldOperation(queryValue.operationId),
          };
        case "LIST_PENDING_SCAFFOLD_OPERATIONS":
          return {
            type: "SCAFFOLD_OPERATIONS",
            operations: selectPendingScaffoldOperations.all().map(scaffoldOperationFromRow),
          };
        case "LIST_OPEN_SCAFFOLD_OPERATIONS":
          return {
            type: "SCAFFOLD_OPERATIONS",
            operations: selectOpenScaffoldOperations.all().map(scaffoldOperationFromRow),
          };
        case "GET_WORK_ITEM":
          return { type: "WORK_ITEM", workItem: readWorkItem(queryValue.workItemId) };
        case "GET_WORKFLOW_SNAPSHOT":
          return { type: "WORKFLOW_SNAPSHOT", snapshot: readWorkflowSnapshot(queryValue.workItemId) };
        case "GET_ATTENTION_INBOX": {
          const sources = humanRequestRowSchema
            .array()
            .parse(
              selectOpenHumanRequestsForAttention.all(
                ...sessionPauseFailureCodes,
                maxAttentionProjectionSources,
              ),
            )
            .map((row) => {
              const request = readHumanRequest(row.id);
              const project = readProject(row.project_id);
              const workItem = readWorkItem(row.work_item_id);
              const stageAttempt = readStageAttempt(row.stage_attempt_id);
              if (!request || !project || !workItem || !stageAttempt) {
                throw new StateStoreError(
                  "PERSISTENCE_FAILURE",
                  "An Attention item has incomplete durable relations",
                );
              }
              const acceptanceValue = selectPendingAcceptancePackageByHumanRequest.get(row.id);
              const acceptancePackageId =
                acceptanceValue === undefined ? null : acceptancePackageRowSchema.parse(acceptanceValue).id;
              return {
                request,
                project,
                workItem,
                stageAttempt,
                acceptancePackageId,
              };
            });
          return {
            type: "ATTENTION_INBOX",
            inbox: buildAttentionInbox(sources),
          };
        }
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
              .prepare(
                "SELECT * FROM workflow_dispatches WHERE status = 'PENDING' ORDER BY created_at, id LIMIT 200",
              )
              .all()
              .map(workflowDispatchFromRow),
          };
        case "GET_SQUAD_ASSIGNMENT": {
          const row = selectLatestSquadAssignment.get(queryValue.pipelineRunId);
          return {
            type: "SQUAD_ASSIGNMENT",
            assignment: row === undefined ? null : squadAssignmentFromRow(row),
          };
        }
        case "GET_AGENT_RUN": {
          const value = selectAgentRunById.get(queryValue.agentRunId);
          return { type: "AGENT_RUNS", runs: value === undefined ? [] : [agentRunFromRow(value)] };
        }
        case "GET_QA_RUN": {
          const value = selectQARunById.get(queryValue.qaRunId);
          return { type: "QA_RUN", qaRun: value === undefined ? null : qaRunFromRow(value) };
        }
        case "GET_QA_STATE":
          return {
            type: "QA_STATE",
            runs: database
              .prepare("SELECT * FROM qa_runs WHERE pipeline_run_id = ? ORDER BY started_at, id")
              .all(queryValue.pipelineRunId)
              .map(qaRunFromRow),
            evidence: database
              .prepare("SELECT * FROM qa_evidence_bundles WHERE pipeline_run_id = ? ORDER BY created_at, id")
              .all(queryValue.pipelineRunId)
              .map(qaEvidenceBundleFromRow),
            attachments: database
              .prepare(
                `SELECT qa_attachment_refs.* FROM qa_attachment_refs
                 INNER JOIN qa_runs ON qa_runs.id = qa_attachment_refs.qa_run_id
                 WHERE qa_runs.pipeline_run_id = ? ORDER BY qa_attachment_refs.captured_at, qa_attachment_refs.id`,
              )
              .all(queryValue.pipelineRunId)
              .map(qaAttachmentRefFromRow),
            defects: database
              .prepare(
                `SELECT qa_defects.* FROM qa_defects
                 INNER JOIN qa_runs ON qa_runs.id = qa_defects.qa_run_id
                 WHERE qa_runs.pipeline_run_id = ? ORDER BY qa_defects.created_at, qa_defects.id`,
              )
              .all(queryValue.pipelineRunId)
              .map(qaDefectFromRow),
          };
        case "LIST_EXPIRED_QA_ATTACHMENTS":
          return {
            type: "QA_ATTACHMENTS",
            attachments: selectExpiredQAAttachmentRefs
              .all(queryValue.closedBefore, queryValue.limit)
              .map(qaAttachmentRefFromRow),
          };
        case "GET_LATEST_SUCCEEDED_DEVELOPER_AGENT_RUN": {
          const value = selectLatestSucceededDeveloperAgentRun.get(queryValue.pipelineRunId);
          return {
            type: "AGENT_RUNS",
            runs: value === undefined ? [] : [agentRunFromRow(value)],
          };
        }
        case "LIST_AGENT_RUNS": {
          const rows =
            queryValue.status === undefined
              ? database
                  .prepare("SELECT * FROM agent_runs ORDER BY started_at DESC, id DESC LIMIT ?")
                  .all(queryValue.limit)
              : database
                  .prepare(
                    "SELECT * FROM agent_runs WHERE status = ? ORDER BY started_at DESC, id DESC LIMIT ?",
                  )
                  .all(queryValue.status, queryValue.limit);
          return { type: "AGENT_RUNS", runs: rows.map(agentRunFromRow) };
        }
        case "LIST_REVIEW_REPORTS":
          return {
            type: "REVIEW_REPORTS",
            reports: database
              .prepare(
                "SELECT * FROM review_reports WHERE pipeline_run_id = ? ORDER BY round DESC, id DESC LIMIT ?",
              )
              .all(queryValue.pipelineRunId, queryValue.limit)
              .map(reviewReportFromRow),
          };
        case "LIST_REVIEW_FINDINGS": {
          const rows =
            queryValue.status === undefined
              ? database
                  .prepare(
                    "SELECT * FROM review_findings WHERE pipeline_run_id = ? ORDER BY created_at, id LIMIT ?",
                  )
                  .all(queryValue.pipelineRunId, queryValue.limit)
              : database
                  .prepare(
                    "SELECT * FROM review_findings WHERE pipeline_run_id = ? AND status = ? ORDER BY created_at, id LIMIT ?",
                  )
                  .all(queryValue.pipelineRunId, queryValue.status, queryValue.limit);
          return { type: "REVIEW_FINDINGS", findings: rows.map(reviewFindingFromRow) };
        }
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
        case "GET_WORKSPACE_BY_WORK_ITEM":
          return {
            type: "WORKSPACE",
            workspace: readWorkItemWorkspaceByWorkItemId(queryValue.workItemId),
          };
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
          error instanceof ReadinessDomainError ||
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
