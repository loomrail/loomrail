import { z } from "zod";

import { agentRunClaimLimitsSchema, agentRunSchema, squadAssignmentSchema } from "./agents.js";
import { providerModelMappingSchema } from "./provider-selection.js";
import {
  actorSchema,
  correlationIdSchema,
  opaqueIdSchema,
  schemaVersionSchema,
  utcTimestampSchema,
} from "./shared.js";
import { reviewFindingOwnerDispositionSchema, reviewFindingSchema } from "./review.js";
import {
  completeQARunCommandSchema,
  qaAttachmentRetentionRecordedResultSchema,
  qaCorrectionExhaustedEventSchema,
  qaCorrectionCancelledEventSchema,
  qaCorrectionPassedEventSchema,
  qaCorrectionStartedEventSchema,
  qaDefectWaivedEventSchema,
  qaDefectWaivedResultSchema,
  qaRunCompletedEventSchema,
  qaRunCompletedResultSchema,
  qaRunReservedEventSchema,
  qaRunReservedResultSchema,
  recordQAAttachmentRetentionCommandSchema,
  reserveQARunCommandSchema,
  waiveQADefectCommandSchema,
} from "./qa.js";
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
  contextPackShareReducedResultSchema,
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
  providerSessionProcessRecordedResultSchema,
  providerUsageRecordedResultSchema,
  providerSessionStartedEventSchema,
  providerSessionStartedResultSchema,
  providerIdSchema,
  publishCheckpointCommandSchema,
  reconcileWorkflowsCommandSchema,
  resolveQACorrectionGateCommandSchema,
  qaCorrectionGateResolvedResultSchema,
  recordProviderSessionProcessCommandSchema,
  recordProviderUsageCommandSchema,
  reduceContextPackShareCommandSchema,
  recoveryReportCreatedEventSchema,
  reviewFindingRecordedEventSchema,
  reviewFindingResolvedEventSchema,
  reviewLoopExhaustedEventSchema,
  reviewReportRecordedEventSchema,
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
import {
  acquireWorkspaceLeaseCommandSchema,
  createWorkItemWorkspaceCommandSchema,
  markWorkspaceOrphanedCommandSchema,
  releaseWorkspaceLeaseCommandSchema,
  workItemWorkspaceCreatedEventSchema,
  workItemWorkspaceCreatedResultSchema,
  workItemWorkspaceOrphanedEventSchema,
  workItemWorkspaceOrphanedResultSchema,
  workspaceLeaseAcquiredResultSchema,
  workspaceLeaseReleasedResultSchema,
} from "./workspace.js";
import {
  completeProjectConstitutionPublicationCommandSchema,
  failProjectConstitutionPublicationCommandSchema,
  projectConstitutionActivatedEventSchema,
  projectConstitutionActivatedResultSchema,
  projectConstitutionProposedEventSchema,
  projectConstitutionProposedResultSchema,
  projectConstitutionPublicationFailedEventSchema,
  projectConstitutionPublicationFailedResultSchema,
  projectConstitutionPublicationRequestedEventSchema,
  projectConstitutionPublicationRequestedResultSchema,
  projectConstitutionPublicationRetriedResultSchema,
  proposeProjectConstitutionCommandSchema,
  requestProjectConstitutionAdoptionCommandSchema,
  retryProjectConstitutionPublicationCommandSchema,
} from "./constitution.js";
import {
  attestProjectReadinessCheckCommandSchema,
  projectReadinessAssessedEventSchema,
  projectReadinessAssessedResultSchema,
  projectReadinessAttestedEventSchema,
  projectReadinessAttestedResultSchema,
  recordProjectReadinessAssessmentCommandSchema,
} from "./readiness.js";
import {
  confirmMcpProfileCommandSchema,
  mcpGrantChangedEventSchema,
  mcpGrantChangedResultSchema,
  mcpCapabilityRecordedResultSchema,
  finishMcpToolCallCommandSchema,
  mcpToolCallChangedResultSchema,
  mcpProfileConsentedEventSchema,
  mcpProfileConsentedResultSchema,
  revokeMcpProfileGrantCommandSchema,
  recordMcpCapabilitySnapshotCommandSchema,
  startMcpToolCallCommandSchema,
  setMcpProfileGrantCommandSchema,
} from "./mcp.js";
import {
  projectProviderPreferenceChangedEventSchema,
  projectProviderPreferenceChangedResultSchema,
  providerPreferenceSchema,
  setProjectProviderPreferenceCommandSchema,
} from "./provider-selection.js";
import {
  providerAllowanceRecordedEventSchema,
  providerAllowanceRecordedResultSchema,
  recordProviderAllowanceCommandSchema,
} from "./provider-allowance.js";
import {
  completeProjectScaffoldCommandSchema,
  failProjectScaffoldCommandSchema,
  projectScaffoldCompletedEventSchema,
  projectScaffoldCompletedResultSchema,
  projectScaffoldFailedEventSchema,
  projectScaffoldFailedResultSchema,
  projectScaffoldRequestedEventSchema,
  projectScaffoldRequestedResultSchema,
  projectScaffoldRetriedResultSchema,
  requestProjectScaffoldCommandSchema,
  retryProjectScaffoldCommandSchema,
} from "./scaffolding.js";
import {
  adoptVerificationPlanCommandSchema,
  cancelVerificationRunCommandSchema,
  completeVerificationCheckCommandSchema,
  completeVerificationPlanPublicationCommandSchema,
  failVerificationPlanPublicationCommandSchema,
  interruptVerificationRunCommandSchema,
  recordVerificationOutputRetentionCommandSchema,
  retryVerificationRunCommandSchema,
  retryVerificationPlanPublicationCommandSchema,
  startVerificationCheckCommandSchema,
  startVerificationRunCommandSchema,
  verificationCheckCompletedEventSchema,
  verificationCheckCompletedResultSchema,
  verificationCheckStartedEventSchema,
  verificationCheckStartedResultSchema,
  verificationFailureRecordedEventSchema,
  verificationOutputRetentionRecordedResultSchema,
  verificationPlanAdoptedEventSchema,
  verificationPlanAdoptedResultSchema,
  verificationPlanPublicationAppliedEventSchema,
  verificationPlanPublicationAppliedResultSchema,
  verificationPlanPublicationFailedEventSchema,
  verificationPlanPublicationFailedResultSchema,
  verificationPlanPublicationRetriedEventSchema,
  verificationPlanPublicationRetriedResultSchema,
  verificationRunInterruptedEventSchema,
  verificationRunInterruptedResultSchema,
  verificationRunReservedEventSchema,
  verificationRunReservedResultSchema,
} from "./verification.js";

