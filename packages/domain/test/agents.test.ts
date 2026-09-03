import type { ContextPackSpec } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  AgentDomainError,
  builtinAgentProfiles,
  createAgentRun,
  createStandardSquadAssignment,
  effectiveAgentCapabilities,
  findBuiltinAgentProfile,
  finishAgentRun,
  refineContextPackForRole,
  resolveAgentRunPolicy,
  validateAgentProfile,
} from "../src/agents.js";

const now = "2026-09-01T10:00:00.000Z";
const later = "2026-09-01T10:10:00.000Z";

const assignment = () =>
  createStandardSquadAssignment({
    id: "squad-1",
    projectId: "project-1",
    workItemId: "work-1",
    pipelineRunId: "pipeline-1",
    revision: 1,
    now,
  });

const implementationPolicy = () => {
  const profile = builtinAgentProfiles.find(({ role }) => role === "DEVELOPER");
  if (profile === undefined) throw new Error("Expected the built-in Developer profile");
  return resolveAgentRunPolicy({
    assignment: assignment(),
    profile,
    stage: "IMPLEMENT",
    provider: "CODEX",
    claimLimits: { global: 3, project: 2, provider: 1 },
    pipelineBudget: { id: "budget-1", revision: 2, maxEstimatedTokens: 200_000 },
    usedEstimatedTokens: 50_000,
    mcpProfileRevisionIds: ["mcp-revision-2", "mcp-revision-1"],
  });
};

