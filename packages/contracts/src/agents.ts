import { z } from "zod";

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
  })
  .strict();

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
  .strict();

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
    assignment: z.object({ id: opaqueIdSchema, revision: z.number().int().positive() }).strict(),
    profile: agentProfileRefSchema,
    provider: providerIdSchema,
    effectiveCapabilities: z.array(agentCapabilitySchema).max(6),
    modelTier: modelTierSchema,
    // Optional only for snapshots written before exact provider-model binding. New live AgentRuns
    // persist the validated adapter model ID; Mock persists explicit null.
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
export type AgentFleetEntry = z.infer<typeof agentFleetEntrySchema>;
export type AgentFleetResponse = z.infer<typeof agentFleetResponseSchema>;
