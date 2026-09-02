import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";
import type { BrowserDriver } from "../packages/browser-qa/dist/index.js";
import { qaPlanSnapshotSchema } from "../packages/contracts/dist/index.js";

test.use({ trace: "off" });

const failedBrowserDriver: BrowserDriver = {
  id: "PLAYWRIGHT",
  run: (qaRun) => {
    const target = qaRun.plan.targets[0];
    const scenario = qaRun.plan.scenarios[0];
    if (!target || !scenario) throw new Error("The Browser QA fixture requires a matrix cell");
    return Promise.resolve({
      result: {
        outcome: "MEASURED",
        environment: {
          osFamily: "MACOS",
          runtimeName: "NODE",
          runtimeVersion: "24.19.0",
          browserName: "CHROMIUM",
          browserVersion: "fixture-failed",
        },
        executions: qaRun.plan.targets.flatMap((plannedTarget) =>
          qaRun.plan.scenarios.map((plannedScenario) => ({
            targetId: plannedTarget.id,
            scenarioId: plannedScenario.id,
            durationMs: 25,
            steps: plannedScenario.steps.map(({ id }) => ({
              id,
              status: "PASSED" as const,
              durationMs: 10,
            })),
            assertions: plannedScenario.assertions.map(({ id }, index) => ({
              id,
              status: index === 0 ? ("FAILED" as const) : ("PASSED" as const),
              details: index === 0 ? "The measured readiness path was not active." : null,
            })),
          })),
        ),
        observations: [
          {
            kind: "CONSOLE",
            severity: "ERROR",
            blocking: true,
            targetId: target.id,
            scenarioId: scenario.id,
            summary: "The fixture reported a blocking browser error.",
          },
        ],
        attachments: [],
        defects: [
          {
            severity: "HIGH",
            title: "Readiness route is unavailable",
            description: "The deterministic browser assertion failed on the measured target.",
            reproduction: ["Open the readiness route.", "Inspect the failed path assertion."],
            targetId: target.id,
            scenarioId: scenario.id,
          },
        ],
      },
      finalizeAttachments: () => Promise.resolve([]),
      confirmAttachments: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    });
  },
};

const realFailurePlanDefinition = {
  schemaVersion: 1 as const,
  revision: 1,
  targets: [
    {
      id: "desktop-light-en",
      viewport: { width: 1_280, height: 800 },
      locale: "en-US",
      theme: "LIGHT" as const,
    },
  ],
  scenarios: [
    {
      id: "intentional-path-failure",
      title: "The readiness route rejects an incorrect expectation",
      steps: [
        {
          id: "open-readiness",
          title: "Open the public readiness endpoint",
          action: { type: "NAVIGATE" as const, path: "/health/ready" },
        },
      ],
      assertions: [
        {
          id: "wrong-path",
          title: "The browser remains on an intentionally incorrect path",
          rule: { type: "URL_PATH" as const, path: "/intentionally-incorrect" },
        },
      ],
    },
  ],
};

const realFailurePlan = qaPlanSnapshotSchema.parse({
  ...realFailurePlanDefinition,
  contentHash: `sha256:${createHash("sha256")
    .update(JSON.stringify(realFailurePlanDefinition))
    .digest("hex")}`,
});

const initializeWorkspace = async (page: Page): Promise<void> => {
  const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
  await expect(initialize).toBeVisible();
  await initialize.click();
  await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled({ timeout: 20_000 });
};

const createTask = async (page: Page, title: string): Promise<Locator> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog
    .getByPlaceholder("Outcome, constraints, relevant files…")
    .fill("Prove that failed measured Browser QA remains visible and blocks Acceptance.");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
  return page.getByRole("complementary", { name: title });
};

const chooseInSettings = async (page: Page, control: string, option: string): Promise<void> => {
  const settings = page.locator('.lr-dialog[data-state="open"]');
  const openSettings = page.getByRole("button", { name: /Open settings|Открыть настройки/ });
  if (!(await openSettings.isVisible())) {
    await page.getByRole("button", { name: /Open navigation|Открыть навигацию/ }).click();
  }
  await openSettings.click();
  await expect(settings).toBeVisible();
  await settings.getByRole("group", { name: control }).getByRole("button", { name: option }).click();
  await settings.locator(".lr-dialog__header button").click();
  await expect(settings).toHaveCount(0);
};

