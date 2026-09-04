import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { passingBrowserQADriver } from "../apps/daemon/test/browser-qa-fixture.js";
import { createProviderRegistry } from "../apps/daemon/dist/provider-selection.js";
import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

const guidedUrl = (bootstrapUrl: string): string => {
  const url = new URL(bootstrapUrl);
  url.pathname = "/try";
  return url.toString();
};

const unlockedMockRegistry = () =>
  createProviderRegistry({
    env: {},
    executableAvailable: () => false,
    probeAuthentication: () => Promise.resolve("UNKNOWN"),
    probeCompatibility: () => Promise.resolve({ compatibility: "VERSION_UNREADABLE", version: null }),
  });

const chooseInSettings = async (page: Page, control: string, option: string): Promise<void> => {
  const settings = page.locator(".lr-dialog");
  await page.getByRole("button", { name: /Open settings|Открыть настройки/ }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("group", { name: control }).getByRole("button", { name: option }).click();
  await settings.locator(".lr-dialog__header button").click();
  await expect(settings).toHaveCount(0);
};

test.describe("canonical guided activation", () => {
  let daemon: RunningDaemon | undefined;
  let dataDirectory: string | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (dataDirectory !== undefined) await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  });

  test("reaches durable owner acceptance without a live provider", async ({ page }) => {
    dataDirectory = await mkdtemp(join(tmpdir(), "loomrail guided activation "));
    const databasePath = join(dataDirectory, "state.sqlite");
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      browserQADriver: passingBrowserQADriver(),
      logger: false,
      providerRegistry: unlockedMockRegistry(),
      stateDatabasePath: databasePath,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(guidedUrl(daemon.bootstrapUrl));
    await expect(page).toHaveURL(/\/try$/);
    await expect(page.getByRole("heading", { level: 1, name: "Guided demo" })).toBeVisible();
    await expect(
      page.getByText("Deterministic Mock only — no provider process, login, or quota."),
    ).toBeVisible();
    const progress = page.getByRole("navigation", { name: "Guided demo progress" });
    await expect(progress.getByText("Human Request and delivery", { exact: true })).toBeVisible();
    await expect(progress.getByText("Independent review", { exact: true })).toBeVisible();
    await expect(progress.getByText("Measured Browser QA", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);

    const prepare = page.getByRole("button", { name: "Prepare demo workspace" });
    await prepare.focus();
    await expect(prepare).toBeFocused();
    await prepare.press("Enter");
    await expect(page.getByRole("button", { name: "Use Mock for this project" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Use Mock for this project" }).click();
    await page.getByRole("button", { name: "Create guided task" }).click();
    await expect(page).toHaveURL(/\/try\?task=/);
    await page.getByText("What this run will do", { exact: true }).click();
    await expect(page.getByText("An empty input renders exactly one visible status message")).toBeVisible();
    await expect(page.getByText("100", { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("button", { name: "Move task to Ready" })).toBeVisible();
    await page.getByRole("button", { name: "Move task to Ready" }).click();
    await expect(page.getByRole("button", { name: "Start guided workflow" })).toBeVisible();

    // Restart before the run: /try must reconstruct its step from SQLite, not browser memory.
    await daemon.close();
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      browserQADriver: passingBrowserQADriver(),
      logger: false,
      providerRegistry: unlockedMockRegistry(),
      stateDatabasePath: databasePath,
      webRoot: resolve("apps/web/dist"),
    });
    await page.goto(guidedUrl(daemon.bootstrapUrl));
    await expect(page.getByRole("button", { name: "Start guided workflow" })).toBeVisible();
    await page.getByRole("button", { name: "Start guided workflow" }).click();

    await expect(page.getByRole("button", { name: "Answer in Attention" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Answer in Attention" }).click();
    await expect(page.getByRole("heading", { name: "Choose the discovery depth" })).toBeVisible();
    await page.getByRole("radio", { name: /Focused pass/ }).click();
    await page.getByRole("button", { name: "Answer & resume" }).click();
    await page.getByRole("link", { name: "Guided demo" }).click();

    await expect(page.getByRole("button", { name: "Open Task Cockpit" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Open Task Cockpit" }).click();
    const inspector = page.getByRole("complementary", {
      name: "Render an accessible empty task state",
    });
    const workflow = inspector
      .locator(".lr-inspector-section")
      .filter({ has: page.getByText("Workflow", { exact: true }) });
    await expect(workflow.getByText("Budget paused", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    await workflow.getByLabel("Hard token budget").fill("200");
    await workflow.getByRole("button", { name: "Approve cost policy" }).click();
    await expect(workflow.getByRole("heading", { name: "Acceptance package" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(inspector.getByRole("region", { name: "Independent review" })).toBeVisible();
    await expect(inspector.getByRole("region", { name: "Browser QA" })).toBeVisible();

    await page.getByRole("link", { name: "Guided demo" }).click();
    await expect(page.getByRole("button", { name: "Review and decide" })).toBeVisible();
    await page.getByRole("button", { name: "Review and decide" }).click();
    await workflow.getByRole("button", { name: "Accept delivery" }).click();
    await page.getByRole("link", { name: "Guided demo" }).click();
    await expect(page.getByRole("heading", { name: "Owner decision recorded" })).toBeVisible();

    await page.getByRole("button", { name: "Connect repository or provider" }).click();
    const settings = page.locator(".lr-dialog");
    await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible();
    await settings.locator(".lr-dialog__header button").click();
    await page.getByText("Read about Guided Launch", { exact: true }).click();
    await expect(page.getByText("not an active purchase flow", { exact: false })).toBeVisible();

    await chooseInSettings(page, "Change color theme", "Light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await chooseInSettings(page, "Change color theme", "Dark");
    await chooseInSettings(page, "Change language", "Русский");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("heading", { level: 1, name: "Пошаговое демо" })).toBeVisible();
    await expect(page.locator(".activation")).toHaveCSS("overflow-y", "visible");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Решение владельца записано" })).toBeVisible();
  });
});
