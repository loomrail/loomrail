import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContextSources } from "@loomrail/context-assembly";
import {
  acceptancePackageSchema,
  agentRunPolicySnapshotSchema,
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
  MAX_AUTOMATIC_CORRECTION_RUNS,
  MAX_TOTAL_CORRECTION_RUNS,
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
  verificationPlanSchema,
  verificationPlanPublicationSchema,
  verificationCheckSchema,
  verificationCorrectionRunSchema,
  verificationFailureSchema,
  verificationRunSchema,
  qaAttachmentRefSchema,
  qaCorrectionRunSchema,
  qaDefectSchema,
  qaEvidenceBundleSchema,
  qaRetestPlanSchema,
  qaRunSchema,
  readinessAttestationSchema,
  readinessCheckSchema,
  sessionPauseFailureCodes,
  providerSessionSchema,
  providerAllowanceSnapshotSchema,
  providerUsageReportSchema,
  providerUsageSchema,
  recoveryReportSchema,
  reportingFactsSchema,
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
  type AgentRunPolicySnapshot,
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
  type VerificationPlan,
  type VerificationPlanPublication,
  type VerificationCheck,
  type VerificationCorrectionRun,
  type VerificationFailure,
  type VerificationRun,
  type QAAttachmentRef,
  type QACorrectionRun,
  type QADefect,
  type QAEvidenceBundle,
  type QARetestPlan,
  type QARun,
  type ReadinessAttestation,
  type ReadinessCheck,
  type ProviderSession,
  type ProviderAllowanceSnapshot,
  type ProviderUsageReport,
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
  AgentDomainError,
  ConstitutionDomainError,
  buildAttentionInbox,
  canonicalMcpProfileSource,
  decideProjectReadinessAssessment,
  decideProjectReadinessAttestation,
  decideFailedQACorrectionTransition,
  decidePassedQACorrectionTransition,
  decideQACorrectionCancellation,
  decideQACorrectionGateResolution,
  decideQADefectWaiver,
  decideReviewFindingDisposition,
  decideQACompletion,
  decideQAReservation,
  qaWorkflowOutcome,
  decideProjectProviderPreference,
  decideVerificationPlanAdoption,
  decideVerificationPlanDisable,
  decideVerificationPlanPublicationCompleted,
  decideVerificationPlanPublicationFailed,
  decideVerificationPlanPublicationRetry,
  decideVerificationCheckCompletion,
  decideVerificationCheckStart,
  decideInitialFailedVerificationCorrectionTransition,
  decideInitialFailedVerificationCorrectionGateTransition,
  decideMixedVerificationCorrectionGateResolution,
  decidePassedVerificationCorrectionQAHandoff,
  decidePassedVerificationCorrectionTransition,
  decideStaleVerificationFailureTransition,
  decideSubsequentFailedVerificationCorrectionTransition,
  decideVerificationCorrectionCancellation,
  decideVerificationCorrectionGateResolution,
  deriveVerificationFailure,
  decideVerificationRunCancellationRequest,
  decideVerificationRunInterruption,
  decideVerificationRunReservation,
  decideRecordProviderAllowance,
  decideRecordProviderUsage,
  decideApproveBudgetOverride,
  decideAnswerHumanRequest,
  decideApplyProviderOutcome,
  decideApplyProviderOutcomeWithUsage,
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
  findBuiltinAgentProfile,
  resolveAgentRunPolicy,
  stageRunsInWorkspace,
  upgradeLegacyStandardSquadForAcceptance,
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
  decideParkQueuedStageAttemptForBudget,
  decideStartMockPipeline,
  decideWorkItemCommand,
  isProviderOutcomeRejectionError,
  stageAttemptIsTerminal,
  WorkflowDomainError,
  ReadinessDomainError,
  McpDomainError,
  ProviderSelectionDomainError,
  VerificationDomainError,
  VerificationCorrectionError,
  ProviderAllowanceDomainError,
  QACompletionError,
  QACorrectionError,
  QADefectDispositionError,
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
  type VerificationPlanAdoptedIntent,
  type VerificationPlanDisabledIntent,
  type VerificationPlanPublicationIntent,
  type VerificationRunEventIntent,
  type ProviderAllowanceRecordedIntent,
  type FailedQACorrectionTransition,
  type PassedQACorrectionTransition,
  type QACorrectionGateResolution,
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
  type RecordProviderUsageDecision,
  type RecoveryDecision,
  type QADefectDispositionDecision,
  type ReviewFindingDispositionDecision,
  type StageAttemptPauseDecision,
  type StartWorkflowDecision,
  type StartedVerificationCorrectionTransition,
  type MixedVerificationCorrectionGateResolution,
  type PassedVerificationCorrectionQAHandoff,
  type PassedVerificationCorrectionTransition,
  type SubsequentFailedVerificationCorrectionTransition,
  type VerificationCorrectionGateResolution,
  type VerificationCorrectionCancellation,
  type WorkItemCommand,
  type WorkItemDecision,
  type WorkItemEventIntent,
} from "@loomrail/domain";
import { verificationPlanContentHash, verificationPlanProposalHash } from "@loomrail/project-readiness";
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
export * from "./inspection.js";

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

const providerAllowanceRowSchema = z.object({
  project_id: z.string(),
  provider: z.string(),
  schema_version: z.number().int(),
  observed_at: z.string(),
  freshness: z.string(),
  snapshot_json: z.string(),
  recorded_at: z.string(),
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
  policy_snapshot_json: z.string().nullable(),
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
  verification_holder: z.string().nullable(),
  created_at: z.string(),
  version: z.number().int(),
});

const verificationRunRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  workspace_id: z.string(),
  plan_id: z.string(),
  plan_revision: z.number().int(),
  plan_content_hash: z.string(),
  implementation_tree: z.string(),
  ordinal: z.number().int(),
  retry_of_run_id: z.string().nullable(),
  verification_correction_run_id: z.string().nullable().optional(),
  platform: z.string(),
  status: z.string(),
  current_check_id: z.string().nullable(),
  terminal_reason: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  version: z.number().int(),
});

const verificationCheckRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  run_id: z.string(),
  recipe_id: z.string(),
  ordinal: z.number().int(),
  required: z.number().int(),
  status: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  error_code: z.string().nullable(),
  output_json: z.string().nullable(),
  version: z.number().int(),
});

const verificationFailureRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  verification_run_id: z.string(),
  verification_check_id: z.string().nullable(),
  plan_id: z.string(),
  plan_revision: z.number().int(),
  plan_content_hash: z.string(),
  implementation_tree: z.string(),
  reason: z.string(),
  stale_reasons_json: z.string(),
  created_at: z.string(),
});

const verificationCorrectionRunRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  budget_position: z.number().int(),
  automatic: z.number().int(),
  source_failure_id: z.string(),
  source_verification_run_id: z.string(),
  source_implementation_tree: z.string(),
  resumes_qa_correction_run_id: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  version: z.number().int(),
});

const correctionBudgetUsageRowSchema = z.object({
  automatic_used: z.number().int().nonnegative(),
  total_used: z.number().int().nonnegative(),
});

const verificationOutputArtifactRowSchema = z.object({
  artifact_id: z.string(),
  run_id: z.string(),
  check_id: z.string(),
  storage_key: z.string(),
});

const verificationOutputRetentionRowSchema = z.object({
  artifact_id: z.string(),
  outcome: z.enum(["DELETED", "ALREADY_ABSENT"]),
  recorded_at: z.string(),
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

const verificationPlanRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  revision: z.number().int(),
  status: z.string(),
  source_proposal_hash: z.string(),
  content_hash: z.string(),
  plan_json: z.string(),
  created_at: z.string(),
});

const verificationPlanPublicationRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  plan_id: z.string(),
  target_path: z.string(),
  expected_target_digest: z.string().nullable(),
  content_hash: z.string(),
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
  model_tier_override: z.string().nullable(),
  agent_run_max_estimated_tokens_override: z.number().int().nullable(),
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

const providerUsageReportRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  agent_run_id: z.string(),
  provider_session_id: z.string(),
  usage_record_id: z.string().nullable(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cached_input_tokens: z.number().int().nullable(),
  reasoning_output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int(),
  cost_usd: z.number().nullable(),
  quality: z.string(),
  usage_digest: z.string(),
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

const reportingFactsRowSchema = z.object({
  work_items_total: z.number().int(),
  work_items_accepted: z.number().int(),
  work_items_cancelled: z.number().int(),
  work_items_active: z.number().int(),
  pipeline_runs_total: z.number().int(),
  pipeline_runs_succeeded: z.number().int(),
  pipeline_runs_failed: z.number().int(),
  pipeline_runs_interrupted: z.number().int(),
  pipeline_runs_cancelled: z.number().int(),
  agent_runs_total: z.number().int(),
  agent_runs_succeeded: z.number().int(),
  agent_runs_failed: z.number().int(),
  agent_runs_interrupted: z.number().int(),
  reviews_total: z.number().int(),
  reviews_first_round: z.number().int(),
  reviews_first_round_passed: z.number().int(),
  qa_total: z.number().int(),
  qa_passed: z.number().int(),
  qa_failed: z.number().int(),
  qa_errored: z.number().int(),
  qa_defects_open: z.number().int(),
  qa_defects_resolved: z.number().int(),
  qa_defects_waived: z.number().int(),
  human_requests_total: z.number().int(),
  human_requests_resolved: z.number().int(),
  estimated_tokens: z.number().int(),
  daemon_restart_recoveries: z.number().int(),
});

const evidenceArtifactRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  stage_attempt_id: z.string(),
  correction_run_id: z.string().nullable(),
  verification_correction_run_id: z.string().nullable().optional(),
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
  verification_correction_run_id: z.string().nullable().optional(),
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
  verification_correction_run_id: z.string().nullable().optional(),
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
    verification_correction_run_id: z.string().nullable().optional(),
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
  verification_correction_run_id: z.string().nullable().optional(),
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
  resolved_by_qa_run_id: z.string().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  version: z.number().int(),
});

const qaCorrectionRunRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  ordinal: z.number().int(),
  source_qa_run_id: z.string(),
  baseline_qa_run_id: z.string(),
  source_evidence_bundle_id: z.string(),
  source_tested_tree: z.string(),
  defect_ids_json: z.string(),
  status: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  version: z.number().int(),
});

const qaRetestPlanRowSchema = z.object({
  id: z.string(),
  schema_version: z.number().int(),
  project_id: z.string(),
  work_item_id: z.string(),
  pipeline_run_id: z.string(),
  correction_run_id: z.string(),
  baseline_qa_run_id: z.string(),
  source_qa_run_id: z.string(),
  source_evidence_bundle_id: z.string(),
  baseline_plan_revision: z.number().int(),
  baseline_plan_content_hash: z.string(),
  cells_json: z.string(),
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
  verification_evidence_json: z.string().nullable(),
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
  verification_correction_run_id: z.string().nullable().optional(),
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
  role_profile_id: z.string().nullable(),
  role_profile_revision: z.number().int().nullable(),
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
  z.object({ type: z.literal("GET_REPORTING_FACTS") }).strict(),
  z.object({ type: z.literal("GET_PROJECT"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_PROVIDER_ALLOWANCES"), projectId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("GET_PROJECT_BY_REPOSITORY_PATH"),
      repositoryPath: z.string().min(1).max(4_096),
    })
    .strict(),
  z.object({ type: z.literal("GET_PROJECT_CONSTITUTION_SNAPSHOT"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_PROJECT_VERIFICATION_PLAN"), projectId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_VERIFICATION_RUN"), runId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("GET_VERIFICATION_RUN_CONTEXT"), runId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("LIST_WORK_ITEM_VERIFICATION_RUNS"),
      workItemId: opaqueIdSchema,
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_WORK_ITEM_VERIFICATION_FAILURES"),
      workItemId: opaqueIdSchema,
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_WORK_ITEM_VERIFICATION_CORRECTIONS"),
      workItemId: opaqueIdSchema,
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  z.object({ type: z.literal("LIST_ACTIVE_VERIFICATION_RUNS") }).strict(),
  z.object({ type: z.literal("GET_VERIFICATION_OUTPUT_ARTIFACT"), checkId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("HAS_VERIFICATION_OUTPUT_STORAGE_KEY"),
      storageKey: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      type: z.literal("LIST_EXPIRED_VERIFICATION_OUTPUTS"),
      closedBefore: utcTimestampSchema,
      limit: z.number().int().min(1).max(1_000).default(200),
    })
    .strict(),
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
  z.object({ type: z.literal("LIST_PENDING_VERIFICATION_PLAN_PUBLICATIONS") }).strict(),
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

const providerAllowanceFromRow = (value: unknown): ProviderAllowanceSnapshot => {
  const row = providerAllowanceRowSchema.parse(value);
  const snapshot = providerAllowanceSnapshotSchema.parse(parseJson(row.snapshot_json));
  if (
    snapshot.schemaVersion !== row.schema_version ||
    snapshot.provider !== row.provider ||
    snapshot.observedAt !== row.observed_at ||
    snapshot.freshness !== row.freshness
  ) {
    throw new StateStoreError(
      "PERSISTENCE_FAILURE",
      "The provider allowance row does not match its normalized snapshot",
    );
  }
  return snapshot;
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

const verificationPlanFromRow = (value: unknown): VerificationPlan => {
  const row = verificationPlanRowSchema.parse(value);
  const plan = verificationPlanSchema.parse(parseJson(row.plan_json));
  if (
    plan.id !== row.id ||
    plan.schemaVersion !== row.schema_version ||
    plan.projectId !== row.project_id ||
    plan.revision !== row.revision ||
    plan.status !== row.status ||
    plan.sourceProposalHash !== row.source_proposal_hash ||
    plan.contentHash !== row.content_hash ||
    plan.createdAt !== row.created_at
  ) {
    throw new StateStoreError(
      "PERSISTENCE_FAILURE",
      "The verification Plan row does not match its normalized content",
    );
  }
  return plan;
};

const verificationPlanPublicationFromRow = (value: unknown): VerificationPlanPublication => {
  const row = verificationPlanPublicationRowSchema.parse(value);
  return verificationPlanPublicationSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    targetPath: row.target_path,
    expectedTargetDigest: row.expected_target_digest,
    contentHash: row.content_hash,
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

const verificationRunFromRow = (value: unknown): VerificationRun => {
  const row = verificationRunRowSchema.parse(value);
  return verificationRunSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    planContentHash: row.plan_content_hash,
    implementationTree: row.implementation_tree,
    ordinal: row.ordinal,
    retryOfRunId: row.retry_of_run_id,
    ...(row.verification_correction_run_id === undefined || row.verification_correction_run_id === null
      ? {}
      : { verificationCorrectionRunId: row.verification_correction_run_id }),
    platform: row.platform,
    status: row.status,
    currentCheckId: row.current_check_id,
    terminalReason: row.terminal_reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    version: row.version,
  });
};

const verificationCheckFromRow = (value: unknown): VerificationCheck => {
  const row = verificationCheckRowSchema.parse(value);
  return verificationCheckSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    recipeId: row.recipe_id,
    ordinal: row.ordinal,
    required: row.required === 1,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    signal: row.signal,
    errorCode: row.error_code,
    output: row.output_json === null ? null : parseJson(row.output_json),
    version: row.version,
  });
};

const verificationFailureFromRow = (value: unknown): VerificationFailure => {
  const row = verificationFailureRowSchema.parse(value);
  return verificationFailureSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    verificationRunId: row.verification_run_id,
    verificationCheckId: row.verification_check_id,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    planContentHash: row.plan_content_hash,
    implementationTree: row.implementation_tree,
    reason: row.reason,
    staleReasons: parseJson(row.stale_reasons_json),
    createdAt: row.created_at,
  });
};

const verificationCorrectionRunFromRow = (value: unknown): VerificationCorrectionRun => {
  const row = verificationCorrectionRunRowSchema.parse(value);
  return verificationCorrectionRunSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    budgetPosition: row.budget_position,
    automatic: row.automatic === 1,
    sourceFailureId: row.source_failure_id,
    sourceVerificationRunId: row.source_verification_run_id,
    sourceImplementationTree: row.source_implementation_tree,
    resumesQACorrectionRunId: row.resumes_qa_correction_run_id,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
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
  const policySnapshot: AgentRunPolicySnapshot | null =
    row.policy_snapshot_json === null
      ? null
      : agentRunPolicySnapshotSchema.parse(parseJson(row.policy_snapshot_json));
  if (policySnapshot !== null) {
    const observedHash = `sha256:${createHash("sha256").update(canonicalJson(policySnapshot)).digest("hex")}`;
    if (observedHash !== row.policy_snapshot_hash) {
      throw new StateStoreError(
        "PERSISTENCE_FAILURE",
        "The AgentRun policy snapshot does not match its immutable hash",
      );
    }
  }
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
    policySnapshot,
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
    modelTierOverride: row.model_tier_override,
    agentRunMaxEstimatedTokensOverride: row.agent_run_max_estimated_tokens_override,
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

const providerUsageReportFromRow = (value: unknown): ProviderUsageReport => {
  const row = providerUsageReportRowSchema.parse(value);
  const usage = providerUsageSchema.parse({
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    ...(row.cached_input_tokens === null ? {} : { cachedInputTokens: row.cached_input_tokens }),
    ...(row.reasoning_output_tokens === null ? {} : { reasoningOutputTokens: row.reasoning_output_tokens }),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
    quality: row.quality,
  });
  const observedDigest = `sha256:${createHash("sha256").update(canonicalJson(usage)).digest("hex")}`;
  if (observedDigest !== row.usage_digest) {
    throw new StateStoreError(
      "PERSISTENCE_FAILURE",
      "The ProviderUsage report does not match its immutable digest",
    );
  }
  return providerUsageReportSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    stageAttemptId: row.stage_attempt_id,
    agentRunId: row.agent_run_id,
    providerSessionId: row.provider_session_id,
    usageRecordId: row.usage_record_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    quality: row.quality,
    usageDigest: row.usage_digest,
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
    ...(row.verification_correction_run_id === undefined || row.verification_correction_run_id === null
      ? {}
      : { verificationCorrectionRunId: row.verification_correction_run_id }),
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
    ...(row.verification_correction_run_id === undefined || row.verification_correction_run_id === null
      ? {}
      : { verificationCorrectionRunId: row.verification_correction_run_id }),
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
    ...(row.verification_correction_run_id === undefined || row.verification_correction_run_id === null
      ? {}
      : { verificationCorrectionRunId: row.verification_correction_run_id }),
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
    ...(row.verification_correction_run_id === undefined || row.verification_correction_run_id === null
      ? {}
      : { verificationCorrectionRunId: row.verification_correction_run_id }),
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
    ...(row.verification_correction_run_id === undefined || row.verification_correction_run_id === null
      ? {}
      : { verificationCorrectionRunId: row.verification_correction_run_id }),
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
    resolvedByQARunId: row.resolved_by_qa_run_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    version: row.version,
  });
};

const qaCorrectionRunFromRow = (value: unknown): QACorrectionRun => {
  const row = qaCorrectionRunRowSchema.parse(value);
  return qaCorrectionRunSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    ordinal: row.ordinal,
    sourceQARunId: row.source_qa_run_id,
    baselineQARunId: row.baseline_qa_run_id,
    sourceEvidenceBundleId: row.source_evidence_bundle_id,
    sourceTestedTree: row.source_tested_tree,
    defectIds: parseJson(row.defect_ids_json),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    version: row.version,
  });
};

