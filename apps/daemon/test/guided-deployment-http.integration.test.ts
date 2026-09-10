import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import {
  apiErrorResponseSchema,
  deploymentPreviewResponseSchema,
  guidedDeploymentProjectResponseSchema,
  launchReleaseGateKeySchema,
  type GithubActionsDeploymentTarget,
  type LaunchRelease,
} from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeploymentDriver } from "../src/deployment-driver.js";
import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken, mutationHeaders } from "./daemon-fixtures.js";
import { makeThrowawayRepo } from "./repo-fixtures.js";

const execFileAsync = promisify(execFile);
const timestamp = "2026-09-10T18:00:00.000Z";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
};

const contentHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");

describe("guided deployment HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("requires owner auth and dispatches the exact approved target only once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail deploy API Репозиторий with spaces "));
    directories.push(directory);
    const repositoryPath = await makeThrowawayRepo(join(directory, "Recurkit проект"));
    const [sourceTree, commitSha] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath }).then(({ stdout }) =>
        stdout.trim(),
      ),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath }).then(({ stdout }) =>
        stdout.trim(),
      ),
    ]);
    const databasePath = join(directory, "state.sqlite");
    const state = await openLocalState({ databasePath, now: () => new Date(timestamp) });
    const projectId = "guided-deployment-project";
    const environmentResult = (() => {
      state.execute({
        schemaVersion: 1,
        commandId: "register-guided-deployment-project",
        correlationId: "register-guided-deployment-project",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: { id: projectId, fixtureId: null, name: "Recurkit", repositoryPath },
      });
      return state.execute({
        schemaVersion: 1,
        commandId: "save-guided-deployment-environment",
        correlationId: "save-guided-deployment-environment",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "SAVE_LAUNCH_ENVIRONMENT",
        payload: {
          projectId,
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
    })();
    if (environmentResult.type !== "LAUNCH_ENVIRONMENT_CHANGED") {
      throw new Error("Expected launch Environment");
    }
    const releaseWithoutHash: Omit<LaunchRelease, "contentHash"> = {
      schemaVersion: 1,
      id: "guided-deployment-release",
      projectId,
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
      environment: environmentResult.environment,
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
      createdAt: timestamp,
    };
    const release: LaunchRelease = {
      ...releaseWithoutHash,
      contentHash: contentHash(releaseWithoutHash),
    };
    state.close();
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        `INSERT INTO launch_releases
         (id, schema_version, project_id, environment_id, source_tree, content_hash, release_json, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        release.id,
        projectId,
        release.environment.id,
        release.sourceTree,
        release.contentHash,
        JSON.stringify(release),
        timestamp,
      );
    database.close();

    const target: GithubActionsDeploymentTarget = {
      presetId: "GITHUB_ACTIONS_WORKFLOW_V1",
      presetRevision: 1,
      repositorySlug: "recurkit/recurkit",
      branch: "main",
      commitSha,
      workflowPath: ".github/workflows/deploy-production.yml",
      workflowContentHash: "a".repeat(64),
      argvDigest: "b".repeat(64),
      dispatchTimeoutSeconds: 30,
      observeTimeoutSeconds: 15,
      outputLimitBytes: 32_768,
      observeOutputLimitBytes: 65_536,
    };
    const preflight = vi.fn<DeploymentDriver["preflight"]>(() => Promise.resolve({ type: "READY", target }));
    const dispatch = vi.fn<DeploymentDriver["dispatch"]>(() =>
      Promise.resolve({
        type: "DISPATCHED",
        runId: 98765,
        runUrl: "https://github.com/recurkit/recurkit/actions/runs/98765",
      }),
    );
    const observe = vi.fn<DeploymentDriver["observe"]>(() => Promise.resolve({ type: "SUCCEEDED" }));
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: databasePath,
      verificationArtifactsDirectory: join(directory, "verification-output"),
      now: () => new Date(timestamp),
      deploymentDriver: { preflight, dispatch, observe },
    });

    expect((await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/guided-deployment`)).status).toBe(
      401,
    );
    const session = await authenticate(daemon, token);
    const headers = mutationHeaders(daemon, session);
    const previewResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/guided-deployment/preview?releaseId=${release.id}`,
      { headers: { cookie: session.cookie } },
    );
    expect(previewResponse.status).toBe(200);
    const previewBody: unknown = await previewResponse.json();
    expect(JSON.stringify(previewBody)).not.toContain(repositoryPath);
    expect(deploymentPreviewResponseSchema.parse(previewBody)).toEqual({
      schemaVersion: 1,
      projectId,
      projectVersion: 2,
      releaseId: release.id,
      releaseContentHash: release.contentHash,
      status: "READY",
      target,
    });

    const planBody = {
      schemaVersion: 1,
      commandId: "adopt-guided-deployment-plan",
      expectedProjectVersion: 2,
      releaseId: release.id,
      expectedReleaseContentHash: release.contentHash,
    };
    expect(
      (
        await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/guided-deployment/plans`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: session.cookie,
            origin: daemon.baseUrl,
          },
          body: JSON.stringify(planBody),
        })
      ).status,
    ).toBe(403);
    const adoptedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/guided-deployment/plans`,
      { method: "POST", headers, body: JSON.stringify(planBody) },
    );
    expect(adoptedResponse.status).toBe(200);
    const adopted = guidedDeploymentProjectResponseSchema.parse(await adoptedResponse.json());
    expect(adopted.latestDeployment?.status).toBe("PENDING_APPROVAL");
    if (adopted.latestDeployment === null) throw new Error("Expected pending Deployment");

    const rejectedApproval = await fetch(
      `${daemon.baseUrl}/api/v1/deployments/${adopted.latestDeployment.id}/approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "reject-wrong-approval-digest",
          expectedVersion: adopted.latestDeployment.version,
          approvalDigest: "f".repeat(64),
        }),
      },
    );
    expect(rejectedApproval.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await rejectedApproval.json()).error.code).toBe(
      "APPROVAL_DIGEST_MISMATCH",
    );

    const approvalBody = {
      schemaVersion: 1,
      commandId: "approve-guided-deployment",
      expectedVersion: adopted.latestDeployment.version,
      approvalDigest: adopted.latestDeployment.approvalDigest,
    };
    const approvedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/deployments/${adopted.latestDeployment.id}/approve`,
      { method: "POST", headers, body: JSON.stringify(approvalBody) },
    );
    expect(approvedResponse.status).toBe(200);
    await daemon.whenIdle();
    const running = guidedDeploymentProjectResponseSchema.parse(
      await fetch(`${daemon.baseUrl}/api/v1/projects/${projectId}/guided-deployment`, {
        headers: { cookie: session.cookie },
      }).then(async (response) => response.json()),
    );
    expect(running.latestDeployment).toMatchObject({
      status: "RUNNING",
      remoteRunId: 98765,
      remoteRunUrl: "https://github.com/recurkit/recurkit/actions/runs/98765",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const replayedApproval = await fetch(
      `${daemon.baseUrl}/api/v1/deployments/${adopted.latestDeployment.id}/approve`,
      { method: "POST", headers, body: JSON.stringify(approvalBody) },
    );
    expect(replayedApproval.status).toBe(200);
    await daemon.whenIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);

    const observedResponse = await fetch(
      `${daemon.baseUrl}/api/v1/deployments/${adopted.latestDeployment.id}/observe`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ schemaVersion: 1, commandId: "observe-guided-deployment" }),
      },
    );
    expect(observedResponse.status).toBe(200);
    const observed = guidedDeploymentProjectResponseSchema.parse(await observedResponse.json());
    expect(observed.latestDeployment).toMatchObject({
      status: "SUCCEEDED",
      remoteRunId: 98765,
      failureCode: null,
    });
    expect(JSON.stringify(observed)).not.toContain(repositoryPath);
    expect(observe).toHaveBeenCalledTimes(1);
  });
});
