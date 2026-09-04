import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";
import type {
  ProjectProviderAllowanceResponse,
  ProviderAllowanceSnapshot,
} from "../packages/contracts/dist/index.js";
import { providerCapabilitiesSchema, type ProviderAdapter } from "../packages/provider-core/dist/index.js";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";
import { createProviderRegistry } from "../apps/daemon/dist/provider-selection.js";

let daemon: RunningDaemon | undefined;
type AllowanceFreshness = "LIVE" | "STALE" | "UNAVAILABLE";

test.afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const unavailable = (provider: "CODEX" | "CLAUDE_CODE" | "MOCK") => ({
  schemaVersion: 1 as const,
  provider,
  observedAt: "2026-09-04T18:00:00.000Z",
  freshness: "UNAVAILABLE" as const,
  buckets: [],
  unavailableReason: "PROVIDER_UNSUPPORTED" as const,
});

const durableCodexSnapshot: ProviderAllowanceSnapshot = {
  schemaVersion: 1,
  provider: "CODEX",
  observedAt: "2026-09-04T19:59:00.000Z",
  freshness: "LIVE",
  buckets: [
    {
      id: "codex:primary",
      name: "Codex",
      kind: "PRIMARY",
      usedPercent: 30,
      remainingPercent: 70,
      windowDurationMins: 300,
      resetsAt: "2026-09-05T00:00:00.000Z",
      limitReached: false,
    },
  ],
  unavailableReason: null,
};

const durableAllowanceRegistry = () => {
  const codex: ProviderAdapter = {
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "CODEX",
        start: true,
        interrupt: true,
        eventStream: true,
        usageReporting: true,
        contextWindowReporting: true,
        checkpointOnRequest: false,
        contextWindowTokens: 128_000,
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: false,
        canReportRateLimits: true,
      }),
    modelMapping: () => ({ FAST: "fast", STANDARD: "standard", DEEP: "deep" }),
    readAllowance: () => Promise.resolve(durableCodexSnapshot),
    start: () => Promise.reject(new Error("The allowance E2E never starts a provider session")),
    requestHandoff: () => Promise.resolve(),
    abortSession: () => Promise.resolve(),
  };
  return createProviderRegistry({
    env: {},
    adapters: { CODEX: codex },
    executableAvailable: (provider) => provider === "CODEX",
    probeCompatibility: (provider) =>
      Promise.resolve(
        provider === "CODEX"
          ? { compatibility: "VERIFIED" as const, version: "0.153.0-alpha.5" }
          : { compatibility: "UNVERIFIED" as const, version: "2.1.260" },
      ),
    probeAuthentication: () => Promise.resolve("AUTHENTICATED"),
    rateLimitVersionTargetVerified: (provider) => provider === "CODEX",
    probeRateLimitAuthenticationMode: () => Promise.resolve("CHATGPT"),
  });
};

const allowanceResponse = (
  projectId: string,
  freshness: AllowanceFreshness,
): ProjectProviderAllowanceResponse => {
  if (freshness === "UNAVAILABLE") {
    return {
      schemaVersion: 1,
      projectId,
      effectiveProvider: "MOCK",
      current: unavailable("MOCK"),
      advisory: { status: "UNKNOWN", deferUntil: null },
      providers: [unavailable("CODEX"), unavailable("CLAUDE_CODE")],
    };
  }
  const codex = {
    schemaVersion: 1 as const,
    provider: "CODEX" as const,
    observedAt: "2026-09-04T18:00:00.000Z",
    freshness,
    buckets: [
      {
        id: "primary",
        name: null,
        kind: "PRIMARY" as const,
        usedPercent: 38,
        remainingPercent: 62,
        windowDurationMins: 300,
        resetsAt: "2026-09-04T20:00:00.000Z",
        limitReached: false,
      },
      {
        id: "secondary",
        name: null,
        kind: "SECONDARY" as const,
        usedPercent: 71,
        remainingPercent: 29,
        windowDurationMins: 10_080,
        resetsAt: "2026-09-11T18:00:00.000Z",
        limitReached: false,
      },
    ],
    unavailableReason: null,
  };
  return {
    schemaVersion: 1,
    projectId,
    effectiveProvider: "CODEX",
    current: codex,
    advisory: { status: "LOW_CAPACITY", deferUntil: "2026-09-11T18:00:00.000Z" },
    providers: [codex, unavailable("CLAUDE_CODE")],
  };
};

const projectIdFrom = (route: Route): string => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/v1/provider/allowance") {
    return url.searchParams.get("projectId") ?? "project-web";
  }
  const match = /^\/api\/v1\/projects\/([^/]+)\/provider-allowance\/refresh$/.exec(url.pathname);
  return match?.[1] === undefined ? "project-web" : decodeURIComponent(match[1]);
};

const fulfillAllowance = async (route: Route, freshness: AllowanceFreshness): Promise<void> => {
  await route.fulfill({
    body: JSON.stringify(allowanceResponse(projectIdFrom(route), freshness)),
    contentType: "application/json",
    status: 200,
  });
};

const openWorkbench = async (page: Page): Promise<void> => {
  daemon = await startDaemon({
    bootstrapToken: randomBytes(32).toString("base64url"),
    logger: false,
    webRoot: resolve("apps/web/dist"),
  });
  await page.goto(daemon.bootstrapUrl);
  const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
  await initialize.click();
  await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible({ timeout: 20_000 });
};

const createTask = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog
    .getByPlaceholder("Outcome, constraints, relevant files…")
    .fill("Show provider allowance separately from the Loomrail budget.");
  await dialog
    .getByPlaceholder("The owner can verify the delivered outcome…")
    .fill("Remaining, reset, freshness and hard budget are visibly distinct.");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
};

