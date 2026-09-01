import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

const initializeWorkspace = async (page: Page): Promise<void> => {
  const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
  await expect(initialize).toBeVisible();
  await initialize.click();
  await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled({ timeout: 20_000 });
};

const createTask = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog
    .getByPlaceholder("Outcome, constraints, relevant files…")
    .fill("Exercise the independent review cockpit.");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
};

const chooseInSettings = async (page: Page, control: string, option: string): Promise<void> => {
  const settings = page.locator(".lr-dialog");
  await page.getByRole("button", { name: /Open settings|Открыть настройки/ }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("group", { name: control }).getByRole("button", { name: option }).click();
  await settings.locator(".lr-dialog__header button").click();
  await expect(settings).toHaveCount(0);
};

test.describe("independent review cockpit", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("shows bounded findings and records an owner disposition across themes, locales and reload", async ({
    page,
  }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    let disposed = false;
    let dispositionAttempts = 0;
    let routedWorkItemId = "";
    await page.route("**/api/v1/work-items/*/reviews", async (route) => {
      routedWorkItemId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
      const finding = {
        schemaVersion: 1,
        id: "review-finding-browser",
        projectId: "project-fixture-web-app-a",
        workItemId: routedWorkItemId,
        pipelineRunId: "pipeline-review-browser",
        stageAttemptId: "review-attempt-browser",
        reviewArtifactId: "review-report-browser",
        reviewedTree: "a".repeat(40),
        ordinal: 1,
        severity: "HIGH",
        status: disposed ? "WAIVED" : "OPEN",
        title: "Expected version is ignored",
        description: "The mutation can overwrite a concurrent update.",
        path: "packages/domain/src/review.ts",
        startLine: 40,
        endLine: 44,
        reproduction: "Submit the command with the previous aggregate version.",
        criterion: "Concurrent updates fail closed.",
        suggestedFix: "Include expectedVersion in the guarded update predicate.",
        resolutionReason: disposed ? "Accepted for this bounded browser fixture." : null,
        resolvedBy: disposed ? { type: "HUMAN", id: "local-owner" } : null,
        createdAt: "2026-09-02T10:00:00.000Z",
        resolvedAt: disposed ? "2026-09-02T10:05:00.000Z" : null,
        version: disposed ? 2 : 1,
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          reports: [
            {
              schemaVersion: 1,
              id: "review-report-browser",
              projectId: "project-fixture-web-app-a",
              workItemId: routedWorkItemId,
              pipelineRunId: "pipeline-review-browser",
              stageAttemptId: "review-attempt-browser",
              authorAgentRunId: "author-run-browser",
              reviewerAgentRunId: "reviewer-run-browser",
              providerRelation: "CROSS_PROVIDER",
              reviewedTree: "a".repeat(40),
              round: 1,
              title: "Independent review",
              summary: "One blocking finding requires another implementation round.",
              checks: ["Checked the guarded update against the acceptance criterion."],
              verdict: "CHANGES_REQUESTED",
              findingIds: [finding.id],
              createdAt: "2026-09-02T10:00:00.000Z",
              authorProvider: "CODEX",
              reviewerProvider: "CLAUDE_CODE",
            },
          ],
          findings: [finding],
        }),
      });
    });
    await page.route("**/api/v1/review-findings/*/disposition", async (route) => {
      const payload = route.request().postDataJSON() as { disposition: string; reason: string };
      expect(route.request().headers()["x-loomrail-csrf"]).toBeTruthy();
      expect(payload).toMatchObject({
        disposition: "WAIVED",
        reason: "Accepted for this bounded browser fixture.",
      });
      dispositionAttempts += 1;
      if (dispositionAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "REVIEW_FINDING_VERSION_CONFLICT",
              message: "The finding changed before this owner decision was recorded.",
              correlationId: "correlation-review-conflict-browser",
            },
          }),
        });
        return;
      }
      disposed = true;
      const finding = {
        schemaVersion: 1,
        id: "review-finding-browser",
        projectId: "project-fixture-web-app-a",
        workItemId: routedWorkItemId,
        pipelineRunId: "pipeline-review-browser",
        stageAttemptId: "review-attempt-browser",
        reviewArtifactId: "review-report-browser",
        reviewedTree: "a".repeat(40),
        ordinal: 1,
        severity: "HIGH",
        status: "WAIVED",
        title: "Expected version is ignored",
        description: "The mutation can overwrite a concurrent update.",
        path: "packages/domain/src/review.ts",
        startLine: 40,
        endLine: 44,
        reproduction: "Submit the command with the previous aggregate version.",
        criterion: "Concurrent updates fail closed.",
        suggestedFix: "Include expectedVersion in the guarded update predicate.",
        resolutionReason: payload.reason,
        resolvedBy: { type: "HUMAN", id: "local-owner" },
        createdAt: "2026-09-02T10:00:00.000Z",
        resolvedAt: "2026-09-02T10:05:00.000Z",
        version: 2,
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          type: "REVIEW_FINDING_DISPOSED",
          replayed: false,
          workItemId: routedWorkItemId,
          finding,
          events: [
            {
              schemaVersion: 1,
              sequence: 1,
              id: "event-review-finding-browser",
              type: "REVIEW_FINDING_RESOLVED",
              aggregateType: "WORK_ITEM",
              aggregateId: routedWorkItemId,
              projectId: "project-fixture-web-app-a",
              actor: { type: "HUMAN", id: "local-owner" },
              occurredAt: "2026-09-02T10:05:00.000Z",
              correlationId: "correlation-review-finding-browser",
              data: { finding },
            },
          ],
        }),
      });
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    const taskTitle = "Review cockpit browser fixture";
    await createTask(page, taskTitle);
    const inspector = page.getByRole("complementary", { name: taskTitle });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await inspector.getByRole("button", { name: "Start workflow" }).click();

    const review = inspector.getByRole("region", { name: "Independent review" });
    await expect(review).toBeVisible();
    await expect(review.getByText("Review round 1", { exact: true })).toBeVisible();
    await expect(review.getByText("Cross-provider", { exact: true })).toBeVisible();
    await expect(review.getByText("packages/domain/src/review.ts:40-44", { exact: true })).toBeVisible();

    await review.getByRole("button", { name: "Waive" }).click();
    const reason = review.getByRole("textbox", { name: "Owner reason" });
    await expect(reason).toBeFocused();
    const confirm = review.getByRole("button", { name: "Record waiver" });
    await expect(confirm).toBeDisabled();
    await reason.fill("Accepted for this bounded browser fixture.");
    await confirm.click();
    await expect(
      review.getByRole("alert").getByText("The finding changed before this owner decision was recorded."),
    ).toBeVisible();
    await confirm.click();
    await expect(review.getByText("Waived", { exact: true })).toBeVisible();
    await expect(
      review.getByText("Accepted for this bounded browser fixture.", { exact: true }),
    ).toBeVisible();

    await chooseInSettings(page, "Change color theme", "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await chooseInSettings(page, "Change language", "Русский");
    await expect(inspector.getByRole("region", { name: "Независимое ревью" })).toBeVisible();

    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByRole("region", { name: "Независимое ревью" })).toBeVisible();
    await expect(page.getByText("Риск принят", { exact: true })).toBeVisible();
  });
});
