import { agentRunPolicySnapshotSchema, coordinatorProfileId, type WorkflowStage } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";
import {
  createStandardSquadAssignment,
  findBuiltinAgentProfile,
  resolveAgentRunPolicy,
} from "../src/agents.js";

const squad = createStandardSquadAssignment({
  id: "squad-1",
  projectId: "project-1",
  workItemId: "item-1",
  pipelineRunId: "pipeline-1",
  revision: 1,
  now: "2026-09-19T00:00:00.000Z",
  orchestration: { mode: "CODE_BLIND", ownerOutcome: "Show accurate progress to the owner." },
});
const policy = (stage: WorkflowStage, provider: "CODEX" | "CLAUDE_CODE" = "CODEX") => {
  const ref = squad.stages.find((entry) => entry.stage === stage)?.profile;
  const profile = ref === undefined ? null : findBuiltinAgentProfile(ref);
  if (profile === null) throw new Error("Missing profile");
  return resolveAgentRunPolicy({
    assignment: squad,
    profile,
    stage,
    provider,
    claimLimits: { global: 3, project: 3, provider: 3 },
    pipelineBudget: { id: "budget-1", revision: 1, maxEstimatedTokens: 100_000 },
    modelTierOverride: "DEEP",
    agentRunMaxEstimatedTokensOverride: 90_000,
    modelMapping: { FAST: "expensive", STANDARD: "expensive", DEEP: "expensive" },
    usedEstimatedTokens: 0,
    mcpProfileRevisionIds: ["mcp-read-revision"],
    projectConstitution: { id: "constitution", version: 1, contentDigest: "a".repeat(64) },
  });
};
describe("code-blind immutable authority", () => {
  it("preserves all six roles and strips manager code/context authority", () => {
    expect(squad.stages).toHaveLength(6);
    expect(policy("PLAN")).toMatchObject({
      profile: { id: coordinatorProfileId },
      provider: "CODEX",
      modelId: "gpt-6-astra",
      modelTier: "DEEP",
      effectiveCapabilities: ["ARTIFACT_WRITE"],
      workspace: { access: "NONE", networkAccess: false },
      mcpProfileRevisionIds: [],
      projectConstitution: null,
      budget: { maxEstimatedTokens: 12_000, maxProviderSessions: 2 },
    });
  });
  it.each(["DISCOVERY", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"] as const)(
    "pins cheap models for %s despite DEEP overrides",
    (stage) => {
      expect(policy(stage)).toMatchObject({ modelId: "gpt-5.6-luna", modelTier: "FAST" });
      expect(policy(stage, "CLAUDE_CODE")).toMatchObject({
        modelId: "claude-sonnet-5",
        modelTier: "STANDARD",
      });
      if (stage !== "IMPLEMENT")
        expect(policy(stage).effectiveCapabilities).not.toContain("REPOSITORY_WRITE");
    },
  );
  it("refuses another provider and every forged authority channel", () => {
    expect(() => policy("PLAN", "CLAUDE_CODE")).toThrow();
    const manager = policy("PLAN");
    for (const patch of [
      { modelId: "gpt-5.6-luna" },
      { modelTier: "FAST" },
      { provider: "CLAUDE_CODE" },
      {
        effectiveCapabilities: ["ARTIFACT_WRITE", "REPOSITORY_READ"],
        workspace: { access: "READ_ONLY", networkAccess: false },
      },
      {
        effectiveCapabilities: ["ARTIFACT_WRITE", "NETWORK"],
        workspace: { access: "NONE", networkAccess: true },
      },
      { effectiveCapabilities: ["ARTIFACT_WRITE", "MCP_READ"], mcpProfileRevisionIds: ["grant"] },
      { projectConstitution: { id: "constitution", version: 1, contentDigest: "a".repeat(64) } },
    ])
      expect(agentRunPolicySnapshotSchema.safeParse({ ...manager, ...patch }).success).toBe(false);
  });
});
