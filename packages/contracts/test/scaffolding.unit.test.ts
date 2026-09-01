import { describe, expect, test } from "vitest";

import {
  projectSchema,
  publishProjectScaffoldRequestSchema,
  scaffoldOperationSchema,
  scaffoldOperationsResponseSchema,
  scaffoldProposalSchema,
  stateCommandSchema,
} from "../src/index.js";

const proposal = {
  schemaVersion: 1,
  recipeId: "typescript-node",
  recipeVersion: 1,
  targetPath: "/projects/new-project",
  projectName: "new-project",
  packageName: "new-project",
  files: [{ path: "README.md", bytes: 10, contentDigest: "a".repeat(64) }],
  systemFiles: [".loomrail/scaffold.json"],
  proposalDigest: "b".repeat(64),
} as const;

describe("Project Scaffold contracts", () => {
  test("parses the exact bounded proposal and rejects authority-bearing additions", () => {
    expect(scaffoldProposalSchema.parse(proposal)).toEqual(proposal);
    expect(() => scaffoldProposalSchema.parse({ ...proposal, command: "npm install" })).toThrow();
    expect(() =>
      scaffoldProposalSchema.parse({
        ...proposal,
        files: [{ ...proposal.files[0], path: "../outside" }],
      }),
    ).toThrow();
    expect(() =>
      publishProjectScaffoldRequestSchema.parse({
        schemaVersion: 1,
        commandId: "publish-scaffold",
        proposal,
        environment: { TOKEN: "secret" },
      }),
    ).toThrow();
  });

  test("represents provisioning honestly and keeps operation fields closed", () => {
    expect(
      projectSchema.parse({
        schemaVersion: 1,
        id: "project-scaffold",
        workspaceId: "workspace-local",
        fixtureId: null,
        name: "new-project",
        repositoryPath: proposal.targetPath,
        providerPreference: "AUTO",
        status: "PROVISIONING",
        version: 1,
        createdAt: "2026-09-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
      }),
    ).toMatchObject({ status: "PROVISIONING" });
    expect(() =>
      scaffoldOperationSchema.parse({
        schemaVersion: 1,
        id: "operation-scaffold",
        projectId: "project-scaffold",
        proposal,
        status: "PENDING",
        attempts: 0,
        lastErrorCode: null,
        version: 1,
        createdAt: "2026-09-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
        completedAt: null,
        rawGitStderr: "secret",
      }),
    ).toThrow();
  });

  test("parses only a closed list of recoverable operations", () => {
    const operation = {
      schemaVersion: 1,
      id: "operation-scaffold",
      projectId: "project-scaffold",
      proposal,
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "TARGET_CONFLICT",
      version: 2,
      createdAt: "2026-09-01T09:00:00.000Z",
      updatedAt: "2026-09-01T09:00:01.000Z",
      completedAt: null,
    } as const;
    expect(scaffoldOperationsResponseSchema.parse({ schemaVersion: 1, operations: [operation] })).toEqual({
      schemaVersion: 1,
      operations: [operation],
    });
    expect(() =>
      scaffoldOperationsResponseSchema.parse({
        schemaVersion: 1,
        operations: [{ ...operation, rawError: "sensitive" }],
      }),
    ).toThrow();
  });

  test("accepts only closed lifecycle commands and error codes", () => {
    expect(
      stateCommandSchema.parse({
        schemaVersion: 1,
        commandId: "request-scaffold",
        correlationId: "correlation-scaffold",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REQUEST_PROJECT_SCAFFOLD",
        payload: { proposal },
      }),
    ).toMatchObject({ type: "REQUEST_PROJECT_SCAFFOLD" });
    expect(() =>
      stateCommandSchema.parse({
        schemaVersion: 1,
        commandId: "fail-scaffold",
        correlationId: "correlation-scaffold",
        actor: { type: "SYSTEM", id: "scaffold-publisher" },
        type: "FAIL_PROJECT_SCAFFOLD",
        payload: {
          operationId: "operation-scaffold",
          expectedVersion: 1,
          errorCode: "RAW_ERROR_FROM_GIT",
        },
      }),
    ).toThrow();
  });
});