const qaRetestPlanFromRow = (value: unknown): QARetestPlan => {
  const row = qaRetestPlanRowSchema.parse(value);
  return qaRetestPlanSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    pipelineRunId: row.pipeline_run_id,
    correctionRunId: row.correction_run_id,
    baselineQARunId: row.baseline_qa_run_id,
    sourceQARunId: row.source_qa_run_id,
    sourceEvidenceBundleId: row.source_evidence_bundle_id,
    baselinePlanRevision: row.baseline_plan_revision,
    baselinePlanContentHash: row.baseline_plan_content_hash,
    cells: parseJson(row.cells_json),
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
    verificationEvidence:
      row.verification_evidence_json === null ? null : parseJson(row.verification_evidence_json),
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
    ...(row.verification_correction_run_id === undefined || row.verification_correction_run_id === null
      ? {}
      : { verificationCorrectionRunId: row.verification_correction_run_id }),
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
    roleProfile:
      row.role_profile_id === null || row.role_profile_revision === null
        ? null
        : { id: row.role_profile_id, revision: row.role_profile_revision },
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
}): OrphanProcessEvent => {
  const { pid, sessionId } = context;
  // Even the reporting is contained: a logger that throws must not be the thing that stops the
  // daemon from starting, having been installed to make this very code observable.
  const report = (event: OrphanProcessEvent): OrphanProcessEvent => {
    try {
      context.report(event);
    } catch {
      // Nothing left to report it to.
    }
    return event;
  };
  try {
    if (!isProcessAlive(pid)) {
      return report({ pid, sessionId, action: "SKIPPED", reason: "ALREADY_GONE" });
    }
    const startedAt = context.processStartedAt(pid);
    if (startedAt === null) {
      return report({ pid, sessionId, action: "SKIPPED", reason: "START_TIME_UNKNOWN" });
    }
    const sessionStartedAtMs = Date.parse(context.sessionStartedAt);
    if (
      Number.isNaN(sessionStartedAtMs) ||
      startedAt.getTime() > sessionStartedAtMs + PID_IDENTITY_TOLERANCE_MS
    ) {
      return report({ pid, sessionId, action: "SKIPPED", reason: "STARTED_AFTER_SESSION" });
    }
    try {
      context.signalProcess(pid, "SIGKILL");
    } catch (cause) {
      // ESRCH is the window this whole comment is about: the process was alive at the check and
      // gone by the signal. Nothing went wrong -- but a kill that did not happen must not be
      // recorded as one, and a pid that vanished mid-probe is worth the one line it costs.
      // Anything else (EPERM above all) says the pid now belongs to a process this daemon may not
      // signal, i.e. the identity guard was wrong, which is louder still.
      return report({
        pid,
        sessionId,
        action: "FAILED",
        reason: errorCodeOf(cause) === "ESRCH" ? "VANISHED_BEFORE_SIGNAL" : "SIGNAL_REFUSED",
      });
    }
    // Reported after the signal landed, never before it: the previous version announced the kill
    // and then attempted it, so a kill that threw was logged as a kill that happened.
    return report({ pid, sessionId, action: "KILLED", reason: "IDENTITY_CONFIRMED" });
  } catch {
    // The liveness check and the default start-time probe both contain their own failures, so this
    // is only reachable through an injected probe -- but "only reachable through" is not "cannot
    // happen", and the cost of being wrong about that is a daemon that will not start.
    return report({ pid, sessionId, action: "FAILED", reason: "PROBE_FAILED" });
  }
};

