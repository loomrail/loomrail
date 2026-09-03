import {
  agentProfileSchema,
  agentRunPolicySnapshotSchema,
  agentRunSchema,
  squadAssignmentSchema,
  type AgentCapability,
  type AgentProfile,
  type AgentProfileRef,
  type AgentRole,
  type AgentRun,
  type AgentRunClaimLimits,
  type AgentRunPolicySnapshot,
  type AgentRunStatus,
  type ContextPackSpec,
  type ProviderId,
  type RolePlaybook,
  type SquadAssignment,
  type WorkflowStage,
} from "@loomrail/contracts";
import { validateContextPackSpec } from "@loomrail/workflow-engine";

import { stageRunsInWorkspace, stageWritesInWorkspace } from "./workspace.js";

export type AgentDomainErrorCode =
  | "DUPLICATE_PROFILE_FIELD"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_STAGE_MISMATCH"
  | "ASSIGNMENT_SCOPE_MISMATCH"
  | "AGENT_RUN_BUDGET_EXHAUSTED"
  | "AGENT_RUN_NOT_RUNNING";

export class AgentDomainError extends Error {
  readonly code: AgentDomainErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: AgentDomainErrorCode,
    message: string,
    details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "AgentDomainError";
    this.code = code;
    this.details = details;
  }
}

const assertUnique = (values: readonly string[], field: string): void => {
  if (new Set(values).size !== values.length) {
    throw new AgentDomainError("DUPLICATE_PROFILE_FIELD", `An AgentProfile repeats ${field}`, { field });
  }
};

export const validateAgentProfile = (input: unknown): AgentProfile => {
  const profile = agentProfileSchema.parse(input);
  assertUnique(profile.stages, "stages");
  assertUnique(profile.expectedInputs, "expectedInputs");
  assertUnique(profile.expectedOutputs, "expectedOutputs");
  assertUnique(profile.allowedCapabilities, "allowedCapabilities");
  assertUnique(profile.playbook.preferredContextSections, "preferredContextSections");
  return profile;
};

type BuiltinProfileInput = Omit<
  AgentProfile,
  "schemaVersion" | "revision" | "defaultProvider" | "provenance"
>;

const builtinProfile = (input: BuiltinProfileInput): AgentProfile =>
  validateAgentProfile({
    schemaVersion: 1,
    revision: 1,
    defaultProvider: "AUTO",
    provenance: "BUILTIN",
    ...input,
  });

