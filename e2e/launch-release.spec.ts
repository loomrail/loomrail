import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "./provider-test-daemon.js";

test.describe("release evidence", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("declares a public environment, freezes honest gates and downloads bounded evidence", async ({
    page,
  }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.addInitScript(() => {
      localStorage.setItem("loomrail-theme", "light");
    });
    await page.goto(daemon.bootstrapUrl);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "Initialize demo workspace" }).click();
    await expect(page.getByRole("button", { name: "Switch project" })).toContainText(
      "Fixture web application",
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: "Open settings" }).click();

    const release = page.getByRole("dialog", { name: "Settings" }).locator(".release-settings");
    await expect(release.getByRole("heading", { name: "Release evidence" })).toBeVisible();
    await expect(release).toContainText("Evidence, not deployment");
    await release.getByLabel("Environment name").fill("Recurkit Preview");
    await release.getByLabel("Public HTTPS origin").fill("https://preview.recurkit.example");
    await release.getByLabel("Public health path").fill("/health/ready");
    await release
      .getByLabel("Required variable names, one per line — never values")
      .fill("DATABASE_URL\nAUTH_SECRET");
    await release.getByRole("button", { name: "Save environment" }).click();

    await expect(release.getByRole("button", { name: "Update environment" })).toBeVisible();
    await release.getByRole("button", { name: "Create immutable snapshot" }).focus();
    await page.keyboard.press("Enter");
    await expect(release).toContainText("Required gates passed: 0 of 24");
    await expect(release).toContainText("Current snapshot");
    await expect(release).toContainText("Action required");

    const downloadPromise = page.waitForEvent("download");
    await release.getByRole("button", { name: "Download evidence package" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^loomrail-release-.+\.md$/u);
    const path = await download.path();
    const markdown = await readFile(path, "utf8");
    expect(markdown).toContain("# Loomrail Launch Evidence Package");
    expect(markdown).toContain("Required gates passed: 0 of 24");
    expect(markdown).toContain("https://preview\\.recurkit\\.example");
    expect(markdown).not.toContain("DATABASE_URL=");
    expect(markdown).not.toContain("OPENAI_API_KEY");

    await page
      .getByRole("group", { name: "Change color theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.setViewportSize({ width: 320, height: 760 });
    await expect(release.getByRole("heading", { name: "Release evidence" })).toBeVisible();
  });
});
