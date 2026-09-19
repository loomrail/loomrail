import { z } from "zod";
import {
  coordinatorModelId,
  coordinatorProfileId,
  economyModelIds,
  stageExecutionPolicySchema,
} from "./orchestration.js";

import { activityOriginSchema } from "./activity.js";
import { providerModelIdSchema, providerPreferenceSchema } from "./provider-selection.js";
import { modelTierSchema, opaqueIdSchema, schemaVersionSchema, utcTimestampSchema } from "./shared.js";
import { contextSectionIdSchema, providerIdSchema, workflowStageSchema } from "./workflow.js";

export const agentRoleSchema = z.enum([
  "LEAD_PM",
  "PRODUCT_ANALYST",
  "SOFTWARE_ARCHITECT",
  "DEVELOPER",
  "CODE_REVIEWER",
  "BROWSER_QA",
  "ACCEPTANCE_MANAGER",
]);

export { modelTierSchema } from "./shared.js";
export const agentProfileProvenanceSchema = z.enum(["BUILTIN", "PROJECT"]);
export const agentCapabilitySchema = z.enum([
  "ARTIFACT_WRITE",
  "REPOSITORY_READ",
  "REPOSITORY_WRITE",
  "NETWORK",
  "MCP_READ",
  "BROWSER_READ",
]);
export const agentArtifactKindSchema = z.enum([
  "DISCOVERY_BRIEF",
  "OPEN_QUESTION_SET",
  "ARCHITECTURE_PROPOSAL",
  "TASK_GRAPH",
  "CHANGE_SET",
  "TEST_REPORT",
  "FINDING_SET",
  "QA_EVIDENCE_BUNDLE",
  "ACCEPTANCE_PACKAGE",
]);

const boundedTextSchema = z.string().trim().min(1).max(2_000);
const shortTextSchema = z.string().trim().min(1).max(200);

export const rolePlaybookSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    preferredContextSections: z.array(contextSectionIdSchema).max(20),
  })
  .strict();

export const agentProfileSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    revision: z.number().int().positive(),
    name: shortTextSchema,
    role: agentRoleSchema,
    identity: boundedTextSchema,
    mission: boundedTextSchema,
    nonGoals: z.array(boundedTextSchema).max(20),
    stages: z.array(workflowStageSchema).min(1).max(6),
    expectedInputs: z.array(shortTextSchema).max(20),
    expectedOutputs: z.array(agentArtifactKindSchema).min(1).max(20),
    allowedCapabilities: z.array(agentCapabilitySchema).max(20),
    successRubric: z.array(boundedTextSchema).min(1).max(20),
    escalationConditions: z.array(boundedTextSchema).min(1).max(20),
    handoffContract: boundedTextSchema,
    defaultProvider: providerPreferenceSchema,
    defaultModelTier: modelTierSchema,
    budgetEnvelope: z
      .object({
        maxEstimatedTokens: z.number().int().positive(),
        maxProviderSessions: z.number().int().positive().max(50),
      })
      .strict(),
    playbook: rolePlaybookSchema,
    provenance: agentProfileProvenanceSchema,
  })
  .strict();

export const agentProfileRefSchema = agentProfileSchema
  .pick({ id: true, revision: true, role: true })
  .strict();

export const squadStageAssignmentSchema = z
  .object({
    stage: workflowStageSchema,
    profile: agentProfileRefSchema,
    execution: stageExecutionPolicySchema.optional(),
  })
  .strict()
  .superRefine((assignment, context) => {
    if (
      (assignment.profile.id === coordinatorProfileId) !==
        (assignment.execution?.kind === "CODE_BLIND_MANAGER") ||
      (assignment.execution?.kind === "CODE_BLIND_MANAGER" && assignment.stage !== "PLAN")
    ) {
      context.addIssue({ code: "custom", message: "Coordinator profile and PLAN execution must match" });
    }
  });