const orphanProcessNoLongerOwnsAuthority = (event: OrphanProcessEvent): boolean =>
  event.action === "KILLED" ||
  event.reason === "ALREADY_GONE" ||
  event.reason === "STARTED_AFTER_SESSION" ||
  event.reason === "VANISHED_BEFORE_SIGNAL";

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
    const selectProviderAllowancesByProject = database.prepare(
      "SELECT * FROM provider_allowance_snapshots WHERE project_id = ? ORDER BY provider",
    );
    const selectProviderAllowance = database.prepare(
      "SELECT * FROM provider_allowance_snapshots WHERE project_id = ? AND provider = ?",
    );
    const upsertProviderAllowance = database.prepare(
      `INSERT INTO provider_allowance_snapshots (
         project_id, provider, schema_version, observed_at, freshness, snapshot_json, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, provider) DO UPDATE SET
         schema_version = excluded.schema_version,
         observed_at = excluded.observed_at,
         freshness = excluded.freshness,
         snapshot_json = excluded.snapshot_json,
         recorded_at = excluded.recorded_at
       WHERE julianday(provider_allowance_snapshots.observed_at) < julianday(excluded.observed_at)`,
    );
    // One statement is the snapshot seam for Insights. Only counts cross it: no row, identifier,
    // free text, timestamp or path can be accidentally handed to the reporting module.
    const selectReportingFacts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM work_items) AS work_items_total,
        (SELECT COUNT(*) FROM work_items WHERE state = 'DONE') AS work_items_accepted,
        (SELECT COUNT(*) FROM work_items WHERE state = 'CANCELLED') AS work_items_cancelled,
        (SELECT COUNT(*) FROM work_items WHERE state IN ('READY', 'IN_PROGRESS', 'BLOCKED')) AS work_items_active,
        (SELECT COUNT(*) FROM pipeline_runs) AS pipeline_runs_total,
        (SELECT COUNT(*) FROM pipeline_runs WHERE orchestration_status = 'SUCCEEDED') AS pipeline_runs_succeeded,
        (SELECT COUNT(*) FROM pipeline_runs WHERE orchestration_status = 'FAILED') AS pipeline_runs_failed,
        (SELECT COUNT(*) FROM pipeline_runs WHERE orchestration_status = 'INTERRUPTED') AS pipeline_runs_interrupted,
        (SELECT COUNT(*) FROM pipeline_runs WHERE orchestration_status = 'CANCELLED') AS pipeline_runs_cancelled,
        (SELECT COUNT(*) FROM agent_runs) AS agent_runs_total,
        (SELECT COUNT(*) FROM agent_runs WHERE status = 'SUCCEEDED') AS agent_runs_succeeded,
        (SELECT COUNT(*) FROM agent_runs WHERE status = 'FAILED') AS agent_runs_failed,
        (SELECT COUNT(*) FROM agent_runs WHERE status = 'INTERRUPTED') AS agent_runs_interrupted,
        (SELECT COUNT(*) FROM review_reports) AS reviews_total,
        (SELECT COUNT(*) FROM review_reports WHERE round = 1) AS reviews_first_round,
        (SELECT COUNT(*) FROM review_reports WHERE round = 1 AND verdict = 'PASSED') AS reviews_first_round_passed,
        (SELECT COUNT(*) FROM qa_runs) AS qa_total,
        (SELECT COUNT(*) FROM qa_runs WHERE status = 'PASSED') AS qa_passed,
        (SELECT COUNT(*) FROM qa_runs WHERE status = 'FAILED') AS qa_failed,
        (SELECT COUNT(*) FROM qa_runs WHERE status = 'ERROR') AS qa_errored,
        (SELECT COUNT(*) FROM qa_defects WHERE status = 'OPEN') AS qa_defects_open,
        (SELECT COUNT(*) FROM qa_defects WHERE status = 'RESOLVED') AS qa_defects_resolved,
        (SELECT COUNT(*) FROM qa_defects WHERE status = 'WAIVED') AS qa_defects_waived,
        (SELECT COUNT(*) FROM human_requests) AS human_requests_total,
        (SELECT COUNT(*) FROM human_requests WHERE status = 'RESOLVED') AS human_requests_resolved,
        (SELECT COALESCE(SUM(amount), 0) FROM usage_records) AS estimated_tokens,
        (SELECT COUNT(*) FROM recovery_reports WHERE reason = 'DAEMON_RESTART') AS daemon_restart_recoveries
    `);
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
    const selectLatestVerificationPlan = database.prepare(
      `SELECT * FROM verification_plans
       WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
    );
    const selectVerificationPlanById = database.prepare("SELECT * FROM verification_plans WHERE id = ?");
    const selectLatestVerificationPlanPublication = database.prepare(
      `SELECT publication.* FROM verification_plan_publications AS publication
       INNER JOIN verification_plans AS plan ON plan.id = publication.plan_id
       WHERE publication.project_id = ? ORDER BY plan.revision DESC LIMIT 1`,
    );
    const selectVerificationPlanPublicationById = database.prepare(
      "SELECT * FROM verification_plan_publications WHERE id = ?",
    );
    const selectPendingVerificationPlanPublications = database.prepare(
      `SELECT * FROM verification_plan_publications
       WHERE status = 'PENDING' ORDER BY created_at, id`,
    );
    const insertVerificationPlan = database.prepare(
      `INSERT INTO verification_plans (
         id, schema_version, project_id, revision, status, source_proposal_hash,
         content_hash, plan_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVerificationPlanPublication = database.prepare(
      `INSERT INTO verification_plan_publications (
         id, schema_version, project_id, plan_id, target_path, expected_target_digest,
         content_hash, status, attempts, last_error_code, version, created_at, updated_at, applied_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateVerificationPlanPublication = database.prepare(
      `UPDATE verification_plan_publications SET
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
       WHERE id = ? AND version = ? AND lease_holder IS NULL AND verification_holder IS NULL`,
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
       WHERE id = ? AND version = ? AND status = 'READY' AND verification_holder IS NULL`,
    );
    // Startup reconciliation's own read (Task 10, spec §6 "Восстановление"): every workspace whose
    // worktree might have gone missing while nothing was watching it. ORPHANED and REMOVED rows are
    // already-settled facts this check has nothing left to say about.
    const selectReadyWorkItemWorkspaces = database.prepare(
      "SELECT * FROM work_item_workspaces WHERE status = 'READY' ORDER BY created_at, id",
    );
    const selectVerificationRunById = database.prepare("SELECT * FROM verification_runs WHERE id = ?");
    const selectVerificationRunsByWorkItem = database.prepare(
      "SELECT * FROM verification_runs WHERE work_item_id = ? ORDER BY ordinal DESC LIMIT ?",
    );
    const selectActiveVerificationRuns = database.prepare(
      "SELECT * FROM verification_runs WHERE status IN ('QUEUED', 'RUNNING', 'CANCELLING') ORDER BY created_at, id",
    );
    const selectActiveVerificationRunByWorkspace = database.prepare(
      `SELECT * FROM verification_runs
       WHERE workspace_id = ? AND status IN ('QUEUED', 'RUNNING', 'CANCELLING') LIMIT 1`,
    );
    const selectMaxVerificationRunOrdinal = database.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM verification_runs WHERE work_item_id = ?",
    );
    const insertVerificationRun = database.prepare(
      `INSERT INTO verification_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, workspace_id, plan_id,
        plan_revision, plan_content_hash, implementation_tree, ordinal, retry_of_run_id,
        verification_correction_run_id, platform, status, current_check_id, terminal_reason,
        started_at, completed_at, created_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateVerificationRun = database.prepare(
      `UPDATE verification_runs SET
        status = ?, current_check_id = ?, terminal_reason = ?, started_at = ?, completed_at = ?,
        version = ?
       WHERE id = ? AND version = ?`,
    );
    const selectVerificationCheckById = database.prepare("SELECT * FROM verification_checks WHERE id = ?");
    const selectVerificationChecksByRun = database.prepare(
      "SELECT * FROM verification_checks WHERE run_id = ? ORDER BY ordinal",
    );
    const selectVerificationFailuresByWorkItem = database.prepare(
      "SELECT * FROM verification_failures WHERE work_item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    );
    const selectVerificationFailureById = database.prepare(
      "SELECT * FROM verification_failures WHERE id = ?",
    );
    const selectVerificationFailureByRun = database.prepare(
      "SELECT * FROM verification_failures WHERE verification_run_id = ?",
    );
    const selectVerificationCorrectionsByWorkItem = database.prepare(
      `SELECT * FROM verification_correction_runs
       WHERE work_item_id = ? ORDER BY budget_position DESC, id DESC LIMIT ?`,
    );
    const selectVerificationCorrectionById = database.prepare(
      "SELECT * FROM verification_correction_runs WHERE id = ?",
    );
    const selectMaxQAStageAttemptForCorrection = database.prepare(
      `SELECT COALESCE(MAX(attempt), 0) AS max_ordinal
       FROM stage_attempts
       WHERE correction_run_id = ? AND stage = 'QA'`,
    );
    const selectLatestFailedVerificationRunForCorrection = database.prepare(
      `SELECT verification_runs.* FROM verification_runs
       INNER JOIN verification_failures
         ON verification_failures.verification_run_id = verification_runs.id
       WHERE verification_runs.verification_correction_run_id = ?
         AND (
           verification_runs.status IN ('FAILED', 'ERROR')
           OR (
             verification_runs.status = 'INTERRUPTED'
             AND verification_failures.reason = 'RUN_INTERRUPTED'
           )
           OR (
             verification_runs.status = 'PASSED'
             AND verification_failures.reason = 'STALE'
           )
         )
       ORDER BY verification_runs.ordinal DESC LIMIT 1`,
    );
    const selectLatestFailedVerificationRunWithoutCorrection = database.prepare(
      `SELECT verification_runs.* FROM verification_runs
       INNER JOIN verification_failures
         ON verification_failures.verification_run_id = verification_runs.id
       WHERE verification_runs.pipeline_run_id = ?
         AND verification_runs.verification_correction_run_id IS NULL
         AND (
           verification_runs.status IN ('FAILED', 'ERROR')
           OR (
             verification_runs.status = 'INTERRUPTED'
             AND verification_failures.reason = 'RUN_INTERRUPTED'
           )
           OR (
             verification_runs.status = 'PASSED'
             AND verification_failures.reason = 'STALE'
           )
         )
       ORDER BY verification_runs.ordinal DESC LIMIT 1`,
    );
    const selectCorrectionBudgetUsage = database.prepare(
      `SELECT
         COUNT(*) FILTER (WHERE automatic = 1) AS automatic_used,
         COUNT(*) AS total_used
       FROM correction_budget_entries
       WHERE pipeline_run_id = ?`,
    );
    const insertCorrectionBudgetEntry = database.prepare(
      `INSERT INTO correction_budget_entries (
        id, project_id, work_item_id, pipeline_run_id, position, automatic, evaluator,
        correction_run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVerificationCorrectionRun = database.prepare(
      `INSERT INTO verification_correction_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, budget_position,
        automatic, source_failure_id, source_verification_run_id, source_implementation_tree,
        resumes_qa_correction_run_id, status, created_at, completed_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateVerificationCorrectionRun = database.prepare(
      `UPDATE verification_correction_runs
       SET status = ?, completed_at = ?, version = ?
       WHERE id = ? AND version = ?`,
    );
    const insertVerificationFailure = database.prepare(
      `INSERT INTO verification_failures (
        id, schema_version, project_id, work_item_id, pipeline_run_id, verification_run_id,
        verification_check_id, plan_id, plan_revision, plan_content_hash, implementation_tree,
        reason, stale_reasons_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVerificationCheck = database.prepare(
      `INSERT INTO verification_checks (
        id, schema_version, project_id, work_item_id, run_id, recipe_id, ordinal, required, status,
        started_at, completed_at, duration_ms, exit_code, signal, error_code, output_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateVerificationCheck = database.prepare(
      `UPDATE verification_checks SET
        status = ?, started_at = ?, completed_at = ?, duration_ms = ?, exit_code = ?, signal = ?,
        error_code = ?, output_json = ?, version = ?
       WHERE id = ? AND version = ?`,
    );
    const claimWorkspaceForVerification = database.prepare(
      `UPDATE work_item_workspaces
       SET verification_holder = ?, version = version + 1
       WHERE id = ? AND version = ? AND status = 'READY'
         AND lease_holder IS NULL AND verification_holder IS NULL`,
    );
    const releaseWorkspaceFromVerification = database.prepare(
      `UPDATE work_item_workspaces
       SET verification_holder = NULL, version = version + 1
       WHERE id = ? AND verification_holder = ?`,
    );
    const insertVerificationOutputArtifact = database.prepare(
      `INSERT INTO verification_output_artifacts (
        artifact_id, schema_version, project_id, work_item_id, run_id, check_id, storage_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectVerificationOutputArtifactByCheck = database.prepare(
      `SELECT artifact_id, run_id, check_id, storage_key
       FROM verification_output_artifacts WHERE check_id = ?`,
    );
    const selectVerificationOutputArtifactById = database.prepare(
      "SELECT artifact_id FROM verification_output_artifacts WHERE artifact_id = ?",
    );
    const selectVerificationOutputArtifactByStorageKey = database.prepare(
      "SELECT artifact_id FROM verification_output_artifacts WHERE storage_key = ? LIMIT 1",
    );
    const selectVerificationOutputRetentionById = database.prepare(
      "SELECT * FROM verification_output_retention_log WHERE artifact_id = ?",
    );
    const insertVerificationOutputRetention = database.prepare(
      `INSERT INTO verification_output_retention_log (artifact_id, outcome, recorded_at)
       VALUES (?, ?, ?)`,
    );
    const selectExpiredVerificationOutputs = database.prepare(
      `SELECT artifact.artifact_id, artifact.run_id, artifact.check_id, artifact.storage_key
       FROM verification_output_artifacts AS artifact
       JOIN work_items AS work_item ON work_item.id = artifact.work_item_id
       LEFT JOIN verification_output_retention_log AS retention
         ON retention.artifact_id = artifact.artifact_id
       WHERE work_item.state IN ('DONE', 'CANCELLED')
         AND work_item.updated_at < ?
         AND retention.artifact_id IS NULL
       ORDER BY work_item.updated_at, artifact.artifact_id
       LIMIT ?`,
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
             AND stage_attempts.failure_code IN (${sessionPauseFailureCodes.map(() => "?").join(", ")}) THEN 3
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
    const selectLatestAgentRunForStageAttempt = database.prepare(
      "SELECT * FROM agent_runs WHERE stage_attempt_id = ? ORDER BY ordinal DESC, rowid DESC LIMIT 1",
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
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    );
    const selectLatestSucceededDeveloperAgentRunForCycle = database.prepare(
      `SELECT agent_runs.* FROM agent_runs
       INNER JOIN stage_attempts ON stage_attempts.id = agent_runs.stage_attempt_id
       WHERE agent_runs.pipeline_run_id = ?
         AND stage_attempts.correction_run_id IS ?
         AND stage_attempts.verification_correction_run_id IS ?
         AND agent_runs.profile_role = 'DEVELOPER'
         AND agent_runs.status = 'SUCCEEDED'
       ORDER BY agent_runs.finished_at DESC, agent_runs.rowid DESC LIMIT 1`,
    );
    const selectLatestSucceededImplementAttemptForCycle = database.prepare(
      `SELECT * FROM stage_attempts
       WHERE pipeline_run_id = ? AND correction_run_id IS ?
         AND verification_correction_run_id IS ?
         AND stage = 'IMPLEMENT' AND status = 'SUCCEEDED' AND result_tree IS NOT NULL
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    );
    const selectLatestSucceededImplementTreeForCycle = database.prepare(
      `SELECT result_tree FROM stage_attempts
       WHERE pipeline_run_id = ? AND correction_run_id IS ?
         AND verification_correction_run_id IS ?
         AND stage = 'IMPLEMENT' AND status = 'SUCCEEDED' AND result_tree IS NOT NULL
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    );
    const selectOpenReviewFindingsForCycle = database.prepare(
      `SELECT * FROM review_findings
       WHERE pipeline_run_id = ? AND correction_run_id IS ?
         AND verification_correction_run_id IS ? AND status = 'OPEN'
       ORDER BY created_at, id LIMIT 200`,
    );
    const countReviewReportsForCycle = database.prepare(
      `SELECT COUNT(*) AS count FROM review_reports
       WHERE pipeline_run_id = ? AND correction_run_id IS ?
         AND verification_correction_run_id IS ?`,
    );
    const selectReviewReportByStageAttempt = database.prepare(
      "SELECT * FROM review_reports WHERE stage_attempt_id = ? ORDER BY rowid DESC LIMIT 1",
    );
    const selectReviewFindingById = database.prepare("SELECT * FROM review_findings WHERE id = ?");
    const selectQADefectById = database.prepare("SELECT * FROM qa_defects WHERE id = ?");
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
        policy_snapshot_json, policy_snapshot_hash, started_at, finished_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateAgentRunStatus = database.prepare(
      `UPDATE agent_runs SET status = ?, finished_at = ?, version = ?
       WHERE id = ? AND version = ? AND status = 'RUNNING'`,
    );
    const selectQARunById = database.prepare("SELECT * FROM qa_runs WHERE id = ?");
    const selectFailedQARunByStageAttempt = database.prepare(
      `SELECT * FROM qa_runs
       WHERE stage_attempt_id = ? AND status = 'FAILED'
       ORDER BY completed_at DESC, rowid DESC LIMIT 1`,
    );
    const selectQARunByAgentRun = database.prepare("SELECT * FROM qa_runs WHERE agent_run_id = ?");
    const selectQARunsForPipeline = database.prepare(
      "SELECT * FROM qa_runs WHERE pipeline_run_id = ? ORDER BY started_at, id",
    );
    const insertQARun = database.prepare(
      `INSERT INTO qa_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        agent_run_id, driver_id, tested_tree, target_origin, plan_json, correction_run_id,
        retest_plan_id, verification_correction_run_id, status, error_code, error_summary,
        started_at, completed_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const completeQARun = database.prepare(
      `UPDATE qa_runs SET status = ?, error_code = ?, error_summary = ?, completed_at = ?, version = ?
       WHERE id = ? AND version = ? AND status = 'RUNNING'`,
    );
    const insertQAEvidenceBundle = database.prepare(
      `INSERT INTO qa_evidence_bundles (
        id, schema_version, qa_run_id, project_id, work_item_id, pipeline_run_id,
        stage_attempt_id, verification_correction_run_id, tested_tree, verdict, environment_json,
        executions_json, observations_json, attachment_ids_json, defect_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectQAEvidenceBundleById = database.prepare("SELECT * FROM qa_evidence_bundles WHERE id = ?");
    const selectQAEvidenceBundleByQARun = database.prepare(
      "SELECT * FROM qa_evidence_bundles WHERE qa_run_id = ?",
    );
    const selectQAEvidenceBundlesForPipeline = database.prepare(
      "SELECT * FROM qa_evidence_bundles WHERE pipeline_run_id = ? ORDER BY created_at, id",
    );
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
        resolution_reason, resolved_by_qa_run_id, created_at, resolved_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectCurrentQACorrectionRun = database.prepare(
      `SELECT * FROM qa_correction_runs
       WHERE pipeline_run_id = ? AND status IN ('ACTIVE', 'EXHAUSTED')
       ORDER BY ordinal DESC LIMIT 1`,
    );
    const selectQACorrectionRunById = database.prepare("SELECT * FROM qa_correction_runs WHERE id = ?");
    const selectQACorrectionRunsForPipeline = database.prepare(
      "SELECT * FROM qa_correction_runs WHERE pipeline_run_id = ? ORDER BY ordinal, id",
    );
    const selectLatestFailedRetestForCorrection = database.prepare(
      `SELECT * FROM qa_runs
       WHERE correction_run_id = ? AND status = 'FAILED'
       ORDER BY completed_at DESC, rowid DESC LIMIT 1`,
    );
    const selectQARetestPlanById = database.prepare("SELECT * FROM qa_retest_plans WHERE id = ?");
    const selectQARetestPlanByCorrection = database.prepare(
      "SELECT * FROM qa_retest_plans WHERE correction_run_id = ?",
    );
    const selectQARetestPlansForPipeline = database.prepare(
      "SELECT * FROM qa_retest_plans WHERE pipeline_run_id = ? ORDER BY created_at, id",
    );
    const selectQADefectsForPipeline = database.prepare(
      `SELECT qa_defects.* FROM qa_defects
       INNER JOIN qa_runs ON qa_runs.id = qa_defects.qa_run_id
       WHERE qa_runs.pipeline_run_id = ?
       ORDER BY qa_defects.created_at, qa_defects.id`,
    );
    const selectOpenQADefectsForPipeline = database.prepare(
      `SELECT qa_defects.* FROM qa_defects
       INNER JOIN qa_runs ON qa_runs.id = qa_defects.qa_run_id
       WHERE qa_runs.pipeline_run_id = ? AND qa_defects.status = 'OPEN'
       ORDER BY qa_defects.created_at, qa_defects.id`,
    );
    const selectPassedReviewForCorrectionTree = database.prepare(
      `SELECT * FROM review_reports
       WHERE pipeline_run_id = ? AND correction_run_id = ? AND reviewed_tree = ? AND verdict = 'PASSED'
       ORDER BY round DESC, rowid DESC LIMIT 1`,
    );
    const insertQACorrectionRun = database.prepare(
      `INSERT INTO qa_correction_runs (
        id, schema_version, project_id, work_item_id, pipeline_run_id, ordinal,
        source_qa_run_id, baseline_qa_run_id, source_evidence_bundle_id, source_tested_tree,
        defect_ids_json, status, created_at, completed_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateQACorrectionRun = database.prepare(
      `UPDATE qa_correction_runs SET status = ?, completed_at = ?, version = ?
       WHERE id = ? AND version = ? AND status IN ('ACTIVE', 'EXHAUSTED')`,
    );
    const insertQARetestPlan = database.prepare(
      `INSERT INTO qa_retest_plans (
        id, schema_version, project_id, work_item_id, pipeline_run_id, correction_run_id,
        baseline_qa_run_id, source_qa_run_id, source_evidence_bundle_id,
        baseline_plan_revision, baseline_plan_content_hash, cells_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const selectProviderUsageReportBySession = database.prepare(
      "SELECT * FROM provider_usage_reports WHERE provider_session_id = ?",
    );
    const selectProviderUsageReportsForAttempt = database.prepare(
      "SELECT * FROM provider_usage_reports WHERE stage_attempt_id = ? ORDER BY recorded_at, id",
    );
    const selectProviderUsageReportsForAgentRun = database.prepare(
      "SELECT * FROM provider_usage_reports WHERE agent_run_id = ? ORDER BY recorded_at, id",
    );
    const insertProviderUsageReport = database.prepare(
      `INSERT INTO provider_usage_reports (
        id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
        agent_run_id, provider_session_id, usage_record_id, input_tokens, output_tokens,
        cached_input_tokens, reasoning_output_tokens, total_tokens, cost_usd, quality,
        usage_digest, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectRunningProviderSession = database.prepare(
      "SELECT id FROM provider_sessions WHERE stage_attempt_id = ? AND status = 'RUNNING' LIMIT 1",
    );
    const selectLatestDispatchByStageAttempt = database.prepare(
      "SELECT * FROM workflow_dispatches WHERE stage_attempt_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
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
        role_profile_id, role_profile_revision, sections_json, omitted_json, content_hash,
        estimated_tokens, budget_tokens, estimate_quality, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // "Latest" is decided by the session ordinal and then the checkpoint ordinal within it, never
    // by timestamp: two checkpoints published in the same millisecond (or across a clock step)
    // would otherwise be tie-broken by a random UUID and hand the next session stale progress.
    const selectLatestCheckpointForAttempt = database.prepare(
      `SELECT checkpoints.* FROM checkpoints
       INNER JOIN provider_sessions ON provider_sessions.id = checkpoints.provider_session_id
       WHERE checkpoints.stage_attempt_id = ?
       ORDER BY provider_sessions.ordinal DESC, checkpoints.ordinal DESC LIMIT 1`,
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

    const readLatestVerificationPlan = (projectId: string): VerificationPlan | null => {
      const row = selectLatestVerificationPlan.get(projectId);
      return row === undefined ? null : verificationPlanFromRow(row);
    };

    const readVerificationPlan = (id: string): VerificationPlan | null => {
      const row = selectVerificationPlanById.get(id);
      return row === undefined ? null : verificationPlanFromRow(row);
    };

    const readVerificationPlanPublication = (id: string): VerificationPlanPublication | null => {
      const row = selectVerificationPlanPublicationById.get(id);
      return row === undefined ? null : verificationPlanPublicationFromRow(row);
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

    const readWorkspaceVerificationHolder = (workspaceId: string): string | null => {
      const row = selectWorkItemWorkspaceById.get(workspaceId);
      return row === undefined ? null : workItemWorkspaceRowSchema.parse(row).verification_holder;
    };

    const readVerificationRun = (runId: string): VerificationRun | null => {
      const row = selectVerificationRunById.get(runId);
      return row === undefined ? null : verificationRunFromRow(row);
    };

    const readVerificationCheck = (checkId: string): VerificationCheck | null => {
      const row = selectVerificationCheckById.get(checkId);
      return row === undefined ? null : verificationCheckFromRow(row);
    };

    const readVerificationChecks = (runId: string): VerificationCheck[] =>
      selectVerificationChecksByRun.all(runId).map(verificationCheckFromRow);

    const readLatestVerificationRun = (workItemId: string): VerificationRun | null => {
      const row = selectVerificationRunsByWorkItem.get(workItemId, 1);
      return row === undefined ? null : verificationRunFromRow(row);
    };

    const readVerificationFailure = (id: string): VerificationFailure | null => {
      const row = selectVerificationFailureById.get(id);
      return row === undefined ? null : verificationFailureFromRow(row);
    };

    const readVerificationFailureForRun = (runId: string): VerificationFailure | null => {
      const row = selectVerificationFailureByRun.get(runId);
      return row === undefined ? null : verificationFailureFromRow(row);
    };

    const readVerificationCorrectionRun = (id: string): VerificationCorrectionRun | null => {
      const row = selectVerificationCorrectionById.get(id);
      return row === undefined ? null : verificationCorrectionRunFromRow(row);
    };

    const insertVerificationFailureRecord = (failure: VerificationFailure): void => {
      insertVerificationFailure.run(
        failure.id,
        failure.schemaVersion,
        failure.projectId,
        failure.workItemId,
        failure.pipelineRunId,
        failure.verificationRunId,
        failure.verificationCheckId,
        failure.planId,
        failure.planRevision,
        failure.planContentHash,
        failure.implementationTree,
        failure.reason,
        JSON.stringify(failure.staleReasons),
        failure.createdAt,
      );
    };

    const persistVerificationFailure = (
      run: VerificationRun,
      checks: readonly VerificationCheck[],
      createdAt: string,
    ): ReturnType<typeof deriveVerificationFailure> => {
      const decision = deriveVerificationFailure({
        failureId: createId("verificationFailure"),
        run,
        checks,
        now: createdAt,
      });
      insertVerificationFailureRecord(decision.failure);
      return decision;
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

    const readCurrentQACorrectionRun = (pipelineRunId: string): QACorrectionRun | null => {
      const value = selectCurrentQACorrectionRun.get(pipelineRunId);
      return value === undefined ? null : qaCorrectionRunFromRow(value);
    };

    const readQACorrectionRun = (correctionRunId: string): QACorrectionRun | null => {
      const value = selectQACorrectionRunById.get(correctionRunId);
      return value === undefined ? null : qaCorrectionRunFromRow(value);
    };

    const readQARetestPlan = (retestPlanId: string): QARetestPlan | null => {
      const value = selectQARetestPlanById.get(retestPlanId);
      return value === undefined ? null : qaRetestPlanFromRow(value);
    };

    const readOpenQADefects = (pipelineRunId: string): QADefect[] =>
      selectOpenQADefectsForPipeline.all(pipelineRunId).map(qaDefectFromRow);

    const readQACorrectionHistory = (pipelineRunId: string) => ({
      correctionRuns: selectQACorrectionRunsForPipeline.all(pipelineRunId).map(qaCorrectionRunFromRow),
      retestPlans: selectQARetestPlansForPipeline.all(pipelineRunId).map(qaRetestPlanFromRow),
      qaRuns: selectQARunsForPipeline.all(pipelineRunId).map(qaRunFromRow),
      evidenceBundles: selectQAEvidenceBundlesForPipeline.all(pipelineRunId).map(qaEvidenceBundleFromRow),
      defects: selectQADefectsForPipeline.all(pipelineRunId).map(qaDefectFromRow),
    });

    const readQACorrectionDefects = (correctionRun: QACorrectionRun): QADefect[] =>
      correctionRun.defectIds.map((defectId) => {
        const value = selectQADefectById.get(defectId);
        if (value === undefined) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "A QA correction references a defect that no longer exists",
          );
        }
        return qaDefectFromRow(value);
      });

    const readCurrentBudgetPolicy = (pipelineRunId: string): BudgetPolicy | null => {
      const value = selectCurrentBudgetPolicy.get(pipelineRunId);
      return value === undefined ? null : budgetPolicyFromRow(value);
    };

    const readUsageRecords = (pipelineRunId: string): UsageRecord[] =>
      database
        .prepare("SELECT * FROM usage_records WHERE pipeline_run_id = ? ORDER BY rowid")
        .all(pipelineRunId)
        .map(usageRecordFromRow);

    const readProviderUsageReportsForAgentRun = (agentRunId: string): ProviderUsageReport[] =>
      selectProviderUsageReportsForAgentRun.all(agentRunId).map(providerUsageReportFromRow);

    const readEvidenceArtifacts = (pipelineRunId: string): EvidenceArtifact[] =>
      database
        .prepare("SELECT * FROM evidence_artifacts WHERE pipeline_run_id = ? ORDER BY created_at, id")
        .all(pipelineRunId)
        .map(evidenceArtifactFromRow);

    // Acceptance may follow several Review/QA correction rounds, but only the Review and measured
    // QA artifacts bound to the current correction lineage and implementation tree are authority
    // for the package. Supplying every historical check to the provider lets it select a real but
    // stale check which decideApplyProviderOutcome must then reject. This selector mirrors that
    // decision's evidence predicates and is shared by context assembly and terminal validation.
    const acceptanceEvidenceArtifacts = (
      run: PipelineRun,
      stageAttempt: StageAttempt,
      artifacts: readonly EvidenceArtifact[],
    ): EvidenceArtifact[] => {
      if (stageAttempt.stage !== "ACCEPTANCE") return [];
      const treeValue = selectLatestSucceededImplementTreeForCycle.get(
        run.id,
        stageAttempt.correctionRunId,
        stageAttempt.verificationCorrectionRunId ?? null,
      );
      if (treeValue === undefined) return [];
      const currentTree = resultTreeRowSchema.parse(treeValue).result_tree;
      const qaArtifact = artifacts.find(
        (artifact) =>
          artifact.kind === "QA_REPORT" &&
          artifact.correctionRunId === stageAttempt.correctionRunId &&
          (artifact.verificationCorrectionRunId ?? null) ===
            (stageAttempt.verificationCorrectionRunId ?? null) &&
          artifact.testedTree === currentTree,
      );
      if (qaArtifact === undefined) return [];
      const reviewArtifact = artifacts.find(
        (artifact) =>
          artifact.kind === "REVIEW_REPORT" &&
          artifact.correctionRunId === qaArtifact.correctionRunId &&
          (artifact.verificationCorrectionRunId ?? null) ===
            (qaArtifact.verificationCorrectionRunId ?? null) &&
          (qaArtifact.correctionRunId === null
            ? artifact.testedTree === undefined || artifact.testedTree === qaArtifact.testedTree
            : artifact.reviewReportId !== undefined && artifact.testedTree === qaArtifact.testedTree),
      );
      return reviewArtifact === undefined ? [qaArtifact] : [reviewArtifact, qaArtifact];
    };

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
                const implementationValue = selectLatestSucceededImplementAttemptForCycle.get(
                  run.id,
                  stageAttempt.correctionRunId,
                  stageAttempt.verificationCorrectionRunId ?? null,
                );
                const authorValue = selectLatestSucceededDeveloperAgentRunForCycle.get(
                  run.id,
                  stageAttempt.correctionRunId,
                  stageAttempt.verificationCorrectionRunId ?? null,
                );
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
                  // Git and the leased worktree are infrastructure concerns. The daemon fills this
                  // derived field after this coherent durable snapshot commits and refuses REVIEW
                  // if the measured tree no longer matches implementationAttempt.resultTree.
                  diffSummary: null,
                  openFindings: selectOpenReviewFindingsForCycle
                    .all(
                      run.id,
                      stageAttempt.correctionRunId,
                      stageAttempt.verificationCorrectionRunId ?? null,
                    )
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

        const runningAgentRunValue = selectRunningAgentRunForStageAttempt.get(stageAttempt.id);
        const runningPolicySnapshot =
          runningAgentRunValue === undefined ? null : agentRunFromRow(runningAgentRunValue).policySnapshot;
        const constitutionReference = runningPolicySnapshot?.projectConstitution;
        // Legacy session-only tests and pre-binding AgentRuns have no field to consult and retain
        // the old current-active read. Every newly created AgentRun writes explicit null or an
        // exact content reference, so a later owner activation cannot change that run's context.
        const activeConstitution =
          constitutionReference === undefined
            ? readActiveProjectConstitution(workItem.projectId)
            : constitutionReference === null
              ? null
              : readProjectConstitutionVersion(constitutionReference.id);
        if (
          constitutionReference !== undefined &&
          constitutionReference !== null &&
          (activeConstitution?.projectId !== workItem.projectId ||
            activeConstitution.contentDigest !== constitutionReference.contentDigest)
        ) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The AgentRun Project Constitution reference is unavailable or no longer matches",
          );
        }
        const projectConstitution =
          activeConstitution === null
            ? null
            : {
                id: activeConstitution.id,
                version: constitutionReference?.version ?? activeConstitution.version,
                ordinal: activeConstitution.ordinal,
                contentDigest: activeConstitution.contentDigest,
                renderedMarkdown: activeConstitution.renderedMarkdown,
              };

        const qaCorrection =
          stageAttempt.correctionRunId === null
            ? null
            : (() => {
                const correctionRun = readQACorrectionRun(stageAttempt.correctionRunId);
                const retestPlanValue = selectQARetestPlanByCorrection.get(stageAttempt.correctionRunId);
                if (correctionRun === null || retestPlanValue === undefined) {
                  throw new StateStoreError(
                    "PERSISTENCE_FAILURE",
                    "The correction context authority is incomplete",
                  );
                }
                const retestPlan = qaRetestPlanFromRow(retestPlanValue);
                const sourceQARunValue = selectQARunById.get(correctionRun.sourceQARunId);
                const sourceEvidenceValue = selectQAEvidenceBundleById.get(
                  correctionRun.sourceEvidenceBundleId,
                );
                if (sourceQARunValue === undefined || sourceEvidenceValue === undefined) {
                  throw new StateStoreError(
                    "PERSISTENCE_FAILURE",
                    "The correction source evidence is incomplete",
                  );
                }
                const sourceQARun = qaRunFromRow(sourceQARunValue);
                const sourceEvidence = qaEvidenceBundleFromRow(sourceEvidenceValue);
                const currentTreeValue = selectLatestSucceededImplementTreeForCycle.get(
                  run.id,
                  correctionRun.id,
                  null,
                );
                const currentTree =
                  currentTreeValue === undefined
                    ? sourceQARun.testedTree
                    : resultTreeRowSchema.parse(currentTreeValue).result_tree;
                return {
                  correctionRun: {
                    id: correctionRun.id,
                    version: correctionRun.version,
                    ordinal: correctionRun.ordinal,
                    status: correctionRun.status,
                  },
                  sourceQARun: {
                    id: sourceQARun.id,
                    version: sourceQARun.version,
                    testedTree: sourceQARun.testedTree,
                    targetOrigin: sourceQARun.targetOrigin,
                  },
                  sourceEvidence: { id: sourceEvidence.id, version: 1 },
                  retestPlan: {
                    id: retestPlan.id,
                    version: 1,
                    baselineQARunId: retestPlan.baselineQARunId,
                    baselinePlanRevision: retestPlan.baselinePlanRevision,
                    baselinePlanContentHash: retestPlan.baselinePlanContentHash,
                    cells: retestPlan.cells,
                  },
                  currentTree,
                  defects: readQACorrectionDefects(correctionRun).map((defect) => ({
                    id: defect.id,
                    version: defect.version,
                    severity: defect.severity,
                    status: defect.status,
                    title: defect.title,
                    description: defect.description,
                    reproduction: defect.reproduction,
                    targetId: defect.targetId,
                    scenarioId: defect.scenarioId,
                  })),
                };
              })();

        const evidenceArtifacts =
          stageAttempt.stage === "ACCEPTANCE"
            ? acceptanceEvidenceArtifacts(run, stageAttempt, readEvidenceArtifacts(run.id))
            : readRecentEvidenceArtifacts(run.id, MAX_CONTEXT_SOURCE_RECORDS);
        const evidence = evidenceArtifacts.map((artifact) => ({
          id: artifact.id,
          version: 1,
          kind: artifact.kind,
          title: artifact.title,
          summary: artifact.summary,
          checks: artifact.checks,
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
          projectConstitution,
          qaCorrection,
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

    const insertProjectVerificationPlan = (plan: VerificationPlan): void => {
      insertVerificationPlan.run(
        plan.id,
        plan.schemaVersion,
        plan.projectId,
        plan.revision,
        plan.status,
        plan.sourceProposalHash,
        plan.contentHash,
        JSON.stringify(plan),
        plan.createdAt,
      );
    };

    const insertProjectVerificationPublication = (publication: VerificationPlanPublication): void => {
      insertVerificationPlanPublication.run(
        publication.id,
        publication.schemaVersion,
        publication.projectId,
        publication.planId,
        publication.targetPath,
        publication.expectedTargetDigest,
        publication.contentHash,
        publication.status,
        publication.attempts,
        publication.lastErrorCode,
        publication.version,
        publication.createdAt,
        publication.updatedAt,
        publication.appliedAt,
      );
    };

    const updateProjectVerificationPublication = (
      publication: VerificationPlanPublication,
      expectedVersion: number,
    ): void => {
      const update = updateVerificationPlanPublication.run(
        publication.status,
        publication.attempts,
        publication.lastErrorCode,
        publication.version,
        publication.updatedAt,
        publication.appliedAt,
        publication.id,
        expectedVersion,
      );
      if (update.changes !== 1) {
        throw new VerificationDomainError(
          "PUBLICATION_VERSION_CONFLICT",
          "The verification publication changed while the command was applied",
        );
      }
    };

    const persistNewVerificationRun = (run: VerificationRun, checks: readonly VerificationCheck[]): void => {
      insertVerificationRun.run(
        run.id,
        run.schemaVersion,
        run.projectId,
        run.workItemId,
        run.pipelineRunId,
        run.workspaceId,
        run.planId,
        run.planRevision,
        run.planContentHash,
        run.implementationTree,
        run.ordinal,
        run.retryOfRunId,
        run.verificationCorrectionRunId ?? null,
        run.platform,
        run.status,
        run.currentCheckId,
        run.terminalReason,
        run.startedAt,
        run.completedAt,
        run.createdAt,
        run.version,
      );
      for (const check of checks) {
        insertVerificationCheck.run(
          check.id,
          check.schemaVersion,
          check.projectId,
          check.workItemId,
          check.runId,
          check.recipeId,
          check.ordinal,
          check.required ? 1 : 0,
          check.status,
          check.startedAt,
          check.completedAt,
          check.durationMs,
          check.exitCode,
          check.signal,
          check.errorCode,
          check.output === null ? null : JSON.stringify(check.output),
          check.version,
        );
      }
    };

    const persistVerificationRunUpdate = (run: VerificationRun, previousVersion: number): void => {
      const update = updateVerificationRun.run(
        run.status,
        run.currentCheckId,
        run.terminalReason,
        run.startedAt,
        run.completedAt,
        run.version,
        run.id,
        previousVersion,
      );
      if (update.changes !== 1) {
        throw new VerificationDomainError(
          "RUN_VERSION_CONFLICT",
          "The verification Run changed while the command was applied",
        );
      }
    };

    const persistVerificationCheckUpdate = (check: VerificationCheck, previousVersion: number): void => {
      const update = updateVerificationCheck.run(
        check.status,
        check.startedAt,
        check.completedAt,
        check.durationMs,
        check.exitCode,
        check.signal,
        check.errorCode,
        check.output === null ? null : JSON.stringify(check.output),
        check.version,
        check.id,
        previousVersion,
      );
      if (update.changes !== 1) {
        throw new VerificationDomainError(
          "CHECK_VERSION_CONFLICT",
          "The verification Check changed while the command was applied",
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

    const appendVerificationPlanEvent = (
      intent:
        VerificationPlanAdoptedIntent | VerificationPlanDisabledIntent | VerificationPlanPublicationIntent,
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

    const appendVerificationRunEvent = (
      intent: VerificationRunEventIntent,
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

    const appendProviderAllowanceEvent = (
      intent: ProviderAllowanceRecordedIntent,
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
      | RecordProviderUsageDecision["events"][number]
      | BudgetOverrideDecision["events"][number]
      | RecoveryDecision["events"][number]
      | QADefectDispositionDecision["events"][number]
      | FailedQACorrectionTransition["events"][number]
      | StartedVerificationCorrectionTransition["events"][number]
      | PassedVerificationCorrectionTransition["event"]
      | SubsequentFailedVerificationCorrectionTransition["events"][number]
      | VerificationCorrectionGateResolution["events"][number]
      | VerificationCorrectionCancellation["events"][number]
      | PassedQACorrectionTransition["events"][number]
      | QACorrectionGateResolution["events"][number]
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
            id, pipeline_run_id, project_id, work_item_id, correction_run_id,
            verification_correction_run_id, stage, attempt, status, version, started_at,
            finished_at, failure_code, unproductive_sessions, pack_share_backoffs, result_tree
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.id,
          attempt.pipelineRunId,
          attempt.projectId,
          attempt.workItemId,
          attempt.correctionRunId,
          attempt.verificationCorrectionRunId ?? null,
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
            max_estimated_tokens, model_tier_override, agent_run_max_estimated_tokens_override,
            warning_thresholds_json, actor_type, actor_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          policy.id,
          policy.schemaVersion,
          policy.projectId,
          policy.workItemId,
          policy.pipelineRunId,
          policy.revision,
          policy.maxEstimatedTokens,
          policy.modelTierOverride ?? null,
          policy.agentRunMaxEstimatedTokensOverride ?? null,
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

    const persistProviderUsageReport = (report: ProviderUsageReport): void => {
      insertProviderUsageReport.run(
        report.id,
        report.schemaVersion,
        report.projectId,
        report.workItemId,
        report.pipelineRunId,
        report.stageAttemptId,
        report.agentRunId,
        report.providerSessionId,
        report.usageRecordId,
        report.inputTokens,
        report.outputTokens,
        report.cachedInputTokens,
        report.reasoningOutputTokens,
        report.totalTokens,
        report.costUsd,
        report.quality,
        report.usageDigest,
        report.recordedAt,
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
            correction_run_id, verification_correction_run_id, stage, kind, status, provider,
            title, summary, checks_json, review_report_id, qa_run_id, qa_evidence_bundle_id,
            tested_tree, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.schemaVersion,
          artifact.projectId,
          artifact.workItemId,
          artifact.pipelineRunId,
          artifact.stageAttemptId,
          artifact.correctionRunId,
          artifact.verificationCorrectionRunId ?? null,
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
            correction_run_id, verification_correction_run_id, author_agent_run_id,
            reviewer_agent_run_id, provider_relation, reviewed_tree, round, title, summary,
            checks_json, verdict, finding_ids_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          report.id,
          report.schemaVersion,
          report.projectId,
          report.workItemId,
          report.pipelineRunId,
          report.stageAttemptId,
          report.correctionRunId,
          report.verificationCorrectionRunId ?? null,
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
            correction_run_id, verification_correction_run_id, review_artifact_id, reviewed_tree,
            ordinal, severity, status, title, description, path, start_line, end_line, reproduction,
            criterion, suggested_fix, resolution_reason, resolved_by_type, resolved_by_id,
            created_at, resolved_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          finding.id,
          finding.schemaVersion,
          finding.projectId,
          finding.workItemId,
          finding.pipelineRunId,
          finding.stageAttemptId,
          finding.correctionRunId,
          finding.verificationCorrectionRunId ?? null,
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

    const updateQADefect = (defect: QADefect): void => {
      const update = database
        .prepare(
          `UPDATE qa_defects SET
            status = ?, resolution_reason = ?, resolved_by_qa_run_id = ?, resolved_at = ?, version = ?
           WHERE id = ? AND version = ? AND status = 'OPEN'`,
        )
        .run(
          defect.status,
          defect.resolutionReason,
          defect.resolvedByQARunId,
          defect.resolvedAt,
          defect.version,
          defect.id,
          defect.version - 1,
        );
      if (update.changes !== 1) {
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The QA defect changed while its disposition was being recorded",
        );
      }
    };

    const persistQACorrectionRun = (
      correctionRun: QACorrectionRun,
      allocation: { position: number; automatic: boolean },
    ): void => {
      insertCorrectionBudgetEntry.run(
        createId("correctionBudgetEntry"),
        correctionRun.projectId,
        correctionRun.workItemId,
        correctionRun.pipelineRunId,
        allocation.position,
        allocation.automatic ? 1 : 0,
        "BROWSER_QA",
        correctionRun.id,
        correctionRun.createdAt,
      );
      insertQACorrectionRun.run(
        correctionRun.id,
        correctionRun.schemaVersion,
        correctionRun.projectId,
        correctionRun.workItemId,
        correctionRun.pipelineRunId,
        correctionRun.ordinal,
        correctionRun.sourceQARunId,
        correctionRun.baselineQARunId,
        correctionRun.sourceEvidenceBundleId,
        correctionRun.sourceTestedTree,
        JSON.stringify(correctionRun.defectIds),
        correctionRun.status,
        correctionRun.createdAt,
        correctionRun.completedAt,
        correctionRun.version,
      );
    };

    const persistVerificationCorrectionRun = (
      correctionRun: StartedVerificationCorrectionTransition["correctionRun"],
    ): void => {
      insertCorrectionBudgetEntry.run(
        createId("correctionBudgetEntry"),
        correctionRun.projectId,
        correctionRun.workItemId,
        correctionRun.pipelineRunId,
        correctionRun.budgetPosition,
        correctionRun.automatic ? 1 : 0,
        "PROJECT_VERIFICATION",
        correctionRun.id,
        correctionRun.createdAt,
      );
      insertVerificationCorrectionRun.run(
        correctionRun.id,
        correctionRun.schemaVersion,
        correctionRun.projectId,
        correctionRun.workItemId,
        correctionRun.pipelineRunId,
        correctionRun.budgetPosition,
        correctionRun.automatic ? 1 : 0,
        correctionRun.sourceFailureId,
        correctionRun.sourceVerificationRunId,
        correctionRun.sourceImplementationTree,
        correctionRun.resumesQACorrectionRunId ?? null,
        correctionRun.status,
        correctionRun.createdAt,
        correctionRun.completedAt,
        correctionRun.version,
      );
    };

    const persistUpdatedVerificationCorrectionRun = (correctionRun: VerificationCorrectionRun): void => {
      const update = updateVerificationCorrectionRun.run(
        correctionRun.status,
        correctionRun.completedAt,
        correctionRun.version,
        correctionRun.id,
        correctionRun.version - 1,
      );
      if (update.changes !== 1) {
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The Project verification correction changed while its workflow transition was recorded",
        );
      }
    };

    const persistUpdatedQACorrectionRun = (correctionRun: QACorrectionRun): void => {
      const update = updateQACorrectionRun.run(
        correctionRun.status,
        correctionRun.completedAt,
        correctionRun.version,
        correctionRun.id,
        correctionRun.version - 1,
      );
      if (update.changes !== 1) {
        throw new StateStoreError(
          "PERSISTENCE_FAILURE",
          "The QA correction changed while its workflow transition was being recorded",
        );
      }
    };

    const persistQARetestPlan = (retestPlan: QARetestPlan): void => {
      insertQARetestPlan.run(
        retestPlan.id,
        retestPlan.schemaVersion,
        retestPlan.projectId,
        retestPlan.workItemId,
        retestPlan.pipelineRunId,
        retestPlan.correctionRunId,
        retestPlan.baselineQARunId,
        retestPlan.sourceQARunId,
        retestPlan.sourceEvidenceBundleId,
        retestPlan.baselinePlanRevision,
        retestPlan.baselinePlanContentHash,
        JSON.stringify(retestPlan.cells),
        retestPlan.createdAt,
      );
    };

    const insertAcceptancePackage = (acceptancePackage: AcceptancePackage): void => {
      database
        .prepare(
          `INSERT INTO acceptance_packages (
            id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
            human_request_id, status, criteria_json, verification_evidence_json, artifact_ids_json, release_note,
            verify_instructions_json, version, created_at, resolved_at, resolved_by_type,
            resolved_by_id, resolution_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          acceptancePackage.verificationEvidence === undefined ||
            acceptancePackage.verificationEvidence === null
            ? null
            : JSON.stringify(acceptancePackage.verificationEvidence),
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
             verification_evidence_json = ?, release_note = ?, verify_instructions_json = ?, version = ?, resolved_at = ?,
             resolved_by_type = ?, resolved_by_id = ?, resolution_reason = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          acceptancePackage.status,
          JSON.stringify(acceptancePackage.criteria),
          JSON.stringify(acceptancePackage.artifactIds),
          acceptancePackage.verificationEvidence === undefined ||
            acceptancePackage.verificationEvidence === null
            ? null
            : JSON.stringify(acceptancePackage.verificationEvidence),
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

    type PersistedVerificationFailureWorkflow = {
      workItemId: string;
      projectId: string;
      events: readonly WorkflowEventIntent[];
    };

    /** Persists the bounded workflow continuation sourced by one immutable verification failure. */
    const persistVerificationFailureWorkflow = (
      verificationRun: VerificationRun,
      failure: VerificationFailure,
      occurredAt: string,
    ): PersistedVerificationFailureWorkflow | null => {
      if (
        failure.reason !== "REQUIRED_CHECK_FAILED" &&
        failure.reason !== "REQUIRED_CHECK_ERROR" &&
        failure.reason !== "RUN_INTERRUPTED"
      ) {
        return null;
      }
      const pipelineRun = readPipelineRun(verificationRun.pipelineRunId);
      const workItem = readWorkItem(verificationRun.workItemId);
      const stageAttempt = pipelineRun === null ? null : readStageAttempt(pipelineRun.currentStageAttemptId);
      const dispatch = stageAttempt === null ? null : readPendingDispatch(stageAttempt.id);
      if (pipelineRun === null || workItem === null || stageAttempt === null || dispatch === null) {
        return null;
      }
      const usage = correctionBudgetUsageRowSchema.parse(
        selectCorrectionBudgetUsage.get(verificationRun.pipelineRunId),
      );
      const budgetUsage = {
        automaticUsed: usage.automatic_used,
        totalUsed: usage.total_used,
      };
      const canStartAutomatically =
        usage.automatic_used < MAX_AUTOMATIC_CORRECTION_RUNS && usage.total_used < MAX_TOTAL_CORRECTION_RUNS;
      const currentCorrectionId = verificationRun.verificationCorrectionRunId ?? null;

      if (
        currentCorrectionId === null &&
        canStartAutomatically &&
        workItem.currentStage === "QA" &&
        pipelineRun.status === "RUNNING" &&
        pipelineRun.currentStageAttemptId === stageAttempt.id &&
        stageAttempt.stage === "QA" &&
        stageAttempt.status === "QUEUED" &&
        (stageAttempt.verificationCorrectionRunId ?? null) === null
      ) {
        const qaCorrectionRun =
          stageAttempt.correctionRunId === null ? null : readQACorrectionRun(stageAttempt.correctionRunId);
        if (stageAttempt.correctionRunId !== null && qaCorrectionRun === null) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The active Browser QA correction lineage is incomplete",
          );
        }
        const decision = decideInitialFailedVerificationCorrectionTransition({
          verificationRun,
          failure,
          workItem,
          pipelineRun,
          stageAttempt,
          dispatch,
          ...(qaCorrectionRun === null ? {} : { qaCorrectionRun }),
          budgetUsage,
          ids: {
            correctionRunId: createId("verificationCorrectionRun"),
            nextStageAttemptId: createId("stageAttempt"),
            nextDispatchId: createId("workflowDispatch"),
          },
          now: occurredAt,
        });
        persistVerificationCorrectionRun(decision.correctionRun);
        updateWorkflowDispatch(decision.completedDispatch);
        updateStageAttempt(decision.completedStageAttempt);
        updatePipelineRun(decision.pipelineRun);
        updateWorkflowWorkItem(decision.workItem);
        insertStageAttempt(decision.nextStageAttempt);
        insertWorkflowDispatch(decision.nextDispatch);
        return {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          events: decision.events,
        };
      }

      if (
        currentCorrectionId === null &&
        !canStartAutomatically &&
        stageAttempt.correctionRunId !== null &&
        (stageAttempt.verificationCorrectionRunId ?? null) === null
      ) {
        const qaCorrectionRun = readQACorrectionRun(stageAttempt.correctionRunId);
        if (qaCorrectionRun === null) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The mixed Project verification owner gate has no active Browser QA correction",
          );
        }
        const decision = decideInitialFailedVerificationCorrectionGateTransition({
          verificationRun,
          failure,
          qaCorrectionRun,
          workItem,
          pipelineRun,
          stageAttempt,
          dispatch,
          budgetUsage,
          ids: {
            humanRequestId: createId("humanRequest"),
            authorizeFinalOptionId: createId("humanRequestOption"),
            cancelOptionId: createId("humanRequestOption"),
          },
          now: occurredAt,
        });
        updateWorkflowDispatch(decision.completedDispatch);
        updateStageAttempt(decision.completedStageAttempt);
        updatePipelineRun(decision.pipelineRun);
        updateWorkflowWorkItem(decision.workItem);
        insertHumanRequest(decision.request);
        return {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          events: decision.events,
        };
      }

      if (currentCorrectionId !== null) {
        const currentCorrection = readVerificationCorrectionRun(currentCorrectionId);
        const correctionSourceVerificationRun =
          currentCorrection === null ? null : readVerificationRun(currentCorrection.sourceVerificationRunId);
        if (currentCorrection === null || correctionSourceVerificationRun === null) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The active Project verification correction lineage is incomplete",
          );
        }
        const decision = decideSubsequentFailedVerificationCorrectionTransition({
          verificationRun,
          failure,
          correctionRun: currentCorrection,
          correctionSourceVerificationRun,
          workItem,
          pipelineRun,
          stageAttempt,
          dispatch,
          budgetUsage,
          ids: {
            correctionRunId: createId("verificationCorrectionRun"),
            nextStageAttemptId: createId("stageAttempt"),
            nextDispatchId: createId("workflowDispatch"),
            humanRequestId: createId("humanRequest"),
            authorizeFinalOptionId: createId("humanRequestOption"),
            cancelOptionId: createId("humanRequestOption"),
          },
          now: occurredAt,
        });
        persistUpdatedVerificationCorrectionRun(decision.previousCorrection);
        updateWorkflowDispatch(decision.completedDispatch);
        updateStageAttempt(decision.completedStageAttempt);
        updatePipelineRun(decision.pipelineRun);
        updateWorkflowWorkItem(decision.workItem);
        if (decision.correctionRun !== null) persistVerificationCorrectionRun(decision.correctionRun);
        if (decision.nextStageAttempt !== null) insertStageAttempt(decision.nextStageAttempt);
        if (decision.nextDispatch !== null) insertWorkflowDispatch(decision.nextDispatch);
        if (decision.request !== null) insertHumanRequest(decision.request);
        return {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          events: decision.events,
        };
      }

      return null;
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

      if (command.type === "ADOPT_VERIFICATION_PLAN") {
        const project = readProject(command.payload.projectId);
        const currentPlan = readLatestVerificationPlan(command.payload.projectId);
        const newPlanId = createId("verificationPlan");
        const newPublicationId = createId("verificationPlanPublication");
        const planContent = {
          schemaVersion: 1 as const,
          id: newPlanId,
          projectId: command.payload.projectId,
          revision: (currentPlan?.revision ?? 0) + 1,
          status: "ACTIVE" as const,
          recipes: command.payload.proposal.recipes,
          sourceProposalHash: command.payload.proposal.proposalHash,
          createdAt: occurredAt,
        };
        const decision = decideVerificationPlanAdoption(command, {
          now: occurredAt,
          newPlanId,
          newPublicationId,
          contentHash: verificationPlanContentHash(planContent),
          observedProposalHash: verificationPlanProposalHash(command.payload.proposal),
          project: project ?? undefined,
          ...(currentPlan === null ? {} : { currentPlan }),
        });
        const update = database
          .prepare(
            `UPDATE projects SET version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            decision.project.version,
            decision.project.updatedAt,
            decision.project.id,
            decision.project.version - 1,
          );
        if (update.changes !== 1) {
          throw new VerificationDomainError(
            "PROJECT_VERSION_CONFLICT",
            "The Project changed while the verification plan was adopted",
          );
        }
        insertProjectVerificationPlan(decision.plan);
        insertProjectVerificationPublication(decision.publication);
        const event = appendVerificationPlanEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_PLAN_ADOPTED",
          replayed: false,
          plan: decision.plan,
          publication: decision.publication,
          event,
        });
      }

      if (command.type === "DISABLE_VERIFICATION_PLAN") {
        const project = readProject(command.payload.projectId);
        const currentPlan = readLatestVerificationPlan(command.payload.projectId);
        const newPlanId = createId("verificationPlan");
        const newPublicationId = createId("verificationPlanPublication");
        const planContent = {
          schemaVersion: 1 as const,
          id: newPlanId,
          projectId: command.payload.projectId,
          revision: (currentPlan?.revision ?? 0) + 1,
          status: "DISABLED" as const,
          recipes: currentPlan?.recipes ?? [],
          sourceProposalHash: currentPlan?.sourceProposalHash ?? "",
          createdAt: occurredAt,
        };
        const decision = decideVerificationPlanDisable(command, {
          now: occurredAt,
          newPlanId,
          newPublicationId,
          contentHash: currentPlan === null ? "0".repeat(64) : verificationPlanContentHash(planContent),
          project: project ?? undefined,
          currentPlan: currentPlan ?? undefined,
        });
        const update = database
          .prepare(
            `UPDATE projects SET version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            decision.project.version,
            decision.project.updatedAt,
            decision.project.id,
            decision.project.version - 1,
          );
        if (update.changes !== 1) {
          throw new VerificationDomainError(
            "PROJECT_VERSION_CONFLICT",
            "The Project changed while the verification plan was disabled",
          );
        }
        insertProjectVerificationPlan(decision.plan);
        insertProjectVerificationPublication(decision.publication);
        const event = appendVerificationPlanEvent(decision.event, {
          projectId: decision.project.id,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_PLAN_DISABLED",
          replayed: false,
          plan: decision.plan,
          publication: decision.publication,
          event,
        });
      }

      if (
        command.type === "COMPLETE_VERIFICATION_PLAN_PUBLICATION" ||
        command.type === "FAIL_VERIFICATION_PLAN_PUBLICATION"
      ) {
        const currentPublication = readVerificationPlanPublication(command.payload.publicationId);
        const plan = currentPublication === null ? null : readVerificationPlan(currentPublication.planId);
        const decision =
          command.type === "COMPLETE_VERIFICATION_PLAN_PUBLICATION"
            ? decideVerificationPlanPublicationCompleted(command, {
                now: occurredAt,
                plan: plan ?? undefined,
                publication: currentPublication ?? undefined,
              })
            : decideVerificationPlanPublicationFailed(command, {
                now: occurredAt,
                plan: plan ?? undefined,
                publication: currentPublication ?? undefined,
              });
        updateProjectVerificationPublication(decision.publication, command.payload.expectedVersion);
        const event = appendVerificationPlanEvent(decision.event, {
          projectId: decision.plan.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: decision.event.type,
          replayed: false,
          plan: decision.plan,
          publication: decision.publication,
          event,
        });
      }

      if (command.type === "RETRY_VERIFICATION_PLAN_PUBLICATION") {
        const currentPublication = readVerificationPlanPublication(command.payload.publicationId);
        const plan = currentPublication === null ? null : readVerificationPlan(currentPublication.planId);
        const latestPlan = readLatestVerificationPlan(command.payload.projectId);
        const decision = decideVerificationPlanPublicationRetry(command, {
          now: occurredAt,
          latestPlanRevision: latestPlan?.revision ?? 0,
          plan: plan ?? undefined,
          publication: currentPublication ?? undefined,
        });
        updateProjectVerificationPublication(decision.publication, command.payload.expectedVersion);
        const event = appendVerificationPlanEvent(decision.event, {
          projectId: decision.plan.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_PLAN_PUBLICATION_RETRIED",
          replayed: false,
          plan: decision.plan,
          publication: decision.publication,
          event,
        });
      }

      if (command.type === "MATERIALIZE_STALE_VERIFICATION_FAILURE") {
        const workItem = readWorkItem(command.payload.workItemId);
        const verificationRun = readVerificationRun(command.payload.verificationRunId);
        const latestVerificationRun = readLatestVerificationRun(command.payload.workItemId);
        const pipelineRun = verificationRun === null ? null : readPipelineRun(verificationRun.pipelineRunId);
        const stageAttempt =
          pipelineRun === null ? null : readStageAttempt(pipelineRun.currentStageAttemptId);
        const dispatch = stageAttempt === null ? null : readPendingDispatch(stageAttempt.id);
        const currentPlan = workItem === null ? null : readLatestVerificationPlan(workItem.projectId);
        const publicationRow =
          workItem === null ? undefined : selectLatestVerificationPlanPublication.get(workItem.projectId);
        const publication =
          publicationRow === undefined ? null : verificationPlanPublicationFromRow(publicationRow);
        const existingFailure =
          verificationRun === null ? null : readVerificationFailureForRun(verificationRun.id);
        const qaCorrectionRun =
          stageAttempt?.correctionRunId === undefined || stageAttempt.correctionRunId === null
            ? null
            : readQACorrectionRun(stageAttempt.correctionRunId);
        const previousPassedCorrectionRun =
          verificationRun?.verificationCorrectionRunId === undefined ||
          verificationRun.verificationCorrectionRunId === null
            ? null
            : readVerificationCorrectionRun(verificationRun.verificationCorrectionRunId);
        if (
          workItem === null ||
          verificationRun === null ||
          pipelineRun === null ||
          stageAttempt === null ||
          dispatch === null
        ) {
          throw new VerificationCorrectionError(
            "REQUEST_INVALID",
            "The stale Project verification gate does not exist",
          );
        }
        const usage = correctionBudgetUsageRowSchema.parse(selectCorrectionBudgetUsage.get(pipelineRun.id));
        const decision = decideStaleVerificationFailureTransition({
          command,
          verificationRun,
          latestVerificationRunId: latestVerificationRun?.id ?? null,
          existingFailure,
          currentPlan: currentPlan ?? undefined,
          publication: publication ?? undefined,
          workItem,
          pipelineRun,
          stageAttempt,
          dispatch,
          ...(qaCorrectionRun === null ? {} : { qaCorrectionRun }),
          ...(previousPassedCorrectionRun === null ? {} : { previousPassedCorrectionRun }),
          budgetUsage: {
            automaticUsed: usage.automatic_used,
            totalUsed: usage.total_used,
          },
          ids: {
            failureId: createId("verificationFailure"),
            correctionRunId: createId("verificationCorrectionRun"),
            nextStageAttemptId: createId("stageAttempt"),
            nextDispatchId: createId("workflowDispatch"),
            humanRequestId: createId("humanRequest"),
            authorizeFinalOptionId: createId("humanRequestOption"),
            cancelOptionId: createId("humanRequestOption"),
          },
          now: occurredAt,
        });
        insertVerificationFailureRecord(decision.failure);
        if (decision.correctionRun !== null) {
          persistVerificationCorrectionRun(decision.correctionRun);
        }
        updateWorkflowDispatch(decision.completedDispatch);
        updateStageAttempt(decision.completedStageAttempt);
        updatePipelineRun(decision.pipelineRun);
        updateWorkflowWorkItem(decision.workItem);
        if (decision.nextStageAttempt !== null) insertStageAttempt(decision.nextStageAttempt);
        if (decision.nextDispatch !== null) insertWorkflowDispatch(decision.nextDispatch);
        if (decision.request !== null) insertHumanRequest(decision.request);
        const failureEvent = appendVerificationRunEvent(decision.failureEvent, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        const workflowEvents = appendWorkflowEvents(decision.events, {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_STALE_FAILURE_MATERIALIZED",
          replayed: false,
          action: decision.action,
          workItemId: decision.workItem.id,
          failure: decision.failure,
          correctionRun: decision.correctionRun,
          request: decision.request,
          run: decision.pipelineRun,
          stageAttempt: decision.completedStageAttempt,
          dispatch: decision.nextDispatch,
          events: [failureEvent, ...workflowEvents],
        });
      }

      if (command.type === "START_VERIFICATION_RUN" || command.type === "RETRY_VERIFICATION_RUN") {
        const workItem = readWorkItem(command.payload.workItemId);
        const project = workItem === null ? null : readProject(workItem.projectId);
        const pipelineRun = readLatestPipelineRun(command.payload.workItemId);
        const workspace = readWorkItemWorkspaceByWorkItemId(command.payload.workItemId);
        const plan = project === null ? null : readLatestVerificationPlan(project.id);
        const publicationRow =
          project === null ? undefined : selectLatestVerificationPlanPublication.get(project.id);
        const publication =
          publicationRow === undefined ? null : verificationPlanPublicationFromRow(publicationRow);
        const retryOfRun =
          command.type === "RETRY_VERIFICATION_RUN"
            ? readVerificationRun(command.payload.retryOfRunId)
            : null;
        if (
          workspace !== null &&
          (readWorkspaceVerificationHolder(workspace.id) !== null ||
            selectActiveVerificationRunByWorkspace.get(workspace.id) !== undefined)
        ) {
          throw new StateStoreError(
            "VERIFICATION_RUN_ALREADY_ACTIVE",
            "The workspace already has an active verification Run",
          );
        }
        const ordinal =
          workItem === null
            ? 1
            : maxOrdinalRowSchema.parse(selectMaxVerificationRunOrdinal.get(workItem.id)).max_ordinal + 1;
        const currentStageAttempt =
          pipelineRun === null ? null : readStageAttempt(pipelineRun.currentStageAttemptId);
        const verificationCorrectionRunId =
          workItem?.currentStage === "QA" && currentStageAttempt?.stage === "QA"
            ? (currentStageAttempt.verificationCorrectionRunId ?? null)
            : null;
        const decision = decideVerificationRunReservation(command, {
          now: occurredAt,
          newRunId: createId("verificationRun"),
          newCheckIds: (plan?.recipes ?? []).map(() => createId("verificationCheck")),
          ordinal,
          project: project ?? undefined,
          workItem: workItem ?? undefined,
          pipelineRun: pipelineRun ?? undefined,
          workspace: workspace ?? undefined,
          plan: plan ?? undefined,
          publication: publication ?? undefined,
          verificationCorrectionRunId,
          ...(retryOfRun === null ? {} : { retryOfRun }),
        });
        persistNewVerificationRun(decision.run, decision.checks);
        const claim = claimWorkspaceForVerification.run(
          decision.run.id,
          decision.run.workspaceId,
          workspace?.version ?? 0,
        );
        if (claim.changes !== 1) {
          throw new VerificationDomainError(
            "WORKSPACE_UNAVAILABLE",
            "The workspace changed while verification was reserved",
          );
        }
        const event = appendVerificationRunEvent(decision.event, {
          workItemId: decision.run.workItemId,
          projectId: decision.run.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_RUN_RESERVED",
          replayed: false,
          run: decision.run,
          checks: decision.checks,
          event,
        });
      }

      if (command.type === "START_VERIFICATION_CHECK") {
        const run = readVerificationRun(command.payload.runId);
        if (run === null) {
          throw new StateStoreError("VERIFICATION_RUN_NOT_FOUND", "The verification Run does not exist");
        }
        const check = readVerificationCheck(command.payload.checkId);
        if (check === null) {
          throw new StateStoreError("VERIFICATION_CHECK_NOT_FOUND", "The verification Check does not exist");
        }
        const decision = decideVerificationCheckStart({
          actor: command.actor,
          run,
          check,
          checks: readVerificationChecks(run.id),
          expectedRunVersion: command.payload.expectedRunVersion,
          expectedCheckVersion: command.payload.expectedCheckVersion,
          now: occurredAt,
        });
        persistVerificationRunUpdate(decision.run, run.version);
        persistVerificationCheckUpdate(decision.check, check.version);
        const event = appendVerificationRunEvent(
          { type: "VERIFICATION_CHECK_STARTED", data: decision },
          {
            workItemId: run.workItemId,
            projectId: run.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_CHECK_STARTED",
          replayed: false,
          ...decision,
          event,
        });
      }

      if (command.type === "COMPLETE_VERIFICATION_CHECK") {
        const run = readVerificationRun(command.payload.runId);
        if (run === null) {
          throw new StateStoreError("VERIFICATION_RUN_NOT_FOUND", "The verification Run does not exist");
        }
        const check = readVerificationCheck(command.payload.checkId);
        if (check === null) {
          throw new StateStoreError("VERIFICATION_CHECK_NOT_FOUND", "The verification Check does not exist");
        }
        const decision = decideVerificationCheckCompletion({
          actor: command.actor,
          run,
          check,
          checks: readVerificationChecks(run.id),
          expectedRunVersion: command.payload.expectedRunVersion,
          expectedCheckVersion: command.payload.expectedCheckVersion,
          observation: command.payload.observation,
        });
        persistVerificationRunUpdate(decision.run, run.version);
        persistVerificationCheckUpdate(decision.check, check.version);
        if (command.payload.outputStorageKey !== null && decision.check.output !== null) {
          insertVerificationOutputArtifact.run(
            decision.check.output.artifactId,
            1,
            decision.check.projectId,
            decision.check.workItemId,
            decision.check.runId,
            decision.check.id,
            command.payload.outputStorageKey,
            command.payload.observation.completedAt,
          );
        }
        if (decision.next === "TERMINAL") {
          const release = releaseWorkspaceFromVerification.run(run.workspaceId, run.id);
          if (release.changes !== 1) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "The verification workspace reservation could not be released",
            );
          }
        }
        const failureDecision =
          decision.next === "TERMINAL" && decision.run.status !== "PASSED"
            ? persistVerificationFailure(decision.run, readVerificationChecks(run.id), occurredAt)
            : null;
        const correctionWorkflow =
          failureDecision === null
            ? null
            : persistVerificationFailureWorkflow(decision.run, failureDecision.failure, occurredAt);
        let passedCorrection: PassedVerificationCorrectionTransition | null = null;
        let qaHandoff: PassedVerificationCorrectionQAHandoff | null = null;
        const verificationCorrectionRunId = decision.run.verificationCorrectionRunId ?? null;
        if (
          decision.next === "TERMINAL" &&
          decision.run.status === "PASSED" &&
          verificationCorrectionRunId !== null
        ) {
          const correctionRun = readVerificationCorrectionRun(verificationCorrectionRunId);
          const sourceVerificationRun =
            correctionRun === null ? null : readVerificationRun(correctionRun.sourceVerificationRunId);
          const sourceFailure =
            correctionRun === null ? null : readVerificationFailure(correctionRun.sourceFailureId);
          if (correctionRun === null || sourceVerificationRun === null || sourceFailure === null) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "A passing Project verification rerun has incomplete correction lineage",
            );
          }
          passedCorrection = decidePassedVerificationCorrectionTransition({
            verificationRun: decision.run,
            sourceVerificationRun,
            sourceFailure,
            correctionRun,
            now: occurredAt,
          });
          persistUpdatedVerificationCorrectionRun(passedCorrection.correctionRun);
          const resumesQACorrectionRunId = passedCorrection.correctionRun.resumesQACorrectionRunId ?? null;
          if (resumesQACorrectionRunId !== null) {
            const qaCorrectionRun = readQACorrectionRun(resumesQACorrectionRunId);
            const pipelineRun = readPipelineRun(decision.run.pipelineRunId);
            const workItem = readWorkItem(decision.run.workItemId);
            const stageAttempt =
              pipelineRun === null ? null : readStageAttempt(pipelineRun.currentStageAttemptId);
            const dispatch = stageAttempt === null ? null : readPendingDispatch(stageAttempt.id);
            if (
              qaCorrectionRun === null ||
              pipelineRun === null ||
              workItem === null ||
              stageAttempt === null ||
              dispatch === null
            ) {
              throw new StateStoreError(
                "PERSISTENCE_FAILURE",
                "The passing Project verification correction cannot restore its Browser QA lineage",
              );
            }
            const nextQAAttempt =
              maxOrdinalRowSchema.parse(selectMaxQAStageAttemptForCorrection.get(qaCorrectionRun.id))
                .max_ordinal + 1;
            qaHandoff = decidePassedVerificationCorrectionQAHandoff({
              verificationRun: decision.run,
              verificationCorrectionRun: passedCorrection.correctionRun,
              qaCorrectionRun,
              workItem,
              pipelineRun,
              stageAttempt,
              dispatch,
              nextQAAttempt,
              ids: {
                nextStageAttemptId: createId("stageAttempt"),
                nextDispatchId: createId("workflowDispatch"),
              },
              now: occurredAt,
            });
            updateWorkflowDispatch(qaHandoff.completedDispatch);
            updateStageAttempt(qaHandoff.completedStageAttempt);
            updatePipelineRun(qaHandoff.pipelineRun);
            updateWorkflowWorkItem(qaHandoff.workItem);
            insertStageAttempt(qaHandoff.nextStageAttempt);
            insertWorkflowDispatch(qaHandoff.nextDispatch);
          }
        }
        const event = appendVerificationRunEvent(
          { type: "VERIFICATION_CHECK_COMPLETED", data: { run: decision.run, check: decision.check } },
          {
            workItemId: run.workItemId,
            projectId: run.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          },
        );
        if (failureDecision !== null) {
          appendVerificationRunEvent(failureDecision.event, {
            workItemId: run.workItemId,
            projectId: run.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          });
        }
        if (correctionWorkflow !== null) {
          appendWorkflowEvents(correctionWorkflow.events, {
            workItemId: correctionWorkflow.workItemId,
            projectId: correctionWorkflow.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          });
        }
        if (passedCorrection !== null) {
          appendWorkflowEvents([passedCorrection.event], {
            workItemId: passedCorrection.correctionRun.workItemId,
            projectId: passedCorrection.correctionRun.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          });
        }
        if (qaHandoff !== null) {
          appendWorkflowEvents(qaHandoff.events, {
            workItemId: qaHandoff.workItem.id,
            projectId: qaHandoff.workItem.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          });
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_CHECK_COMPLETED",
          replayed: false,
          ...decision,
          event,
        });
      }

      if (command.type === "CANCEL_VERIFICATION_RUN") {
        const run = readVerificationRun(command.payload.runId);
        if (run === null) {
          throw new StateStoreError("VERIFICATION_RUN_NOT_FOUND", "The verification Run does not exist");
        }
        const decision = decideVerificationRunCancellationRequest({
          actor: command.actor,
          run,
          expectedRunVersion: command.payload.expectedRunVersion,
        });
        persistVerificationRunUpdate(decision.run, run.version);
        const event = appendVerificationRunEvent(decision.event, {
          workItemId: run.workItemId,
          projectId: run.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_RUN_CANCELLATION_REQUESTED",
          replayed: false,
          run: decision.run,
          event,
        });
      }

      if (
        command.type === "FINALIZE_VERIFICATION_RUN_CANCELLATION" ||
        command.type === "INTERRUPT_VERIFICATION_RUN"
      ) {
        const run = readVerificationRun(command.payload.runId);
        if (run === null) {
          throw new StateStoreError("VERIFICATION_RUN_NOT_FOUND", "The verification Run does not exist");
        }
        const checks = readVerificationChecks(run.id);
        const currentCheckId = run.currentCheckId;
        const decision = decideVerificationRunInterruption({
          actor: command.actor,
          run,
          checks,
          expectedRunVersion: command.payload.expectedRunVersion,
          reason:
            command.type === "FINALIZE_VERIFICATION_RUN_CANCELLATION"
              ? "OWNER_CANCELLED"
              : command.payload.reason,
          now: occurredAt,
        });
        persistVerificationRunUpdate(decision.run, run.version);
        const interruptedCheck =
          currentCheckId === null
            ? null
            : (decision.checks.find((candidate) => candidate.id === currentCheckId) ?? null);
        const previousCheck =
          currentCheckId === null
            ? null
            : (checks.find((candidate) => candidate.id === currentCheckId) ?? null);
        if (interruptedCheck !== null && previousCheck !== null) {
          persistVerificationCheckUpdate(interruptedCheck, previousCheck.version);
        }
        const release = releaseWorkspaceFromVerification.run(run.workspaceId, run.id);
        if (release.changes !== 1) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The interrupted verification workspace reservation could not be released",
          );
        }
        const intent: VerificationRunEventIntent = {
          type: "VERIFICATION_RUN_INTERRUPTED",
          data: { run: decision.run, interruptedCheck },
        };
        const event = appendVerificationRunEvent(intent, {
          workItemId: run.workItemId,
          projectId: run.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        const failureDecision = persistVerificationFailure(decision.run, decision.checks, occurredAt);
        appendVerificationRunEvent(failureDecision.event, {
          workItemId: run.workItemId,
          projectId: run.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        const correctionWorkflow =
          command.type === "INTERRUPT_VERIFICATION_RUN"
            ? persistVerificationFailureWorkflow(decision.run, failureDecision.failure, occurredAt)
            : null;
        if (correctionWorkflow !== null) {
          appendWorkflowEvents(correctionWorkflow.events, {
            workItemId: correctionWorkflow.workItemId,
            projectId: correctionWorkflow.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          });
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_RUN_INTERRUPTED",
          replayed: false,
          run: decision.run,
          interruptedCheck,
          event,
        });
      }

      if (command.type === "RECORD_VERIFICATION_OUTPUT_RETENTION") {
        if (command.actor.type !== "SYSTEM" || command.actor.id !== "local-daemon") {
          throw new StateStoreError(
            "VERIFICATION_RETENTION_ACTOR_FORBIDDEN",
            "Only the local daemon can record Project verification output retention",
          );
        }
        if (selectVerificationOutputArtifactById.get(command.payload.artifactId) === undefined) {
          throw new StateStoreError(
            "VERIFICATION_OUTPUT_NOT_FOUND",
            "The Project verification output artifact does not exist",
          );
        }
        const existing = selectVerificationOutputRetentionById.get(command.payload.artifactId);
        const retention =
          existing === undefined
            ? {
                artifact_id: command.payload.artifactId,
                outcome: command.payload.outcome,
                recorded_at: occurredAt,
              }
            : verificationOutputRetentionRowSchema.parse(existing);
        if (existing === undefined) {
          insertVerificationOutputRetention.run(
            retention.artifact_id,
            retention.outcome,
            retention.recorded_at,
          );
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_OUTPUT_RETENTION_RECORDED",
          replayed: false,
          artifactId: retention.artifact_id,
          outcome: retention.outcome,
          recordedAt: retention.recorded_at,
        });
      }

      if (command.type === "RECORD_PROVIDER_ALLOWANCE") {
        const project = readProject(command.payload.projectId);
        const currentRow = selectProviderAllowance.get(
          command.payload.projectId,
          command.payload.snapshot.provider,
        );
        const decision = decideRecordProviderAllowance(command, {
          ...(project === null ? {} : { project }),
          ...(currentRow === undefined ? {} : { current: providerAllowanceFromRow(currentRow) }),
        });
        const persisted = upsertProviderAllowance.run(
          command.payload.projectId,
          decision.snapshot.provider,
          decision.snapshot.schemaVersion,
          decision.snapshot.observedAt,
          decision.snapshot.freshness,
          JSON.stringify(decision.snapshot),
          occurredAt,
        );
        if (persisted.changes !== 1) {
          throw new ProviderAllowanceDomainError(
            "PROVIDER_ALLOWANCE_STALE",
            "The provider allowance changed while this observation was being applied",
          );
        }
        options.onProviderAllowanceSnapshotPersisted?.();
        const event = appendProviderAllowanceEvent(decision.event, {
          projectId: command.payload.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROVIDER_ALLOWANCE_RECORDED",
          replayed: false,
          snapshot: decision.snapshot,
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
        let assignment =
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
        let assignmentWasInserted = storedAssignment === undefined;
        if (
          storedAssignment !== undefined &&
          stageAttempt.stage === "ACCEPTANCE" &&
          !assignment.stages.some(({ stage }) => stage === "ACCEPTANCE")
        ) {
          assignment = upgradeLegacyStandardSquadForAcceptance({
            assignment,
            id: createId("squadAssignment"),
            now: occurredAt,
          });
          assignmentWasInserted = true;
        }
        if (assignmentWasInserted) {
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
        const profile = stageProfile === undefined ? null : findBuiltinAgentProfile(stageProfile);
        if (!profile) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "The assigned AgentProfile revision is unavailable",
          );
        }
        const currentBudget = readCurrentBudgetPolicy(workflowRun.id);
        if (currentBudget === null) {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The AgentRun has no current BudgetPolicy");
        }
        const usedEstimatedTokens = readUsageRecords(workflowRun.id).reduce(
          (total, record) => total + record.amount,
          0,
        );
        const mcpProfileRevisionIds = selectEnabledLatestMcpGrantsForProject
          .all(workItem.projectId)
          .map(mcpGrantFromRow)
          .map(({ profileRevisionId }) => profileRevisionId);
        const activeProjectConstitution = readActiveProjectConstitution(workItem.projectId);
        let policySnapshot: AgentRunPolicySnapshot;
        try {
          policySnapshot = resolveAgentRunPolicy({
            assignment,
            profile,
            stage: stageAttempt.stage,
            provider: command.payload.provider,
            claimLimits: command.payload.limits,
            pipelineBudget: {
              id: currentBudget.id,
              revision: currentBudget.revision,
              maxEstimatedTokens: currentBudget.maxEstimatedTokens,
            },
            modelTierOverride: currentBudget.modelTierOverride ?? null,
            ...(command.payload.modelMapping === undefined
              ? {}
              : { modelMapping: command.payload.modelMapping }),
            agentRunMaxEstimatedTokensOverride: currentBudget.agentRunMaxEstimatedTokensOverride ?? null,
            usedEstimatedTokens,
            mcpProfileRevisionIds,
            projectConstitution:
              activeProjectConstitution === null
                ? null
                : {
                    id: activeProjectConstitution.id,
                    version: activeProjectConstitution.version,
                    contentDigest: activeProjectConstitution.contentDigest,
                  },
          });
        } catch (error: unknown) {
          if (error instanceof AgentDomainError && error.code === "AGENT_RUN_BUDGET_EXHAUSTED") {
            // A queued attempt of a running pipeline whose budget is already spent is parked, in
            // this same transaction, rather than refused: a refusal changes nothing durable, so the
            // worker would retry it every pass while the owner sees a stage that never starts and
            // has no pause to override. Any other shape keeps the typed refusal.
            if (
              stageAttempt.status === "QUEUED" &&
              workflowRun.status === "RUNNING" &&
              workflowRun.currentStageAttemptId === stageAttempt.id &&
              dispatch.status === "PENDING"
            ) {
              const parked = decideParkQueuedStageAttemptForBudget({
                now: occurredAt,
                workItem,
                run: workflowRun,
                stageAttempt,
                dispatch,
              });
              updateWorkflowDispatch(parked.dispatch);
              updateStageAttempt(parked.stageAttempt);
              updatePipelineRun(parked.run);
              updateWorkflowWorkItem(parked.workItem);
              const parkedEvents = appendWorkflowEvents(parked.events, {
                workItemId: workItem.id,
                projectId: workItem.projectId,
                actor: command.actor,
                occurredAt,
                correlationId: command.correlationId,
              });
              return stateCommandResultSchema.parse({
                schemaVersion: 1,
                type: "AGENT_RUN_BUDGET_PARKED",
                replayed: false,
                workItemId: workItem.id,
                run: parked.run,
                stageAttempt: parked.stageAttempt,
                dispatch: parked.dispatch,
                events: parkedEvents,
              });
            }
            throw new StateStoreError("AGENT_RUN_BUDGET_EXHAUSTED", error.message);
          }
          throw error;
        }
        const policySnapshotHash = `sha256:${createHash("sha256")
          .update(canonicalJson(policySnapshot))
          .digest("hex")}`;
        const existingWorkspace = readWorkItemWorkspaceByWorkItemId(workItem.id);
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
          policySnapshot,
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
          JSON.stringify(agentRun.policySnapshot),
          agentRun.policySnapshotHash,
          agentRun.startedAt,
          agentRun.finishedAt,
          agentRun.version,
        );

        if (existingWorkspace && stageRunsInWorkspace(stageAttempt.stage)) {
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
        if (assignmentWasInserted) {
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
        const currentCorrection = readCurrentQACorrectionRun(stageAttempt.pipelineRunId);
        const retestPlan =
          command.payload.scope.type === "RETEST"
            ? readQARetestPlan(command.payload.scope.retestPlanId)
            : null;
        let baselineQARun: QARun | null = null;
        if (currentCorrection !== null) {
          const baselineValue = selectQARunById.get(currentCorrection.baselineQARunId);
          if (baselineValue !== undefined) baselineQARun = qaRunFromRow(baselineValue);
        }
        const qaRun = decideQAReservation(command, {
          newQARunId: createId("qaRun"),
          now: occurredAt,
          currentTree,
          stageAttempt,
          agentRun: agentRunFromRow(agentRunValue),
          ...(currentCorrection === null ? {} : { currentCorrection }),
          ...(retestPlan === null ? {} : { retestPlan }),
          ...(baselineQARun === null ? {} : { baselineQARun }),
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
          qaRun.verificationCorrectionRunId ?? null,
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
        const retestPlan =
          current.scope.type === "RETEST" ? readQARetestPlan(current.scope.retestPlanId) : null;
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
          ...(retestPlan === null ? {} : { retestPlan }),
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
              resolvedByQARunId: null,
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
                verificationCorrectionRunId: decision.qaRun.verificationCorrectionRunId ?? null,
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
            evidence.verificationCorrectionRunId ?? null,
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
        const metadata = {
          workItemId: decision.qaRun.workItemId,
          projectId: decision.qaRun.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        if (decision.status === "FAILED") {
          if (evidence === null) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "A measured failed QA run must persist its evidence before correction starts",
            );
          }
          const currentCorrection = readCurrentQACorrectionRun(decision.qaRun.pipelineRunId);
          const usage = correctionBudgetUsageRowSchema.parse(
            selectCorrectionBudgetUsage.get(decision.qaRun.pipelineRunId),
          );
          let baselineQARun = decision.qaRun;
          if (currentCorrection !== null) {
            const baselineValue = selectQARunById.get(currentCorrection.baselineQARunId);
            if (baselineValue === undefined) {
              throw new StateStoreError("PERSISTENCE_FAILURE", "The QA correction baseline no longer exists");
            }
            baselineQARun = qaRunFromRow(baselineValue);
          }
          const correctionDecision = decideFailedQACorrectionTransition({
            qaRun: decision.qaRun,
            sourceEvidence: evidence,
            baselineQARun,
            openDefects: readOpenQADefects(decision.qaRun.pipelineRunId),
            ...(currentCorrection === null ? {} : { currentCorrection }),
            budgetUsage: {
              automaticUsed: usage.automatic_used,
              totalUsed: usage.total_used,
            },
            workItem,
            run: pipelineRun,
            stageAttempt,
            dispatch,
            ids: {
              correctionRunId: createId("qaCorrectionRun"),
              retestPlanId: createId("qaRetestPlan"),
              nextStageAttemptId: createId("stageAttempt"),
              nextDispatchId: createId("workflowDispatch"),
              humanRequestId: createId("humanRequest"),
              authorizeFinalOptionId: createId("humanRequestOption"),
              cancelOptionId: createId("humanRequestOption"),
            },
            now: occurredAt,
          });
          if (correctionDecision.previousCorrection !== null) {
            persistUpdatedQACorrectionRun(correctionDecision.previousCorrection);
          }
          if (correctionDecision.correctionRun !== null) {
            persistQACorrectionRun(correctionDecision.correctionRun, correctionDecision.budgetAllocation);
            persistQARetestPlan(correctionDecision.retestPlan);
          }
          updateWorkflowDispatch(correctionDecision.completedDispatch);
          updateStageAttempt(correctionDecision.completedStageAttempt);
          updatePipelineRun(correctionDecision.run);
          updateWorkflowWorkItem(correctionDecision.workItem);
          if (correctionDecision.nextStageAttempt !== null) {
            insertStageAttempt(correctionDecision.nextStageAttempt);
          }
          if (correctionDecision.nextDispatch !== null) {
            insertWorkflowDispatch(correctionDecision.nextDispatch);
          }
          if (correctionDecision.request !== null) {
            insertHumanRequest(correctionDecision.request);
          }
          const event = appendAgentEvent(
            {
              type: "QA_RUN_COMPLETED",
              data: {
                qaRun: decision.qaRun,
                evidenceBundleId: evidence.id,
                defectIds: defects.map(({ id }) => id),
              },
            },
            metadata,
          );
          // Derived from the attempt the correction decision actually produced, like every sibling
          // branch: an exhausted correction loop leaves the attempt WAITING_HUMAN, and recording its
          // Browser QA run as SUCCEEDED would make the AgentRun history and Insights disagree with it.
          const correctionAgentStatus = terminalAgentRunStatus(
            correctionDecision.completedStageAttempt.status,
          );
          if (correctionAgentStatus) finishActiveAgentRun(stageAttempt.id, correctionAgentStatus, metadata);
          appendWorkflowEvents(correctionDecision.events, metadata);
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
        let passedCorrection: PassedQACorrectionTransition | null = null;
        if (decision.status === "PASSED" && decision.qaRun.scope.type === "RETEST") {
          const currentCorrection = readCurrentQACorrectionRun(decision.qaRun.pipelineRunId);
          const reviewValue = selectPassedReviewForCorrectionTree.get(
            decision.qaRun.pipelineRunId,
            decision.qaRun.scope.correctionRunId,
            decision.qaRun.testedTree,
          );
          const reviewReport = reviewValue === undefined ? null : reviewReportFromRow(reviewValue);
          const reviewArtifactValue =
            reviewReport === null
              ? undefined
              : database
                  .prepare(
                    `SELECT * FROM evidence_artifacts
                     WHERE review_report_id = ? AND kind = 'REVIEW_REPORT' AND status = 'PASSED' LIMIT 1`,
                  )
                  .get(reviewReport.id);
          if (
            currentCorrection === null ||
            evidence === null ||
            reviewReport === null ||
            reviewArtifactValue === undefined
          ) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "A passing QA retest has no active correction, measured evidence, or current independent review",
            );
          }
          passedCorrection = decidePassedQACorrectionTransition({
            qaRun: decision.qaRun,
            evidence,
            currentCorrection,
            defects: readQACorrectionDefects(currentCorrection),
            openDefects: readOpenQADefects(decision.qaRun.pipelineRunId),
            reviewReport,
            reviewArtifact: evidenceArtifactFromRow(reviewArtifactValue),
            now: occurredAt,
          });
          persistUpdatedQACorrectionRun(passedCorrection.correctionRun);
          passedCorrection.resolvedDefects.forEach(updateQADefect);
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
        if (passedCorrection !== null) appendWorkflowEvents(passedCorrection.events, metadata);
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

      if (command.type === "WAIVE_QA_DEFECT") {
        const defectValue = selectQADefectById.get(command.payload.defectId);
        const decision = decideQADefectWaiver(command, {
          defect: defectValue === undefined ? undefined : qaDefectFromRow(defectValue),
          now: occurredAt,
        });
        updateQADefect(decision.defect);
        const events = appendWorkflowEvents(decision.events, {
          workItemId: decision.defect.workItemId,
          projectId: decision.defect.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        const event = events.at(0);
        if (event === undefined) {
          throw new StateStoreError("PERSISTENCE_FAILURE", "The QA defect waiver event was not recorded");
        }
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "QA_DEFECT_WAIVED",
          replayed: false,
          workItemId: decision.defect.workItemId,
          defect: decision.defect,
          event,
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
                const authorValue = selectLatestSucceededDeveloperAgentRunForCycle.get(
                  run.id,
                  stageAttempt.correctionRunId,
                  stageAttempt.verificationCorrectionRunId ?? null,
                );
                const treeValue = selectLatestSucceededImplementTreeForCycle.get(
                  run.id,
                  stageAttempt.correctionRunId,
                  stageAttempt.verificationCorrectionRunId ?? null,
                );
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
                  round:
                    countRowSchema.parse(
                      countReviewReportsForCycle.get(
                        run.id,
                        stageAttempt.correctionRunId,
                        stageAttempt.verificationCorrectionRunId ?? null,
                      ),
                    ).count + 1,
                  openFindings: selectOpenReviewFindingsForCycle
                    .all(
                      run.id,
                      stageAttempt.correctionRunId,
                      stageAttempt.verificationCorrectionRunId ?? null,
                    )
                    .map(reviewFindingFromRow),
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
                const qaArtifact = acceptanceEvidenceArtifacts(run, stageAttempt, existingArtifacts).find(
                  ({ kind }) => kind === "QA_REPORT",
                );
                if (qaArtifact?.testedTree === undefined) return undefined;
                const currentTree = qaArtifact.testedTree;
                return readMeasuredQAForArtifact(qaArtifact, currentTree);
              })()
            : undefined;
        const qaCorrectionHistory =
          measuredQA?.qaRun.scope.type === "RETEST" ? readQACorrectionHistory(run.id) : undefined;
        const projectVerification =
          command.payload.outcome.type === "READY_FOR_ACCEPTANCE"
            ? (() => {
                const currentPlan = readLatestVerificationPlan(workItem.projectId);
                const publicationRow = selectLatestVerificationPlanPublication.get(workItem.projectId);
                const latestRun = readLatestVerificationRun(workItem.id);
                return {
                  projectId: workItem.projectId,
                  workItemId: workItem.id,
                  pipelineRunId: run.id,
                  currentPlan: currentPlan ?? undefined,
                  publication:
                    publicationRow === undefined
                      ? undefined
                      : verificationPlanPublicationFromRow(publicationRow),
                  latestRun: latestRun ?? undefined,
                  checks: latestRun === null ? [] : readVerificationChecks(latestRun.id),
                  currentTree: measuredQA?.currentTree ?? "",
                };
              })()
            : undefined;
        const normalizedCommand = { ...command, type: "APPLY_PROVIDER_OUTCOME" } as const;
        const existingUsageRecords = readUsageRecords(run.id);
        const budgetPolicy = readCurrentBudgetPolicy(run.id);
        const decisionContext = {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          dispatch,
          budgetPolicy,
          existingUsageRecords,
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
          projectVerification,
          qaCorrectionHistory,
          qaRunRequired,
          // Pre-R1 fixture workflows completed Review without AgentRun reservation. Keep those
          // historical migration paths readable, while every scheduled live reviewer is held to
          // the structured independent-review contract.
          reviewRequired: runningReviewerValue !== undefined,
          humanRequestId: createId("humanRequest"),
          acceptancePackageId: createId("acceptancePackage"),
          nextStageAttemptId: createId("stageAttempt"),
          nextDispatchId: createId("workflowDispatch"),
        };
        const sessionCompletion = command.payload.sessionCompletion;
        let completedSession: ProviderSession | null = null;
        let terminalUsageReport: ProviderUsageReport | null = null;
        let outcomeRejectionCode: string | null = null;
        let decision: ApplyProviderOutcomeDecision;
        if (sessionCompletion === undefined) {
          decision = decideApplyProviderOutcome(normalizedCommand, decisionContext);
        } else {
          const sessionValue = selectProviderSessionById.get(sessionCompletion.providerSessionId);
          if (sessionValue === undefined) {
            throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The ProviderSession does not exist");
          }
          const providerSession = providerSessionFromRow(sessionValue);
          if (
            providerSession.status !== "RUNNING" ||
            providerSession.stageAttemptId !== stageAttempt.id ||
            providerSession.agentRunId === null ||
            runningAgentRunValue === undefined
          ) {
            throw new WorkflowDomainError(
              "PROVIDER_SESSION_MISMATCH",
              "The terminal provider outcome does not match the active ProviderSession",
            );
          }
          const agentRun = agentRunFromRow(runningAgentRunValue);
          if (providerSession.agentRunId !== agentRun.id) {
            throw new WorkflowDomainError(
              "PROVIDER_SESSION_MISMATCH",
              "The terminal provider outcome does not match the active AgentRun",
            );
          }
          completedSession = providerSessionSchema.parse({
            ...providerSession,
            status: "ENDED",
            endReason: "COMPLETED",
            endedAt: occurredAt,
            version: providerSession.version + 1,
          });
          const terminalUsage = sessionCompletion.usage;
          const usageContext =
            terminalUsage === null
              ? null
              : (() => {
                  if (command.actor.type !== "SYSTEM" || command.actor.id !== "session-loop") {
                    throw new StateStoreError(
                      "PROVIDER_USAGE_ACTOR_FORBIDDEN",
                      "Only the provider session loop can finalize provider usage",
                    );
                  }
                  if (selectProviderUsageReportBySession.get(providerSession.id) !== undefined) {
                    throw new StateStoreError(
                      "PROVIDER_USAGE_ALREADY_RECORDED",
                      "The ProviderSession already has its final usage report",
                    );
                  }
                  const usageDigest = `sha256:${createHash("sha256")
                    .update(canonicalJson(terminalUsage))
                    .digest("hex")}`;
                  const totalTokens = terminalUsage.inputTokens + terminalUsage.outputTokens;
                  return {
                    ...decisionContext,
                    providerSession,
                    agentRun,
                    existingAgentUsageTotal: readProviderUsageReportsForAgentRun(agentRun.id).reduce(
                      (total, report) => total + report.totalTokens,
                      0,
                    ),
                    usage: terminalUsage,
                    reportId: createId("providerUsageReport"),
                    usageRecordId: totalTokens === 0 ? null : createId("usageRecord"),
                    usageDigest,
                  };
                })();
          let usageDecision: RecordProviderUsageDecision | null = null;
          try {
            if (usageContext === null) {
              decision = decideApplyProviderOutcome(normalizedCommand, decisionContext);
            } else {
              const withUsage = decideApplyProviderOutcomeWithUsage(normalizedCommand, usageContext);
              decision = withUsage;
              terminalUsageReport = withUsage.usageReport;
            }
          } catch (error: unknown) {
            if (!isProviderOutcomeRejectionError(error)) throw error;
            outcomeRejectionCode = error.code;
            completedSession = providerSessionSchema.parse({
              ...completedSession,
              endReason: "INTERRUPTED",
            });

            // The adapter already produced its final cumulative usage. Rejection of the stage
            // result must not erase that spend, so derive and persist it in the same transaction as
            // closing the session and pausing the attempt. Reusing the domain usage decision also
            // preserves the stricter budget pause when this very report crosses a hard ceiling.
            if (usageContext !== null) {
              usageDecision = decideRecordProviderUsage(usageContext);
              terminalUsageReport = usageDecision.report;
            }

            if (usageDecision?.hardPaused === true) {
              decision = {
                workItem: usageDecision.workItem,
                run: usageDecision.run,
                stageAttempt: usageDecision.stageAttempt,
                dispatch: usageDecision.dispatch,
                request: null,
                nextStageAttempt: null,
                nextDispatch: null,
                usageRecords: usageDecision.usageRecord === null ? [] : [usageDecision.usageRecord],
                artifacts: [],
                acceptancePackage: null,
                events: usageDecision.events,
              };
            } else {
              const paused = decideStageAttemptHardPause({
                now: occurredAt,
                workItem: usageDecision?.workItem ?? workItem,
                run: usageDecision?.run ?? run,
                stageAttempt: usageDecision?.stageAttempt ?? stageAttempt,
                previousStatus: stageAttempt.status,
                pendingDispatch: usageDecision?.dispatch ?? dispatch,
                humanRequestId: createId("humanRequest"),
                reason: {
                  type: "PROVIDER_OUTCOME_REJECTED",
                  sessionOrdinal: providerSession.ordinal,
                  errorCode: error.code,
                },
              });
              decision = {
                workItem: paused.workItem,
                run: paused.run,
                stageAttempt: paused.stageAttempt,
                dispatch: paused.dispatch ?? dispatch,
                request: paused.request,
                nextStageAttempt: null,
                nextDispatch: null,
                usageRecords:
                  usageDecision?.usageRecord === null || usageDecision === null
                    ? []
                    : [usageDecision.usageRecord],
                artifacts: [],
                acceptancePackage: null,
                events: [
                  ...(usageDecision?.events ?? []),
                  ...paused.events.filter((event) => event.type !== "CONTEXT_FLOOR_EXCEEDED"),
                ],
              };
            }
          }
        }
        persistWorkflowTemplate(command.payload.template, occurredAt);
        if (completedSession !== null) {
          const currentVersion = completedSession.version - 1;
          const updated = updateProviderSession.run(
            completedSession.status,
            completedSession.endReason,
            completedSession.handoffRequestedAt,
            completedSession.endedAt,
            completedSession.version,
            completedSession.id,
            currentVersion,
          );
          if (updated.changes !== 1) {
            throw new WorkflowDomainError(
              "WORKFLOW_VERSION_CONFLICT",
              "The ProviderSession changed while its terminal outcome was being applied",
            );
          }
        }
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
        if (terminalUsageReport !== null) persistProviderUsageReport(terminalUsageReport);
        const metadata = {
          workItemId: decision.workItem.id,
          projectId: decision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const sessionEvents =
          completedSession === null
            ? []
            : [
                appendSessionEvent(
                  { type: "PROVIDER_SESSION_ENDED", data: { session: completedSession } },
                  metadata,
                ),
              ];
        const agentStatus = terminalAgentRunStatus(decision.stageAttempt.status);
        if (agentStatus) finishActiveAgentRun(decision.stageAttempt.id, agentStatus, metadata);
        const events = [...sessionEvents, ...appendWorkflowEvents(decision.events, metadata)];
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
          outcomeRejectionCode,
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

      if (command.type === "RESOLVE_QA_CORRECTION_GATE") {
        const request = readHumanRequest(command.payload.humanRequestId);
        const correctionRun =
          command.payload.correctionRunId === null
            ? null
            : readQACorrectionRun(command.payload.correctionRunId);
        const stageAttempt = request ? readStageAttempt(request.stageAttemptId) : null;
        const run = stageAttempt ? readPipelineRun(stageAttempt.pipelineRunId) : null;
        const workItem = request ? readWorkItem(request.workItemId) : null;
        if (
          !request ||
          !stageAttempt ||
          !run ||
          !workItem ||
          (command.payload.correctionRunId !== null && correctionRun === null)
        ) {
          throw new QACorrectionError(
            "QA_CORRECTION_REQUEST_INVALID",
            "The exhausted QA correction gate does not exist",
          );
        }
        const sourceValue =
          correctionRun === null
            ? selectFailedQARunByStageAttempt.get(stageAttempt.id)
            : selectLatestFailedRetestForCorrection.get(correctionRun.id);
        const baselineValue =
          correctionRun === null ? sourceValue : selectQARunById.get(correctionRun.baselineQARunId);
        if (sourceValue === undefined || baselineValue === undefined) {
          throw new QACorrectionError(
            "QA_CORRECTION_LINEAGE_MISMATCH",
            "The exhausted QA correction lineage is incomplete",
          );
        }
        const sourceQARun = qaRunFromRow(sourceValue);
        const evidenceValue = selectQAEvidenceBundleByQARun.get(sourceQARun.id);
        if (evidenceValue === undefined) {
          throw new QACorrectionError(
            "QA_CORRECTION_LINEAGE_MISMATCH",
            "The exhausted QA correction source evidence is missing",
          );
        }
        const usage = correctionBudgetUsageRowSchema.parse(selectCorrectionBudgetUsage.get(run.id));
        const gateDecision = decideQACorrectionGateResolution({
          command,
          workItem,
          run,
          stageAttempt,
          request,
          correctionRun,
          sourceQARun,
          sourceEvidence: qaEvidenceBundleFromRow(evidenceValue),
          baselineQARun: qaRunFromRow(baselineValue),
          openDefects: readOpenQADefects(run.id),
          budgetUsage: {
            automaticUsed: usage.automatic_used,
            totalUsed: usage.total_used,
          },
          ids: {
            decisionId: createId("decision"),
            correctionRunId: createId("qaCorrectionRun"),
            retestPlanId: createId("qaRetestPlan"),
            nextStageAttemptId: createId("stageAttempt"),
            dispatchId: createId("workflowDispatch"),
          },
          now: occurredAt,
        });
        updateHumanRequest(gateDecision.request);
        insertDecision(gateDecision.decision);
        if (gateDecision.previousCorrection !== null) {
          persistUpdatedQACorrectionRun(gateDecision.previousCorrection);
        }
        if (gateDecision.correctionRun !== null) {
          persistQACorrectionRun(gateDecision.correctionRun, gateDecision.budgetAllocation);
          persistQARetestPlan(gateDecision.retestPlan);
        }
        updateStageAttempt(gateDecision.stageAttempt);
        updatePipelineRun(gateDecision.run);
        updateWorkflowWorkItem(gateDecision.workItem);
        if (gateDecision.nextStageAttempt !== null) insertStageAttempt(gateDecision.nextStageAttempt);
        if (gateDecision.dispatch !== null) insertWorkflowDispatch(gateDecision.dispatch);
        const events = appendWorkflowEvents(gateDecision.events, {
          workItemId: gateDecision.workItem.id,
          projectId: gateDecision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "QA_CORRECTION_GATE_RESOLVED",
          replayed: false,
          action: gateDecision.action,
          workItemId: gateDecision.workItem.id,
          request: gateDecision.request,
          decision: gateDecision.decision,
          previousCorrection: gateDecision.previousCorrection,
          correctionRun: gateDecision.correctionRun,
          retestPlan: gateDecision.retestPlan,
          run: gateDecision.run,
          stageAttempt: gateDecision.stageAttempt,
          dispatch: gateDecision.dispatch,
          events,
        });
      }

      if (command.type === "RESOLVE_VERIFICATION_CORRECTION_GATE") {
        const request = readHumanRequest(command.payload.humanRequestId);
        const stageAttempt = request ? readStageAttempt(request.stageAttemptId) : null;
        const run = stageAttempt ? readPipelineRun(stageAttempt.pipelineRunId) : null;
        const workItem = request ? readWorkItem(request.workItemId) : null;
        if (command.payload.correctionRunId === null) {
          const qaCorrectionRunId = command.payload.qaCorrectionRunId ?? null;
          const qaCorrectionRun = qaCorrectionRunId === null ? null : readQACorrectionRun(qaCorrectionRunId);
          const failedValue =
            run === null ? undefined : selectLatestFailedVerificationRunWithoutCorrection.get(run.id);
          const failedVerificationRun =
            failedValue === undefined ? null : verificationRunFromRow(failedValue);
          const failure =
            failedVerificationRun === null ? null : readVerificationFailureForRun(failedVerificationRun.id);
          if (
            request === null ||
            stageAttempt === null ||
            run === null ||
            workItem === null ||
            qaCorrectionRun === null ||
            failedVerificationRun === null ||
            failure === null
          ) {
            throw new VerificationCorrectionError(
              "REQUEST_INVALID",
              "The mixed Project verification correction gate does not exist",
            );
          }
          const usage = correctionBudgetUsageRowSchema.parse(selectCorrectionBudgetUsage.get(run.id));
          const mixedDecision: MixedVerificationCorrectionGateResolution =
            decideMixedVerificationCorrectionGateResolution({
              command,
              workItem,
              run,
              stageAttempt,
              request,
              qaCorrectionRun,
              failedVerificationRun,
              failure,
              budgetUsage: {
                automaticUsed: usage.automatic_used,
                totalUsed: usage.total_used,
              },
              ids: {
                decisionId: createId("decision"),
                correctionRunId: createId("verificationCorrectionRun"),
                nextStageAttemptId: createId("stageAttempt"),
                dispatchId: createId("workflowDispatch"),
              },
              now: occurredAt,
            });
          updateHumanRequest(mixedDecision.request);
          insertDecision(mixedDecision.decision);
          if (mixedDecision.action === "CANCEL") {
            persistUpdatedQACorrectionRun(mixedDecision.qaCorrection);
          }
          if (mixedDecision.correctionRun !== null) {
            persistVerificationCorrectionRun(mixedDecision.correctionRun);
          }
          updateStageAttempt(mixedDecision.stageAttempt);
          updatePipelineRun(mixedDecision.run);
          updateWorkflowWorkItem(mixedDecision.workItem);
          if (mixedDecision.nextStageAttempt !== null) {
            insertStageAttempt(mixedDecision.nextStageAttempt);
          }
          if (mixedDecision.dispatch !== null) {
            insertWorkflowDispatch(mixedDecision.dispatch);
          }
          const events = appendWorkflowEvents(mixedDecision.events, {
            workItemId: mixedDecision.workItem.id,
            projectId: mixedDecision.workItem.projectId,
            actor: command.actor,
            occurredAt,
            correlationId: command.correlationId,
          });
          return stateCommandResultSchema.parse({
            schemaVersion: 1,
            type: "VERIFICATION_CORRECTION_GATE_RESOLVED",
            replayed: false,
            action: mixedDecision.action,
            workItemId: mixedDecision.workItem.id,
            request: mixedDecision.request,
            decision: mixedDecision.decision,
            previousCorrection: null,
            qaCorrection: mixedDecision.qaCorrection,
            correctionRun: mixedDecision.correctionRun,
            run: mixedDecision.run,
            stageAttempt: mixedDecision.stageAttempt,
            dispatch: mixedDecision.dispatch,
            events,
          });
        }
        const correctionRun = readVerificationCorrectionRun(command.payload.correctionRunId);
        const correctionSourceVerificationRun =
          correctionRun === null ? null : readVerificationRun(correctionRun.sourceVerificationRunId);
        const suspendedQACorrection =
          correctionRun?.resumesQACorrectionRunId === undefined ||
          correctionRun.resumesQACorrectionRunId === null
            ? null
            : readQACorrectionRun(correctionRun.resumesQACorrectionRunId);
        const failedValue =
          correctionRun === null
            ? undefined
            : selectLatestFailedVerificationRunForCorrection.get(correctionRun.id);
        const failedVerificationRun = failedValue === undefined ? null : verificationRunFromRow(failedValue);
        const failure =
          failedVerificationRun === null ? null : readVerificationFailureForRun(failedVerificationRun.id);
        if (
          request === null ||
          correctionRun === null ||
          stageAttempt === null ||
          run === null ||
          workItem === null ||
          correctionSourceVerificationRun === null ||
          (correctionRun.resumesQACorrectionRunId !== undefined &&
            correctionRun.resumesQACorrectionRunId !== null &&
            suspendedQACorrection === null) ||
          failedVerificationRun === null ||
          failure === null
        ) {
          throw new VerificationCorrectionError(
            "REQUEST_INVALID",
            "The exhausted Project verification correction gate does not exist",
          );
        }
        const gateDecision = decideVerificationCorrectionGateResolution({
          command,
          workItem,
          run,
          stageAttempt,
          request,
          correctionRun,
          suspendedQACorrection,
          correctionSourceVerificationRun,
          failedVerificationRun,
          failure,
          ids: {
            decisionId: createId("decision"),
            correctionRunId: createId("verificationCorrectionRun"),
            nextStageAttemptId: createId("stageAttempt"),
            dispatchId: createId("workflowDispatch"),
          },
          now: occurredAt,
        });
        updateHumanRequest(gateDecision.request);
        insertDecision(gateDecision.decision);
        if (gateDecision.previousCorrection.version !== correctionRun.version) {
          persistUpdatedVerificationCorrectionRun(gateDecision.previousCorrection);
        }
        if (gateDecision.cancelledQACorrection !== null) {
          persistUpdatedQACorrectionRun(gateDecision.cancelledQACorrection);
        }
        if (gateDecision.correctionRun !== null) {
          persistVerificationCorrectionRun(gateDecision.correctionRun);
        }
        updateStageAttempt(gateDecision.stageAttempt);
        updatePipelineRun(gateDecision.run);
        updateWorkflowWorkItem(gateDecision.workItem);
        if (gateDecision.nextStageAttempt !== null) {
          insertStageAttempt(gateDecision.nextStageAttempt);
        }
        if (gateDecision.dispatch !== null) {
          insertWorkflowDispatch(gateDecision.dispatch);
        }
        const events = appendWorkflowEvents(gateDecision.events, {
          workItemId: gateDecision.workItem.id,
          projectId: gateDecision.workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        });
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "VERIFICATION_CORRECTION_GATE_RESOLVED",
          replayed: false,
          action: gateDecision.action,
          workItemId: gateDecision.workItem.id,
          request: gateDecision.request,
          decision: gateDecision.decision,
          previousCorrection: gateDecision.previousCorrection,
          qaCorrection: gateDecision.cancelledQACorrection ?? suspendedQACorrection,
          correctionRun: gateDecision.correctionRun,
          run: gateDecision.run,
          stageAttempt: gateDecision.stageAttempt,
          dispatch: gateDecision.dispatch,
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
        const reviewReportValue =
          stageAttempt.stage === "REVIEW" ? selectReviewReportByStageAttempt.get(stageAttempt.id) : undefined;
        const decision = decideAnswerHumanRequest(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          request,
          decisionId: createId("decision"),
          dispatchId: createId("workflowDispatch"),
          nextStageAttemptId: createId("stageAttempt"),
          ...(reviewReportValue === undefined
            ? {}
            : { reviewRound: reviewReportFromRow(reviewReportValue).round }),
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
        if (
          command.type === "RESUME_PIPELINE" &&
          (selectRunningAgentRunForStageAttempt.get(stageAttempt.id) !== undefined ||
            selectRunningProviderSession.get(stageAttempt.id) !== undefined)
        ) {
          throw new WorkflowDomainError(
            "WORKFLOW_CONTROL_NOT_ALLOWED",
            "The soft-paused provider turn must finish before the pipeline can resume",
          );
        }
        const pendingDispatch = readPendingDispatch(stageAttempt.id);
        const currentCorrection = readCurrentQACorrectionRun(run.id);
        const currentVerificationCorrectionId = stageAttempt.verificationCorrectionRunId ?? null;
        const currentVerificationCorrectionValue =
          currentVerificationCorrectionId === null
            ? null
            : readVerificationCorrectionRun(currentVerificationCorrectionId);
        const currentVerificationCorrection =
          currentVerificationCorrectionValue?.status === "ACTIVE" ||
          currentVerificationCorrectionValue?.status === "EXHAUSTED"
            ? currentVerificationCorrectionValue
            : null;
        const correctionCancellation =
          command.type === "CANCEL_PIPELINE" && currentCorrection !== null
            ? decideQACorrectionCancellation({
                correctionRun: currentCorrection,
                run,
                stageAttempt,
                now: occurredAt,
              })
            : null;
        const verificationCorrectionCancellation =
          command.type === "CANCEL_PIPELINE" && currentVerificationCorrection !== null
            ? decideVerificationCorrectionCancellation({
                correctionRun: currentVerificationCorrection,
                run,
                stageAttempt,
                suspendedQACorrection:
                  currentVerificationCorrection.resumesQACorrectionRunId === undefined ||
                  currentVerificationCorrection.resumesQACorrectionRunId === null
                    ? null
                    : readQACorrectionRun(currentVerificationCorrection.resumesQACorrectionRunId),
                now: occurredAt,
              })
            : null;
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
        if (correctionCancellation !== null) {
          persistUpdatedQACorrectionRun(correctionCancellation.correctionRun);
        }
        if (verificationCorrectionCancellation !== null) {
          persistUpdatedVerificationCorrectionRun(verificationCorrectionCancellation.correctionRun);
          if (verificationCorrectionCancellation.suspendedQACorrection !== null) {
            persistUpdatedQACorrectionRun(verificationCorrectionCancellation.suspendedQACorrection);
          }
        }
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
        const providerTurnStillRunning =
          (decision.action === "PAUSE" || decision.action === "CANCEL") &&
          selectRunningProviderSession.get(decision.stageAttempt.id) !== undefined;
        if (agentStatus && !providerTurnStillRunning) {
          finishActiveAgentRun(decision.stageAttempt.id, agentStatus, metadata);
        }
        const events = appendWorkflowEvents(
          [
            ...decision.events,
            ...(correctionCancellation?.events ?? []),
            ...(verificationCorrectionCancellation?.events ?? []),
          ],
          metadata,
        );
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
        const latestAgentRunValue = selectLatestAgentRunForStageAttempt.get(stageAttempt.id);
        const latestAgentRun = latestAgentRunValue ? agentRunFromRow(latestAgentRunValue) : null;
        const decision = decideApproveBudgetOverride(command, {
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          currentBudgetPolicy,
          cumulativeUsage: readUsageRecords(run.id).reduce((total, record) => total + record.amount, 0),
          currentAgentRunMaxEstimatedTokens:
            latestAgentRun?.policySnapshot?.budget.maxEstimatedTokens ?? null,
          ids: {
            budgetPolicyId: createId("budgetPolicy"),
            stageAttemptId: createId("stageAttempt"),
            dispatchId: createId("workflowDispatch"),
          },
        });
        updatePipelineRun(decision.run);
        updateWorkflowWorkItem(decision.workItem);
        insertBudgetPolicy(decision.budgetPolicy);
        if (decision.stageAttempt.id === decision.previousStageAttempt.id) {
          updateStageAttempt(decision.stageAttempt);
        } else {
          insertStageAttempt(decision.stageAttempt);
        }
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
        const interruptedVerificationRuns: VerificationRun[] = [];
        const verificationEvents: DomainEvent[] = [];
        const interruptedAgentRunLeases: { stageAttemptId: string; workItemId: string }[] = [];
        const verificationProcessAuthorityReleasedRunIds = new Set(
          command.payload.verificationProcessAuthorityReleasedRunIds ?? [],
        );
        // An active verification process has no daemon loop after restart. A durable owner
        // cancellation keeps its reason; otherwise record restart uncertainty. Never replay work.
        for (const runRow of selectActiveVerificationRuns.all()) {
          const current = verificationRunFromRow(runRow);
          if (!verificationProcessAuthorityReleasedRunIds.has(current.id)) continue;
          const checks = readVerificationChecks(current.id);
          const interruptionReason = current.status === "CANCELLING" ? "OWNER_CANCELLED" : "DAEMON_RESTART";
          const decision = decideVerificationRunInterruption({
            actor: command.actor,
            run: current,
            checks,
            expectedRunVersion: current.version,
            reason: interruptionReason,
            now: occurredAt,
          });
          persistVerificationRunUpdate(decision.run, current.version);
          const interruptedCheck =
            current.currentCheckId === null
              ? null
              : (decision.checks.find((check) => check.id === current.currentCheckId) ?? null);
          const previousCheck =
            current.currentCheckId === null
              ? null
              : (checks.find((check) => check.id === current.currentCheckId) ?? null);
          if (interruptedCheck !== null && previousCheck !== null) {
            persistVerificationCheckUpdate(interruptedCheck, previousCheck.version);
          }
          const release = releaseWorkspaceFromVerification.run(current.workspaceId, current.id);
          if (release.changes !== 1) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "An interrupted verification reservation changed during startup recovery",
            );
          }
          interruptedVerificationRuns.push(decision.run);
          const failureDecision = persistVerificationFailure(decision.run, decision.checks, occurredAt);
          verificationEvents.push(
            appendVerificationRunEvent(
              {
                type: "VERIFICATION_RUN_INTERRUPTED",
                data: { run: decision.run, interruptedCheck },
              },
              {
                workItemId: current.workItemId,
                projectId: current.projectId,
                actor: command.actor,
                occurredAt,
                correlationId: command.correlationId,
              },
            ),
            appendVerificationRunEvent(failureDecision.event, {
              workItemId: current.workItemId,
              projectId: current.projectId,
              actor: command.actor,
              occurredAt,
              correlationId: command.correlationId,
            }),
          );
          const correctionWorkflow =
            interruptionReason === "DAEMON_RESTART"
              ? persistVerificationFailureWorkflow(decision.run, failureDecision.failure, occurredAt)
              : null;
          if (correctionWorkflow !== null) {
            verificationEvents.push(
              ...appendWorkflowEvents(correctionWorkflow.events, {
                workItemId: correctionWorkflow.workItemId,
                projectId: correctionWorkflow.projectId,
                actor: command.actor,
                occurredAt,
                correlationId: command.correlationId,
              }),
            );
          }
        }
        // AgentRun is the A3 concurrency authority. Every RUNNING row at startup is orphaned even
        // when no ProviderSession was created yet; ending all of them first frees capacity and
        // ensures the dispatch-level recovery below never resurrects one implicitly.
        for (const runRow of selectRunningAgentRuns.all()) {
          const current = agentRunFromRow(runRow);
          interruptedAgentRunLeases.push({
            stageAttemptId: current.stageAttemptId,
            workItemId: current.workItemId,
          });
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
        const events: DomainEvent[] = [...verificationEvents];

        // A session still marked RUNNING at startup is orphaned by definition. It only ends as
        // ENDED/INTERRUPTED once recovery knows its recorded process is gone or the pid was reused.
        // A failed or inconclusive identity/signal check leaves both the session and writer lease
        // in place for the next startup pass: freeing either would let another writer overlap a
        // child that may still be touching the worktree. A3 forbids automatic retry of an
        // interrupted AgentRun; historical sessions with no AgentRun fail closed the same way.
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
          if (
            current.pid !== null &&
            !orphanProcessNoLongerOwnsAuthority(
              killOrphanedSessionProcess({
                pid: current.pid,
                sessionId: current.id,
                sessionStartedAt: current.startedAt,
                processStartedAt,
                signalProcess,
                report: reportOrphanProcess,
              }),
            )
          ) {
            continue;
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

          // A prior inconclusive recovery may already have interrupted the AgentRun, so it will no
          // longer appear in `interruptedAgentRunLeases` on this pass. Release its lease here once
          // this pass has finally established that the process no longer owns writer authority.
          const workspace = readWorkItemWorkspaceByWorkItemId(sessionAttempt.workItemId);
          if (workspace?.leaseHolder === sessionAttempt.id) {
            const release = releaseWorkItemWorkspaceLease.run(
              workspace.id,
              workspace.version,
              sessionAttempt.id,
            );
            if (release.changes !== 1) {
              throw new StateStoreError(
                "PERSISTENCE_FAILURE",
                "An interrupted ProviderSession workspace lease changed during startup recovery",
              );
            }
          }
        }

        // A RUNNING AgentRun found at startup has no daemon loop left to release its workspace.
        // Do this only when no ProviderSession still claims that attempt: an inconclusive process
        // probe deliberately leaves the session RUNNING, which must fence the writer lease until a
        // later reconciliation confirms the child is gone. This also covers a Soft Pause whose
        // allowed in-flight turn was interrupted by the daemon restart.
        for (const { stageAttemptId, workItemId } of interruptedAgentRunLeases) {
          if (selectRunningProviderSession.get(stageAttemptId) !== undefined) continue;
          const workspace = readWorkItemWorkspaceByWorkItemId(workItemId);
          if (workspace?.leaseHolder !== stageAttemptId) continue;
          const release = releaseWorkItemWorkspaceLease.run(workspace.id, workspace.version, stageAttemptId);
          if (release.changes !== 1) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "An interrupted AgentRun workspace lease changed during startup recovery",
            );
          }
        }

        // A StageAttempt this loop recovers to INTERRUPTED is never coming back to reclaim a
        // workspace lease itself (AD-008: nothing here restarts it). Collected here, not derived
        // from a later status re-read, because it is this transaction's own decision that makes an
        // attempt "dead" for lease purposes -- a StageAttempt already WAITING_HUMAN or *_PAUSED
        // before this reconciliation even ran still legitimately owns its lease, and nothing below
        // may release that.
        const attemptsRecoveredToInterrupted = new Set<string>();

        for (const dispatch of orphanedDispatches) {
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
          // are expected back, in this same worktree. A still-RUNNING ProviderSession is a stronger
          // process-authority fence even when recovery just made the attempt itself terminal.
          const leaseHolder = workspace.leaseHolder;
          const leaseHolderAttempt = leaseHolder === null ? null : readStageAttempt(leaseHolder);
          const leaseHolderIsDead =
            leaseHolder !== null &&
            selectRunningProviderSession.get(leaseHolder) === undefined &&
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
          interruptedVerificationRuns,
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
        const stageAttempt = readStageAttempt(command.payload.stageAttemptId);
        if (stageAttempt === null) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The StageAttempt does not exist");
        }
        const activeAgentRunValue = selectRunningAgentRunForStageAttempt.get(stageAttempt.id);
        if (stageAttempt.status !== "RUNNING" || activeAgentRunValue === undefined) {
          throw new StateStoreError(
            "AGENT_RUN_NOT_ACTIVE",
            "A ProviderSession requires a running StageAttempt with an active AgentRun",
          );
        }
        const activeAgentRun = agentRunFromRow(activeAgentRunValue);
        if (activeAgentRun.policySnapshot === null) {
          throw new StateStoreError(
            "PERSISTENCE_FAILURE",
            "A running AgentRun has no effective policy snapshot",
          );
        }
        const maxOrdinal = maxOrdinalRowSchema.parse(
          selectMaxProviderSessionOrdinal.get(command.payload.stageAttemptId),
        ).max_ordinal;
        const session = providerSessionSchema.parse({
          schemaVersion: 1,
          id: createId("providerSession"),
          agentRunId: activeAgentRun.id,
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
        // All authority reads above and these writes share the command's SQLite transaction. A
        // pause/cancel that commits before this claim has already ended the AgentRun and is refused
        // above. After the claim, cancellation closes this session/run atomically; Soft Pause keeps
        // both authorities until the current turn naturally ends them.
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
          recipe.roleProfile?.id ?? null,
          recipe.roleProfile?.revision ?? null,
          JSON.stringify(recipe.sections),
          JSON.stringify(recipe.omitted),
          recipe.contentHash,
          recipe.estimatedTokens,
          recipe.budgetTokens,
          recipe.estimateQuality,
          recipe.createdAt,
        );
        const pinnedMcpRevisions = new Set(activeAgentRun.policySnapshot.mcpProfileRevisionIds);
        const enabledGrants = selectEnabledLatestMcpGrantsForProject
          .all(stageAttempt.projectId)
          .map(mcpGrantFromRow)
          .filter(({ profileRevisionId }) => pinnedMcpRevisions.has(profileRevisionId));
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

      if (command.type === "RECORD_PROVIDER_USAGE") {
        if (command.actor.type !== "SYSTEM" || command.actor.id !== "session-loop") {
          throw new StateStoreError(
            "PROVIDER_USAGE_ACTOR_FORBIDDEN",
            "Only the provider session loop can record provider usage",
          );
        }
        if (selectProviderUsageReportBySession.get(command.payload.providerSessionId) !== undefined) {
          throw new StateStoreError(
            "PROVIDER_USAGE_ALREADY_RECORDED",
            "The ProviderSession already has its final usage report",
          );
        }
        const sessionValue = selectProviderSessionById.get(command.payload.providerSessionId);
        if (sessionValue === undefined) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The ProviderSession does not exist");
        }
        const providerSession = providerSessionFromRow(sessionValue);
        if (providerSession.agentRunId === null) {
          throw new StateStoreError(
            "AGENT_RUN_NOT_ACTIVE",
            "Provider usage requires a ProviderSession owned by an AgentRun",
          );
        }
        const agentRunValue = selectAgentRunById.get(providerSession.agentRunId);
        const stageAttempt = readStageAttempt(providerSession.stageAttemptId);
        if (agentRunValue === undefined || stageAttempt === null) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The execution backing this ProviderSession is incomplete",
          );
        }
        const agentRun = agentRunFromRow(agentRunValue);
        const run = readPipelineRun(stageAttempt.pipelineRunId);
        const workItem = readWorkItem(stageAttempt.workItemId);
        const pendingDispatch = readPendingDispatchForAttempt(stageAttempt.id);
        const latestDispatchValue =
          stageAttempt.status === "SOFT_PAUSED"
            ? selectLatestDispatchByStageAttempt.get(stageAttempt.id)
            : undefined;
        const dispatch =
          pendingDispatch ??
          (latestDispatchValue === undefined ? null : workflowDispatchFromRow(latestDispatchValue));
        if (run === null || workItem === null || dispatch === null) {
          throw new WorkflowDomainError(
            "WORKFLOW_NOT_FOUND",
            "The workflow state backing this ProviderSession is incomplete",
          );
        }
        const usageDigest = `sha256:${createHash("sha256")
          .update(canonicalJson(command.payload.usage))
          .digest("hex")}`;
        const totalTokens = command.payload.usage.inputTokens + command.payload.usage.outputTokens;
        const decision = decideRecordProviderUsage({
          now: occurredAt,
          workItem,
          run,
          stageAttempt,
          dispatch,
          providerSession,
          agentRun,
          budgetPolicy: readCurrentBudgetPolicy(run.id),
          existingUsageRecords: readUsageRecords(run.id),
          existingAgentUsageTotal: readProviderUsageReportsForAgentRun(agentRun.id).reduce(
            (total, report) => total + report.totalTokens,
            0,
          ),
          usage: command.payload.usage,
          reportId: createId("providerUsageReport"),
          usageRecordId: totalTokens === 0 ? null : createId("usageRecord"),
          usageDigest,
        });
        if (decision.usageRecord !== null) insertUsageRecord(decision.usageRecord);
        persistProviderUsageReport(decision.report);
        if (decision.hardPaused) {
          // After a Soft Pause the dispatch is already FAILED and the domain hands it back
          // unchanged; completing it "again" would match 0 PENDING rows, throw, and roll back the
          // very report that crossed the hard ceiling -- on every retry.
          if (decision.dispatch.status !== dispatch.status) updateWorkflowDispatch(decision.dispatch);
          updateStageAttempt(decision.stageAttempt);
          updatePipelineRun(decision.run);
          updateWorkflowWorkItem(decision.workItem);
        }
        const metadata = {
          workItemId: workItem.id,
          projectId: workItem.projectId,
          actor: command.actor,
          occurredAt,
          correlationId: command.correlationId,
        };
        const events = appendWorkflowEvents(decision.events, metadata);
        // The active session still owns the provider process and, for writer stages, its workspace.
        // The loop awaits abort and END_PROVIDER_SESSION finishes the AgentRun/releases the lease;
        // doing that here would advertise a free writer before the child has stopped.
        return stateCommandResultSchema.parse({
          schemaVersion: 1,
          type: "PROVIDER_USAGE_RECORDED",
          replayed: false,
          workItemId: workItem.id,
          report: decision.report,
          usageRecord: decision.usageRecord,
          cumulativeAmount: decision.cumulativeAmount,
          hardPaused: decision.hardPaused,
          stageAttempt: decision.stageAttempt,
          events,
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
        // A live usage report may have atomically HARD-paused this attempt while the adapter was
        // still returning from start(). The session itself still has to be ended for recovery and
        // audit, but its unproductive-session transition must not run against an attempt that has
        // already left RUNNING or manufacture a second pause/request.
        if (
          stageAttempt.status === "RUNNING" &&
          session.endReason !== "CANCELLED" &&
          command.payload.providerStarted
        ) {
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
        const leaseAttempt = readStageAttempt(command.payload.stageAttemptId);
        if (!leaseAttempt) {
          throw new WorkflowDomainError("WORKFLOW_NOT_FOUND", "The StageAttempt does not exist");
        }
        // Only an attempt that can still run may take the writer lease. The session loop acquires
        // it after an `await` on git; a cancel or pause that lands during that wait used to let the
        // claim through anyway, and a lease held by a finished attempt is released by nothing but
        // the next daemon start.
        if (
          leaseAttempt.status !== "QUEUED" &&
          leaseAttempt.status !== "RUNNING" &&
          leaseAttempt.status !== "RECOVERING"
        ) {
          throw new StateStoreError(
            "WORKSPACE_LEASE_ATTEMPT_INACTIVE",
            "A StageAttempt that is no longer executable cannot take a workspace lease",
            { status: leaseAttempt.status },
          );
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
          if (readWorkspaceVerificationHolder(after.id) !== null) {
            throw new StateStoreError(
              "WORKSPACE_VERIFICATION_HELD",
              "The workspace is reserved by an active verification Run",
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
          if (readWorkspaceVerificationHolder(after.id) !== null) {
            throw new StateStoreError(
              "WORKSPACE_VERIFICATION_HELD",
              "An active verification Run still owns this workspace",
            );
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
      // The acceptance criteria are bound into the AcceptancePackage and checked again when the
      // release summary is rendered; rewriting them under a running pipeline makes that gate
      // unpassable ("claims must cover every criterion exactly once") with no way back but a
      // cancel. Title, description, priority and risk stay editable.
      if (
        command.type === "UPDATE_WORK_ITEM" &&
        command.payload.patch.acceptanceCriteria !== undefined &&
        current &&
        selectActivePipelineRun.get(current.id) !== undefined
      ) {
        throw new WorkItemDomainError(
          "ACTIVE_WORKFLOW_CONTROLS_STATE",
          "The acceptance criteria are bound by the active workflow until it stops",
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

    const readCommandReceipt = (command: StateCommand, inputHash: string): StateCommandResult | null => {
      const receiptValue = selectCommandReceipt.get(command.commandId);
      if (receiptValue === undefined) return null;
      const receipt = commandReceiptRowSchema.parse(receiptValue);
      if (receipt.command_type !== command.type || receipt.input_hash !== inputHash) {
        throw new StateStoreError("COMMAND_ID_REUSED", "The command ID was already used for different input");
      }
      return asReplayed(stateCommandResultSchema.parse(parseJson(receipt.result_json)));
    };

    const execute = (input: StateCommand): StateCommandResult => {
      assertOpen();
      const command = stateCommandSchema.parse(input);
      const inputHash = commandHash(command);
      let transactionStarted = false;
      try {
        database.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        const replayed = readCommandReceipt(command, inputHash);
        if (replayed !== null) {
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
          error instanceof ProviderAllowanceDomainError ||
          error instanceof ProviderSelectionDomainError ||
          error instanceof VerificationDomainError ||
          error instanceof VerificationCorrectionError ||
          error instanceof QACompletionError ||
          error instanceof QACorrectionError ||
          error instanceof QADefectDispositionError ||
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
        case "GET_REPORTING_FACTS": {
          const row = reportingFactsRowSchema.parse(selectReportingFacts.get());
          return {
            type: "REPORTING_FACTS",
            facts: reportingFactsSchema.parse({
              workItems: {
                total: row.work_items_total,
                accepted: row.work_items_accepted,
                cancelled: row.work_items_cancelled,
                active: row.work_items_active,
              },
              pipelineRuns: {
                total: row.pipeline_runs_total,
                succeeded: row.pipeline_runs_succeeded,
                failed: row.pipeline_runs_failed,
                interrupted: row.pipeline_runs_interrupted,
                cancelled: row.pipeline_runs_cancelled,
              },
              agentRuns: {
                total: row.agent_runs_total,
                succeeded: row.agent_runs_succeeded,
                failed: row.agent_runs_failed,
                interrupted: row.agent_runs_interrupted,
              },
              reviews: {
                total: row.reviews_total,
                firstRound: row.reviews_first_round,
                firstRoundPassed: row.reviews_first_round_passed,
              },
              qa: {
                total: row.qa_total,
                passed: row.qa_passed,
                failed: row.qa_failed,
                errored: row.qa_errored,
                defectsOpen: row.qa_defects_open,
                defectsResolved: row.qa_defects_resolved,
                defectsWaived: row.qa_defects_waived,
              },
              humanRequests: {
                total: row.human_requests_total,
                resolved: row.human_requests_resolved,
              },
              usage: { estimatedTokens: row.estimated_tokens },
              reliability: { daemonRestartRecoveries: row.daemon_restart_recoveries },
            }),
          };
        }
        case "GET_PROJECT":
          return { type: "PROJECT", project: readProject(queryValue.projectId) };
        case "GET_PROVIDER_ALLOWANCES": {
          if (readProject(queryValue.projectId) === null) {
            throw new ProviderAllowanceDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
          }
          return {
            type: "PROVIDER_ALLOWANCES",
            snapshots: selectProviderAllowancesByProject
              .all(queryValue.projectId)
              .map(providerAllowanceFromRow),
          };
        }
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
        case "GET_PROJECT_VERIFICATION_PLAN": {
          const project = readProject(queryValue.projectId);
          if (project === null) {
            throw new VerificationDomainError("PROJECT_NOT_FOUND", "The Project does not exist");
          }
          const plan = readLatestVerificationPlan(queryValue.projectId);
          const publicationRow = selectLatestVerificationPlanPublication.get(queryValue.projectId);
          return {
            type: "PROJECT_VERIFICATION_PLAN",
            project,
            plan,
            publication:
              publicationRow === undefined ? null : verificationPlanPublicationFromRow(publicationRow),
          };
        }
        case "GET_VERIFICATION_RUN": {
          const run = readVerificationRun(queryValue.runId);
          return {
            type: "VERIFICATION_RUN",
            run,
            checks: run === null ? [] : readVerificationChecks(run.id),
          };
        }
        case "GET_VERIFICATION_RUN_CONTEXT": {
          const run = readVerificationRun(queryValue.runId);
          if (run === null) {
            throw new StateStoreError("VERIFICATION_RUN_NOT_FOUND", "The verification Run does not exist");
          }
          const plan = readVerificationPlan(run.planId);
          const workspace = readWorkItemWorkspace(run.workspaceId);
          if (plan === null || workspace === null) {
            throw new StateStoreError(
              "PERSISTENCE_FAILURE",
              "The verification Run has incomplete execution context",
            );
          }
          return {
            type: "VERIFICATION_RUN_CONTEXT",
            run,
            checks: readVerificationChecks(run.id),
            plan,
            workspace,
          };
        }
        case "LIST_WORK_ITEM_VERIFICATION_RUNS":
          return {
            type: "VERIFICATION_RUNS",
            runs: selectVerificationRunsByWorkItem
              .all(queryValue.workItemId, queryValue.limit)
              .map(verificationRunFromRow),
          };
        case "LIST_WORK_ITEM_VERIFICATION_FAILURES":
          return {
            type: "VERIFICATION_FAILURES",
            failures: selectVerificationFailuresByWorkItem
              .all(queryValue.workItemId, queryValue.limit)
              .map(verificationFailureFromRow),
          };
        case "LIST_WORK_ITEM_VERIFICATION_CORRECTIONS":
          return {
            type: "VERIFICATION_CORRECTIONS",
            correctionRuns: selectVerificationCorrectionsByWorkItem
              .all(queryValue.workItemId, queryValue.limit)
              .map(verificationCorrectionRunFromRow),
          };
        case "LIST_ACTIVE_VERIFICATION_RUNS":
          return {
            type: "VERIFICATION_RUNS",
            runs: selectActiveVerificationRuns.all().map(verificationRunFromRow),
          };
        case "GET_VERIFICATION_OUTPUT_ARTIFACT": {
          const value = selectVerificationOutputArtifactByCheck.get(queryValue.checkId);
          const row = value === undefined ? null : verificationOutputArtifactRowSchema.parse(value);
          return {
            type: "VERIFICATION_OUTPUT_ARTIFACT",
            artifact:
              row === null
                ? null
                : {
                    artifactId: row.artifact_id,
                    checkId: row.check_id,
                    runId: row.run_id,
                    storageKey: row.storage_key,
                  },
          };
        }
        case "HAS_VERIFICATION_OUTPUT_STORAGE_KEY":
          return {
            type: "VERIFICATION_OUTPUT_STORAGE_KEY",
            exists: selectVerificationOutputArtifactByStorageKey.get(queryValue.storageKey) !== undefined,
          };
        case "LIST_EXPIRED_VERIFICATION_OUTPUTS":
          return {
            type: "VERIFICATION_OUTPUTS",
            artifacts: selectExpiredVerificationOutputs
              .all(queryValue.closedBefore, queryValue.limit)
              .map((value) => {
                const row = verificationOutputArtifactRowSchema.parse(value);
                return { artifactId: row.artifact_id, storageKey: row.storage_key };
              }),
          };
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
        case "LIST_PENDING_VERIFICATION_PLAN_PUBLICATIONS":
          return {
            type: "VERIFICATION_PLAN_PUBLICATIONS",
            publications: selectPendingVerificationPlanPublications.all().map((row) => {
              const publication = verificationPlanPublicationFromRow(row);
              const plan = readVerificationPlan(publication.planId);
              if (plan === null) {
                throw new StateStoreError(
                  "PERSISTENCE_FAILURE",
                  "A pending verification plan publication has incomplete durable state",
                );
              }
              return { plan, publication };
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
            correctionRuns: database
              .prepare("SELECT * FROM qa_correction_runs WHERE pipeline_run_id = ? ORDER BY ordinal, id")
              .all(queryValue.pipelineRunId)
              .map(qaCorrectionRunFromRow),
            retestPlans: database
              .prepare("SELECT * FROM qa_retest_plans WHERE pipeline_run_id = ? ORDER BY created_at, id")
              .all(queryValue.pipelineRunId)
              .map(qaRetestPlanFromRow),
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
            usageReports: selectProviderUsageReportsForAttempt
              .all(queryValue.stageAttemptId)
              .map(providerUsageReportFromRow),
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
          error instanceof VerificationDomainError ||
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
