import type {
  Actor,
  Deployment,
  GithubActionsDeploymentTargetV2,
  LaunchEnvironment,
  LaunchRelease,
  Project,
} from "@loomrail/contracts";
import { launchReleaseGateKeySchema } from "@loomrail/contracts";
import { expect, it } from "vitest";

import {
  decideAdoptDeploymentPlan,
  decideApproveDeployment,
  decideRecordDeploymentDispatch,
  decideRecordDeploymentObservation,
  decideReconcileDeployment,
  decideStartDeployment,
} from "../src/guided-deployment.js";

const now = "2026-09-10T15:00:00.000Z";
const owner: Actor = { type: "HUMAN", id: "local-owner" };
const system: Actor = { type: "SYSTEM", id: "deployment-runner" };
const project: Project = {
  schemaVersion: 1,
  id: "project-1",
  workspaceId: "workspace-default",
  fixtureId: null,
  name: "Recurkit",
  repositoryPath: "C:\\Users\\Имя\\Project with spaces\\recurkit",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 8,
  createdAt: now,
  updatedAt: now,
};
const environment: LaunchEnvironment = {
  schemaVersion: 1,
  id: "environment-preview",
  projectId: project.id,
  kind: "PREVIEW",
  name: "Рекуркит Preview",
  presetId: "WEB_APP_V1",
  presetRevision: 1,
  publicBaseUrl: "https://preview.example.test",
  healthPath: "/api/health",
  requiredEnvironmentVariables: [],
  contentHash: "a".repeat(64),
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const release: LaunchRelease = {
  schemaVersion: 1,
  id: "release-1",
  projectId: project.id,
  sourceTree: "b".repeat(40),
  source: {
    readinessRunId: null,
    readinessSourceDigest: null,
    workingTreeDirty: null,
    verificationPlanId: null,
    verificationPlanRevision: null,
    verificationPlanContentHash: null,
    launchMeasurementPlanId: null,
    launchMeasurementPlanRevision: null,
    launchMeasurementPlanContentHash: null,
    launchMeasurementRunId: null,
    launchMeasurementRunVersion: null,
  },
  environment,
  selectedWorkItems: [],
  gates: launchReleaseGateKeySchema.options.map((key) => ({
    key,
    status: "PASSED",
    required: true,
    waivable: ![
      "READINESS/SECURITY_SECRET_PATHS",
      "READINESS/ENV_PROD_SEPARATION",
      "MEASURED/SEC_CLIENT_BUNDLE_SECRETS",
    ].includes(key),
    summary: "Passed.",
    evidenceRefs: [],
  })),
  requiredGateCount: 24,
  passedRequiredGateCount: 24,
  contentHash: "c".repeat(64),
  createdAt: now,
};
const target: GithubActionsDeploymentTargetV2 = {
  presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2" as const,
  presetRevision: 2 as const,
  environmentKind: "PREVIEW" as const,
  repositorySlug: "recurkit/recurkit",
  branch: "main",
  commitSha: "d".repeat(40),
  workflowPath: ".github/workflows/deploy-preview.yml" as const,
  workflowContentHash: "e".repeat(64),
  argvDigest: "f".repeat(64),
  dispatchTimeoutSeconds: 30 as const,
  observeTimeoutSeconds: 15 as const,
  outputLimitBytes: 32_768 as const,
  observeOutputLimitBytes: 65_536 as const,
};
const releaseEvidenceDigest = "3".repeat(64);
const targetRunUrl = (): string => "https://github.com/recurkit/recurkit/actions/runs/12345";

const adopt = (
  actor: Actor = owner,
  candidate: LaunchRelease = release,
  candidateTarget: GithubActionsDeploymentTargetV2 = target,
  previousPreviewDeployment?: Extract<Deployment, { planRevision: 2 }>,
) =>
  decideAdoptDeploymentPlan(
    {
      schemaVersion: 1,
      commandId: "adopt-plan",
      correlationId: "correlation-adopt-plan",
      actor,
      type: "ADOPT_DEPLOYMENT_PLAN",
      payload: {
        projectId: project.id,
        expectedProjectVersion: project.version,
        releaseId: candidate.id,
        expectedReleaseContentHash: candidate.contentHash,
        releaseFreshness: { status: "CURRENT", reasons: [] },
        releaseEvidenceDigest,
        target: candidateTarget,
      },
    },
    {
      now,
      newPlanId: "deployment-plan-1",
      newDeploymentId: "deployment-1",
      planContentHash: "1".repeat(64),
      approvalDigest: "2".repeat(64),
      releaseEvidenceDigest,
      ...(previousPreviewDeployment === undefined ? {} : { previousPreviewDeployment }),
      project,
      release: candidate,
      releaseFreshness: { status: "CURRENT", reasons: [] },
    },
  );

it("adopts one exact PREVIEW plan and creates a pending Deployment", () => {
  const decision = adopt();
  expect(decision.project.version).toBe(project.version + 1);
  expect(decision.plan).toMatchObject({
    releaseId: release.id,
    environmentId: environment.id,
    environmentKind: "PREVIEW",
    releaseEvidenceDigest,
    target,
    revision: 2,
  });
  expect(decision.deployment).toMatchObject({
    environmentKind: "PREVIEW",
    releaseEvidenceDigest,
    status: "PENDING_APPROVAL",
    intent: "STANDARD",
    approvalDigest: "2".repeat(64),
    version: 1,
  });
});

it("refuses provider authority, stale evidence and failed gates", () => {
  expect(() => adopt({ type: "SYSTEM", id: "provider" })).toThrow(
    expect.objectContaining({ code: "OWNER_REQUIRED" }),
  );
  expect(() =>
    decideAdoptDeploymentPlan(
      {
        schemaVersion: 1,
        commandId: "stale",
        correlationId: "stale",
        actor: owner,
        type: "ADOPT_DEPLOYMENT_PLAN",
        payload: {
          projectId: project.id,
          expectedProjectVersion: project.version,
          releaseId: release.id,
          expectedReleaseContentHash: release.contentHash,
          releaseFreshness: { status: "STALE", reasons: ["TREE_CHANGED"] },
          releaseEvidenceDigest,
          target,
        },
      },
      {
        now,
        newPlanId: "plan-stale",
        newDeploymentId: "deployment-stale",
        planContentHash: "1".repeat(64),
        approvalDigest: "2".repeat(64),
        releaseEvidenceDigest,
        project,
        release,
        releaseFreshness: { status: "STALE", reasons: ["TREE_CHANGED"] },
      },
    ),
  ).toThrow(expect.objectContaining({ code: "RELEASE_STALE" }));

  const failedRelease: LaunchRelease = {
    ...release,
    gates: release.gates.map((gate, index) => (index === 0 ? { ...gate, status: "FAILED" as const } : gate)),
    passedRequiredGateCount: 23,
  };
  expect(() => adopt(owner, failedRelease)).toThrow(
    expect.objectContaining({ code: "RELEASE_GATES_BLOCKED" }),
  );
});

it("requires the same successful v2 Preview evidence before Production STANDARD", () => {
  const productionEnvironment: LaunchEnvironment = {
    ...environment,
    id: "environment-production",
    kind: "PRODUCTION",
    name: "Рекуркит Production",
    publicBaseUrl: "https://example.test",
    contentHash: "4".repeat(64),
  };
  const productionRelease: LaunchRelease = {
    ...release,
    id: "release-production",
    environment: productionEnvironment,
    contentHash: "5".repeat(64),
  };
  const productionTarget = {
    ...target,
    environmentKind: "PRODUCTION" as const,
    workflowPath: ".github/workflows/deploy-production.yml" as const,
  };

  expect(() => adopt(owner, productionRelease, productionTarget)).toThrow(
    expect.objectContaining({ code: "PREVIEW_PROMOTION_REQUIRED" }),
  );

  const preview = adopt().deployment;
  if (preview.planRevision !== 2) throw new Error("Expected a v2 Preview deployment");
  const successfulPreview = {
    ...preview,
    status: "SUCCEEDED" as const,
    approvalId: "approval-preview",
    remoteRunId: 12345,
    remoteRunUrl: targetRunUrl(),
    approvedAt: now,
    startedAt: now,
    completedAt: now,
    observedAt: now,
  };
  const decision = adopt(owner, productionRelease, productionTarget, successfulPreview);
  expect(decision.deployment).toMatchObject({
    environmentKind: "PRODUCTION",
    releaseEvidenceDigest,
    status: "PENDING_APPROVAL",
  });

  for (const invalidPreview of [
    { ...successfulPreview, projectId: "other-project" },
    { ...successfulPreview, releaseEvidenceDigest: "6".repeat(64) },
    { ...successfulPreview, environmentKind: "PRODUCTION" as const },
    { ...successfulPreview, status: "UNKNOWN" as const },
  ]) {
    expect(() => adopt(owner, productionRelease, productionTarget, invalidPreview)).toThrow(
      expect.objectContaining({ code: "PREVIEW_PROMOTION_REQUIRED" }),
    );
  }
});

it("binds one owner Approval and allows the runner to start exactly once", () => {
  const adopted = adopt();
  const pending = adopted.deployment;
  const approved = decideApproveDeployment(
    {
      schemaVersion: 1,
      commandId: "approve",
      correlationId: "approve",
      actor: owner,
      type: "APPROVE_DEPLOYMENT",
      payload: {
        deploymentId: pending.id,
        expectedVersion: pending.version,
        approvalDigest: pending.approvalDigest,
      },
    },
    { now, newApprovalId: "approval-1", deployment: pending },
  );
  expect(approved.deployment).toMatchObject({ status: "APPROVED", version: 2 });
  expect(approved.approval).toMatchObject({
    deploymentId: pending.id,
    approvalDigest: pending.approvalDigest,
    actorId: owner.id,
  });

  const started = decideStartDeployment(
    {
      schemaVersion: 1,
      commandId: "start",
      correlationId: "start",
      actor: system,
      type: "START_DEPLOYMENT",
      payload: { deploymentId: pending.id, expectedVersion: approved.deployment.version },
    },
    { now, deployment: approved.deployment, approval: approved.approval },
  );
  expect(started.deployment).toMatchObject({ status: "RUNNING", version: 3, startedAt: now });
  expect(() =>
    decideStartDeployment(
      {
        schemaVersion: 1,
        commandId: "start-again",
        correlationId: "start-again",
        actor: system,
        type: "START_DEPLOYMENT",
        payload: { deploymentId: pending.id, expectedVersion: started.deployment.version },
      },
      { now, deployment: started.deployment, approval: approved.approval },
    ),
  ).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
});

it("refuses wrong approval, runner and remote identities with typed errors", () => {
  const adopted = adopt();
  const pending = adopted.deployment;
  const approvalCommand = {
    schemaVersion: 1 as const,
    commandId: "approval-boundary",
    correlationId: "approval-boundary",
    actor: owner,
    type: "APPROVE_DEPLOYMENT" as const,
    payload: {
      deploymentId: pending.id,
      expectedVersion: pending.version,
      approvalDigest: pending.approvalDigest,
    },
  };
  expect(() =>
    decideApproveDeployment(
      { ...approvalCommand, actor: { type: "SYSTEM", id: "provider" } },
      { now, newApprovalId: "forbidden-approval", deployment: pending },
    ),
  ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
  expect(() =>
    decideApproveDeployment(
      { ...approvalCommand, payload: { ...approvalCommand.payload, approvalDigest: "9".repeat(64) } },
      { now, newApprovalId: "wrong-digest-approval", deployment: pending },
    ),
  ).toThrow(expect.objectContaining({ code: "APPROVAL_DIGEST_MISMATCH" }));

  const approved = decideApproveDeployment(approvalCommand, {
    now,
    newApprovalId: "approval-boundary",
    deployment: pending,
  });
  const startCommand = {
    schemaVersion: 1 as const,
    commandId: "start-boundary",
    correlationId: "start-boundary",
    actor: system,
    type: "START_DEPLOYMENT" as const,
    payload: { deploymentId: pending.id, expectedVersion: approved.deployment.version },
  };
  expect(() =>
    decideStartDeployment(
      { ...startCommand, actor: owner },
      { now, deployment: approved.deployment, approval: approved.approval },
    ),
  ).toThrow(expect.objectContaining({ code: "RUNNER_REQUIRED" }));
  expect(() =>
    decideStartDeployment(startCommand, { now, deployment: approved.deployment, approval: undefined }),
  ).toThrow(expect.objectContaining({ code: "APPROVAL_NOT_FOUND" }));
  const running = decideStartDeployment(startCommand, {
    now,
    deployment: approved.deployment,
    approval: approved.approval,
  }).deployment;
  expect(() =>
    decideRecordDeploymentDispatch(
      {
        schemaVersion: 1,
        commandId: "wrong-run-url",
        correlationId: "wrong-run-url",
        actor: system,
        type: "RECORD_DEPLOYMENT_DISPATCH",
        payload: {
          deploymentId: running.id,
          expectedVersion: running.version,
          outcome: {
            type: "DISPATCHED",
            runId: 12345,
            runUrl: "https://github.com/other/repository/actions/runs/12345",
          },
        },
      },
      { now, deployment: running, plan: adopted.plan },
    ),
  ).toThrow(expect.objectContaining({ code: "PLAN_IDENTITY_MISMATCH" }));

  const identified = decideRecordDeploymentDispatch(
    {
      schemaVersion: 1,
      commandId: "exact-run-url",
      correlationId: "exact-run-url",
      actor: system,
      type: "RECORD_DEPLOYMENT_DISPATCH",
      payload: {
        deploymentId: running.id,
        expectedVersion: running.version,
        outcome: {
          type: "DISPATCHED",
          runId: 12345,
          runUrl: "https://github.com/recurkit/recurkit/actions/runs/12345",
        },
      },
    },
    { now, deployment: running, plan: adopted.plan },
  ).deployment;
  expect(() =>
    decideRecordDeploymentObservation(
      {
        schemaVersion: 1,
        commandId: "wrong-observed-run",
        correlationId: "wrong-observed-run",
        actor: system,
        type: "RECORD_DEPLOYMENT_OBSERVATION",
        payload: {
          deploymentId: identified.id,
          expectedVersion: identified.version,
          observedRunId: 99999,
          outcome: { type: "RUNNING" },
        },
      },
      { now, deployment: identified },
    ),
  ).toThrow(expect.objectContaining({ code: "RUN_IDENTITY_MISMATCH" }));
});

it("maps every closed dispatch and observation outcome without synthetic success", () => {
  const pending = adopt().deployment;
  const approved = decideApproveDeployment(
    {
      schemaVersion: 1,
      commandId: "approve-outcomes",
      correlationId: "approve-outcomes",
      actor: owner,
      type: "APPROVE_DEPLOYMENT",
      payload: {
        deploymentId: pending.id,
        expectedVersion: pending.version,
        approvalDigest: pending.approvalDigest,
      },
    },
    { now, newApprovalId: "approval-outcomes", deployment: pending },
  );
  const running = decideStartDeployment(
    {
      schemaVersion: 1,
      commandId: "start-outcomes",
      correlationId: "start-outcomes",
      actor: system,
      type: "START_DEPLOYMENT",
      payload: { deploymentId: pending.id, expectedVersion: approved.deployment.version },
    },
    { now, deployment: approved.deployment, approval: approved.approval },
  ).deployment;

  const dispatch = (outcome: { type: "REFUSED" } | { type: "UNKNOWN" }) =>
    decideRecordDeploymentDispatch(
      {
        schemaVersion: 1,
        commandId: `dispatch-${outcome.type}`,
        correlationId: `dispatch-${outcome.type}`,
        actor: system,
        type: "RECORD_DEPLOYMENT_DISPATCH",
        payload: { deploymentId: running.id, expectedVersion: running.version, outcome },
      },
      { now, deployment: running },
    ).deployment;
  expect(dispatch({ type: "REFUSED" })).toMatchObject({
    status: "FAILED",
    failureCode: "PRECONDITION_CHANGED",
    completedAt: now,
  });
  expect(dispatch({ type: "UNKNOWN" })).toMatchObject({
    status: "UNKNOWN",
    failureCode: "DISPATCH_OUTCOME_UNKNOWN",
    completedAt: null,
  });

  const identified = { ...running, remoteRunId: 12345, remoteRunUrl: targetRunUrl(), observedAt: now };
  const observe = (
    outcome:
      | { type: "RUNNING" }
      | { type: "SUCCEEDED" }
      | { type: "UNKNOWN" }
      | { type: "FAILED"; failureCode: "REMOTE_CANCELLED" },
  ) =>
    decideRecordDeploymentObservation(
      {
        schemaVersion: 1,
        commandId: `observe-${outcome.type}`,
        correlationId: `observe-${outcome.type}`,
        actor: system,
        type: "RECORD_DEPLOYMENT_OBSERVATION",
        payload: {
          deploymentId: identified.id,
          expectedVersion: identified.version,
          observedRunId: 12345,
          outcome,
        },
      },
      { now, deployment: identified },
    ).deployment;
  expect(observe({ type: "RUNNING" })).toMatchObject({ status: "RUNNING", failureCode: null });
  expect(observe({ type: "SUCCEEDED" })).toMatchObject({ status: "SUCCEEDED", failureCode: null });
  expect(observe({ type: "UNKNOWN" })).toMatchObject({
    status: "UNKNOWN",
    failureCode: "OBSERVATION_INVALID",
  });
  expect(observe({ type: "FAILED", failureCode: "REMOTE_CANCELLED" })).toMatchObject({
    status: "FAILED",
    failureCode: "REMOTE_CANCELLED",
  });
});

it("keeps exact run identity, maps observations and makes restart UNKNOWN without replay", () => {
  const adopted = adopt();
  const pending = adopted.deployment;
  const approved = decideApproveDeployment(
    {
      schemaVersion: 1,
      commandId: "approve-2",
      correlationId: "approve-2",
      actor: owner,
      type: "APPROVE_DEPLOYMENT",
      payload: {
        deploymentId: pending.id,
        expectedVersion: pending.version,
        approvalDigest: pending.approvalDigest,
      },
    },
    { now, newApprovalId: "approval-2", deployment: pending },
  );
  const running = decideStartDeployment(
    {
      schemaVersion: 1,
      commandId: "start-2",
      correlationId: "start-2",
      actor: system,
      type: "START_DEPLOYMENT",
      payload: { deploymentId: pending.id, expectedVersion: approved.deployment.version },
    },
    { now, deployment: approved.deployment, approval: approved.approval },
  ).deployment;
  const identified = decideRecordDeploymentDispatch(
    {
      schemaVersion: 1,
      commandId: "dispatch",
      correlationId: "dispatch",
      actor: system,
      type: "RECORD_DEPLOYMENT_DISPATCH",
      payload: {
        deploymentId: pending.id,
        expectedVersion: running.version,
        outcome: {
          type: "DISPATCHED",
          runId: 12345,
          runUrl: "https://github.com/recurkit/recurkit/actions/runs/12345",
        },
      },
    },
    { now, deployment: running, plan: adopted.plan },
  ).deployment;
  expect(identified).toMatchObject({ status: "RUNNING", remoteRunId: 12345, version: 4 });
  const succeeded = decideRecordDeploymentObservation(
    {
      schemaVersion: 1,
      commandId: "observe",
      correlationId: "observe",
      actor: system,
      type: "RECORD_DEPLOYMENT_OBSERVATION",
      payload: {
        deploymentId: pending.id,
        expectedVersion: identified.version,
        observedRunId: 12345,
        outcome: { type: "SUCCEEDED" },
      },
    },
    { now, deployment: identified },
  ).deployment;
  expect(succeeded).toMatchObject({ status: "SUCCEEDED", completedAt: now, failureCode: null });

  const reconciled = decideReconcileDeployment(
    {
      schemaVersion: 1,
      commandId: "reconcile",
      correlationId: "reconcile",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_DEPLOYMENT",
      payload: { deploymentId: pending.id, expectedVersion: running.version },
    },
    { now, deployment: running },
  ).deployment;
  expect(reconciled).toMatchObject({ status: "UNKNOWN", failureCode: "DAEMON_RESTARTED", version: 4 });
});
