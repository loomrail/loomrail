import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "./provider-test-daemon.js";

test.describe("local launch measurement", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("approves an exact local service and renders all six measured gates", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
    await expect(initialize).toBeVisible();
    await initialize.click();
    await expect(page.getByRole("button", { name: "Switch project" })).toContainText(
      "Fixture web application",
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: "Open settings" }).click();

    const settings = page.getByRole("dialog", { name: "Settings" });
    const verification = settings.locator(".verification-settings");
    await expect(verification).toContainText("Start service");
    await verification.getByRole("button", { name: /Approve Plan/ }).click();
    await expect(verification).toContainText("Published to .loomrail/verification-plan.json");

    const launch = settings.locator(".launch-settings:not(.release-settings)");
    await expect(launch.getByRole("heading", { name: "Local launch gates" })).toBeVisible();
    const serviceCommand = launch.getByLabel("Local service command");
    await expect(serviceCommand).toHaveValue("package-start");
    await expect(serviceCommand).toContainText("Start service: npm run start");
    await launch.getByLabel("Loopback origin").fill("http://127.0.0.1:4173");
    await launch.getByLabel("Health path").fill("/health");
    await launch.getByLabel("Private paths, one per line").fill("");
    await launch.getByRole("button", { name: "Approve launch gates" }).click();

    await expect(launch).toContainText("Active revision 1");
    await launch.getByRole("button", { name: "Run local measurement" }).click();
    await expect(launch).toContainText("Measurement running");
    await expect(launch).toContainText("Launch action required", { timeout: 60_000 });
    await expect(launch.locator(".launch-gates > li")).toHaveCount(6);
    await expect(launch).toContainText("Web Vitals");
    await expect(launch).toContainText("Response headers");
    await expect(launch).toContainText("Client bundle secret scan");
    await expect(launch).toContainText("No current-tree audit evidence");
    await expect(launch).toContainText("Current evidence");

    await settings
      .getByRole("group", { name: "Change language" })
      .getByRole("button", { name: "Русский" })
      .click();
    await expect(page.locator(".launch-settings:not(.release-settings)")).toContainText(
      "Локальные launch-gates",
    );
    await expect(page.locator(".launch-settings:not(.release-settings)")).toContainText(
      "Только локальное измерение",
    );
  });
});