export const fixtureProjectIdSchema = z.enum(["web-app-a", "api-service-b"]);
export const projectStatusSchema = z.enum(["PROVISIONING", "ACTIVE", "ARCHIVED"]);
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
/**
 * A repository path exactly as an owner typed it, before anything has judged it.
 *
 * Bounded only in length, because this is the *request* side: a path that is relative, or points at
 * something that is not a repository, has to reach the daemon so the owner can be told which of
 * those it was. Rejecting it here would collapse both into one "the request payload is invalid".
 */
const repositoryPathTextSchema = z.string().min(1).max(4_096);

// Absolute, tested here rather than with `node:path`'s `isAbsolute`, because this package is parsed
// in the browser as well as in the daemon and must not import a Node builtin -- and because
// `isAbsolute` answers for the platform it is running on, while a contract has to mean the same
// thing wherever it is read. Both platform spellings are accepted: a rooted POSIX path, a
// drive-letter path, and a UNC share, since macOS and Windows are both blocking platforms.
const absolutePathPattern = /^(?:[/\\]|[A-Za-z]:[/\\])/;

/**
 * A repository path a Project may actually *record*.
 *
 * Absolute, without exception. A relative path has no meaning outside the process that resolved it:
 * typing `.` into the Settings field used to register whatever directory the daemon happened to be
 * launched from, silently and with a 200, while every field description promised an absolute path.
 * A Project's path is read back by a daemon started from somewhere else entirely -- a launcher, a
 * login item, a different shell -- so a stored relative path names a different repository on the
 * next start than it did on this one.
 *
 * Enforced on the command and on the Project itself rather than only at the HTTP edge, so no route,
 * fixture or test can put a relative path into the database by a path that skips the edge check.
 */
const repositoryPathSchema = repositoryPathTextSchema.regex(
  absolutePathPattern,
  "A repository path must be absolute",
);
const acceptanceCriteriaSchema = z.array(z.string().trim().min(1).max(500)).max(50);

