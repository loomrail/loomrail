import type {
  CompleteProjectScaffoldCommand,
  FailProjectScaffoldCommand,
  RequestProjectScaffoldCommand,
  RetryProjectScaffoldCommand,
  ScaffoldOperation,
  ScaffoldProposal,
} from "@loomrail/contracts";
import { describe, expect, test } from "vitest";

import {
  decideProjectScaffoldCompleted,
  decideProjectScaffoldFailed,
  decideProjectScaffoldRequested,
  decideProjectScaffoldRetry,
} from "../src/scaffolding.js";

const actor = { type: "HUMAN", id: "local-owner" } as const;
const proposal: ScaffoldProposal = {
  schemaVersion: 1,
  recipeId: "typescript-node",
  recipeVersion: 1,
  targetPath: "/projects/new-project",
  projectName: "new-project",
  packageName: "new-project",
  files: [{ path: "README.md", bytes: 10, contentDigest: "a".repeat(64) }],
  systemFiles: [".loomrail/scaffold.json"],
  proposalDigest: "b".repeat(64),
};

const request: RequestProjectScaffoldCommand = {
  schemaVersion: 1,
  commandId: "command-scaffold-request",
  correlationId: "correlation-scaffold",
  actor,
  type: "REQUEST_PROJECT_SCAFFOLD",
  payload: { proposal },
};

const requested = () =>
  decideProjectScaffoldRequested(request, {
    now: "2026-09-01T08:00:00.000Z",
    newOperationId: "scaffold-operation-1",
    newProjectId: "scaffold-project-1",
  });

describe("project scaffold lifecycle", () => {
  test("creates a provisioning Project and pending durable operation", () => {
    const decision = requested();
    expect(decision.project).toMatchObject({
      id: "scaffold-project-1",
      repositoryPath: proposal.targetPath,
      status: "PROVISIONING",
      version: 1,
    });
    expect(decision.operation).toMatchObject({
      projectId: decision.project.id,
      status: "PENDING",
      attempts: 0,
      version: 1,
    });
    expect(decision.event.type).toBe("PROJECT_SCAFFOLD_REQUESTED");
  });

  test("completes only a pending operation and activates the Project", () => {
    const current = requested();
    const command: CompleteProjectScaffoldCommand = {
      ...request,
      commandId: "command-scaffold-complete",
      type: "COMPLETE_PROJECT_SCAFFOLD",
      payload: { operationId: current.operation.id, expectedVersion: 1 },
    };
    const decision = decideProjectScaffoldCompleted(command, {
      now: "2026-09-01T08:01:00.000Z",
      operation: current.operation,
      project: current.project,
    });
    expect(decision.operation).toMatchObject({ status: "COMPLETED", attempts: 1, version: 2 });
    expect(decision.project).toMatchObject({ status: "ACTIVE", version: 2 });
    expect(decision.event.type).toBe("PROJECT_SCAFFOLD_COMPLETED");
  });

  test("records a closed failure code without activating the Project", () => {
    const current = requested();
    const command: FailProjectScaffoldCommand = {
      ...request,
      commandId: "command-scaffold-fail",
      type: "FAIL_PROJECT_SCAFFOLD",
      payload: {
        operationId: current.operation.id,
        expectedVersion: 1,
        errorCode: "TARGET_CONFLICT",
      },
    };
    const decision = decideProjectScaffoldFailed(command, {
      now: "2026-09-01T08:01:00.000Z",
      operation: current.operation,
      project: current.project,
    });
    expect(decision.operation).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "TARGET_CONFLICT",
      version: 2,
    });
    expect(current.project.status).toBe("PROVISIONING");
  });

  test("retries only a failed operation and keeps the attempt count", () => {
    const current = requested();
    const failed: ScaffoldOperation = {
      ...current.operation,
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "GIT_UNAVAILABLE",
      version: 2,
    };
    const command: RetryProjectScaffoldCommand = {
      ...request,
      commandId: "command-scaffold-retry",
      type: "RETRY_PROJECT_SCAFFOLD",
      payload: { operationId: failed.id, expectedVersion: 2 },
    };
    const decision = decideProjectScaffoldRetry(command, {
      now: "2026-09-01T08:02:00.000Z",
      operation: failed,
      project: current.project,
    });
    expect(decision.operation).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastErrorCode: null,
      version: 3,
    });
  });

  test("refuses every forbidden status and version transition", () => {
    const current = requested();
    const completed: ScaffoldOperation = { ...current.operation, status: "COMPLETED" };
    const complete: CompleteProjectScaffoldCommand = {
      ...request,
      commandId: "command-scaffold-complete-invalid",
      type: "COMPLETE_PROJECT_SCAFFOLD",
      payload: { operationId: current.operation.id, expectedVersion: 1 },
    };
    expect(() =>
      decideProjectScaffoldCompleted(complete, {
        now: "2026-09-01T08:03:00.000Z",
        operation: completed,
        project: current.project,
      }),
    ).toThrow(/pending/u);
    expect(() =>
      decideProjectScaffoldCompleted(
        { ...complete, payload: { ...complete.payload, expectedVersion: 2 } },
        { now: "2026-09-01T08:03:00.000Z", operation: current.operation, project: current.project },
      ),
    ).toThrow(/changed/u);
    expect(() =>
      decideProjectScaffoldCompleted(complete, {
        now: "2026-09-01T08:03:00.000Z",
        operation: current.operation,
        project: { ...current.project, status: "ACTIVE" },
      }),
    ).toThrow(/provisioning/u);
  });
});