export const builtinAgentProfiles: readonly AgentProfile[] = [
  builtinProfile({
    id: "builtin.lead-pm",
    name: "Lead PM",
    role: "LEAD_PM",
    identity: "A bounded product and delivery coordinator for approved work.",
    mission: "Shape the next safe decision and coordinate only the roles the work needs.",
    nonGoals: ["Do not expand scope, budgets or permissions without the owner."],
    stages: ["DISCOVERY", "PLAN"],
    expectedInputs: ["Approved work item", "Project Constitution"],
    expectedOutputs: ["DISCOVERY_BRIEF", "TASK_GRAPH"],
    allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "MCP_READ"],
    successRubric: ["Every proposed task is bounded, owned and traceable to an approved outcome."],
    escalationConditions: ["Scope, budget or acceptance authority must change."],
    handoffContract:
      "Publish the current plan, dependencies, risks and exact owner decisions still required.",
    defaultModelTier: "DEEP",
    budgetEnvelope: { maxEstimatedTokens: 100_000, maxProviderSessions: 8 },
    playbook: {
      schemaVersion: 1,
      preferredContextSections: ["WORK_ITEM_BRIEF", "DECISIONS", "ACTIVITY"],
    },
  }),
  builtinProfile({
    id: "builtin.product-analyst",
    name: "Product Analyst",
    role: "PRODUCT_ANALYST",
    identity: "A requirements analyst focused on observable user outcomes and edge cases.",
    mission: "Turn the approved problem into a precise discovery brief and open questions.",
    nonGoals: ["Do not implement code or silently decide unresolved product trade-offs."],
    stages: ["DISCOVERY"],
    expectedInputs: ["Work item brief", "Project Constitution"],
    expectedOutputs: ["DISCOVERY_BRIEF", "OPEN_QUESTION_SET"],
    allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "MCP_READ"],
    successRubric: ["Requirements, non-goals, edge cases and acceptance signals are explicit."],
    escalationConditions: ["Two valid product interpretations change the implementation materially."],
    handoffContract: "Publish findings, unresolved questions and acceptance-criteria implications.",
    defaultModelTier: "STANDARD",
    budgetEnvelope: { maxEstimatedTokens: 80_000, maxProviderSessions: 6 },
    playbook: {
      schemaVersion: 1,
      preferredContextSections: ["WORK_ITEM_BRIEF", "DECISIONS", "ACTIVITY"],
    },
  }),
  builtinProfile({
    id: "builtin.software-architect",
    name: "Software Architect",
    role: "SOFTWARE_ARCHITECT",
    identity: "A software architect who protects module boundaries and reversible delivery.",
    mission: "Produce the smallest implementation plan that satisfies product and architecture constraints.",
    nonGoals: ["Do not replace approved product decisions with provider preferences."],
    stages: ["PLAN"],
    expectedInputs: ["Discovery brief", "Repository context", "Project Constitution"],
    expectedOutputs: ["ARCHITECTURE_PROPOSAL", "TASK_GRAPH"],
    allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "MCP_READ"],
    successRubric: ["The plan names seams, invariants, risks, verification and rollback boundaries."],
    escalationConditions: ["A hard-to-reverse architecture choice has no approved authority."],
    handoffContract: "Publish the selected design, rejected alternatives, risks and executable task graph.",
    defaultModelTier: "DEEP",
    budgetEnvelope: { maxEstimatedTokens: 120_000, maxProviderSessions: 8 },
    playbook: {
      schemaVersion: 1,
      preferredContextSections: ["WORK_ITEM_BRIEF", "DECISIONS", "LATEST_CHECKPOINT", "ACTIVITY"],
    },
  }),
  builtinProfile({
    id: "builtin.developer",
    name: "Developer",
    role: "DEVELOPER",
    identity: "A scoped implementation specialist responsible for code and focused verification.",
    mission: "Implement the approved stage without widening its authority or acceptance criteria.",
    nonGoals: ["Do not merge, push, accept the work or rewrite unrelated owner changes."],
    stages: ["IMPLEMENT"],
    expectedInputs: ["Approved plan", "Acceptance criteria", "Repository workspace"],
    expectedOutputs: ["CHANGE_SET", "TEST_REPORT"],
    allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "REPOSITORY_WRITE", "NETWORK", "MCP_READ"],
    successRubric: ["Changes remain in scope and the narrowest relevant checks pass."],
    escalationConditions: ["The implementation needs a new permission, dependency or product decision."],
    handoffContract: "Publish changed scope, verification, deviations, risks and remaining work.",
    defaultModelTier: "STANDARD",
    budgetEnvelope: { maxEstimatedTokens: 160_000, maxProviderSessions: 12 },
    playbook: {
      schemaVersion: 1,
      preferredContextSections: [
        "WORKFLOW_POSITION",
        "WORK_ITEM_BRIEF",
        "DECISIONS",
        "LATEST_CHECKPOINT",
        "EVIDENCE",
      ],
    },
  }),
  builtinProfile({
    id: "builtin.code-reviewer",
    name: "Code Reviewer",
    role: "CODE_REVIEWER",
    identity: "An independent reviewer of the implementation and its evidence.",
    mission: "Find actionable correctness, security and specification defects without editing the change.",
    nonGoals: ["Do not author the implementation being judged or accept it for the owner."],
    stages: ["REVIEW"],
    expectedInputs: [
      "Stable change checkpoint",
      "Acceptance criteria",
      "Developer handoff",
      "Project Constitution",
    ],
    expectedOutputs: ["FINDING_SET"],
    allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "MCP_READ"],
    successRubric: ["Every finding is reproducible, scoped and tied to code or an acceptance criterion."],
    escalationConditions: ["The checkpoint changes while review is running or evidence is incomplete."],
    handoffContract: "Publish findings, severity, evidence and the conditions for closing each finding.",
    defaultModelTier: "DEEP",
    budgetEnvelope: { maxEstimatedTokens: 100_000, maxProviderSessions: 8 },
    playbook: {
      schemaVersion: 1,
      preferredContextSections: ["EVIDENCE", "LATEST_CHECKPOINT", "WORK_ITEM_BRIEF", "DECISIONS"],
    },
  }),
  builtinProfile({
    id: "builtin.browser-qa",
    name: "Browser QA",
    role: "BROWSER_QA",
    identity: "An independent QA specialist who records observable evidence.",
    mission: "Verify accepted behavior against a stable checkpoint and report reproducible defects.",
    nonGoals: ["Do not weaken expected behavior or approve final acceptance."],
    stages: ["QA"],
    expectedInputs: ["Stable change checkpoint", "Acceptance criteria", "Review findings"],
    expectedOutputs: ["QA_EVIDENCE_BUNDLE", "TEST_REPORT"],
    allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "BROWSER_READ"],
    successRubric: ["Evidence identifies the checkpoint, environment, steps, assertions and outcomes."],
    escalationConditions: ["The environment is unavailable or the checkpoint changes during verification."],
    handoffContract: "Publish evidence, defects, environment and exact reproduction steps.",
    defaultModelTier: "STANDARD",
    budgetEnvelope: { maxEstimatedTokens: 100_000, maxProviderSessions: 8 },
    playbook: {
      schemaVersion: 1,
      preferredContextSections: ["EVIDENCE", "WORK_ITEM_BRIEF", "LATEST_CHECKPOINT", "DECISIONS"],
    },
  }),
  builtinProfile({
    id: "builtin.acceptance-manager",
    name: "Acceptance Manager",
    role: "ACCEPTANCE_MANAGER",
    identity: "An evidence coordinator preparing the owner's final acceptance decision.",
    mission: "Trace criteria to implementation and independent evidence without deciding for the owner.",
    nonGoals: ["Do not accept, reject or return the WorkItem on the owner's behalf."],
    stages: ["ACCEPTANCE"],
    expectedInputs: ["Acceptance criteria", "Review findings", "QA evidence"],
    expectedOutputs: ["ACCEPTANCE_PACKAGE"],
    allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ"],
    successRubric: ["Every criterion has a visible evidence state and unresolved gaps are explicit."],
    escalationConditions: ["A criterion lacks independent evidence or conflicts with the delivered change."],
    handoffContract: "Publish the evidence matrix and leave the final decision to the owner gate.",
    defaultModelTier: "STANDARD",
    budgetEnvelope: { maxEstimatedTokens: 60_000, maxProviderSessions: 4 },
    playbook: {
      schemaVersion: 1,
      preferredContextSections: ["WORK_ITEM_BRIEF", "EVIDENCE", "DECISIONS", "LATEST_CHECKPOINT"],
    },
  }),
] as const;

