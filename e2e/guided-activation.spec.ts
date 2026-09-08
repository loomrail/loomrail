import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { passingBrowserQADriver } from "../apps/daemon/test/browser-qa-fixture.js";
import { createProviderTestDouble } from "../apps/daemon/test/provider-double.js";
import { createProviderRegistry } from "../apps/daemon/dist/provider-selection.js";
import type { ProviderAdapter } from "../packages/provider-core/dist/index.js";
import { startDaemon, type RunningDaemon } from "./provider-test-daemon.js";

const guidedUrl = (bootstrapUrl: string): string => {
  const url = new URL(bootstrapUrl);
  url.pathname = "/try";
  return url.toString();
};

const providerContractRegistry = (readyProvider: "CODEX" | "CLAUDE_CODE" | null = "CODEX") => {
  const adapter = createProviderTestDouble();
  const capabilities = adapter.capabilities();
  const boundedAdapter: ProviderAdapter = {
    ...adapter,
    capabilities: () => ({
      ...capabilities,
      stages: ["DISCOVERY", "PLAN", "REVIEW", "ACCEPTANCE"],
    }),
  };
  return createProviderRegistry({
    env: {},
    adapters: {
      CODEX: boundedAdapter,
      CLAUDE_CODE: boundedAdapter,
    },
    probeAuthentication: (provider) =>
      Promise.resolve(provider === readyProvider ? "AUTHENTICATED" : "REQUIRED"),
    probeRuntime: (provider) =>
      Promise.resolve({
        installed: provider === readyProvider,
        compatibility: provider === readyProvider ? "VERIFIED" : "MISSING",
        version: provider === readyProvider ? (provider === "CODEX" ? "0.153.4" : "2.1.260") : null,
      }),
  });
};

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

  test("stops at the explicit executor gate after supported provider stages", async ({ page }) => {
    dataDirectory = await mkdtemp(join(tmpdir(), "loomrail guided activation "));
    const databasePath = join(dataDirectory, "state.sqlite");
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      browserQADriver: passingBrowserQADriver(),
      logger: false,
      providerRegistry: providerContractRegistry(),
      stateDatabasePath: databasePath,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(guidedUrl(daemon.bootstrapUrl));
    await expect(page).toHaveURL(/\/try$/);
    await expect(page.getByRole("heading", { level: 1, name: "Guided demo" })).toBeVisible();
    await expect(
      page.getByText(
        "Local agent only — no API key or separate API billing. Subscription usage is reported after each CLI session.",
      ),
    ).toBeVisible();
    const progress = page.getByRole("navigation", { name: "Guided demo progress" });
    await expect(progress.getByText("Human Request and provider result", { exact: true })).toBeVisible();
    await expect(progress.getByText("Independent review after execution", { exact: true })).toBeVisible();
    await expect(progress.getByText("Measured Browser QA after execution", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);

    const prepare = page.getByRole("button", { name: "Prepare demo workspace" });
    await prepare.focus();
    await expect(prepare).toBeFocused();
    await prepare.press("Enter");
    await expect(page.getByRole("button", { name: "Create guided task" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Create guided task" }).click();
    await expect(page).toHaveURL(/\/try\?task=/);
    await page.getByText("What this run will do", { exact: true }).click();
    await expect(page.getByText("An empty input renders exactly one visible status message")).toBeVisible();
    await expect(page.getByText("64,000", { exact: true })).toHaveCount(1);
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
      providerRegistry: providerContractRegistry(),
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

    await expect(page.getByRole("button", { name: "Answer in Attention" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Answer in Attention" }).click();
    await expect(page.getByRole("heading", { name: "CODEX cannot serve IMPLEMENT" })).toBeVisible();
    await expect(
      page.getByText(/declares only these stages: DISCOVERY, PLAN, REVIEW, ACCEPTANCE/),
    ).toBeVisible();
    await page.getByRole("link", { name: "Guided demo" }).click();
    await expect(page.getByRole("heading", { name: "Human Request and provider result" })).toBeVisible();

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
    await expect(page.getByRole("heading", { name: "Human Request и результат провайдера" })).toBeVisible();
  });

  test("recovers a stale unavailable provider preference through Auto", async ({ page }) => {
    dataDirectory = await mkdtemp(join(tmpdir(), "loomrail guided provider recovery "));
    const databasePath = join(dataDirectory, "state.sqlite");
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      browserQADriver: passingBrowserQADriver(),
      logger: false,
      providerRegistry: providerContractRegistry(null),
      stateDatabasePath: databasePath,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(guidedUrl(daemon.bootstrapUrl));
    await page.getByRole("button", { name: "Prepare demo workspace" }).click();
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const selector = settings.getByRole("combobox", { name: "Provider for new sessions" });
    await selector.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(selector).toContainText("Codex CLI");
    await settings.getByRole("button", { name: "Close dialog" }).click();

    await daemon.close();
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      browserQADriver: passingBrowserQADriver(),
      logger: false,
      providerRegistry: providerContractRegistry("CLAUDE_CODE"),
      stateDatabasePath: databasePath,
      webRoot: resolve("apps/web/dist"),
    });
    await page.goto(guidedUrl(daemon.bootstrapUrl));

    const recover = page.getByRole("button", { name: "Use available local CLI" });
    await expect(recover).toBeVisible();
    await recover.click();
    await expect(page.getByRole("button", { name: "Create guided task" })).toBeVisible();
  });
});