export const projectSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    workspaceId: opaqueIdSchema,
    // Nullable, not optional: a Project registered by path is a local Git repository the owner
    // named, and it genuinely has no bundled fixture behind it (spec
    // docs/plans/13-e1-workspace-execution-spec.ru.md §4). Absent would read as "not recorded";
    // null records the fact that there is nothing to record -- the same discipline
    // workItemWorkspaceSchema's baseCommit and snapshotCommit follow in workspace.ts.
    fixtureId: fixtureProjectIdSchema.nullable(),
    name: titleSchema,
    repositoryPath: repositoryPathSchema,
    providerPreference: providerPreferenceSchema.default("AUTO"),
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

/**
 * Records that, at this moment, this Project is registered at this repository path.
 *
 * REPOINT_FIXTURE_PROJECT emits this too, and deliberately not an event type of its own. What the
 * repoint changes is exactly what this event already carries -- the Project, path included -- and
 * the path it moved *off* is not lost by reusing the type: it is the `repositoryPath` on this same
 * Project's earlier PROJECT_REGISTERED event, which the append-only log still holds. A second event
 * type would have bought a field the log already answers, at the price of rebuilding the `events`
 * CHECK constraint (migration 0011's shape) on the owner's real database.
 */
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

export const squadAssignedEventSchema = eventBaseSchema.extend({
  type: z.literal("SQUAD_ASSIGNED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ assignment: squadAssignmentSchema }).strict(),
});

export const agentRunStartedEventSchema = eventBaseSchema.extend({
  type: z.literal("AGENT_RUN_STARTED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ run: agentRunSchema }).strict(),
});

export const agentRunFinishedEventSchema = eventBaseSchema.extend({
  type: z.literal("AGENT_RUN_FINISHED"),
  aggregateType: z.literal("WORK_ITEM"),
  data: z.object({ run: agentRunSchema }).strict(),
});

export const domainEventSchema = z.discriminatedUnion("type", [
  projectRegisteredEventSchema,
  projectScaffoldRequestedEventSchema,
  projectScaffoldCompletedEventSchema,
  projectScaffoldFailedEventSchema,
  projectConstitutionProposedEventSchema,
  projectConstitutionPublicationRequestedEventSchema,
  projectConstitutionActivatedEventSchema,
  projectConstitutionPublicationFailedEventSchema,
  projectReadinessAssessedEventSchema,
  projectReadinessAttestedEventSchema,
  projectProviderPreferenceChangedEventSchema,
  verificationPlanAdoptedEventSchema,
  verificationPlanPublicationAppliedEventSchema,
  verificationPlanPublicationFailedEventSchema,
  verificationPlanPublicationRetriedEventSchema,
  verificationRunReservedEventSchema,
  verificationCheckStartedEventSchema,
  verificationCheckCompletedEventSchema,
  verificationRunInterruptedEventSchema,
  verificationFailureRecordedEventSchema,
  providerAllowanceRecordedEventSchema,
  mcpProfileConsentedEventSchema,
  mcpGrantChangedEventSchema,
  workItemCreatedEventSchema,
  workItemUpdatedEventSchema,
  workItemStateChangedEventSchema,
  squadAssignedEventSchema,
  agentRunStartedEventSchema,
  agentRunFinishedEventSchema,
  qaRunReservedEventSchema,
  qaRunCompletedEventSchema,
  qaDefectWaivedEventSchema,
  qaCorrectionStartedEventSchema,
  qaCorrectionExhaustedEventSchema,
  qaCorrectionCancelledEventSchema,
  qaCorrectionPassedEventSchema,
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
  reviewReportRecordedEventSchema,
  reviewFindingRecordedEventSchema,
  reviewFindingResolvedEventSchema,
  reviewLoopExhaustedEventSchema,
  acceptanceRequestedEventSchema,
  acceptanceResolvedEventSchema,
  pipelineCompletedEventSchema,
  providerSessionStartedEventSchema,
  checkpointPublishedEventSchema,
  contextHandoffRequestedEventSchema,
  providerSessionEndedEventSchema,
  contextFloorExceededEventSchema,
  workItemWorkspaceCreatedEventSchema,
  workItemWorkspaceOrphanedEventSchema,
]);

const commandBaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    correlationId: correlationIdSchema,
    actor: actorSchema,
  })
  .strict();

/**
 * Registers a Project at a local Git repository.
 *
 * One command for both ways in, because there is only one thing being recorded: a repository
 * Loomrail may branch. Where the repository came from is data, not a second operation -- a bundled
 * fixture names itself in `fixtureId`, a repository the owner registered by path leaves it null,
 * and everything downstream (the dedupe on id/fixture/path, the PROJECT_REGISTERED event, the row)
 * is identical either way. It was called REGISTER_FIXTURE_PROJECT while a fixture was the only way
 * in; keeping that name over a null `fixtureId` would be a command lying about what it registers.
 */
