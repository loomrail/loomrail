import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "./provider-test-daemon.js";

let daemon: RunningDaemon | undefined;
let temporaryDirectory: string | undefined;

test.afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

const initializeWorkspace = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Initialize demo workspace" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled({ timeout: 20_000 });
};

const createWorkItem = async (
  page: Page,
  input: { title: string; type: "Epic" | "Task"; parent?: string },
): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByPlaceholder("What should the team deliver?").fill(input.title);
  await dialog.getByPlaceholder("Outcome, constraints, relevant files…").fill("Durable Beta work graph.");
  await dialog
    .getByPlaceholder("The owner can verify the delivered outcome…")
    .fill("The relationship survives a daemon restart.");
  await dialog.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: input.type, exact: true }).click();
  if (input.parent) {
    const parent = dialog.getByRole("combobox", { name: "Parent work item" });
    await expect(parent).toBeEnabled();
    await parent.click();
    await page.getByRole("option", { name: input.parent, exact: true }).click();
  }
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: input.title })).toBeVisible();
};

test("creates an Epic DAG, blocks a dependent start, and restores the exact graph after restart", async ({
  page,
}) => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail dependency e2e Юникод "));
  const stateDatabasePath = join(temporaryDirectory, "state with spaces.sqlite");
  daemon = await startDaemon({
    bootstrapToken: randomBytes(32).toString("base64url"),
    logger: false,
    stateDatabasePath,
    webRoot: resolve("apps/web/dist"),
  });
  await page.goto(daemon.bootstrapUrl);
  await initializeWorkspace(page);

  const epicTitle = "Beta delivery Epic";
  const firstTitle = "01 — prepare contract";
  const secondTitle = "02 — verify integration";
  await createWorkItem(page, { title: epicTitle, type: "Epic" });
  await createWorkItem(page, { title: firstTitle, type: "Task", parent: epicTitle });
  await createWorkItem(page, { title: secondTitle, type: "Task", parent: epicTitle });

  await page.getByRole("button", { name: secondTitle }).click();
  const inspector = page.getByRole("complementary", { name: secondTitle });
  const dependencySection = inspector
    .locator(".lr-inspector-section")
    .filter({ has: page.getByText("Structure and dependencies", { exact: true }) });
  await expect(dependencySection.getByText(epicTitle, { exact: true })).toBeVisible();
  await dependencySection.getByRole("button", { name: "Edit blockers" }).click();
  const dependencyDialog = page.getByRole("dialog", { name: "Edit blockers" });
  const blocker = dependencyDialog.getByRole("checkbox", { name: new RegExp(firstTitle) });
  await blocker.focus();
  await page.keyboard.press("Space");
  await expect(blocker).toBeChecked();
  await dependencyDialog.getByRole("button", { name: "Save blockers" }).click();
  await expect(dependencyDialog).toBeHidden();
  await expect(dependencySection.getByText(firstTitle, { exact: true })).toBeVisible();

  await inspector.getByRole("button", { name: "Move to Ready" }).click();
  const start = inspector.getByRole("button", { name: "Start workflow" });
  await expect(start).toBeDisabled();
  await expect(
    inspector.getByText("Finish every blocking work item before starting this workflow."),
  ).toBeVisible();

  await daemon.close();
  daemon = await startDaemon({
    bootstrapToken: randomBytes(32).toString("base64url"),
    logger: false,
    stateDatabasePath,
    webRoot: resolve("apps/web/dist"),
  });
  await page.goto(daemon.bootstrapUrl);
  await page.getByRole("button", { name: "All issues", exact: true }).click();
  await page.getByRole("button", { name: secondTitle }).click();
  const restoredInspector = page.getByRole("complementary", { name: secondTitle });
  const restoredDependencies = restoredInspector
    .locator(".lr-inspector-section")
    .filter({ has: page.getByText("Structure and dependencies", { exact: true }) });
  await expect(restoredDependencies.getByText(epicTitle, { exact: true })).toBeVisible();
  await expect(restoredDependencies.getByText(firstTitle, { exact: true })).toBeVisible();
  await expect(restoredInspector.getByRole("button", { name: "Start workflow" })).toBeDisabled();
  await expect(
    restoredInspector.getByText("Finish every blocking work item before starting this workflow."),
  ).toBeVisible();
});
