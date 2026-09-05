import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";
import type { VerificationPlan, VerificationRunSnapshotResponse } from "../packages/contracts/dist/index.js";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

const projectId = "project-fixture-web-app-a";
const timestamp = "2026-09-05T12:00:00.000Z";
const plan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-browser",
  projectId,
  revision: 2,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "package-test",
      kind: "UNIT",
      label: "Unit tests",
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
        manifestContentHash: "a".repeat(64),
        scriptName: "test",
        scriptBodyPreview: "vitest run",
      },
    },
  ],
  sourceProposalHash: "b".repeat(64),
  contentHash: "c".repeat(64),
  createdAt: timestamp,
};

const runSnapshot = (workItemId: string): VerificationRunSnapshotResponse => ({
  schemaVersion: 1,
  plan,
  run: {
    schemaVersion: 1,
    id: "verification-run-browser",
    projectId,
    workItemId,
    pipelineRunId: "pipeline-run-browser",
    workspaceId: "workspace-browser",
    planId: plan.id,
    planRevision: plan.revision,
    planContentHash: plan.contentHash,
    implementationTree: "d".repeat(40),
    ordinal: 1,
    retryOfRunId: null,
    platform: "darwin",
    status: "PASSED",
    currentCheckId: null,
    terminalReason: "ALL_REQUIRED_PASSED",
    startedAt: timestamp,
    completedAt: "2026-09-05T12:00:01.250Z",
    createdAt: timestamp,
    version: 3,
  },
  checks: [
    {
      schemaVersion: 1,
      id: "verification-check-browser",
      projectId,
      workItemId,
      runId: "verification-run-browser",
      recipeId: "package-test",
      ordinal: 1,
      required: true,
      status: "PASSED",
      startedAt: timestamp,
      completedAt: "2026-09-05T12:00:01.250Z",
      durationMs: 1_250,
      exitCode: 0,
      signal: null,
      errorCode: null,
      output: {
        schemaVersion: 1,
        artifactId: "verification-output-browser",
        sha256: "e".repeat(64),
        capturedBytes: 48,
        stdoutBytes: 48,
        stderrBytes: 0,
        truncated: false,
        available: true,
      },
      version: 3,
    },
  ],
  freshness: "CURRENT",
  staleReasons: [],
});

const workItemIdFrom = (route: Route): string => {
  const match = /\/work-items\/([^/]+)\/verification-runs$/u.exec(new URL(route.request().url()).pathname);
  if (match?.[1] === undefined) throw new Error("Verification route did not contain a WorkItem id");
  return decodeURIComponent(match[1]);
};

const initializeWorkspace = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Initialize demo workspace" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled({ timeout: 20_000 });
};

const createTask = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog
    .getByPlaceholder("Outcome, constraints, relevant files…")
    .fill("Show measured checks clearly.");
  await dialog
    .getByPlaceholder("The owner can verify the delivered outcome…")
    .fill("Project verification is current and inspectable.");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
};

