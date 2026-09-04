import type { AdoptVerificationPlanCommand, Project, VerificationPlanProposal } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { VerificationDomainError, decideVerificationPlanAdoption } from "../src/verification.js";

const now = "2026-09-05T09:00:00.000Z";
const proposalHash = "a".repeat(64);
const contentHash = "b".repeat(64);
const project: Project = {
  schemaVersion: 1,
  id: "project-1",
  workspaceId: "workspace-local",
  fixtureId: null,
  name: "Project",
  repositoryPath: "/projects/Project",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 4,
  createdAt: now,
  updatedAt: now,
};
const proposal: VerificationPlanProposal = {
  schemaVersion: 1,
  projectId: project.id,
  target: { state: "ABSENT", digest: null },
  recipes: [
    {
      schemaVersion: 1,
      id: "package-test",
      kind: "UNIT",
      label: "Package tests",
      required: true,
      executable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "c".repeat(64),
        scriptName: "test",
        scriptBodyPreview: "vitest run",
      },
    },
  ],
  warnings: [],
  proposalHash,
};
const command: AdoptVerificationPlanCommand = {
  schemaVersion: 1,
  commandId: "command-adopt-plan",
  correlationId: "correlation-adopt-plan",
  actor: { type: "HUMAN", id: "local-owner" },
  type: "ADOPT_VERIFICATION_PLAN",
  payload: {
    projectId: project.id,
    expectedProjectVersion: project.version,
    proposal,
  },
};

describe("verification plan adoption", () => {
  it("adopts the exact preview as revision one and advances Project version", () => {
    const decision = decideVerificationPlanAdoption(command, {
      now,
      newPlanId: "verification-plan-1",
      newPublicationId: "verification-publication-1",
      contentHash,
      observedProposalHash: proposalHash,
      project,
    });

    expect(decision.plan).toMatchObject({
      id: "verification-plan-1",
      projectId: project.id,
      revision: 1,
      contentHash,
      sourceProposalHash: proposalHash,
      recipes: proposal.recipes,
      status: "ACTIVE",
    });
    expect(decision.project).toMatchObject({ version: 5, updatedAt: now });
    expect(decision.publication).toMatchObject({
      id: "verification-publication-1",
      projectId: project.id,
      planId: "verification-plan-1",
      targetPath: ".loomrail/verification-plan.json",
      expectedTargetDigest: null,
      contentHash,
      status: "PENDING",
      attempts: 0,
      version: 1,
    });
    expect(decision.event).toMatchObject({
      type: "VERIFICATION_PLAN_ADOPTED",
      data: { previousPlanRevision: null },
    });
  });

  it("increments the immutable plan revision on a later adoption", () => {
    const first = decideVerificationPlanAdoption(command, {
      now,
      newPlanId: "verification-plan-1",
      newPublicationId: "verification-publication-1",
      contentHash,
      observedProposalHash: proposalHash,
      project,
    });
    const next = decideVerificationPlanAdoption(
      {
        ...command,
        commandId: "command-adopt-plan-2",
        payload: { ...command.payload, expectedProjectVersion: first.project.version },
      },
      {
        now: "2026-09-05T09:01:00.000Z",
        newPlanId: "verification-plan-2",
        newPublicationId: "verification-publication-2",
        contentHash: "d".repeat(64),
        observedProposalHash: proposalHash,
        project: first.project,
        currentPlan: first.plan,
      },
    );

    expect(next.plan.revision).toBe(2);
    expect(next.event.data.previousPlanRevision).toBe(1);
  });

  it.each([
    ["PROJECT_NOT_FOUND", { project: undefined }],
    ["PROJECT_NOT_ACTIVE", { project: { ...project, status: "ARCHIVED" as const } }],
    ["PROJECT_VERSION_CONFLICT", { project: { ...project, version: 5 } }],
  ])("fails closed with %s", (code, override) => {
    try {
      decideVerificationPlanAdoption(command, {
        now,
        newPlanId: "verification-plan-1",
        newPublicationId: "verification-publication-1",
        contentHash,
        observedProposalHash: proposalHash,
        project: override.project,
      });
      expect.unreachable("adoption should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationDomainError);
      expect((error as VerificationDomainError).code).toBe(code);
    }
  });

  it("refuses a preview for another Project", () => {
    expect(() =>
      decideVerificationPlanAdoption(
        {
          ...command,
          payload: { ...command.payload, proposal: { ...proposal, projectId: "project-2" } },
        },
        {
          now,
          newPlanId: "verification-plan-1",
          newPublicationId: "verification-publication-1",
          contentHash,
          observedProposalHash: proposalHash,
          project,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "PROPOSAL_PROJECT_MISMATCH" }));
  });

  it("refuses to adopt a warning-only proposal with no executable authority", () => {
    expect(() =>
      decideVerificationPlanAdoption(
        { ...command, payload: { ...command.payload, proposal: { ...proposal, recipes: [] } } },
        {
          now,
          newPlanId: "verification-plan-1",
          newPublicationId: "verification-publication-1",
          contentHash,
          observedProposalHash: proposalHash,
          project,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "PROPOSAL_EMPTY" }));
  });

  it("refuses adoption while the marker-bound target is blocked", () => {
    expect(() =>
      decideVerificationPlanAdoption(
        {
          ...command,
          payload: {
            ...command.payload,
            proposal: { ...proposal, target: { state: "BLOCKED", digest: null } },
          },
        },
        {
          now,
          newPlanId: "verification-plan-1",
          newPublicationId: "verification-publication-1",
          contentHash,
          observedProposalHash: proposalHash,
          project,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "PROPOSAL_TARGET_BLOCKED" }));
  });
});
