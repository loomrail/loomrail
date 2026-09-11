import type {
  Deployment,
  DeploymentApproval,
  DeploymentPlan,
  LaunchRelease,
  Project,
  StateCommand,
  StateCommandResult,
} from "@loomrail/contracts";
import type { LocalState, StateQuery, StateQueryResult } from "@loomrail/persistence-sqlite";
import { expect, it, vi } from "vitest";

import type { DeploymentDriver } from "../src/deployment-driver.js";
import { createDeploymentRunner } from "../src/deployment-runner.js";
import { silentLogger } from "./silent-logger.js";

const now = "2026-09-10T15:00:00.000Z";
const target = {
  presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2" as const,
  presetRevision: 2 as const,
  environmentKind: "PREVIEW" as const,
  repositorySlug: "recurkit/recurkit",
  branch: "main",
  commitSha: "a".repeat(40),
  workflowPath: ".github/workflows/deploy-preview.yml" as const,
  workflowContentHash: "b".repeat(64),
  argvDigest: "c".repeat(64),
  dispatchTimeoutSeconds: 30 as const,
  observeTimeoutSeconds: 15 as const,
  outputLimitBytes: 32_768 as const,
  observeOutputLimitBytes: 65_536 as const,
};
const plan: DeploymentPlan = {
  schemaVersion: 1,
  id: "plan-1",
  projectId: "project-1",
  revision: 2,
  releaseId: "release-1",
  releaseContentHash: "d".repeat(64),
  environmentId: "environment-1",
  environmentContentHash: "e".repeat(64),
  environmentKind: "PREVIEW",
  releaseEvidenceDigest: "0".repeat(64),
  target,
  contentHash: "f".repeat(64),
  createdAt: now,
};
const approval: DeploymentApproval = {
  schemaVersion: 1,
  id: "approval-1",
  projectId: "project-1",
  deploymentId: "deployment-1",
  approvalDigest: "1".repeat(64),
  actorId: "owner",
  createdAt: now,
};
const deployment: Deployment = {
  schemaVersion: 1,
  id: "deployment-1",
  projectId: "project-1",
  planId: plan.id,
  planRevision: 2,
  planContentHash: plan.contentHash,
  releaseId: plan.releaseId,
  releaseContentHash: plan.releaseContentHash,
  environmentId: plan.environmentId,
  environmentContentHash: plan.environmentContentHash,
  environmentKind: "PREVIEW",
  releaseEvidenceDigest: "0".repeat(64),
  intent: "STANDARD",
  approvalDigest: approval.approvalDigest,
  status: "APPROVED",
  approvalId: approval.id,
  remoteRunId: null,
  remoteRunUrl: null,
  failureCode: null,
  createdAt: now,
  approvedAt: now,
  startedAt: null,
  completedAt: null,
  observedAt: null,
  version: 2,
};
const project = {
  schemaVersion: 1,
  id: "project-1",
  workspaceId: "workspace-default",
  fixtureId: null,
  name: "Recurkit",
  repositoryPath: "/tmp/Recurkit проект",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 3,
  createdAt: now,
  updatedAt: now,
} satisfies Project;
const release = {
  schemaVersion: 1,
  id: "release-1",
  projectId: "project-1",
  sourceTree: "2".repeat(40),
} as LaunchRelease;

const resultFor = (current: Deployment): StateCommandResult =>
  ({
    schemaVersion: 1,
    type: "DEPLOYMENT_CHANGED",
    replayed: false,
    deployment: current,
    approval: null,
    event: {},
  }) as StateCommandResult;