export const findBuiltinAgentProfile = (reference: AgentProfileRef): AgentProfile | null =>
  builtinAgentProfiles.find(
    (profile) =>
      profile.id === reference.id &&
      profile.revision === reference.revision &&
      profile.role === reference.role,
  ) ?? null;

const profileForRole = (role: AgentRole): AgentProfile => {
  const profile = builtinAgentProfiles.find((candidate) => candidate.role === role);
  if (!profile)
    throw new AgentDomainError("PROFILE_NOT_FOUND", "The required AgentProfile is missing", { role });
  return profile;
};

const standardStageRoles: readonly { stage: WorkflowStage; role: AgentRole }[] = [
  { stage: "DISCOVERY", role: "PRODUCT_ANALYST" },
  { stage: "PLAN", role: "SOFTWARE_ARCHITECT" },
  { stage: "IMPLEMENT", role: "DEVELOPER" },
  { stage: "REVIEW", role: "CODE_REVIEWER" },
  { stage: "QA", role: "BROWSER_QA" },
];

export const standardAgentProfileForStage = (stage: WorkflowStage): AgentProfile | null => {
  const role = standardStageRoles.find((assignment) => assignment.stage === stage)?.role;
  return role === undefined ? null : profileForRole(role);
};

export const createStandardSquadAssignment = (input: {
  id: string;
  projectId: string;
  workItemId: string;
  pipelineRunId: string;
  revision: number;
  now: string;
}): SquadAssignment =>
  squadAssignmentSchema.parse({
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    workItemId: input.workItemId,
    pipelineRunId: input.pipelineRunId,
    revision: input.revision,
    stages: standardStageRoles.map(({ stage }) => {
      const profile = standardAgentProfileForStage(stage);
      if (profile === null) {
        throw new AgentDomainError("PROFILE_NOT_FOUND", "The standard stage profile is missing", { stage });
      }
      return {
        stage,
        profile: { id: profile.id, revision: profile.revision, role: profile.role },
      };
    }),
    createdAt: input.now,
  });

