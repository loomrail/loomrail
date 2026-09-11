import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  launchReleaseGateKeySchema,
  type GithubActionsDeploymentTargetV2,
  type LaunchEnvironment,
  type LaunchRelease,
} from "@loomrail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical-json.js";
import { launchReleaseEvidenceDigest, openLocalState, type LocalState } from "../src/index.js";
import { loadMigrationSources } from "../src/migrations.js";

const now = "2026-09-10T15:00:00.000Z";
const sourceTree = "a".repeat(40);
const target: GithubActionsDeploymentTargetV2 = {
  presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2",
  presetRevision: 2,
  environmentKind: "PREVIEW",
  repositorySlug: "recurkit/recurkit",
  branch: "main",
  commitSha: "b".repeat(40),
  workflowPath: ".github/workflows/deploy-preview.yml",
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
        releaseEvidenceDigest: launchReleaseEvidenceDigest(release),
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

  it("qualifies Production only from the exact durable successful v2 Preview", async () => {
    const { release } = await seedPassingRelease();
    let localState = await open();
    const adopted = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-preview",
      correlationId: "adopt-preview",
      actor: { type: "HUMAN", id: "owner" },
      type: "ADOPT_DEPLOYMENT_PLAN",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 2,
        releaseId: release.id,
        expectedReleaseContentHash: release.contentHash,
        releaseFreshness: { status: "CURRENT", reasons: [] },
        releaseEvidenceDigest: launchReleaseEvidenceDigest(release),
        target,
      },
    });
    if (adopted.type !== "DEPLOYMENT_PLAN_ADOPTED") throw new Error("Expected Preview plan");
    const approved = localState.execute({
      schemaVersion: 1,
      commandId: "approve-preview",
      correlationId: "approve-preview",
      actor: { type: "HUMAN", id: "owner" },
      type: "APPROVE_DEPLOYMENT",
      payload: {
        deploymentId: adopted.deployment.id,
        expectedVersion: adopted.deployment.version,
        approvalDigest: adopted.deployment.approvalDigest,
      },
    });
    if (approved.type !== "DEPLOYMENT_CHANGED") throw new Error("Expected Preview Approval");
    const started = localState.execute({
      schemaVersion: 1,
      commandId: "start-preview",
      correlationId: "start-preview",
      actor: { type: "SYSTEM", id: "deployment-runner" },
      type: "START_DEPLOYMENT",
      payload: { deploymentId: adopted.deployment.id, expectedVersion: approved.deployment.version },
    });
    if (started.type !== "DEPLOYMENT_CHANGED") throw new Error("Expected running Preview");
    const dispatched = localState.execute({
      schemaVersion: 1,
      commandId: "dispatch-preview",
      correlationId: "dispatch-preview",
      actor: { type: "SYSTEM", id: "deployment-runner" },
      type: "RECORD_DEPLOYMENT_DISPATCH",
      payload: {
        deploymentId: adopted.deployment.id,
        expectedVersion: started.deployment.version,
        outcome: {
          type: "DISPATCHED",
          runId: 42,
          runUrl: "https://github.com/recurkit/recurkit/actions/runs/42",
        },
      },
    });
    if (dispatched.type !== "DEPLOYMENT_CHANGED") throw new Error("Expected dispatched Preview");
    const succeeded = localState.execute({
      schemaVersion: 1,
      commandId: "observe-preview",
      correlationId: "observe-preview",
      actor: { type: "SYSTEM", id: "deployment-runner" },
      type: "RECORD_DEPLOYMENT_OBSERVATION",
      payload: {
        deploymentId: adopted.deployment.id,
        expectedVersion: dispatched.deployment.version,
        observedRunId: 42,
        outcome: { type: "SUCCEEDED" },
      },
    });
    expect(succeeded).toMatchObject({
      type: "DEPLOYMENT_CHANGED",
      deployment: { status: "SUCCEEDED", environmentKind: "PREVIEW" },
    });

    const productionEnvironment = localState.execute({
      schemaVersion: 1,
      commandId: "environment-production",
      correlationId: "environment-production",
      actor: { type: "HUMAN", id: "owner" },
      type: "SAVE_LAUNCH_ENVIRONMENT",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 3,
        environmentId: null,
        expectedEnvironmentVersion: null,
        configuration: {
          kind: "PRODUCTION",
          name: "Recurkit Production",
          presetId: "WEB_APP_V1",
          presetRevision: 1,
          publicBaseUrl: "https://example.test",
          healthPath: "/api/health",
          requiredEnvironmentVariables: [],
        },
      },
    });
    if (productionEnvironment.type !== "LAUNCH_ENVIRONMENT_CHANGED") {
      throw new Error("Expected Production Environment");
    }
    const productionDraft: LaunchRelease = {
      ...release,
      id: "release-production",
      environment: productionEnvironment.environment,
      contentHash: "0".repeat(64),
    };
    const productionContent = { ...productionDraft };
    delete (productionContent as Partial<LaunchRelease>).contentHash;
    const productionRelease: LaunchRelease = {
      ...productionDraft,
      contentHash: createHash("sha256").update(canonicalJson(productionContent)).digest("hex"),
    };
    expect(launchReleaseEvidenceDigest(productionRelease)).toBe(launchReleaseEvidenceDigest(release));

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
        productionRelease.id,
        productionRelease.projectId,
        productionRelease.environment.id,
        productionRelease.sourceTree,
        productionRelease.contentHash,
        JSON.stringify(productionRelease),
        productionRelease.createdAt,
      );
    database.close();

    localState = await open();
    expect(
      localState.query({
        type: "GET_QUALIFYING_PREVIEW_DEPLOYMENT",
        projectId: "project-1",
        releaseEvidenceDigest: launchReleaseEvidenceDigest(productionRelease),
      }),
    ).toMatchObject({
      type: "QUALIFYING_PREVIEW_DEPLOYMENT",
      deployment: { id: adopted.deployment.id, status: "SUCCEEDED" },
    });
    const productionTarget: GithubActionsDeploymentTargetV2 = {
      ...target,
      environmentKind: "PRODUCTION",
      workflowPath: ".github/workflows/deploy-production.yml",
    };
    const production = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-production",
      correlationId: "adopt-production",
      actor: { type: "HUMAN", id: "owner" },
      type: "ADOPT_DEPLOYMENT_PLAN",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 4,
        releaseId: productionRelease.id,
        expectedReleaseContentHash: productionRelease.contentHash,
        releaseFreshness: { status: "CURRENT", reasons: [] },
        releaseEvidenceDigest: launchReleaseEvidenceDigest(productionRelease),
        target: productionTarget,
      },
    });
    expect(production).toMatchObject({
      type: "DEPLOYMENT_PLAN_ADOPTED",
      plan: { revision: 2, environmentKind: "PRODUCTION", target: productionTarget },
      deployment: { status: "PENDING_APPROVAL", environmentKind: "PRODUCTION" },
    });
  });

  it("migrates a populated v60 database without rewriting legacy v1 deployment history", async () => {
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT`);
    const migrationLedger = database.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    const migrations = await loadMigrationSources();
    for (const migration of migrations.filter(({ version }) => version <= 60)) {
      database.exec(migration.sql);
      migrationLedger.run(migration.version, migration.name, migration.checksum, now);
    }

    database
      .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-legacy", "Legacy", now, now);
    database
      .prepare(
        `INSERT INTO projects (
          id, workspace_id, fixture_id, name, repository_path, provider_preference,
          status, version, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, 'AUTO', 'ACTIVE', 2, ?, ?)`,
      )
      .run(
        "project-legacy",
        "workspace-legacy",
        "Legacy Recurkit",
        "C:\\Users\\Имя\\Project with spaces\\recurkit",
        now,
        now,
      );
    const configuration = {
      kind: "PREVIEW" as const,
      name: "Legacy Preview",
      presetId: "WEB_APP_V1" as const,
      presetRevision: 1 as const,
      publicBaseUrl: "https://legacy-preview.example.test",
      healthPath: "/api/health",
      requiredEnvironmentVariables: [] as string[],
    };
    const legacyEnvironment: LaunchEnvironment = {
      schemaVersion: 1,
      id: "environment-legacy",
      projectId: "project-legacy",
      ...configuration,
      contentHash: createHash("sha256")
        .update(canonicalJson({ projectId: "project-legacy", configuration }))
        .digest("hex"),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    database
      .prepare(
        `INSERT INTO launch_environments (
          id, schema_version, project_id, kind, content_hash, environment_json,
          version, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        legacyEnvironment.id,
        legacyEnvironment.projectId,
        legacyEnvironment.kind,
        legacyEnvironment.contentHash,
        JSON.stringify(legacyEnvironment),
        now,
        now,
      );
    const legacyReleaseDraft: LaunchRelease = {
      schemaVersion: 1,
      id: "release-legacy",
      projectId: "project-legacy",
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
      environment: legacyEnvironment,
      selectedWorkItems: [],
      gates: launchReleaseGateKeySchema.options.map((key) => ({
        key,
        status: "PASSED" as const,
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
    const legacyReleaseContent = { ...legacyReleaseDraft };
    delete (legacyReleaseContent as Partial<LaunchRelease>).contentHash;
    const legacyRelease: LaunchRelease = {
      ...legacyReleaseDraft,
      contentHash: createHash("sha256").update(canonicalJson(legacyReleaseContent)).digest("hex"),
    };
    database
      .prepare(
        `INSERT INTO launch_releases
         (id, schema_version, project_id, environment_id, source_tree, content_hash, release_json, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyRelease.id,
        legacyRelease.projectId,
        legacyRelease.environment.id,
        legacyRelease.sourceTree,
        legacyRelease.contentHash,
        JSON.stringify(legacyRelease),
        now,
      );
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
    const legacyPlanDraft = {
      schemaVersion: 1 as const,
      id: "plan-legacy",
      projectId: "project-legacy",
      revision: 1 as const,
      releaseId: legacyRelease.id,
      releaseContentHash: legacyRelease.contentHash,
      environmentId: legacyEnvironment.id,
      environmentContentHash: legacyEnvironment.contentHash,
      target: legacyTarget,
      contentHash: "0".repeat(64),
      createdAt: now,
    };
    const legacyPlanContent = { ...legacyPlanDraft };
    delete (legacyPlanContent as Partial<typeof legacyPlanDraft>).contentHash;
    const legacyPlan = {
      ...legacyPlanDraft,
      contentHash: createHash("sha256").update(canonicalJson(legacyPlanContent)).digest("hex"),
    };
    database
      .prepare(
        `INSERT INTO deployment_plans (
          id, schema_version, project_id, release_id, environment_id, revision,
          content_hash, plan_json, created_at
        ) VALUES (?, 1, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        legacyPlan.id,
        legacyPlan.projectId,
        legacyPlan.releaseId,
        legacyPlan.environmentId,
        legacyPlan.contentHash,
        JSON.stringify(legacyPlan),
        now,
      );
    const legacyDeployment = {
      schemaVersion: 1 as const,
      id: "deployment-legacy",
      projectId: "project-legacy",
      planId: legacyPlan.id,
      planRevision: 1 as const,
      planContentHash: legacyPlan.contentHash,
      releaseId: legacyRelease.id,
      releaseContentHash: legacyRelease.contentHash,
      environmentId: legacyEnvironment.id,
      environmentContentHash: legacyEnvironment.contentHash,
      intent: "STANDARD" as const,
      approvalDigest: "9".repeat(64),
      status: "PENDING_APPROVAL" as const,
      approvalId: null,
      remoteRunId: null,
      remoteRunUrl: null,
      failureCode: null,
      createdAt: now,
      approvedAt: null,
      startedAt: null,
      completedAt: null,
      observedAt: null,
      version: 1,
    };
    database
      .prepare(
        `INSERT INTO deployments (
          id, schema_version, project_id, plan_id, release_id, environment_id, status,
          approval_digest, remote_run_id, deployment_json, version, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
      )
      .run(
        legacyDeployment.id,
        legacyDeployment.projectId,
        legacyDeployment.planId,
        legacyDeployment.releaseId,
        legacyDeployment.environmentId,
        legacyDeployment.status,
        legacyDeployment.approvalDigest,
        JSON.stringify(legacyDeployment),
        now,
        now,
      );
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();

    const migrated = await open();
    expect(migrated.startup.backupPath).toBeDefined();
    expect(
      migrated.query({ type: "GET_PROJECT_GUIDED_DEPLOYMENT", projectId: "project-legacy" }),
    ).toMatchObject({
      type: "PROJECT_GUIDED_DEPLOYMENT",
      latestPlan: { id: legacyPlan.id, revision: 1 },
      latestDeployment: { id: legacyDeployment.id, planRevision: 1 },
    });
    migrated.close();
    state = undefined;
    const inspected = new DatabaseSync(databasePath);
    expect(
      inspected
        .prepare(
          `SELECT plan_revision, environment_kind, release_evidence_digest
           FROM deployments WHERE id = ?`,
        )
        .get(legacyDeployment.id),
    ).toEqual({ plan_revision: 1, environment_kind: null, release_evidence_digest: null });
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });
});