const fakeState = (initial: Deployment, currentPlan: DeploymentPlan = plan) => {
  let current = initial;
  const commands: StateCommand[] = [];
  const query = (input: StateQuery): StateQueryResult => {
    if (input.type === "LIST_ACTIVE_DEPLOYMENTS") {
      return {
        type: "DEPLOYMENTS",
        deployments: [current].filter(({ status }) => status === "APPROVED" || status === "RUNNING"),
      };
    }
    if (input.type !== "GET_DEPLOYMENT_CONTEXT") throw new Error(`Unexpected query ${input.type}`);
    return {
      type: "DEPLOYMENT_CONTEXT",
      project,
      plan: currentPlan,
      deployment: current,
      approval,
      release,
    };
  };
  const execute = (command: StateCommand): StateCommandResult => {
    commands.push(command);
    if (command.type === "START_DEPLOYMENT") {
      current = { ...current, status: "RUNNING", startedAt: now, version: current.version + 1 };
    } else if (command.type === "RECORD_DEPLOYMENT_DISPATCH") {
      current =
        command.payload.outcome.type === "DISPATCHED"
          ? {
              ...current,
              remoteRunId: command.payload.outcome.runId,
              remoteRunUrl: command.payload.outcome.runUrl,
              observedAt: now,
              version: current.version + 1,
            }
          : {
              ...current,
              status: command.payload.outcome.type === "REFUSED" ? "FAILED" : "UNKNOWN",
              failureCode:
                command.payload.outcome.type === "REFUSED"
                  ? "PRECONDITION_CHANGED"
                  : "DISPATCH_OUTCOME_UNKNOWN",
              completedAt: command.payload.outcome.type === "REFUSED" ? now : null,
              observedAt: now,
              version: current.version + 1,
            };
    } else if (command.type === "RECONCILE_DEPLOYMENT") {
      current = {
        ...current,
        status: "UNKNOWN",
        failureCode: "DAEMON_RESTARTED",
        observedAt: now,
        version: current.version + 1,
      };
    } else if (command.type === "RECORD_DEPLOYMENT_OBSERVATION") {
      current = {
        ...current,
        status: command.payload.outcome.type,
        failureCode:
          command.payload.outcome.type === "UNKNOWN"
            ? "OBSERVATION_INVALID"
            : command.payload.outcome.type === "FAILED"
              ? command.payload.outcome.failureCode
              : null,
        observedAt: now,
        version: current.version + 1,
      };
    }
    return resultFor(current);
  };
  return {
    state: { query, execute } as Pick<LocalState, "query" | "execute">,
    commands,
    current: () => current,
  };
};

it("starts before dispatch and coalesces duplicate wake calls", async () => {
  const fixture = fakeState(deployment);
  const dispatch = vi.fn<DeploymentDriver["dispatch"]>().mockResolvedValue({
    type: "DISPATCHED",
    runId: 123,
    runUrl: "https://github.com/recurkit/recurkit/actions/runs/123",
  });
  const driver: DeploymentDriver = {
    preflight: vi.fn(),
    dispatch,
    observe: vi.fn(),
  };
  const runner = createDeploymentRunner({
    state: fixture.state,
    driver,
    now: () => new Date(now),
    createCommandId: () => "command-id",
    logger: silentLogger,
  });
  runner.wake(deployment.id);
  runner.wake(deployment.id);
  await runner.whenIdle();

  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(fixture.commands.map(({ type }) => type)).toEqual([
    "START_DEPLOYMENT",
    "RECORD_DEPLOYMENT_DISPATCH",
  ]);
  expect(fixture.current()).toMatchObject({ status: "RUNNING", remoteRunId: 123, version: 4 });
});

