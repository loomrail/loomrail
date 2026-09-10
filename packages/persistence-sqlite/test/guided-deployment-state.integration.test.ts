import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  launchReleaseGateKeySchema,
  type GithubActionsDeploymentTarget,
  type LaunchEnvironment,
  type LaunchRelease,
} from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical-json.js";
import { openLocalState, type LocalState } from "../src/index.js";

const now = "2026-09-10T15:00:00.000Z";
const sourceTree = "a".repeat(40);
const target: GithubActionsDeploymentTarget = {
  presetId: "GITHUB_ACTIONS_WORKFLOW_V1",
  presetRevision: 1,
  repositorySlug: "recurkit/recurkit",
  branch: "main",
  commitSha: "b".repeat(40),
  workflowPath: ".github/workflows/deploy-production.yml",
  workflowContentHash: "c".repeat(64),
  argvDigest: "d".repeat(64),
  dispatchTimeoutSeconds: 30,
  observeTimeoutSeconds: 15,
  outputLimitBytes: 32_768,
  observeOutputLimitBytes: 65_536,
};

describe("durable guided deployment", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail deployment state тест "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(now),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const seedPassingRelease = async (): Promise<{
    release: LaunchRelease;
    environment: LaunchEnvironment;
  }> => {
    const localState = await open();
    localState.execute({
      schemaVersion: 1,
      commandId: "register",
      correlationId: "register",
      actor: { type: "HUMAN", id: "owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-1",
        fixtureId: null,
        name: "Recurkit",
        repositoryPath: join(directory, "Репозиторий with spaces"),
      },
    });
    const saved = localState.execute({
      schemaVersion: 1,
      commandId: "environment",
      correlationId: "environment",
      actor: { type: "HUMAN", id: "owner" },
      type: "SAVE_LAUNCH_ENVIRONMENT",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 1,
        environmentId: null,
        expectedEnvironmentVersion: null,
        configuration: {
          kind: "PREVIEW",
          name: "Recurkit Preview",
          presetId: "WEB_APP_V1",
          presetRevision: 1,
          publicBaseUrl: "https://preview.example.test",
          healthPath: "/api/health",
          requiredEnvironmentVariables: [],
        },
      },
    });
    if (saved.type !== "LAUNCH_ENVIRONMENT_CHANGED") throw new Error("Expected Environment");
    const draft: LaunchRelease = {
      schemaVersion: 1,
      id: "release-passing",
      projectId: "project-1",
      sourceTree,
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
      environment: saved.environment,
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
      contentHash: "0".repeat(64),
      createdAt: now,
    };
    const content = { ...draft };
    delete (content as Partial<LaunchRelease>).contentHash;
    const release = {
      ...draft,
      contentHash: createHash("sha256").update(canonicalJson(content)).digest("hex"),
    };
    localState.close();
    state = undefined;
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        `INSERT INTO launch_releases
         (id, schema_version, project_id, environment_id, source_tree, content_hash, release_json, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        release.id,
        release.projectId,
        release.environment.id,
        release.sourceTree,
        release.contentHash,
        JSON.stringify(release),
        release.createdAt,
      );
    database.close();
    return { release, environment: saved.environment };
  };

  it("commits Plan, Deployment, Approval and restart reconciliation with idempotent receipts", async () => {
    const { release } = await seedPassingRelease();
    const localState = await open();
    const adoptCommand = {
      schemaVersion: 1 as const,
      commandId: "adopt-deployment-plan",
      correlationId: "adopt-deployment-plan",
      actor: { type: "HUMAN" as const, id: "owner" },
      type: "ADOPT_DEPLOYMENT_PLAN" as const,
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 2,
        releaseId: release.id,
        expectedReleaseContentHash: release.contentHash,
        releaseFreshness: { status: "CURRENT" as const, reasons: [] },
        target,
      },
    };
    const adopted = localState.execute(adoptCommand);
    expect(adopted).toMatchObject({
      type: "DEPLOYMENT_PLAN_ADOPTED",
      replayed: false,
      projectVersion: 3,
      deployment: { status: "PENDING_APPROVAL", version: 1 },
    });
    expect(localState.execute(adoptCommand)).toMatchObject({
      type: "DEPLOYMENT_PLAN_ADOPTED",
      replayed: true,
    });
    if (adopted.type !== "DEPLOYMENT_PLAN_ADOPTED") throw new Error("Expected adopted plan");

    const approveCommand = {
      schemaVersion: 1,
      commandId: "approve-deployment",
      correlationId: "approve-deployment",
      actor: { type: "HUMAN", id: "owner" },
      type: "APPROVE_DEPLOYMENT",
      payload: {
        deploymentId: adopted.deployment.id,
        expectedVersion: adopted.deployment.version,
        approvalDigest: adopted.deployment.approvalDigest,
      },
    } as const;
    const approved = localState.execute(approveCommand);
    expect(approved).toMatchObject({
      type: "DEPLOYMENT_CHANGED",
      deployment: { status: "APPROVED", version: 2 },
      approval: { actorId: "owner" },
    });
    if (approved.type !== "DEPLOYMENT_CHANGED" || approved.approval === null) {
      throw new Error("Expected Approval");
    }
    const approvalId = approved.approval.id;
    expect(localState.execute(approveCommand)).toMatchObject({
      type: "DEPLOYMENT_CHANGED",
      replayed: true,
      approval: { id: approved.approval.id },
    });
    expect(() =>
      localState.execute({
        ...approveCommand,
        payload: { ...approveCommand.payload, approvalDigest: "9".repeat(64) },
      }),
    ).toThrow(expect.objectContaining({ code: "COMMAND_ID_REUSED" }));
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-deployment",
      correlationId: "start-deployment",
      actor: { type: "SYSTEM", id: "deployment-runner" },
      type: "START_DEPLOYMENT",
      payload: { deploymentId: adopted.deployment.id, expectedVersion: approved.deployment.version },
    });
    if (started.type !== "DEPLOYMENT_CHANGED") throw new Error("Expected running Deployment");
    expect(started.deployment.status).toBe("RUNNING");

    localState.close();
    state = undefined;
    const reopened = await open();
    const active = reopened.query({ type: "LIST_ACTIVE_DEPLOYMENTS" });
    expect(active).toMatchObject({ type: "DEPLOYMENTS", deployments: [{ id: adopted.deployment.id }] });
    const reconciled = reopened.execute({
      schemaVersion: 1,
      commandId: "reconcile-deployment",
      correlationId: "reconcile-deployment",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECONCILE_DEPLOYMENT",
      payload: { deploymentId: adopted.deployment.id, expectedVersion: started.deployment.version },
    });
    expect(reconciled).toMatchObject({
      type: "DEPLOYMENT_CHANGED",
      deployment: { status: "UNKNOWN", failureCode: "DAEMON_RESTARTED", version: 4 },
    });
    expect(reopened.query({ type: "GET_PROJECT_GUIDED_DEPLOYMENT", projectId: "project-1" })).toMatchObject({
      type: "PROJECT_GUIDED_DEPLOYMENT",
      project: { version: 3 },
      latestPlan: { id: adopted.plan.id },
      latestDeployment: { status: "UNKNOWN" },
    });

    reopened.close();
    state = undefined;
    const database = new DatabaseSync(databasePath);
    expect(() =>
      database
        .prepare("UPDATE deployment_plans SET created_at = created_at WHERE id = ?")
        .run(adopted.plan.id),
    ).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare("UPDATE deployment_approvals SET created_at = created_at WHERE id = ?")
        .run(approvalId),
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM deployment_approvals WHERE id = ?").run(approvalId)).toThrow(
      /cannot be deleted/u,
    );
    database.close();
  });
});