describe("agent team domain", () => {
  it("ships a unique complete roster but assigns only executable non-owner stages", () => {
    expect(builtinAgentProfiles).toHaveLength(7);
    expect(new Set(builtinAgentProfiles.map(({ id }) => id)).size).toBe(7);
    expect(new Set(builtinAgentProfiles.map(({ role }) => role)).size).toBe(7);

    const squad = assignment();
    expect(squad.stages.map(({ stage, profile }) => ({ stage, role: profile.role }))).toEqual([
      { stage: "DISCOVERY", role: "PRODUCT_ANALYST" },
      { stage: "PLAN", role: "SOFTWARE_ARCHITECT" },
      { stage: "IMPLEMENT", role: "DEVELOPER" },
      { stage: "REVIEW", role: "CODE_REVIEWER" },
      { stage: "QA", role: "BROWSER_QA" },
    ]);
    expect(squad.stages.some(({ stage }) => stage === "ACCEPTANCE")).toBe(false);
    const developer = squad.stages.find(({ stage }) => stage === "IMPLEMENT")?.profile;
    expect(developer === undefined ? null : findBuiltinAgentProfile(developer)?.role).toBe("DEVELOPER");
    expect(findBuiltinAgentProfile({ id: "builtin.developer", revision: 2, role: "DEVELOPER" })).toBeNull();
  });

  it("refuses duplicate profile authority and playbook entries", () => {
    const developer = builtinAgentProfiles.find(({ role }) => role === "DEVELOPER");
    expect(developer).toBeDefined();
    if (!developer) return;

    expect(() =>
      validateAgentProfile({
        ...developer,
        allowedCapabilities: ["REPOSITORY_WRITE", "REPOSITORY_WRITE"],
      }),
    ).toThrow(AgentDomainError);
    expect(() =>
      refineContextPackForRole(
        {
          schemaVersion: 1,
          sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
        },
        {
          schemaVersion: 1,
          preferredContextSections: ["ACTIVITY", "ACTIVITY"],
        },
      ),
    ).toThrow(AgentDomainError);
  });

  it("raises role context without removing workflow-required sections", () => {
    const template: ContextPackSpec = {
      schemaVersion: 1,
      sections: [
        { id: "WORK_ITEM_BRIEF", ordinal: 0, required: true },
        { id: "WORKFLOW_POSITION", ordinal: 1, required: true },
        { id: "ACTIVITY", ordinal: 2, required: false },
      ],
    };

    const refined = refineContextPackForRole(template, {
      schemaVersion: 1,
      preferredContextSections: ["LATEST_CHECKPOINT", "ACTIVITY"],
    });

    expect(refined.sections).toEqual([
      { id: "LATEST_CHECKPOINT", ordinal: 0, required: false },
      { id: "ACTIVITY", ordinal: 1, required: false },
      { id: "WORK_ITEM_BRIEF", ordinal: 2, required: true },
      { id: "WORKFLOW_POSITION", ordinal: 3, required: true },
    ]);
  });

  it("intersects capabilities with upper policy instead of widening it", () => {
    const developer = builtinAgentProfiles.find(({ role }) => role === "DEVELOPER");
    expect(developer).toBeDefined();
    if (!developer) return;

    expect(effectiveAgentCapabilities(developer, ["ARTIFACT_WRITE", "REPOSITORY_READ", "MCP_READ"])).toEqual([
      "ARTIFACT_WRITE",
      "REPOSITORY_READ",
      "MCP_READ",
    ]);
  });

  it("resolves a bounded immutable policy from stage, profile, budget and exact MCP grants", () => {
    expect(implementationPolicy()).toEqual({
      schemaVersion: 1,
      assignment: { id: "squad-1", revision: 1 },
      profile: { id: "builtin.developer", revision: 1, role: "DEVELOPER" },
      provider: "CODEX",
      effectiveCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ", "REPOSITORY_WRITE", "NETWORK", "MCP_READ"],
      modelTier: "STANDARD",
      claimLimits: { global: 3, project: 2, provider: 1 },
      budget: {
        pipelinePolicyId: "budget-1",
        pipelinePolicyRevision: 2,
        maxEstimatedTokens: 150_000,
        maxProviderSessions: 12,
      },
      workspace: { access: "READ_WRITE", networkAccess: true },
      mcpProfileRevisionIds: ["mcp-revision-1", "mcp-revision-2"],
    });
  });

  it("does not grant MCP or browser authority that the stage/profile intersection lacks", () => {
    const reviewer = builtinAgentProfiles.find(({ role }) => role === "CODE_REVIEWER");
    if (reviewer === undefined) throw new Error("Expected the built-in reviewer profile");
    const policy = resolveAgentRunPolicy({
      assignment: assignment(),
      profile: reviewer,
      stage: "REVIEW",
      provider: "CODEX",
      claimLimits: { global: 3, project: 3, provider: 3 },
      pipelineBudget: { id: "budget-1", revision: 1, maxEstimatedTokens: 100_000 },
      usedEstimatedTokens: 0,
      mcpProfileRevisionIds: [],
    });
    expect(policy.effectiveCapabilities).toEqual(["ARTIFACT_WRITE", "REPOSITORY_READ"]);
    expect(policy.workspace).toEqual({ access: "READ_ONLY", networkAccess: false });
    expect(policy.mcpProfileRevisionIds).toEqual([]);
  });

  it("keeps Browser QA read-only and offline even though its worktree is required", () => {
    const profile = builtinAgentProfiles.find(({ role }) => role === "BROWSER_QA");
    if (profile === undefined) throw new Error("Expected the built-in Browser QA profile");
    const policy = resolveAgentRunPolicy({
      assignment: assignment(),
      profile,
      stage: "QA",
      provider: "CODEX",
      claimLimits: { global: 3, project: 3, provider: 3 },
      pipelineBudget: { id: "budget-1", revision: 1, maxEstimatedTokens: 100_000 },
      usedEstimatedTokens: 0,
      mcpProfileRevisionIds: ["mcp-revision-not-authorized"],
    });

    expect(policy.effectiveCapabilities).toEqual(["ARTIFACT_WRITE", "REPOSITORY_READ", "BROWSER_READ"]);
    expect(policy.workspace).toEqual({ access: "READ_ONLY", networkAccess: false });
    expect(policy.mcpProfileRevisionIds).toEqual([]);
  });

  it("creates one run from the assigned profile revision and only finishes it once", () => {
    const run = createAgentRun({
      id: "agent-run-1",
      projectId: "project-1",
      workItemId: "work-1",
      pipelineRunId: "pipeline-1",
      stageAttemptId: "attempt-1",
      ordinal: 1,
      stage: "IMPLEMENT",
      assignment: assignment(),
      provider: "CODEX",
      policySnapshot: implementationPolicy(),
      policySnapshotHash: `sha256:${"a".repeat(64)}`,
      now,
    });

    expect(run.profile).toEqual({ id: "builtin.developer", revision: 1, role: "DEVELOPER" });
    const finished = finishAgentRun(run, "SUCCEEDED", later);
    expect(finished).toMatchObject({ status: "SUCCEEDED", finishedAt: later, version: 2 });
    expect(() => finishAgentRun(finished, "FAILED", later)).toThrow(/Only a running AgentRun/u);
  });

  it("fails closed when an assignment crosses workflow scope or omits the stage", () => {
    expect(() =>
      createAgentRun({
        id: "agent-run-1",
        projectId: "project-other",
        workItemId: "work-1",
        pipelineRunId: "pipeline-1",
        stageAttemptId: "attempt-1",
        ordinal: 1,
        stage: "IMPLEMENT",
        assignment: assignment(),
        provider: "CODEX",
        policySnapshot: implementationPolicy(),
        policySnapshotHash: `sha256:${"a".repeat(64)}`,
        now,
      }),
    ).toThrow(/does not belong/u);

    expect(() =>
      createAgentRun({
        id: "agent-run-1",
        projectId: "project-1",
        workItemId: "work-1",
        pipelineRunId: "pipeline-1",
        stageAttemptId: "attempt-1",
        ordinal: 1,
        stage: "ACCEPTANCE",
        assignment: assignment(),
        provider: "CODEX",
        policySnapshot: implementationPolicy(),
        policySnapshotHash: `sha256:${"a".repeat(64)}`,
        now,
      }),
    ).toThrow(/no profile/u);
  });
});