const advanceTaskToBrowserQA = async (page: Page, title: string): Promise<Locator> => {
  const inspector = await createTask(page, title);
  await inspector.getByRole("button", { name: "Move to Ready" }).click();
  await inspector.getByRole("button", { name: "Start workflow" }).click();
  await expect(inspector.getByRole("heading", { name: "Choose the discovery depth" })).toBeVisible({
    timeout: 20_000,
  });
  await inspector.getByRole("radio", { name: /Focused pass/ }).click();
  await inspector.getByRole("button", { name: "Answer & resume" }).click();
  const workflow = inspector
    .locator(".lr-inspector-section")
    .filter({ has: page.getByText("Workflow", { exact: true }) });
  await expect(workflow.getByText("Budget paused", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await workflow.getByRole("button", { name: "Approve 200 token budget" }).click();
  return workflow;
};

test.describe("measured Browser QA cockpit", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("shows a durable failed matrix and never opens Acceptance", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
      browserQADriver: failedBrowserDriver,
    });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    const workflow = await advanceTaskToBrowserQA(page, "Measured Browser QA failure");
    const inspector = page.getByRole("complementary", { name: "Measured Browser QA failure" });

    const qa = workflow.getByRole("region", { name: "Browser QA" });
    await expect(qa).toBeVisible({ timeout: 20_000 });
    await expect(qa.getByText("Failed", { exact: true }).first()).toBeVisible();
    await expect(
      qa.locator(".qa-matrix__failures > li").filter({
        hasText: "Failed: The readiness path is active",
      }),
    ).toHaveCount(2);
    await expect(
      qa.getByText("The fixture reported a blocking browser error.", { exact: true }),
    ).toBeVisible();
    await expect(qa.getByText("Readiness route is unavailable", { exact: true })).toBeVisible();
    await expect(qa.getByText("High", { exact: true })).toBeVisible();
    await expect(workflow.getByRole("heading", { name: "Acceptance package" })).toHaveCount(0);
    await expect(inspector.getByRole("heading", { name: "Browser QA found blocking defects" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("region", { name: "Browser QA" })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 720 });
    await chooseInSettings(page, "Change color theme", "Dark");
    await chooseInSettings(page, "Change language", "Русский");
    const russianQA = page.getByRole("region", { name: "QA в браузере" });
    await expect(russianQA).toBeVisible();
    await expect(russianQA.getByText("Есть ошибки", { exact: true }).first()).toBeVisible();
    await expect(russianQA.getByText("Дефекты QA", { exact: true })).toBeVisible();
    await expect(russianQA.getByText("Высокая", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("shows real green evidence before opening Acceptance", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    const workflow = await advanceTaskToBrowserQA(page, "Measured Browser QA success");

    const qa = workflow.getByRole("region", { name: "Browser QA" });
    await expect(qa).toBeVisible({ timeout: 30_000 });
    await expect(qa.getByText("Passed", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(qa.getByText("The local Loomrail demo is reachable", { exact: true })).toHaveCount(2);
    await expect(qa.getByText(/CHROMIUM .* · .* · Node /)).toBeVisible();
    const evidenceLinks = qa.getByRole("link", { name: "Open evidence" });
    await expect(evidenceLinks).toHaveCount(4);
    await expect(evidenceLinks.first()).toHaveAttribute("href", /\/qa\/attachments\//);
    await evidenceLinks.first().focus();
    await expect(evidenceLinks.first()).toBeFocused();
    await expect(workflow.getByRole("heading", { name: "Acceptance package" })).toBeVisible();
  });

  test("keeps a real browser assertion failure outside Acceptance", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
      browserQAConfigResolver: () => {
        if (!daemon) throw new Error("The Browser QA daemon is not ready");
        return Promise.resolve({
          status: "READY",
          targetOrigin: daemon.baseUrl,
          plan: realFailurePlan,
        });
      },
    });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    const workflow = await advanceTaskToBrowserQA(page, "Real Browser QA failure");

    const qa = workflow.getByRole("region", { name: "Browser QA" });
    await expect(qa).toBeVisible({ timeout: 30_000 });
    await expect(qa.getByText("Failed", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(
      qa.locator(".qa-matrix__failures > li").filter({
        hasText: "Failed: The browser remains on an intentionally incorrect path",
      }),
    ).toHaveCount(1);
    await expect(
      qa.getByText("The browser remains on an intentionally incorrect path", { exact: true }),
    ).toBeVisible();
    await expect(qa.getByRole("link", { name: "Open evidence" })).toHaveCount(2);
    await expect(workflow.getByRole("heading", { name: "Acceptance package" })).toHaveCount(0);
    await expect(workflow.getByRole("heading", { name: "Browser QA found blocking defects" })).toBeVisible();
  });
});