test.describe("project verification Task Cockpit", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("keeps one easy action, inert output and a narrow dark Russian layout", async ({ page }) => {
    let measured: VerificationRunSnapshotResponse | null = null;
    await page.route("**/api/v1/projects/*/verification-plan", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          projectId,
          projectVersion: 3,
          proposal: {
            schemaVersion: 1,
            projectId,
            target: { state: "PRESENT", digest: plan.contentHash },
            recipes: plan.recipes,
            warnings: [],
            proposalHash: plan.sourceProposalHash,
          },
          plan,
          publication: {
            schemaVersion: 1,
            id: "verification-publication-browser",
            projectId,
            planId: plan.id,
            targetPath: ".loomrail/verification-plan.json",
            expectedTargetDigest: null,
            contentHash: plan.contentHash,
            status: "APPLIED",
            attempts: 1,
            lastErrorCode: null,
            version: 2,
            createdAt: timestamp,
            updatedAt: timestamp,
            appliedAt: timestamp,
          },
        }),
      });
    });
    await page.route("**/api/v1/work-items/*/workflow", async (route) => {
      const workItemId = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[4] ?? "");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          run: {
            schemaVersion: 1,
            id: "pipeline-run-browser",
            projectId,
            workItemId,
            workflowTemplateId: "mock-delivery-v1",
            workflowVersion: 1,
            status: "WAITING_HUMAN",
            currentStageAttemptId: "stage-attempt-browser",
            version: 4,
            createdAt: timestamp,
            updatedAt: timestamp,
            finishedAt: null,
          },
          stageAttempts: [],
          humanRequests: [],
          decisions: [],
          budgetPolicies: [],
          usageRecords: [],
          recoveryReports: [],
          artifacts: [],
          acceptancePackage: null,
        }),
      });
    });
    await page.route("**/api/v1/work-items/*/workspace", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          workspace: {
            schemaVersion: 1,
            branch: "loomrail/project-verification",
            worktreePath: "/private/tmp/loomrail worktree ё",
            baseCommit: "f".repeat(40),
            snapshotCommit: null,
            status: "READY",
          },
        }),
      });
    });
    await page.route("**/api/v1/work-items/*/verification-runs", async (route) => {
      const workItemId = workItemIdFrom(route);
      if (route.request().method() === "POST") measured = runSnapshot(workItemId);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          route.request().method() === "POST"
            ? measured
            : {
                schemaVersion: 1,
                runs: measured === null ? [] : [measured],
                failures: [],
                correctionRuns: [],
              },
        ),
      });
    });
    await page.route("**/api/v1/verification-checks/*/output", async (route) => {
      await route.fulfill({
        contentType: "text/plain; charset=utf-8",
        body: "<script>window.mustNotRun = true</script>\nPASS 1 test\n",
      });
    });

    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Measured project checks");

    const inspector = page.getByRole("complementary", { name: "Measured project checks" });
    const verification = inspector.locator(".project-verification");
    await expect(verification.getByText("Unit tests", { exact: true })).toBeVisible();
    await expect(verification.locator(".verification-command code")).toHaveText(["pnpm", "run", "test"]);
    const run = verification.getByRole("button", { name: "Run checks" });
    await run.focus();
    await expect(run).toBeFocused();
    await run.press("Enter");
    await expect(verification.getByText("Passed", { exact: true }).first()).toBeVisible();
    await expect(verification.getByRole("button", { name: "Run again" })).toBeVisible();

    const viewOutput = verification.getByRole("button", { name: "View output" });
    await viewOutput.focus();
    await viewOutput.press("Enter");
    const output = verification.locator("pre");
    await expect(output).toContainText("<script>window.mustNotRun = true</script>");
    expect(await output.locator("script").count()).toBe(0);

    const desktopOverflow = await verification.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(desktopOverflow).toBeLessThanOrEqual(1);

    const visualQaDirectory = process.env["LOOMRAIL_VISUAL_QA_DIR"];
    if (visualQaDirectory !== undefined) {
      await page.screenshot({ path: resolve(visualQaDirectory, "project-verification-light.png") });
    }

    await page.evaluate(() => {
      localStorage.setItem("loomrail-theme", "dark");
      localStorage.setItem("loomrail.locale", "ru");
    });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.reload();
    const narrowInspector = page.getByRole("complementary", { name: "Measured project checks" });
    const narrowVerification = narrowInspector.locator(".project-verification");
    await narrowVerification.scrollIntoViewIfNeeded();
    await expect(narrowInspector.getByText("Проверка проекта", { exact: true })).toBeVisible();
    await expect(narrowVerification.getByRole("button", { name: "Запустить снова" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    const narrowOverflow = await narrowVerification.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(narrowOverflow).toBeLessThanOrEqual(1);

    if (visualQaDirectory !== undefined) {
      await page.screenshot({
        fullPage: true,
        path: resolve(visualQaDirectory, "project-verification-dark-ru-320.png"),
      });
    }
  });
});