export const registerProjectCommandSchema = commandBaseSchema.extend({
  type: z.literal("REGISTER_PROJECT"),
  payload: z
    .object({
      id: opaqueIdSchema,
      fixtureId: fixtureProjectIdSchema.nullable(),
      name: titleSchema,
      repositoryPath: repositoryPathSchema,
    })
    .strict(),
});

/**
 * Moves a fixture-backed Project off the bundled template it still records, onto the repository
 * that template has just been materialised into.
 *
 * Why this exists at all: the two demo Projects were registered before a bundled fixture became a
 * real repository, so their `repository_path` names a directory *inside Loomrail's own checkout*.
 * Migration 0012 carried those paths across verbatim -- correctly, because a migration cannot know
 * the data directory, which is runtime configuration -- and pressing "Initialize demo workspace"
 * afterwards materialised the repository and then answered PROJECT_ALREADY_REGISTERED, leaving the
 * fresh repository orphaned on disk and the Project pointing at the template forever. Every stage
 * that needs a workspace is refused at such a path, and no route repaired it.
 *
 * A command of its own rather than a widening of REGISTER_PROJECT, because it is a different claim:
 * that one asserts nothing is registered here yet, this one asserts something is and names both the
 * path it must currently record and the path it should record instead.
 *
 * `expectedRepositoryPath` is the guard, not a convenience. The persistence layer applies this only
 * when the row still carries exactly that path, so a Project the owner registered by path can never
 * be moved by it, and a concurrent registration that already fixed the row is refused rather than
 * silently re-applied.
 */
