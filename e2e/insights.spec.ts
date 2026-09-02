import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

test.describe("private Insights and one-shot reporting", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("previews and downloads the exact anonymous payload without external telemetry", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      productVersion: "0.1.0-alpha.5",
      webRoot: resolve("apps/web/dist"),
    });
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== new URL(daemon?.baseUrl ?? request.url()).origin) {
        externalRequests.push(request.url());
      }
    });

    await page.goto(daemon.bootstrapUrl);
    await page.getByRole("link", { name: "Insights" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Insights" })).toBeVisible();
    await expect(page.getByText("Local only", { exact: true })).toBeVisible();
    await expect(page.getByText("No crash report is available", { exact: false })).toBeVisible();

    const preview = page.getByLabel("Exact report payload");
    await expect(preview).toContainText('"kind": "AGGREGATE"');
    await expect(preview).toContainText('"productVersion": "0.1.0-alpha.5"');
    const previewText = await preview.textContent();
    expect(previewText).not.toMatch(/projectId|repositoryPath|generatedAt|message|stack|prompt|artifact/);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download this JSON" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("loomrail-aggregate-report.json");
    const path = await download.path();
    expect(await readFile(path, "utf8")).toBe(previewText);
    expect(externalRequests).toEqual([]);
  });
});
