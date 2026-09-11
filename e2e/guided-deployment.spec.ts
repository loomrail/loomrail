import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import {
  launchReleaseGateKeySchema,
  type GithubActionsDeploymentTargetV2,
  type LaunchRelease,
} from "../packages/contracts/dist/index.js";
import { openLocalState } from "../packages/persistence-sqlite/dist/index.js";
import { expect, test } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "./provider-test-daemon.js";

const execFileAsync = promisify(execFile);
const timestamp = "2026-09-11T00:00:00.000Z";

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

test.describe("guided deployment", () => {
  let daemon: RunningDaemon | undefined;
  let directory = "";

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (directory !== "") await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  test("requires two keyboard confirmations and observes only the exact GitHub run", async ({ page }) => {
    directory = await mkdtemp(join(tmpdir(), "loomrail guided deploy Репозиторий with spaces "));
    const repositoryPath = join(directory, "Recurkit проект");
    await mkdir(repositoryPath, { recursive: true });
    await writeFile(join(repositoryPath, "committed.txt"), "committed\n", "utf8");
    await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: repositoryPath });
    await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: repositoryPath });
    await execFileAsync("git", ["add", "committed.txt"], { cwd: repositoryPath });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=loomrail-test@example.com",
        "-c",
        "user.name=Loomrail Test",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: repositoryPath },
    );
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
    const projectId = "guided-deploy-e2e-project";
    state.execute({
      schemaVersion: 1,
      commandId: "register-guided-deploy-e2e-project",
      correlationId: "register-guided-deploy-e2e-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: { id: projectId, fixtureId: null, name: "Recurkit", repositoryPath },
    });
    const environmentResult = state.execute({
      schemaVersion: 1,
      commandId: "save-guided-deploy-e2e-environment",
      correlationId: "save-guided-deploy-e2e-environment",
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
    if (environmentResult.type !== "LAUNCH_ENVIRONMENT_CHANGED") {
      throw new Error("Expected launch Environment");
    }
    const releaseWithoutHash: Omit<LaunchRelease, "contentHash"> = {
      schemaVersion: 1,
      id: "guided-deploy-e2e-release",
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
        release.projectId,
        release.environment.id,
        release.sourceTree,
        release.contentHash,
        JSON.stringify(release),
        release.createdAt,
      );
    database.close();

    const targetFor = (environmentKind: "PREVIEW" | "PRODUCTION"): GithubActionsDeploymentTargetV2 => ({
      presetId: "GITHUB_ACTIONS_ENVIRONMENT_WORKFLOW_V2",
      presetRevision: 2,
      environmentKind,
      repositorySlug: "recurkit/recurkit",
      branch: "main",
      commitSha,
      workflowPath:
        environmentKind === "PREVIEW"
          ? ".github/workflows/deploy-preview.yml"
          : ".github/workflows/deploy-production.yml",
      workflowContentHash: "a".repeat(64),
      argvDigest: "b".repeat(64),
      dispatchTimeoutSeconds: 30,
      observeTimeoutSeconds: 15,
      outputLimitBytes: 32_768,
      observeOutputLimitBytes: 65_536,
    });
    let dispatchCount = 0;
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
      stateDatabasePath: databasePath,
      verificationArtifactsDirectory: join(directory, "verification-output"),
      now: () => new Date(timestamp),
      deploymentDriver: {
        preflight: ({ environmentKind }) =>
          Promise.resolve({ type: "READY", target: targetFor(environmentKind) }),
        dispatch: () => {
          dispatchCount += 1;
          return Promise.resolve({
            type: "DISPATCHED",
            runId: 98765,
            runUrl: "https://github.com/recurkit/recurkit/actions/runs/98765",
          });
        },
        observe: ({ runId }) =>
          Promise.resolve(runId === 98765 ? { type: "SUCCEEDED" } : { type: "UNKNOWN" }),
      },
    });

    await page.addInitScript(() => {
      localStorage.setItem("loomrail-theme", "light");
    });
    await page.goto(daemon.bootstrapUrl);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: "Switch project" })).toContainText("Recurkit");
    await page.getByRole("button", { name: "Open settings" }).click();

    const deploy = page.getByRole("dialog", { name: "Settings" }).locator(".deployment-settings");
    await expect(deploy.getByRole("heading", { name: "Guided deploy" })).toBeVisible();
    await expect(deploy).toContainText("recurkit/recurkit");
    await expect(deploy).toContainText(".github/workflows/deploy-preview.yml");
    await expect(deploy).toContainText("Preview");
    await expect(deploy).toContainText(commitSha.slice(0, 12));
    await expect(deploy).toContainText("no hosting or SSH credentials");

    await deploy.getByRole("button", { name: "Confirm exact plan" }).focus();
    await page.keyboard.press("Enter");
    await expect(deploy.getByRole("button", { name: "Approve and deploy once" })).toBeVisible();
    expect(dispatchCount).toBe(0);

    await deploy.getByRole("button", { name: "Approve and deploy once" }).focus();
    await page.keyboard.press("Enter");
    await expect(deploy).toContainText("GitHub run started");
    expect(dispatchCount).toBe(1);
    await expect(deploy.getByRole("link", { name: "Open this run on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/recurkit/recurkit/actions/runs/98765",
    );

    await deploy.getByRole("button", { name: "Check exact run" }).click();
    await expect(deploy).toContainText("Deploy succeeded");
    expect(dispatchCount).toBe(1);
    await expect(deploy).toContainText("Rollback is unavailable");

    await daemon.close();
    daemon = undefined;
    const promotionState = await openLocalState({ databasePath, now: () => new Date(timestamp) });
    const productionEnvironment = promotionState.execute({
      schemaVersion: 1,
      commandId: "save-guided-deploy-e2e-production",
      correlationId: "save-guided-deploy-e2e-production",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "SAVE_LAUNCH_ENVIRONMENT",
      payload: {
        projectId,
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
    const productionWithoutHash: Omit<LaunchRelease, "contentHash"> = {
      ...releaseWithoutHash,
      id: "guided-deploy-e2e-production-release",
      environment: productionEnvironment.environment,
      createdAt: "2026-09-11T00:00:01.000Z",
    };
    const productionRelease: LaunchRelease = {
      ...productionWithoutHash,
      contentHash: contentHash(productionWithoutHash),
    };
    promotionState.close();
    const productionDatabase = new DatabaseSync(databasePath);
    productionDatabase
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
    productionDatabase.close();

    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
      stateDatabasePath: databasePath,
      verificationArtifactsDirectory: join(directory, "verification-output"),
      now: () => new Date(timestamp),
      deploymentDriver: {
        preflight: ({ environmentKind }) =>
          Promise.resolve({ type: "READY", target: targetFor(environmentKind) }),
        dispatch: () => {
          dispatchCount += 1;
          return Promise.resolve({
            type: "DISPATCHED",
            runId: 98765,
            runUrl: "https://github.com/recurkit/recurkit/actions/runs/98765",
          });
        },
        observe: ({ runId }) =>
          Promise.resolve(runId === 98765 ? { type: "SUCCEEDED" } : { type: "UNKNOWN" }),
      },
    });
    await page.goto(daemon.bootstrapUrl);
    await page.getByRole("button", { name: "Open settings" }).click();
    const productionDeploy = page.getByRole("dialog", { name: "Settings" }).locator(".deployment-settings");
    await expect(productionDeploy).toContainText("Production");
    await expect(productionDeploy).toContainText(".github/workflows/deploy-production.yml");
    await productionDeploy.getByRole("button", { name: "Confirm exact plan" }).focus();
    await page.keyboard.press("Enter");
    await expect(productionDeploy.getByRole("button", { name: "Approve and deploy once" })).toBeVisible();
    await productionDeploy.getByRole("button", { name: "Approve and deploy once" }).focus();
    await page.keyboard.press("Enter");
    await expect(productionDeploy).toContainText("GitHub run started");
    expect(dispatchCount).toBe(2);
    await productionDeploy.getByRole("button", { name: "Check exact run" }).click();
    await expect(productionDeploy).toContainText("Deploy succeeded");

    await page
      .getByRole("group", { name: "Change color theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.setViewportSize({ width: 320, height: 760 });
    await expect(deploy.getByRole("heading", { name: "Guided deploy" })).toBeVisible();
  });
});