export const squadAssignmentSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    revision: z.number().int().positive(),
    stages: z.array(squadStageAssignmentSchema).min(1).max(6),
    createdAt: utcTimestampSchema,
  })
  .strict()
  .superRefine((assignment, context) => {
    if (!assignment.stages.some(({ execution }) => execution !== undefined)) return;
    if (
      assignment.stages.length !== 6 ||
      new Set(assignment.stages.map(({ stage }) => stage)).size !== 6 ||
      assignment.stages.some(
        ({ stage, execution }) =>
          execution?.kind !== (stage === "PLAN" ? "CODE_BLIND_MANAGER" : "ECONOMY_WORKER"),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Code-blind squads require exactly one manager and all five economy worker stages",
      });
    }
  });

export const agentRunStatusSchema = z.enum([
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
  "WAITING_HUMAN",
  "SOFT_PAUSED",
  "HARD_PAUSED",
]);

export const agentRunClaimLimitsSchema = z
  .object({
    global: z.number().int().min(0).max(32),
    project: z.number().int().min(0).max(32),
    provider: z.number().int().min(0).max(32),
  })
  .strict();

export const agentRunWorkspacePolicySchema = z
  .object({
    access: z.enum(["NONE", "READ_ONLY", "READ_WRITE"]),
    networkAccess: z.boolean(),
  })
  .strict();

export const agentRunPolicySnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    execution: stageExecutionPolicySchema.optional(),
    assignment: z.object({ id: opaqueIdSchema, revision: z.number().int().positive() }).strict(),
    profile: agentProfileRefSchema,
    provider: providerIdSchema,
    effectiveCapabilities: z.array(agentCapabilitySchema).max(6),
    modelTier: modelTierSchema,
    // Optional only for snapshots written before exact provider-model binding. New live AgentRuns
    // persist the validated adapter model ID; historical pre-API records persist explicit null.
    modelId: providerModelIdSchema.nullable().optional(),
    // Optional only for policy snapshots written before the Constitution binding existed. New
    // AgentRuns always write either the exact immutable content reference or explicit null.
    projectConstitution: z
      .object({
        id: opaqueIdSchema,
        version: z.number().int().positive(),
        contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable()
      .optional(),
    claimLimits: agentRunClaimLimitsSchema,
    budget: z
      .object({
        pipelinePolicyId: opaqueIdSchema,
        pipelinePolicyRevision: z.number().int().positive(),
        maxEstimatedTokens: z.number().int().positive(),
        maxProviderSessions: z.number().int().positive().max(50),
      })
      .strict(),
    workspace: agentRunWorkspacePolicySchema,
    mcpProfileRevisionIds: z.array(opaqueIdSchema).max(64),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const manager = snapshot.execution?.kind === "CODE_BLIND_MANAGER";
    if (manager !== (snapshot.profile.id === coordinatorProfileId)) {
      context.addIssue({ code: "custom", message: "Coordinator execution must match the immutable profile" });
    }
    if (
      manager &&
      (snapshot.provider !== "CODEX" ||
        snapshot.modelId !== coordinatorModelId ||
        snapshot.modelTier !== "DEEP" ||
        snapshot.projectConstitution !== null ||
        snapshot.effectiveCapabilities.length !== 1 ||
        snapshot.effectiveCapabilities[0] !== "ARTIFACT_WRITE" ||
        snapshot.workspace.access !== "NONE" ||
        snapshot.workspace.networkAccess ||
        snapshot.mcpProfileRevisionIds.length !== 0)
    ) {
      context.addIssue({ code: "custom", message: "Code-blind manager authority or model mismatch" });
    }
    if (manager && (snapshot.budget.maxEstimatedTokens > 12_000 || snapshot.budget.maxProviderSessions > 2)) {
      context.addIssue({ code: "custom", message: "Coordinator budget cannot exceed its bounded profile" });
    }
    if (
      snapshot.execution?.kind === "ECONOMY_WORKER" &&
      (snapshot.provider === "MOCK" ||
        snapshot.modelId !== economyModelIds[snapshot.provider] ||
        snapshot.modelTier !== (snapshot.provider === "CODEX" ? "FAST" : "STANDARD"))
    ) {
      context.addIssue({ code: "custom", message: "Economy worker must use its exact provider model" });
    }
    const capabilities = new Set(snapshot.effectiveCapabilities);
    if (capabilities.size !== snapshot.effectiveCapabilities.length) {
      context.addIssue({ code: "custom", message: "Effective capabilities must be unique" });
    }
    if (capabilities.has("REPOSITORY_WRITE") && !capabilities.has("REPOSITORY_READ")) {
      context.addIssue({ code: "custom", message: "Repository write requires repository read" });
    }
    const expectedAccess = capabilities.has("REPOSITORY_WRITE")
      ? "READ_WRITE"
      : capabilities.has("REPOSITORY_READ")
        ? "READ_ONLY"
        : "NONE";
    if (snapshot.workspace.access !== expectedAccess) {
      context.addIssue({ code: "custom", message: "Workspace access must match effective capabilities" });
    }
    if (snapshot.workspace.networkAccess !== capabilities.has("NETWORK")) {
      context.addIssue({ code: "custom", message: "Network access must match effective capabilities" });
    }
    if (new Set(snapshot.mcpProfileRevisionIds).size !== snapshot.mcpProfileRevisionIds.length) {
      context.addIssue({ code: "custom", message: "MCP profile revisions must be unique" });
    }
    if (capabilities.has("MCP_READ") !== snapshot.mcpProfileRevisionIds.length > 0) {
      context.addIssue({ code: "custom", message: "MCP read requires an exact non-empty revision set" });
    }
  });