it("fails a pending legacy v1 attempt closed without external dispatch", async () => {
  const legacyTarget = {
    presetId: "GITHUB_ACTIONS_WORKFLOW_V1" as const,
    presetRevision: 1 as const,
    repositorySlug: target.repositorySlug,
    branch: target.branch,
    commitSha: target.commitSha,
    workflowPath: ".github/workflows/deploy-production.yml" as const,
    workflowContentHash: target.workflowContentHash,
    argvDigest: target.argvDigest,
    dispatchTimeoutSeconds: target.dispatchTimeoutSeconds,
    observeTimeoutSeconds: target.observeTimeoutSeconds,
    outputLimitBytes: target.outputLimitBytes,
    observeOutputLimitBytes: target.observeOutputLimitBytes,
  };
  const legacyPlan: DeploymentPlan = {
    schemaVersion: 1,
    id: plan.id,
    projectId: plan.projectId,
    revision: 1,
    releaseId: plan.releaseId,
    releaseContentHash: plan.releaseContentHash,
    environmentId: plan.environmentId,
    environmentContentHash: plan.environmentContentHash,
    target: legacyTarget,
    contentHash: plan.contentHash,
    createdAt: now,
  };
  const legacyDeployment: Deployment = {
    schemaVersion: 1,
    id: deployment.id,
    projectId: deployment.projectId,
    planId: legacyPlan.id,
    planRevision: 1,
    planContentHash: legacyPlan.contentHash,
    releaseId: legacyPlan.releaseId,
    releaseContentHash: legacyPlan.releaseContentHash,
    environmentId: legacyPlan.environmentId,
    environmentContentHash: legacyPlan.environmentContentHash,
    intent: "STANDARD",
    approvalDigest: deployment.approvalDigest,
    status: "APPROVED",
    approvalId: approval.id,
    remoteRunId: null,
    remoteRunUrl: null,
    failureCode: null,
    createdAt: now,
    approvedAt: now,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    version: 2,
  };
  const fixture = fakeState(legacyDeployment, legacyPlan);
  const dispatch = vi.fn<DeploymentDriver["dispatch"]>();
  const runner = createDeploymentRunner({
    state: fixture.state,
    driver: { preflight: vi.fn(), dispatch, observe: vi.fn() },
    now: () => new Date(now),
    createCommandId: () => "legacy-command",
    logger: silentLogger,
  });
  runner.wake(legacyDeployment.id);
  await runner.whenIdle();

  expect(dispatch).not.toHaveBeenCalled();
  expect(fixture.commands.map(({ type }) => type)).toEqual([
    "START_DEPLOYMENT",
    "RECORD_DEPLOYMENT_DISPATCH",
  ]);
  expect(fixture.current()).toMatchObject({
    status: "FAILED",
    failureCode: "PRECONDITION_CHANGED",
  });
});

it("reconciles RUNNING to UNKNOWN at startup without dispatch", async () => {
  const running: Deployment = { ...deployment, status: "RUNNING", startedAt: now, version: 3 };
  const fixture = fakeState(running);
  const dispatch = vi.fn<DeploymentDriver["dispatch"]>();
  const runner = createDeploymentRunner({
    state: fixture.state,
    driver: { preflight: vi.fn(), dispatch, observe: vi.fn() },
    now: () => new Date(now),
    createCommandId: () => "reconcile-command",
    logger: silentLogger,
  });
  await runner.recover();
  expect(dispatch).not.toHaveBeenCalled();
  expect(fixture.commands.map(({ type }) => type)).toEqual(["RECONCILE_DEPLOYMENT"]);
  expect(fixture.current()).toMatchObject({ status: "UNKNOWN", failureCode: "DAEMON_RESTARTED" });
});

it("normalizes unexpected dispatch and observation failures to UNKNOWN", async () => {
  const dispatchFixture = fakeState(deployment);
  const dispatchRunner = createDeploymentRunner({
    state: dispatchFixture.state,
    driver: {
      preflight: vi.fn(),
      dispatch: vi.fn<DeploymentDriver["dispatch"]>().mockRejectedValue(new Error("untrusted failure")),
      observe: vi.fn(),
    },
    now: () => new Date(now),
    createCommandId: () => "unknown-command",
    logger: silentLogger,
  });
  dispatchRunner.wake(deployment.id);
  await dispatchRunner.whenIdle();
  expect(dispatchFixture.current()).toMatchObject({
    status: "UNKNOWN",
    failureCode: "DISPATCH_OUTCOME_UNKNOWN",
  });

  const identified: Deployment = {
    ...deployment,
    status: "RUNNING",
    startedAt: now,
    observedAt: now,
    remoteRunId: 123,
    remoteRunUrl: "https://github.com/recurkit/recurkit/actions/runs/123",
    version: 4,
  };
  const observationFixture = fakeState(identified);
  const observationRunner = createDeploymentRunner({
    state: observationFixture.state,
    driver: {
      preflight: vi.fn(),
      dispatch: vi.fn(),
      observe: vi.fn<DeploymentDriver["observe"]>().mockRejectedValue(new Error("malformed output")),
    },
    now: () => new Date(now),
    createCommandId: () => "unused-command",
    logger: silentLogger,
  });
  await observationRunner.observe({
    deploymentId: identified.id,
    commandId: "observe-unknown",
    correlationId: "observe-unknown",
  });
  expect(observationFixture.current()).toMatchObject({
    status: "UNKNOWN",
    failureCode: "OBSERVATION_INVALID",
  });
});
