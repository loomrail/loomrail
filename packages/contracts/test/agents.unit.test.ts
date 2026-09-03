import { describe, expect, it } from "vitest";

import {
  agentFleetEntrySchema,
  agentProfileSchema,
  agentRunPolicySnapshotSchema,
  agentRunSchema,
  squadAssignmentSchema,
} from "../src/index.js";

const profile = {
  schemaVersion: 1,
  id: "builtin.developer",
  revision: 1,
  name: "Developer",
  role: "DEVELOPER",
  identity: "A scoped implementation specialist.",
  mission: "Implement the approved stage and verify the result.",
  nonGoals: ["Do not change acceptance criteria."],
  stages: ["IMPLEMENT"],
  expectedInputs: ["Approved plan"],
  expectedOutputs: ["CHANGE_SET", "TEST_REPORT"],
  allowedCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "REPOSITORY_WRITE", "NETWORK"],
  successRubric: ["The approved acceptance criteria are traced to verified changes."],
  escalationConditions: ["The requested change requires a permission outside the profile."],
  handoffContract: "Publish a bounded change summary, tests and deviations.",
  defaultProvider: "AUTO",
  defaultModelTier: "STANDARD",
  budgetEnvelope: { maxEstimatedTokens: 120_000, maxProviderSessions: 10 },
  playbook: { schemaVersion: 1, preferredContextSections: ["WORKFLOW_POSITION", "WORK_ITEM_BRIEF"] },
  provenance: "BUILTIN",
} as const;

describe("agent contracts", () => {
  it("accepts a complete versioned profile and rejects undeclared authority", () => {
    expect(agentProfileSchema.parse(profile)).toEqual(profile);
    expect(() =>
      agentProfileSchema.parse({
        ...profile,
        allowedCapabilities: [...profile.allowedCapabilities, "SHELL_ROOT"],
      }),
    ).toThrow();
  });

  it("keeps a squad assignment bound to exact profile revisions", () => {
    const assignment = {
      schemaVersion: 1,
      id: "squad-1",
      projectId: "project-1",
      workItemId: "work-1",
      pipelineRunId: "pipeline-1",
      revision: 1,
      stages: [
        {
          stage: "IMPLEMENT",
          profile: { id: profile.id, revision: profile.revision, role: profile.role },
        },
      ],
      createdAt: "2026-09-01T10:00:00.000Z",
    } as const;

    expect(squadAssignmentSchema.parse(assignment)).toEqual(assignment);
    expect(() => squadAssignmentSchema.parse({ ...assignment, currentProfile: profile })).toThrow();
  });

  it("requires a terminal AgentRun to carry a finish timestamp", () => {
    const policySnapshot = agentRunPolicySnapshotSchema.parse({
      schemaVersion: 1,
      assignment: { id: "squad-1", revision: 1 },
      profile: { id: profile.id, revision: profile.revision, role: profile.role },
      provider: "CODEX",
      effectiveCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "REPOSITORY_WRITE", "NETWORK"],
      modelTier: "STANDARD",
      claimLimits: { global: 3, project: 3, provider: 2 },
      budget: {
        pipelinePolicyId: "budget-1",
        pipelinePolicyRevision: 1,
        maxEstimatedTokens: 100_000,
        maxProviderSessions: 10,
      },
      workspace: { access: "READ_WRITE", networkAccess: true },
      mcpProfileRevisionIds: [],
    });
    const run = {
      schemaVersion: 1,
      id: "agent-run-1",
      projectId: "project-1",
      workItemId: "work-1",
      pipelineRunId: "pipeline-1",
      stageAttemptId: "attempt-1",
      ordinal: 1,
      squadAssignmentId: "squad-1",
      profile: { id: profile.id, revision: profile.revision, role: profile.role },
      provider: "CODEX",
      status: "RUNNING",
      policySnapshot,
      policySnapshotHash: `sha256:${"a".repeat(64)}`,
      startedAt: "2026-09-01T10:00:00.000Z",
      finishedAt: null,
      version: 1,
    } as const;

    expect(agentRunSchema.parse(run)).toEqual(run);
    expect(() => agentRunSchema.parse({ ...run, status: "SUCCEEDED" })).toThrow();
    expect(() => agentRunSchema.parse({ ...run, finishedAt: "2026-09-01T10:01:00.000Z" })).toThrow();
    expect(() =>
      agentRunSchema.parse({
        ...run,
        policySnapshot: { ...policySnapshot, provider: "CLAUDE_CODE" },
      }),
    ).toThrow();
    expect(() =>
      agentRunPolicySnapshotSchema.parse({
        ...policySnapshot,
        workspace: { access: "READ_ONLY", networkAccess: true },
      }),
    ).toThrow();
  });

  it("keeps Fleet status, run identity and machine wait reason consistent", () => {
    const waiting = {
      schemaVersion: 1,
      project: { id: "project-1", name: "Project one" },
      workItem: { id: "work-1", title: "Ship the bounded pool" },
      pipelineRunId: "pipeline-1",
      stageAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      agentRunId: null,
      profile: { id: profile.id, revision: profile.revision, role: profile.role },
      stage: "IMPLEMENT",
      provider: "CODEX",
      status: "WAITING",
      waitReason: "GLOBAL_LIMIT",
      startedAt: null,
    } as const;

    expect(agentFleetEntrySchema.parse(waiting)).toEqual(waiting);
    expect(() => agentFleetEntrySchema.parse({ ...waiting, waitReason: null })).toThrow();
    expect(() =>
      agentFleetEntrySchema.parse({
        ...waiting,
        status: "RUNNING",
        agentRunId: "agent-run-1",
        startedAt: null,
        waitReason: null,
      }),
    ).toThrow();
  });
});
