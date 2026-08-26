import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

/**
 * Spec D5: a StageAttempt is the unit of work and a ProviderSession is the unit of execution, and
 * the cockpit must show sessions nested inside their attempt. What shipped shows a bare "Sessions"
 * heading with no attempt identity above it -- ordinal or status -- so the owner cannot tell which
 * attempt the list belongs to. This is invisible with only one attempt on screen (today's only
 * case), which is exactly why it needs its own proof rather than relying on the existing suite.
 *
 * A new file, not an addition to walking-skeleton.spec.ts: that file is held by a concurrent
 * session's in-flight edits.
 */

const initializeWorkspace = async (page: Page): Promise<void> => {
  const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
  await expect(initialize).toBeVisible();
  await initialize.click();
  await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();
};

const createTask = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  const submit = dialog.getByRole("button", { name: "Create task" });
  await expect(submit).toBeDisabled();
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog.getByPlaceholder("Outcome, constraints, relevant files…").fill("Exercises the attempt header.");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
};

test.describe("attempt nesting", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("names the attempt its sessions are nested inside, by ordinal and status", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Attempt header task");

    const inspector = page.getByRole("complementary", { name: "Attempt header task" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByRole("button", { name: "Start mock workflow" })).toBeEnabled();
    await inspector.getByRole("button", { name: "Start mock workflow" }).click();

    // The mock pipeline's first ProviderSession has ended by the time this human decision surfaces
    // -- the earliest point the sessions list (and so its attempt header) is guaranteed to render.
    await expect(inspector.getByRole("heading", { name: "Choose the discovery depth" })).toBeVisible();

    const workflowSection = inspector
      .locator(".lr-inspector-section")
      .filter({ has: page.getByText("Workflow", { exact: true }) });
    const sessionsPanel = workflowSection.locator(".lr-session-timeline-panel");
    await expect(sessionsPanel.getByRole("listitem", { name: "Session 1" })).toBeVisible();

    // D5's fix: the header identifying the attempt -- its ordinal and its status -- sits above the
    // sessions list, not just a bare "Sessions" heading.
    const attemptHeader = sessionsPanel.locator(".lr-session-timeline__row").first();
    await expect(attemptHeader.getByText("Attempt 1", { exact: true })).toBeVisible();
    await expect(attemptHeader.locator(".lr-status")).toBeVisible();
  });
});
