import {
  deploymentPlanSchema,
  deploymentPreviewResponseSchema,
  githubActionsDeploymentTargetV2Schema,
} from "../src/index.js";
import { expect, it } from "vitest";

const targetBase = {
  repositorySlug: "recurkit/recurkit",
  branch: "main",
  commitSha: "a".repeat(40),
  workflowContentHash: "b".repeat(64),
  argvDigest: "c".repeat(64),
  dispatchTimeoutSeconds: 30,
  observeTimeoutSeconds: 15,
  outputLimitBytes: 32_768,
  observeOutputLimitBytes: 65_536,
};

it("keeps legacy v1 Deployment Plans readable", () => {
  expect(
    deploymentPlanSchema.parse({
      schemaVersion: 1,
      id: "plan-v1",
      projectId: "project-1",
      revision: 1,
      releaseId: "release-1",
      releaseContentHash: "d".repeat(64),
      environmentId: "environment-1",
      environmentContentHash: "e".repeat(64),
      target: {
        ...targetBase,
        presetId: "GITHUB_ACTIONS_WORKFLOW_V1",
        presetRevision: 1,
        workflowPath: ".github/workflows/deploy-production.yml",
      },
      contentHash: "f".repeat(64),
      createdAt: "2026-09-11T00:00:00.000Z",
    }),
  ).toMatchObject({ revision: 1, target: { presetRevision: 1 } });
});

it.each([
  ["PREVIEW", ".github/workflows/deploy-preview.yml"],
  ["PRODUCTION", ".github/workflows/deploy-production.yml"],
] as const)("binds %s to its one fixed v2 workflow", (environmentKind, workflowPath) => {
  expect(
    githubActionsDeploymentTargetV2Schema.parse({
      ...targetBase,
      presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2",
      presetRevision: 2,
      environmentKind,
      workflowPath,
    }),
  ).toMatchObject({ environmentKind, workflowPath });
});

it("refuses a workflow path that does not match the Environment kind", () => {
  expect(() =>
    githubActionsDeploymentTargetV2Schema.parse({
      ...targetBase,
      presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2",
      presetRevision: 2,
      environmentKind: "PREVIEW",
      workflowPath: ".github/workflows/deploy-production.yml",
    }),
  ).toThrow();
});

it("requires the environment-independent evidence digest in every preview response", () => {
  expect(() =>
    deploymentPreviewResponseSchema.parse({
      schemaVersion: 1,
      projectId: "project-1",
      projectVersion: 1,
      releaseId: "release-1",
      releaseContentHash: "d".repeat(64),
      status: "BLOCKED",
      code: "PREVIEW_PROMOTION_REQUIRED",
    }),
  ).toThrow();
});