export const agentRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    workItemId: opaqueIdSchema,
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    ordinal: z.number().int().positive(),
    squadAssignmentId: opaqueIdSchema,
    profile: agentProfileRefSchema,
    provider: providerIdSchema,
    status: agentRunStatusSchema,
    policySnapshot: agentRunPolicySnapshotSchema.nullable().default(null),
    policySnapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    startedAt: utcTimestampSchema,
    finishedAt: utcTimestampSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((run, context) => {
    if ((run.status === "RUNNING") !== (run.finishedAt === null)) {
      context.addIssue({
        code: "custom",
        message: "A running AgentRun must not be finished and every non-running AgentRun must be finished",
      });
    }
    if (
      run.policySnapshot !== null &&
      (run.policySnapshot.assignment.id !== run.squadAssignmentId ||
        run.policySnapshot.profile.id !== run.profile.id ||
        run.policySnapshot.profile.revision !== run.profile.revision ||
        run.policySnapshot.profile.role !== run.profile.role ||
        run.policySnapshot.provider !== run.provider)
    ) {
      context.addIssue({ code: "custom", message: "The policy snapshot must describe this AgentRun" });
    }
  });

export const agentFleetWaitReasonSchema = z.enum([
  "NOT_READY",
  "BUDGET_BLOCKED",
  "CHECKPOINT_NOT_STABLE",
  "ATTEMPT_ACTIVE",
  "GLOBAL_LIMIT",
  "PROJECT_LIMIT",
  "PROVIDER_LIMIT",
  "WORKSPACE_CONFLICT",
]);
export const agentFleetEntryStatusSchema = z.enum(["READY", "WAITING", "RUNNING"]);
export const maxAgentFleetEntries = 200;