export const refineContextPackForRole = (
  templateSpec: ContextPackSpec,
  playbook: RolePlaybook,
): ContextPackSpec => {
  const template = validateContextPackSpec(templateSpec);
  assertUnique(playbook.preferredContextSections, "preferredContextSections");
  const templateById = new Map(template.sections.map((section) => [section.id, section]));
  const preferred = playbook.preferredContextSections.map((id) => ({
    id,
    required: templateById.get(id)?.required ?? false,
  }));
  const preferredIds = new Set(playbook.preferredContextSections);
  const remaining = [...template.sections]
    .sort((left, right) => left.ordinal - right.ordinal)
    .filter(({ id }) => !preferredIds.has(id))
    .map(({ id, required }) => ({ id, required }));

  return validateContextPackSpec({
    schemaVersion: 1,
    sections: [...preferred, ...remaining].map((section, ordinal) => ({ ...section, ordinal })),
  });
};

export const effectiveAgentCapabilities = (
  profile: AgentProfile,
  upperPolicy: readonly AgentCapability[],
): AgentCapability[] => {
  assertUnique(profile.allowedCapabilities, "allowedCapabilities");
  assertUnique(upperPolicy, "upperPolicy capabilities");
  const permitted = new Set(upperPolicy);
  return profile.allowedCapabilities.filter((capability) => permitted.has(capability));
};

const stageCapabilityCeiling = (stage: WorkflowStage, hasMcpGrant: boolean): AgentCapability[] => {
  const capabilities: AgentCapability[] = ["ARTIFACT_WRITE"];
  if (stageRunsInWorkspace(stage)) capabilities.push("REPOSITORY_READ");
  if (stageWritesInWorkspace(stage)) capabilities.push("REPOSITORY_WRITE", "NETWORK");
  if (hasMcpGrant) capabilities.push("MCP_READ");
  if (stage === "QA") capabilities.push("BROWSER_READ");
  return capabilities;
};

/**
 * Resolves every mutable input to one immutable run policy before a provider can start.
 * Callers persist this value and apply it; they do not repeat its intersection rules.
 */