export const repointFixtureProjectCommandSchema = commandBaseSchema.extend({
  type: z.literal("REPOINT_FIXTURE_PROJECT"),
  payload: z
    .object({
      projectId: opaqueIdSchema,
      // Non-nullable, unlike REGISTER_PROJECT's: only a fixture-backed Project can be re-pointed,
      // and requiring the fixture here is half of what keeps a path-registered one out of reach.
      fixtureId: fixtureProjectIdSchema,
      expectedRepositoryPath: repositoryPathSchema,
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

export const startAgentRunCommandSchema = commandBaseSchema.extend({
  type: z.literal("START_AGENT_RUN"),
  payload: z
    .object({
      dispatchId: opaqueIdSchema,
      provider: providerIdSchema,
      // Optional only for replaying command receipts created before exact model snapshots. The
      // daemon now supplies the mapping from the selected adapter, never from HTTP or provider text.
      modelMapping: providerModelMappingSchema.nullable().optional(),
      limits: agentRunClaimLimitsSchema,
    })
    .strict(),
});

export const disposeReviewFindingCommandSchema = commandBaseSchema.extend({
  type: z.literal("DISPOSE_REVIEW_FINDING"),
  payload: z
    .object({
      findingId: opaqueIdSchema,
      expectedVersion: z.number().int().positive(),
      disposition: reviewFindingOwnerDispositionSchema,
      reason: z.string().trim().min(1).max(4_000),
    })
    .strict(),
});

export const stateCommandSchema = z.discriminatedUnion("type", [
  registerProjectCommandSchema,
  repointFixtureProjectCommandSchema,
  requestProjectScaffoldCommandSchema,
  completeProjectScaffoldCommandSchema,
  failProjectScaffoldCommandSchema,
  retryProjectScaffoldCommandSchema,
  proposeProjectConstitutionCommandSchema,
  requestProjectConstitutionAdoptionCommandSchema,
  completeProjectConstitutionPublicationCommandSchema,
  failProjectConstitutionPublicationCommandSchema,
  retryProjectConstitutionPublicationCommandSchema,
  recordProjectReadinessAssessmentCommandSchema,
  attestProjectReadinessCheckCommandSchema,
  setProjectProviderPreferenceCommandSchema,
  adoptVerificationPlanCommandSchema,
  completeVerificationPlanPublicationCommandSchema,
  failVerificationPlanPublicationCommandSchema,
  retryVerificationPlanPublicationCommandSchema,
  startVerificationRunCommandSchema,
  retryVerificationRunCommandSchema,
  startVerificationCheckCommandSchema,
  completeVerificationCheckCommandSchema,
  cancelVerificationRunCommandSchema,
  interruptVerificationRunCommandSchema,
  recordVerificationOutputRetentionCommandSchema,
  recordProviderAllowanceCommandSchema,
  confirmMcpProfileCommandSchema,
  setMcpProfileGrantCommandSchema,
  revokeMcpProfileGrantCommandSchema,
  recordMcpCapabilitySnapshotCommandSchema,
  startMcpToolCallCommandSchema,
  finishMcpToolCallCommandSchema,
  createWorkItemCommandSchema,
  updateWorkItemCommandSchema,
  moveWorkItemCommandSchema,
  startAgentRunCommandSchema,
  reserveQARunCommandSchema,
  completeQARunCommandSchema,
  recordQAAttachmentRetentionCommandSchema,
  waiveQADefectCommandSchema,
  disposeReviewFindingCommandSchema,
  startMockPipelineCommandSchema,
  markWorkflowDispatchStartedCommandSchema,
  applyProviderOutcomeCommandSchema,
  legacyApplyMockProviderOutcomeCommandSchema,
  answerHumanRequestCommandSchema,
  resolveQACorrectionGateCommandSchema,
  pausePipelineCommandSchema,
  resumePipelineCommandSchema,
  cancelPipelineCommandSchema,
  approveBudgetOverrideCommandSchema,
  reconcileWorkflowsCommandSchema,
  resolveAcceptanceCommandSchema,
  startProviderSessionCommandSchema,
  recordProviderSessionProcessCommandSchema,
  recordProviderUsageCommandSchema,
  publishCheckpointCommandSchema,
  endProviderSessionCommandSchema,
  requestContextHandoffCommandSchema,
  hardPauseStageAttemptCommandSchema,
  reduceContextPackShareCommandSchema,
  createWorkItemWorkspaceCommandSchema,
  acquireWorkspaceLeaseCommandSchema,
  releaseWorkspaceLeaseCommandSchema,
  markWorkspaceOrphanedCommandSchema,
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

export const agentRunStartedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("AGENT_RUN_STARTED"),
  workItemId: opaqueIdSchema,
  assignment: squadAssignmentSchema,
  run: agentRunSchema,
  events: z.array(
    z.discriminatedUnion("type", [
      squadAssignedEventSchema,
      stageAttemptChangedEventSchema,
      agentRunStartedEventSchema,
    ]),
  ),
});

export const reviewFindingDisposedResultSchema = commandResultBaseSchema.extend({
  type: z.literal("REVIEW_FINDING_DISPOSED"),
  workItemId: opaqueIdSchema,
  finding: reviewFindingSchema,
  events: z.array(reviewFindingResolvedEventSchema).length(1),
});

export const stateCommandResultSchema = z.discriminatedUnion("type", [
  projectRegisteredResultSchema,
  projectScaffoldRequestedResultSchema,
  projectScaffoldCompletedResultSchema,
  projectScaffoldFailedResultSchema,
  projectScaffoldRetriedResultSchema,
  projectConstitutionProposedResultSchema,
  projectConstitutionPublicationRequestedResultSchema,
  projectConstitutionActivatedResultSchema,
  projectConstitutionPublicationFailedResultSchema,
  projectConstitutionPublicationRetriedResultSchema,
  projectReadinessAssessedResultSchema,
  projectReadinessAttestedResultSchema,
  projectProviderPreferenceChangedResultSchema,
  verificationPlanAdoptedResultSchema,
  verificationPlanPublicationAppliedResultSchema,
  verificationPlanPublicationFailedResultSchema,
  verificationPlanPublicationRetriedResultSchema,
  verificationRunReservedResultSchema,
  verificationCheckStartedResultSchema,
  verificationCheckCompletedResultSchema,
  verificationRunInterruptedResultSchema,
  verificationOutputRetentionRecordedResultSchema,
  providerAllowanceRecordedResultSchema,
  mcpProfileConsentedResultSchema,
  mcpGrantChangedResultSchema,
  mcpCapabilityRecordedResultSchema,
  mcpToolCallChangedResultSchema,
  workItemCreatedResultSchema,
  workItemUpdatedResultSchema,
  workItemMovedResultSchema,
  agentRunStartedResultSchema,
  qaRunReservedResultSchema,
  qaRunCompletedResultSchema,
  qaAttachmentRetentionRecordedResultSchema,
  qaDefectWaivedResultSchema,
  reviewFindingDisposedResultSchema,
  pipelineStartedResultSchema,
  workflowDispatchStartedResultSchema,
  mockProviderOutcomeAppliedResultSchema,
  humanRequestAnsweredResultSchema,
  qaCorrectionGateResolvedResultSchema,
  pipelineControlAppliedResultSchema,
  budgetOverrideApprovedResultSchema,
  workflowsReconciledResultSchema,
  acceptanceResolvedResultSchema,
  providerSessionStartedResultSchema,
  providerSessionProcessRecordedResultSchema,
  providerUsageRecordedResultSchema,
  checkpointPublishedResultSchema,
  providerSessionEndedResultSchema,
  contextHandoffRequestedResultSchema,
  stageAttemptHardPausedResultSchema,
  contextPackShareReducedResultSchema,
  workItemWorkspaceCreatedResultSchema,
  workspaceLeaseAcquiredResultSchema,
  workspaceLeaseReleasedResultSchema,
  workItemWorkspaceOrphanedResultSchema,
]);

export const registerFixtureProjectRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    fixtureId: fixtureProjectIdSchema,
  })
  .strict();

/**
 * Registering the owner's own repository by path.
 *
 * A separate request from the fixture one rather than a widening of it, because the two share no
 * input: a fixture registration names one of two catalog entries and Loomrail derives the path, the
 * id and the name from the bundled manifest; this one names a path on the owner's disk and derives
 * everything from that. Folding them together would mean a schema with two optional fields and a
 * refinement saying exactly one must be present -- a union at the boundary, standing in for two
 * endpoints, so that the handler could immediately branch back apart.
 *
 * The path is the only field. There is deliberately no `name`: see the daemon's
 * `registerRepositoryProject`, which takes the repository directory's own name.
 *
 * `repositoryPathTextSchema`, not `repositoryPathSchema`: the request accepts what the owner typed
 * so that the daemon can answer *why* it is not usable -- "this path is not absolute", "this is not
 * a repository", "this is a directory inside the repository at X" are three different fixes, and a
 * schema refusal at the edge would give all three the same "the request payload is invalid".
 * `repositoryPathSchema` still guards what is ultimately recorded, on the command below.
 */
export const registerRepositoryProjectRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: opaqueIdSchema,
    repositoryPath: repositoryPathTextSchema,
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

/**
 * Whether a Project's recorded `repositoryPath` is, right now, the top level of a Git repository.
 *
 * A Project is a durable record and this is a fact about the filesystem this minute, so it is not a
 * field of `projectSchema`: it is never stored, never carried on an event, and it can be true one
 * start and false the next without the Project having changed at all. It rides on the list response
 * because the list is the one place the owner sees their Projects, and a Project whose repository
 * has gone is otherwise indistinguishable from a healthy one -- the two demo Projects on a database
 * that predates E1 record a path inside Loomrail's own checkout, every IMPLEMENT and QA on them is
 * refused there, and nothing in the UI said so.
 */
export const projectRepositoryStatusSchema = z.enum(["READY", "UNUSABLE"]);

export const listedProjectSchema = projectSchema
  .extend({ repositoryStatus: projectRepositoryStatusSchema })
  .strict();

export const projectsResponseSchema = z
  .object({ schemaVersion: schemaVersionSchema, projects: z.array(listedProjectSchema) })
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
export type ProjectRepositoryStatus = z.infer<typeof projectRepositoryStatusSchema>;
export type ListedProject = z.infer<typeof listedProjectSchema>;
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
export type SquadAssignedEvent = z.infer<typeof squadAssignedEventSchema>;
export type AgentRunStartedEvent = z.infer<typeof agentRunStartedEventSchema>;
export type AgentRunFinishedEvent = z.infer<typeof agentRunFinishedEventSchema>;
export type RegisterProjectCommand = z.infer<typeof registerProjectCommandSchema>;
export type RepointFixtureProjectCommand = z.infer<typeof repointFixtureProjectCommandSchema>;
export type CreateWorkItemCommand = z.infer<typeof createWorkItemCommandSchema>;
export type UpdateWorkItemCommand = z.infer<typeof updateWorkItemCommandSchema>;
export type MoveWorkItemCommand = z.infer<typeof moveWorkItemCommandSchema>;
export type StartAgentRunCommand = z.infer<typeof startAgentRunCommandSchema>;
export type DisposeReviewFindingCommand = z.infer<typeof disposeReviewFindingCommandSchema>;
export type StateCommand = z.infer<typeof stateCommandSchema>;
export type StateCommandResult = z.infer<typeof stateCommandResultSchema>;