// Task 10: the newest thing a running agent has done, across both Run Activity sources (daemon
// -audited and provider-reported). `label` is bare text -- for a DAEMON_AUDITED entry it is a
// `WorkspaceToolOperation` code meant for the `workspaceTool.operation.*` i18n lookup the Run
// Activity feed already uses; for a PROVIDER_REPORTED entry it is the provider's own free text,
// untrusted and rendered as-is. Which reading applies is exactly what `origin` tells the caller, so
// this carries no separate "is this translatable" flag of its own.
export const agentFleetLatestActionSchema = z
  .object({
    // Bounded at 500, matching `agentRunActivityEntrySchema.label`'s own max (not this file's
    // `shortTextSchema`, whose 200-char cap is a UI convention for names and titles, not for a
    // provider's free-text description of what it just did) -- the source of this text, never a
    // UI concern of the Fleet's own.
    label: z.string().trim().min(1).max(500),
    origin: activityOriginSchema,
  })
  .strict();

export const agentFleetEntrySchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    project: z.object({ id: opaqueIdSchema, name: shortTextSchema }).strict(),
    workItem: z.object({ id: opaqueIdSchema, title: shortTextSchema }).strict(),
    pipelineRunId: opaqueIdSchema,
    stageAttemptId: opaqueIdSchema,
    dispatchId: opaqueIdSchema.nullable(),
    agentRunId: opaqueIdSchema.nullable(),
    profile: agentProfileRefSchema,
    stage: workflowStageSchema,
    provider: providerIdSchema,
    status: agentFleetEntryStatusSchema,
    waitReason: agentFleetWaitReasonSchema.nullable(),
    startedAt: utcTimestampSchema.nullable(),
    // Nullable rather than omitted: a running entry legitimately has no activity yet (its first
    // provider report has not landed), and that is a different fact from "this entry cannot have
    // one" (every queued entry below).
    latestAction: agentFleetLatestActionSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.status === "RUNNING") {
      if (entry.agentRunId === null || entry.startedAt === null || entry.waitReason !== null) {
        context.addIssue({ code: "custom", message: "A running Fleet entry must name its AgentRun" });
      }
      return;
    }
    if (entry.agentRunId !== null || entry.startedAt !== null) {
      context.addIssue({ code: "custom", message: "A queued Fleet entry cannot name an AgentRun" });
    }
    if ((entry.status === "WAITING") !== (entry.waitReason !== null)) {
      context.addIssue({ code: "custom", message: "Only a waiting Fleet entry has a wait reason" });
    }
    if (entry.latestAction !== null) {
      context.addIssue({
        code: "custom",
        message: "Only a running Fleet entry -- the one with an AgentRun -- can report a latest action",
      });
    }
  });

export const agentFleetResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    entries: z.array(agentFleetEntrySchema).max(maxAgentFleetEntries),
    capacity: z
      .object({
        active: z.number().int().nonnegative().max(maxAgentFleetEntries),
        globalLimit: z.number().int().min(0).max(32),
      })
      .strict(),
  })
  .strict();

export type AgentRole = z.infer<typeof agentRoleSchema>;
export type { ModelTier } from "./shared.js";
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export type AgentArtifactKind = z.infer<typeof agentArtifactKindSchema>;
export type RolePlaybook = z.infer<typeof rolePlaybookSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProfileRef = z.infer<typeof agentProfileRefSchema>;
export type SquadStageAssignment = z.infer<typeof squadStageAssignmentSchema>;
export type SquadAssignment = z.infer<typeof squadAssignmentSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentRunClaimLimits = z.infer<typeof agentRunClaimLimitsSchema>;
export type AgentRunWorkspacePolicy = z.infer<typeof agentRunWorkspacePolicySchema>;
export type AgentRunPolicySnapshot = z.infer<typeof agentRunPolicySnapshotSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type AgentFleetWaitReason = z.infer<typeof agentFleetWaitReasonSchema>;
export type AgentFleetEntryStatus = z.infer<typeof agentFleetEntryStatusSchema>;
export type AgentFleetLatestAction = z.infer<typeof agentFleetLatestActionSchema>;
export type AgentFleetEntry = z.infer<typeof agentFleetEntrySchema>;
export type AgentFleetResponse = z.infer<typeof agentFleetResponseSchema>;
