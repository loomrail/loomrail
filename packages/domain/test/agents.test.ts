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
        policySnapshotHash: `sha256:${"a".repeat(64)}`,
        now,
      }),
    ).toThrow(/no profile/u);
  });
});