export const resolveAgentRunPolicy = (input: {
  assignment: SquadAssignment;
  profile: AgentProfile;
  stage: WorkflowStage;
  provider: ProviderId;
  claimLimits: AgentRunClaimLimits;
  pipelineBudget: { id: string; revision: number; maxEstimatedTokens: number };
  usedEstimatedTokens: number;
  mcpProfileRevisionIds: readonly string[];
}): AgentRunPolicySnapshot => {
  const assigned = input.assignment.stages.find(({ stage }) => stage === input.stage)?.profile;
  if (
    assigned?.id !== input.profile.id ||
    assigned.revision !== input.profile.revision ||
    assigned.role !== input.profile.role
  ) {
    throw new AgentDomainError(
      "PROFILE_STAGE_MISMATCH",
      "The AgentProfile does not match the exact assigned stage revision",
      { stage: input.stage },
    );
  }
  if (!Number.isSafeInteger(input.usedEstimatedTokens) || input.usedEstimatedTokens < 0) {
    throw new AgentDomainError("AGENT_RUN_BUDGET_EXHAUSTED", "Recorded usage is invalid");
  }
  const remainingPipelineTokens = input.pipelineBudget.maxEstimatedTokens - input.usedEstimatedTokens;
  if (remainingPipelineTokens <= 0) {
    throw new AgentDomainError(
      "AGENT_RUN_BUDGET_EXHAUSTED",
      "No estimated-token budget remains for a new AgentRun",
    );
  }

  assertUnique(input.mcpProfileRevisionIds, "MCP profile revisions");
  const availableMcpProfileRevisionIds = [...input.mcpProfileRevisionIds].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const effectiveCapabilities = effectiveAgentCapabilities(
    input.profile,
    stageCapabilityCeiling(input.stage, availableMcpProfileRevisionIds.length > 0),
  );
  const mcpProfileRevisionIds = effectiveCapabilities.includes("MCP_READ")
    ? availableMcpProfileRevisionIds
    : [];
  const access = effectiveCapabilities.includes("REPOSITORY_WRITE")
    ? "READ_WRITE"
    : effectiveCapabilities.includes("REPOSITORY_READ")
      ? "READ_ONLY"
      : "NONE";

  return agentRunPolicySnapshotSchema.parse({
    schemaVersion: 1,
    assignment: { id: input.assignment.id, revision: input.assignment.revision },
    profile: { id: input.profile.id, revision: input.profile.revision, role: input.profile.role },
    provider: input.provider,
    effectiveCapabilities,
    modelTier: input.profile.defaultModelTier,
    claimLimits: input.claimLimits,
    budget: {
      pipelinePolicyId: input.pipelineBudget.id,
      pipelinePolicyRevision: input.pipelineBudget.revision,
      maxEstimatedTokens: Math.min(input.profile.budgetEnvelope.maxEstimatedTokens, remainingPipelineTokens),
      maxProviderSessions: input.profile.budgetEnvelope.maxProviderSessions,
    },
    workspace: {
      access,
      networkAccess: effectiveCapabilities.includes("NETWORK"),
    },
    mcpProfileRevisionIds,
  });
};

export const createAgentRun = (input: {
  id: string;
  projectId: string;
  workItemId: string;
  pipelineRunId: string;
  stageAttemptId: string;
  ordinal: number;
  stage: WorkflowStage;
  assignment: SquadAssignment;
  provider: ProviderId;
  policySnapshot: AgentRunPolicySnapshot;
  policySnapshotHash: string;
  now: string;
}): AgentRun => {
  if (
    input.assignment.projectId !== input.projectId ||
    input.assignment.workItemId !== input.workItemId ||
    input.assignment.pipelineRunId !== input.pipelineRunId
  ) {
    throw new AgentDomainError(
      "ASSIGNMENT_SCOPE_MISMATCH",
      "The SquadAssignment does not belong to this workflow scope",
    );
  }
  const stageAssignment = input.assignment.stages.find(({ stage }) => stage === input.stage);
  if (!stageAssignment) {
    throw new AgentDomainError("PROFILE_STAGE_MISMATCH", "The squad has no profile for this stage", {
      stage: input.stage,
    });
  }

  return agentRunSchema.parse({
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    workItemId: input.workItemId,
    pipelineRunId: input.pipelineRunId,
    stageAttemptId: input.stageAttemptId,
    ordinal: input.ordinal,
    squadAssignmentId: input.assignment.id,
    profile: stageAssignment.profile,
    provider: input.provider,
    status: "RUNNING",
    policySnapshot: input.policySnapshot,
    policySnapshotHash: input.policySnapshotHash,
    startedAt: input.now,
    finishedAt: null,
    version: 1,
  });
};

export const finishAgentRun = (
  run: AgentRun,
  status: Exclude<AgentRunStatus, "RUNNING">,
  now: string,
): AgentRun => {
  if (run.status !== "RUNNING") {
    throw new AgentDomainError("AGENT_RUN_NOT_RUNNING", "Only a running AgentRun can finish", {
      status: run.status,
    });
  }
  return agentRunSchema.parse({ ...run, status, finishedAt: now, version: run.version + 1 });
};