test.describe("provider allowance product surface", () => {
  test("shares live and stale readings across Command Center and Task Cockpit", async ({ page }) => {
    let freshness: AllowanceFreshness = "LIVE";
    await page.route("**/api/v1/provider/allowance?*", async (route) => fulfillAllowance(route, freshness));
    await page.route("**/api/v1/projects/*/provider-allowance/refresh", async (route) => {
      freshness = "STALE";
      await fulfillAllowance(route, freshness);
    });
    await openWorkbench(page);
    await createTask(page, "Provider allowance surface");

    const command = page.getByRole("region", {
      name: "Codex provider allowance in Command Center",
    });
    const inspector = page.getByRole("complementary", { name: "Provider allowance surface" });
    const cockpit = inspector.getByRole("region", {
      name: "Codex provider allowance in Task Cockpit",
    });
    await expect(command.getByText("62% remaining", { exact: true })).toBeVisible();
    await expect(command.getByText("29% remaining", { exact: true })).toBeVisible();
    await expect(cockpit.getByText("Live", { exact: true })).toBeVisible();

    const visualQaDirectory = process.env["LOOMRAIL_VISUAL_QA_DIR"];
    if (visualQaDirectory !== undefined) {
      await page.screenshot({ path: resolve(visualQaDirectory, "provider-allowance-light.png") });
    }

    await cockpit.getByText("Usage details", { exact: true }).first().click();
    await expect(cockpit.getByText("38% used", { exact: false })).toBeVisible();

    const refresh = command.getByRole("button", { name: "Check again" });
    await refresh.focus();
    await refresh.press("Enter");
    await expect(command.getByText("Stale", { exact: true })).toBeVisible();
    await expect(cockpit.getByText("Stale", { exact: true })).toBeVisible();

    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await inspector.getByRole("button", { name: "Start workflow" }).click();
    await expect(inspector.getByText("Hard budget", { exact: true })).toBeVisible();
    await expect(cockpit.getByText("Hard budget", { exact: true })).toHaveCount(0);

    await page.evaluate(() => {
      localStorage.setItem("loomrail.locale", "ru");
      localStorage.setItem("loomrail-theme", "dark");
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByText("62% осталось", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Устарело", { exact: true }).first()).toBeVisible();

    if (visualQaDirectory !== undefined) {
      await page.screenshot({ path: resolve(visualQaDirectory, "provider-allowance-dark.png") });
    }

    await page.setViewportSize({ width: 320, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    if (visualQaDirectory !== undefined) {
      await page.screenshot({
        fullPage: true,
        path: resolve(visualQaDirectory, "provider-allowance-narrow.png"),
      });
    }
  });

  test("shows unavailable as unknown capacity, never as zero remaining", async ({ page }) => {
    await page.route("**/api/v1/provider/allowance?*", async (route) =>
      fulfillAllowance(route, "UNAVAILABLE"),
    );
    await page.route("**/api/v1/projects/*/provider-allowance/refresh", async (route) =>
      fulfillAllowance(route, "UNAVAILABLE"),
    );
    await openWorkbench(page);

    const command = page.getByRole("region", {
      name: "Mock provider allowance in Command Center",
    });
    await expect(command.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(command.getByText("This provider does not expose an allowance signal.")).toBeVisible();
    await expect(command.getByText("0% remaining", { exact: true })).toHaveCount(0);
    await expect(command.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  test("reconstructs a persisted allowance as stale after a daemon restart", async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail allowance browser restart "));
    const databasePath = join(directory, "state.sqlite");
    let now = new Date("2026-09-04T20:00:00.000Z");
    try {
      daemon = await startDaemon({
        bootstrapToken: randomBytes(32).toString("base64url"),
        logger: false,
        now: () => new Date(now),
        providerRegistry: durableAllowanceRegistry(),
        stateDatabasePath: databasePath,
        webRoot: resolve("apps/web/dist"),
      });
      await page.goto(daemon.bootstrapUrl);
      await page.getByRole("button", { name: "Initialize demo workspace" }).click();
      await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "Switch project" }).click();
      await page.getByRole("menuitem", { name: "Fixture web application" }).click();
      const liveStrip = page.getByRole("region", {
        name: "Codex provider allowance in Command Center",
      });
      await liveStrip.getByRole("button", { name: "Check again" }).click();
      await expect(liveStrip.getByText("70% remaining", { exact: true })).toBeVisible();
      await expect(liveStrip.getByText("Live", { exact: true })).toBeVisible();

      await daemon.close();
      daemon = undefined;
      now = new Date("2026-09-04T20:20:00.000Z");
      daemon = await startDaemon({
        bootstrapToken: randomBytes(32).toString("base64url"),
        logger: false,
        now: () => new Date(now),
        providerRegistry: durableAllowanceRegistry(),
        stateDatabasePath: databasePath,
        webRoot: resolve("apps/web/dist"),
      });
      await page.goto(daemon.bootstrapUrl);
      await page.getByRole("button", { name: "Switch project" }).click();
      await page.getByRole("menuitem", { name: "Fixture web application" }).click();
      const restoredStrip = page.getByRole("region", {
        name: "Codex provider allowance in Command Center",
      });
      await expect(restoredStrip.getByText("70% remaining", { exact: true })).toBeVisible();
      await expect(restoredStrip.getByText("Stale", { exact: true })).toBeVisible();
    } finally {
      await daemon?.close();
      daemon = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
