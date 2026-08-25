import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";
import { openLocalState } from "../packages/persistence-sqlite/dist/index.js";

/**
 * Writes a task carrying more activity than a single page holds. Driving forty moves through the
 * board would dominate the run, and the point under test is what the inspector does with a long
 * log, not how the log came to be long.
 */
const seedLongActivity = async (databasePath: string, title: string): Promise<number> => {
  let nextId = 0;
  const localState = await openLocalState({
    databasePath,
    now: () => new Date("2026-08-22T18:00:00.000Z"),
    createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
  });
  try {
    localState.execute({
      schemaVersion: 1,
      commandId: "seed-register-project",
      correlationId: "correlation-seed-register-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_FIXTURE_PROJECT",
      payload: {
        id: "project-web",
        fixtureId: "web-app-a",
        name: "Fixture web application",
        repositoryPath: resolve("fixtures/projects/web-app-a"),
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: "seed-create-work-item",
      correlationId: "correlation-seed-create-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-web",
        parentId: null,
        type: "TASK",
        title,
        description: "Seeded with a long audit trail.",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: [],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("The seeded WorkItem was not created");

    let version = created.workItem.version;
    for (let move = 0; move < 40; move += 1) {
      const moved = localState.execute({
        schemaVersion: 1,
        commandId: `seed-move-${move.toString()}`,
        correlationId: `correlation-seed-move-${move.toString()}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: version,
          targetState: move % 2 === 0 ? "READY" : "BACKLOG",
        },
      });
      if (moved.type !== "WORK_ITEM_MOVED") throw new Error("The seeded WorkItem was not moved");
      version = moved.workItem.version;
    }
    // One creation plus forty moves.
    return 41;
  } finally {
    localState.close();
  }
};

const initializeWorkspace = async (page: Page): Promise<void> => {
  const initialize = page.getByRole("button", { name: "Initialize demo workspace" });
  await expect(initialize).toBeVisible();
  await initialize.click();
  await expect(page.getByRole("button", { name: "Switch project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();
};

const createTask = async (
  page: Page,
  title: string,
  description = "Persisted through the authenticated local API.",
): Promise<void> => {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  const submit = dialog.getByRole("button", { name: "Create task" });
  await expect(submit).toBeDisabled();
  await dialog.getByPlaceholder("What should the team deliver?").fill(title);
  await dialog.getByPlaceholder("Outcome, constraints, relevant files…").fill(description);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
};

/**
 * Changes one preference through the settings dialog.
 *
 * The dialog is located by class rather than by accessible name: choosing a language renames it
 * mid-flight, and a name-based locator would report the still-open dialog as hidden while it is
 * covering the page.
 */
/**
 * Picks one preference in the settings dialog.
 *
 * The dialog is located by class rather than by accessible name: choosing a language renames it
 * mid-flight, and a name-based locator would report the still-open dialog as hidden while it is
 * covering the page. The close control is used for the same reason.
 */
const chooseInSettings = async (page: Page, control: string, option: string): Promise<void> => {
  const settings = page.locator(".lr-dialog");
  await page.getByRole("button", { name: /Open settings|Открыть настройки/ }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("group", { name: control }).getByRole("button", { name: option }).click();
  await settings.locator(".lr-dialog__header button").click();
  await expect(settings).toHaveCount(0);
};

test.describe("authenticated walking skeleton", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("opens a real persisted workbench and preserves local preferences", async ({ page }) => {
    const bootstrapToken = randomBytes(32).toString("base64url");
    const requestedUrls: string[] = [];
    page.on("request", (request) => {
      requestedUrls.push(request.url());
    });
    daemon = await startDaemon({
      bootstrapToken,
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);

    await expect(page.getByRole("heading", { level: 1, name: "Current work" })).toBeVisible();
    await expect(page.getByText("No local projects yet", { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/bootstrap=/);
    expect(requestedUrls.every((url) => !url.includes(bootstrapToken))).toBe(true);
    expect(await page.evaluate<string>("window.location.hash")).toBe("");
    expect(await page.evaluate<string>("document.referrer")).not.toContain(bootstrapToken);

    const viewport = page.viewportSize();
    const appSurfaceBox = await page.locator(".app-surface").boundingBox();
    expect(viewport).not.toBeNull();
    expect(appSurfaceBox).not.toBeNull();
    if (viewport && appSurfaceBox) {
      expect(appSurfaceBox.y).toBe(8);
      expect(viewport.width - (appSurfaceBox.x + appSurfaceBox.width)).toBe(8);
      expect(viewport.height - (appSurfaceBox.y + appSurfaceBox.height)).toBe(8);
    }

    await initializeWorkspace(page);
    await createTask(page, "Persisted browser task");

    const task = page.getByRole("button", { name: "Persisted browser task" });
    const card = task.locator(".lr-task-card");
    await expect(task).toHaveAttribute("aria-pressed", "true");
    await expect(card).toHaveClass(/is-selected/);
    await expect(card).toHaveCSS("box-shadow", /0px 0px 0px 1px/);
    const initialInspector = page.getByRole("complementary", { name: "Persisted browser task" });
    await expect(
      initialInspector.getByRole("heading", { level: 2, name: "Persisted browser task" }),
    ).toBeVisible();
    await expect(initialInspector.getByText("Backlog", { exact: true })).toBeVisible();

    await initialInspector.getByRole("button", { name: "Edit task" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit task" });
    await editDialog.locator("#edit-task-title").fill("Edited persisted browser task");
    await editDialog.locator("#edit-task-description").fill("Updated through the persisted PATCH command.");
    await editDialog
      .locator("#edit-work-item-criteria")
      .fill("The edit survives reload\nThe event is auditable");
    await editDialog.getByRole("combobox", { name: "Priority" }).click();
    await page.getByRole("option", { name: "High" }).click();
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(editDialog).toBeHidden();

    const inspector = page.getByRole("complementary", { name: "Edited persisted browser task" });
    await expect(page.getByRole("button", { name: "Edited persisted browser task" })).toBeVisible();
    await expect(inspector.getByText("Updated through the persisted PATCH command.")).toBeVisible();
    await expect(inspector.getByText("The edit survives reload")).toBeVisible();
    await expect(inspector.getByText("Task updated", { exact: true })).toBeVisible();
    await expect(
      inspector.getByText(/Changed title, description, priority, acceptance criteria/),
    ).toBeVisible();

    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByText("Ready", { exact: true })).toBeVisible();
    await expect(inspector.getByText("State changed", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Backlog → Ready", { exact: true })).toBeVisible();

    await chooseInSettings(page, "Change color theme", "Dark");
    await chooseInSettings(page, "Change language", "Русский");
    await expect(page.getByRole("heading", { level: 1, name: "Текущая работа" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("heading", { level: 1, name: "Текущая работа" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edited persisted browser task" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Components" })).toHaveCount(0);
  });

  test("keeps the application frame stable while the workspace is loading", async ({ page }) => {
    const bootstrapToken = randomBytes(32).toString("base64url");
    let releaseStatus: (() => void) | undefined;
    const statusBlocked = new Promise<void>((resolveStatus) => {
      releaseStatus = resolveStatus;
    });
    daemon = await startDaemon({
      bootstrapToken,
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });
    await page.route("**/api/v1/status", async (route) => {
      await statusBlocked;
      await route.continue();
    });

    await page.goto(daemon.bootstrapUrl, { waitUntil: "domcontentloaded" });
    const surface = page.locator(".app-surface");
    await expect(surface).toBeVisible();
    await expect(page.locator(".app-sidebar nav:visible")).toHaveCount(0);
    await expect(page.locator(".app-topbar")).toBeHidden();
    const loadingMark = surface.locator(".app-brand-mark");
    await expect(loadingMark).toBeVisible();
    await expect(loadingMark).toHaveAttribute("height", "40");
    await expect(surface.getByRole("status", { name: "Connecting…" })).toBeVisible();
    expect(
      await surface.locator(".app-loading-mark").evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style.animationName === "app-loading-mark" && style.animationDuration === "1.4s";
      }),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await surface.locator(".app-loading-mark").evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style.animationName === "none" && style.opacity === "1" && style.transform === "none";
      }),
    ).toBe(true);
    const initialDocument = await page.request.get(new URL("/", daemon.bootstrapUrl).toString());
    const initialMarkup = await initialDocument.text();
    expect(initialMarkup).not.toContain("Starting Loomrail");
    expect(initialMarkup).toContain('class="app-shell app-shell--loading"');
    expect(initialMarkup).toContain('lang="ru">Подключение…');
    const loadingBox = await surface.boundingBox();

    releaseStatus?.();
    await expect(page.getByRole("heading", { level: 1, name: "Current work" })).toBeVisible();
    const loadedBox = await surface.boundingBox();
    expect(loadingBox).not.toBeNull();
    expect(loadedBox).not.toBeNull();
    if (loadingBox && loadedBox) {
      expect(Math.abs(loadingBox.x - loadedBox.x)).toBeLessThan(0.1);
      expect(Math.abs(loadingBox.y - loadedBox.y)).toBeLessThan(0.1);
      expect(Math.abs(loadingBox.width - loadedBox.width)).toBeLessThan(0.1);
      expect(Math.abs(loadingBox.height - loadedBox.height)).toBeLessThan(0.1);
    }
  });

  test("reserves inspector workflow and activity space while their data loads", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Stable inspector loading");

    let releaseWorkflow: (() => void) | undefined;
    let releaseEvents: (() => void) | undefined;
    const workflowBlocked = new Promise<void>((resolveWorkflow) => {
      releaseWorkflow = resolveWorkflow;
    });
    const eventsBlocked = new Promise<void>((resolveEvents) => {
      releaseEvents = resolveEvents;
    });
    await page.route("**/api/v1/work-items/*/workflow", async (route) => {
      await workflowBlocked;
      await route.continue();
    });
    await page.route(/\/api\/v1\/events\?/, async (route) => {
      await eventsBlocked;
      await route.continue();
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    const inspector = page.getByRole("complementary", { name: "Stable inspector loading" });
    const workflowSkeleton = inspector.getByRole("status", { name: "Loading workflow…" });
    const activitySkeleton = inspector.getByRole("status", { name: "Loading activity…" });
    await expect(workflowSkeleton).toBeVisible();
    await expect(activitySkeleton).toBeVisible();
    expect((await workflowSkeleton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(120);
    expect((await activitySkeleton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(90);
    await expect(inspector.getByText("Loading workflow…", { exact: true })).toHaveCount(0);
    await expect(inspector.getByText("Loading activity…", { exact: true })).toHaveCount(0);

    releaseWorkflow?.();
    releaseEvents?.();
    await expect(workflowSkeleton).toBeHidden();
    await expect(activitySkeleton).toBeHidden();
    await expect(inspector.getByText("Move this task to Ready before starting its workflow.")).toBeVisible();
  });

  test("keeps localized inspector actions inside the inspector", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Localized inspector actions");
    await chooseInSettings(page, "Change language", "Русский");

    const inspector = page.getByRole("complementary", { name: "Localized inspector actions" });
    const inspectorTitle = inspector.getByRole("heading", { name: "Localized inspector actions" });
    expect(await inspectorTitle.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await inspector.getByRole("button", { name: "Редактировать задачу" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Редактировать задачу");
    await expect(page.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");
    // A visible tooltip is a label, not a target: it must not intercept clicks beneath it.
    await expect(page.getByRole("tooltip")).toHaveCSS("pointer-events", "none");
    await expect(inspector.getByRole("button", { name: "Редактировать задачу" })).not.toHaveAttribute(
      "title",
    );
    await page.mouse.move(0, 0);
    const footer = inspector.locator(".task-inspector__footer");
    const footerBox = await footer.boundingBox();
    const actionBoxes = await footer.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
    expect(footerBox).not.toBeNull();
    if (footerBox) {
      expect(
        actionBoxes.every(({ left, right }) => left >= footerBox.x && right <= footerBox.x + footerBox.width),
      ).toBe(true);
    }
    expect(await footer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await page.getByRole("button", { name: "Настройки отображения" }).click();
    const ordering = page.getByRole("combobox", { name: "Сортировать задачи по" });
    await ordering.click();
    const updated = page.getByRole("option", { name: "Обновлено" });
    expect(
      await updated
        .locator(".lr-select-item__copy > span")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  });

  test("offers both languages in settings and marks the active one", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const languages = settings.getByRole("group", { name: "Change language" });

    await expect(languages.getByRole("button")).toHaveCount(2);
    await expect(languages.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    // Neither label may be clipped by the tile that holds it.
    for (const name of ["English", "Русский"]) {
      const label = languages.getByRole("button", { name }).locator("span");
      expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  });

  test("filters the board to blocking requests and back from the workspace navigation", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Quick filter task");

    // Human requests is the only quick filter the product still offers.
    await page.getByRole("link", { name: "Human requests" }).click();
    await expect(page).toHaveURL(/summary=needsYou/);

    const appliedFilters = page.getByRole("region", { name: "Filter tasks" });
    await expect(appliedFilters.getByText("Quick filter", { exact: true })).toBeVisible();
    await expect(appliedFilters.getByText("Needs you", { exact: true })).toBeVisible();
    // Nothing is blocking, so the task the test just created must be filtered out.
    await expect(page.getByRole("button", { name: "Quick filter task" })).toHaveCount(0);

    await page.reload();
    await expect(appliedFilters.getByText("Needs you", { exact: true })).toBeVisible();

    await appliedFilters.getByRole("button", { name: "Clear quick filter" }).click();
    await expect(page).not.toHaveURL(/summary=/);
    await expect(page.getByRole("button", { name: "Quick filter task" })).toBeVisible();
  });

  test("filters the board by risk", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Medium risk task");

    // Risk is a real WorkItem field, so it belongs in the filter tree rather than behind a
    // metric chip that mixed it with delivery state.
    await page.getByRole("button", { name: "Filter tasks" }).first().click();
    await page.locator(".lr-filter-popover").getByRole("menuitem", { name: "Risk" }).hover();
    await expect(page.getByRole("menu", { name: "Risk options" })).toBeVisible();
    await page.getByRole("button", { name: "Add Critical" }).click();
    await expect(page).toHaveURL(/filters=risk-critical/);
    await expect(page.getByRole("button", { name: "Medium risk task" })).toHaveCount(0);

    // The filter popover stays open after adding a value and would cover the applied-filter bar.
    await page.keyboard.press("Escape");
    await expect(page.locator(".lr-filter-popover")).toBeHidden();
    await page.getByRole("region", { name: "Filter tasks" }).getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Medium risk task" })).toBeVisible();
  });

  test("isolates board scrolling from the inspector on compact screens", async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 720 });
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Compact screen task");
    const workbench = page.locator(".workbench");
    const board = page.locator(".workbench-board");
    const columns = page.locator(".kanban-board-scroll");
    const inspector = page.getByRole("complementary", { name: "Compact screen task" });

    expect(await workbench.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    // The column row absorbs the horizontal overflow so the toolbar and heading never scroll away.
    expect(await columns.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await board.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true);
    await inspector.scrollIntoViewIfNeeded();
    const surfaceBox = await page.locator(".app-surface").boundingBox();
    const inspectorBox = await inspector.boundingBox();
    expect(surfaceBox).not.toBeNull();
    expect(inspectorBox).not.toBeNull();
    if (surfaceBox && inspectorBox) {
      expect(inspectorBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
      expect(inspectorBox.x + inspectorBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("explains how to recover when the local daemon becomes unavailable", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Recovery guidance task");

    const stoppedDaemon = daemon;
    daemon = undefined;
    await stoppedDaemon.close();

    const inspector = page.getByRole("complementary", { name: "Recovery guidance task" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByText("Loomrail is temporarily unreachable", { exact: true })).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("renders persisted WorkItem text as inert content", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    const title = '<img src=x onerror="window.__loomrailXss = true">';
    await createTask(page, title, "<script>window.__loomrailXss = true</script>");

    await expect(page.getByRole("button", { name: title })).toBeVisible();
    expect(await page.evaluate<boolean>("Boolean(window.__loomrailXss)")).toBe(false);
    await page.reload();
    await expect(page.getByRole("button", { name: title })).toBeVisible();
    expect(await page.evaluate<boolean>("Boolean(window.__loomrailXss)")).toBe(false);
  });

  test("persists the full mock delivery and gates Done on owner acceptance", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Human decision workflow");
    const inspector = page.getByRole("complementary", { name: "Human decision workflow" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await expect(inspector.getByRole("button", { name: "Start mock workflow" })).toBeEnabled();
    await inspector.getByRole("button", { name: "Start mock workflow" }).click();

    await expect(inspector.getByRole("heading", { name: "Choose the discovery depth" })).toBeVisible();
    await expect(inspector.getByText("Waiting for you", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Needs your decision/ })).toBeVisible();

    await page.goto(new URL("/?filters=priority-urgent", daemon.baseUrl).toString());
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toHaveCount(0);
    const filteredAttentionBanner = page.getByRole("button", { name: /Needs your decision/ });
    await expect(filteredAttentionBanner).toBeVisible();
    await filteredAttentionBanner.click();
    await expect(page).not.toHaveURL(/filters=/);
    await expect(page.getByRole("complementary", { name: "Human decision workflow" })).toBeVisible();

    await page.reload();
    const restoredInspector = page.getByRole("complementary", { name: "Human decision workflow" });
    await expect(
      restoredInspector.getByRole("heading", { name: "Choose the discovery depth" }),
    ).toBeVisible();

    await restoredInspector.getByRole("radio", { name: /Focused pass/ }).click();
    await restoredInspector.getByRole("button", { name: "Answer & resume" }).click();
    const workflowSection = restoredInspector
      .locator(".lr-inspector-section")
      .filter({ has: page.getByText("Workflow", { exact: true }) });
    await expect(workflowSection.getByText("Budget paused", { exact: true }).first()).toBeVisible();
    await expect(workflowSection.getByText("100 of 100", { exact: true })).toBeVisible();
    await expect(workflowSection.getByRole("button", { name: "Approve 200 token budget" })).toBeEnabled();
    await workflowSection.getByRole("button", { name: "Approve 200 token budget" }).click();
    await expect(workflowSection.getByText("100 of 200", { exact: true })).toBeVisible();
    await expect(workflowSection.getByRole("heading", { name: "Acceptance package" })).toBeVisible();
    await expect(workflowSection.getByText("Review report", { exact: true })).toBeVisible();
    await expect(workflowSection.getByText("QA report", { exact: true })).toBeVisible();
    await expect(workflowSection.getByText("Needs decision", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Needs your decision/ })).toBeVisible();
    await expect(restoredInspector.getByText("Decision recorded", { exact: true })).toBeVisible();
    const acceptanceResponsePromise = page.waitForResponse(
      (response) => response.url().includes("/acceptance/") && response.url().endsWith("/resolve"),
    );
    await workflowSection.getByRole("button", { name: "Accept delivery" }).click();
    const acceptanceResponse = await acceptanceResponsePromise;
    expect(acceptanceResponse.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Needs your decision/ })).toHaveCount(0);

    // Accepted work leaves the active board, so "All issues" has to be able to show it again.
    await page.getByRole("button", { name: "All issues", exact: true }).click();
    await expect(page).toHaveURL(/scope=all/);
    const doneColumn = page
      .locator(".lr-kanban-column")
      .filter({ has: page.getByText("Done", { exact: true }) });
    await expect(doneColumn.getByRole("button", { name: "Human decision workflow" })).toBeVisible();

    // The scope survives a reload and the summary keeps describing live work only.
    await page.reload();
    await expect(page.getByRole("button", { name: "All issues", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toBeVisible();

    await page.getByRole("button", { name: "Backlog", exact: true }).click();
    await expect(page).toHaveURL(/scope=backlog/);
    await expect(page.locator(".lr-kanban-column")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Human decision workflow" })).toHaveCount(0);
  });

  test("keeps overlays mutually exclusive, dismissible, and responsive", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    const viewActionsTrigger = page.getByRole("button", { name: "Open view actions" });
    const triggerBox = await viewActionsTrigger.boundingBox();
    const iconBox = await viewActionsTrigger.locator("svg").boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    if (triggerBox && iconBox) {
      expect(Math.abs(triggerBox.y + triggerBox.height / 2 - (iconBox.y + iconBox.height / 2))).toBeLessThan(
        1,
      );
    }
    await viewActionsTrigger.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Open view actions");
    await expect(page.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");
    await expect(viewActionsTrigger).not.toHaveAttribute("title");
    await page.mouse.move(0, 0);
    await viewActionsTrigger.click();
    await expect(page.getByRole("menuitem", { name: "Copy view link" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewActionsTrigger).toBeFocused();

    const filterTrigger = page.getByRole("button", { name: "Filter tasks" });
    const displayTrigger = page.getByRole("button", { name: "Display settings" });
    const filterPopover = page.locator(".lr-filter-popover");
    const displayPopover = page.locator('.lr-popover[aria-label="Display settings"]');
    await filterTrigger.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Filter tasks");
    await page.mouse.move(0, 0);
    await filterTrigger.click();
    await expect(filterPopover).toBeVisible();
    await displayTrigger.click();
    await expect(filterPopover).toBeHidden();
    await expect(displayPopover).toBeVisible();
    await filterTrigger.click();
    await expect(displayPopover).toBeHidden();
    await expect(filterPopover).toBeVisible();
    await page.keyboard.press("Escape");

    const dialogTrigger = page.getByRole("button", { name: "New task" });
    await dialogTrigger.click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "New task" })).toBeHidden();
    await expect(dialogTrigger).toBeFocused();

    await page.setViewportSize({ height: 844, width: 390 });
    await expect(page.locator(".app-surface")).toHaveCSS("margin", "0px");
    await expect
      .poll(() =>
        page.evaluate<boolean>(
          "document.documentElement.scrollWidth === document.documentElement.clientWidth",
        ),
      )
      .toBe(true);
  });

  test("keeps navigation, form controls, and persisted activity optically aligned", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    // Measure the very link that is hovered, not merely the first one in the sidebar.
    const humanRequests = page.locator(".app-nav-link").filter({ hasText: "Human requests" });
    const navBackground = async (): Promise<string> =>
      humanRequests.evaluate((element) => getComputedStyle(element).backgroundColor);
    const navBackgroundBefore = await navBackground();
    await humanRequests.hover();
    expect(await navBackground()).not.toBe(navBackgroundBefore);

    await page.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog", { name: "New task" });
    const submit = dialog.getByRole("button", { name: "Create task" });
    await expect(submit).toBeDisabled();
    const textField = dialog.locator(".lr-text-field");
    const projectTrigger = dialog.getByRole("combobox", { name: "Project" });
    const priorityTrigger = dialog.getByRole("combobox", { name: "Priority" });
    await expect(textField).toHaveCSS("height", "34px");
    await expect(projectTrigger).toHaveCSS("height", "34px");
    await expect(priorityTrigger).toHaveCSS("height", "34px");
    const controlBoxes = await Promise.all([
      textField.boundingBox(),
      projectTrigger.boundingBox(),
      priorityTrigger.boundingBox(),
    ]);
    expect(controlBoxes.every((box) => box !== null)).toBe(true);

    const titleLabel = dialog.locator('label[for="new-task-title"]');
    const briefLabel = dialog.locator('label[for="new-task-brief"]');
    const briefField = dialog.locator("#new-task-brief");
    const briefDescription = dialog.locator("#new-task-brief-description");
    const fieldBoxes = await Promise.all([
      titleLabel.boundingBox(),
      textField.boundingBox(),
      briefLabel.boundingBox(),
      briefField.boundingBox(),
      briefDescription.boundingBox(),
    ]);
    expect(fieldBoxes.every((box) => box !== null)).toBe(true);
    if (fieldBoxes[0] && fieldBoxes[1]) {
      expect(Math.abs(fieldBoxes[1].y - (fieldBoxes[0].y + fieldBoxes[0].height) - 6)).toBeLessThan(0.1);
    }
    if (fieldBoxes[2] && fieldBoxes[3] && fieldBoxes[4]) {
      expect(Math.abs(fieldBoxes[3].y - (fieldBoxes[2].y + fieldBoxes[2].height) - 6)).toBeLessThan(0.1);
      expect(Math.abs(fieldBoxes[4].y - (fieldBoxes[3].y + fieldBoxes[3].height) - 3)).toBeLessThan(0.1);
    }
    await expect(briefDescription).toHaveCSS("font-size", "11px");
    await expect(briefDescription).toHaveCSS("line-height", "14px");

    await projectTrigger.click();
    await expect(page.getByRole("option", { name: "Fixture web application" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Fixture API service" })).toBeVisible();
    await page.keyboard.press("Escape");

    await dialog.getByPlaceholder("What should the team deliver?").fill("Aligned persisted task");
    await dialog.getByPlaceholder("Outcome, constraints, relevant files…").fill("Verify timeline alignment.");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toBeHidden();

    const createdEvent = page.locator(".lr-timeline-event").filter({ hasText: "Task created" }).first();
    const timelineBoxes = await Promise.all([
      createdEvent.boundingBox(),
      createdEvent.locator(".lr-timeline-event__icon").boundingBox(),
      createdEvent.locator("time").boundingBox(),
    ]);
    expect(timelineBoxes.every((box) => box !== null)).toBe(true);
    if (timelineBoxes[0] && timelineBoxes[1] && timelineBoxes[2]) {
      const rowCenter = timelineBoxes[0].y + timelineBoxes[0].height / 2;
      const iconCenter = timelineBoxes[1].y + timelineBoxes[1].height / 2;
      const timeCenter = timelineBoxes[2].y + timelineBoxes[2].height / 2;
      expect(Math.abs(rowCenter - iconCenter)).toBeLessThan(1);
      expect(Math.abs(rowCenter - timeCenter)).toBeLessThan(1);
    }
  });

  test("supports localized cascading filters on desktop and mobile", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Filtered persisted task");
    await page
      .getByRole("complementary", { name: "Filtered persisted task" })
      .getByRole("button", { name: "Move to Ready" })
      .click();

    const trigger = page.getByRole("button", { name: "Filter tasks" }).first();
    const triggerBoxBeforeOpen = await trigger.boundingBox();
    await trigger.click();
    const rootPopover = page.locator(".lr-filter-popover");
    await expect(rootPopover).toBeVisible();
    await expect(page.getByRole("menu", { name: "Filters options" })).toBeVisible();
    await expect(rootPopover.getByRole("menuitem")).toHaveCount(3);
    await expect(rootPopover.getByRole("separator")).toHaveCount(0);
    await expect(rootPopover).toHaveCSS("width", "191px");
    await expect(rootPopover).toHaveCSS("border-top-color", "rgb(232, 232, 234)");

    const statusItem = rootPopover.getByRole("menuitem", { name: "Status" });
    await statusItem.hover();
    const statusMenu = page.getByRole("menu", { name: "Status options" });
    await expect(statusMenu).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search Status" })).toHaveAttribute(
      "placeholder",
      "Filter…",
    );
    await page.getByRole("button", { name: "Add Ready" }).click();
    await expect(rootPopover).toBeVisible();

    const appliedFilters = page.getByRole("region", { name: "Filter tasks" });
    await expect(appliedFilters.locator(".lr-applied-filter")).toHaveCount(1);
    await expect(appliedFilters).toContainText("Ready");
    // The view tabs carry no rule of their own; the board heading below is the only divider.
    await expect(page.locator(".board-toolbar")).toHaveCSS("border-bottom-width", "0px");
    await expect(appliedFilters).toHaveCSS("background-color", "rgb(239, 239, 240)");
    await expect(appliedFilters).toHaveCSS("border-radius", "10px");
    const triggerBoxAfterSelection = await trigger.boundingBox();
    if (triggerBoxBeforeOpen && triggerBoxAfterSelection) {
      expect(Math.abs(triggerBoxBeforeOpen.x - triggerBoxAfterSelection.x)).toBeLessThan(1);
      expect(Math.abs(triggerBoxBeforeOpen.y - triggerBoxAfterSelection.y)).toBeLessThan(1);
    }

    const displayTrigger = page.getByRole("button", { name: "Display settings" });
    await displayTrigger.click();
    await expect(rootPopover).toBeHidden();
    const displaySettings = page.locator('.lr-popover[aria-label="Display settings"]');
    await expect(displaySettings).toBeVisible();
    const orderingTrigger = displaySettings.getByRole("combobox", {
      exact: true,
      name: "Order tasks by",
    });
    await orderingTrigger.click();
    const orderingOptions = page.getByRole("listbox");
    // Every offered ordering is backed by a real WorkItem field.
    await expect(orderingOptions.getByRole("option")).toHaveCount(4);
    await expect(
      orderingOptions.getByRole("option", { name: "Priority" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "500");
    await expect(
      orderingOptions.getByRole("option", { name: "Created" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "400");
    const titleOption = orderingOptions.getByRole("option", { name: "Title" });
    expect(
      await titleOption
        .locator(".lr-select-item__copy > span")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await titleOption.hover();
    await expect(titleOption).toHaveCSS("cursor", "default");
    await expect(titleOption).toHaveCSS("user-select", "none");
    await page.keyboard.press("Escape");
    await expect(orderingOptions).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(displaySettings).toBeHidden();

    await appliedFilters.getByRole("button", { name: "Clear" }).click();
    await page.setViewportSize({ height: 844, width: 390 });
    await trigger.click();
    const mobileDialog = page.locator(".lr-filter-dialog");
    await expect(page.getByRole("dialog", { name: "Filter tasks" })).toBeVisible();
    const viewport = page.viewportSize();
    const dialogBox = await mobileDialog.boundingBox();
    expect(viewport).not.toBeNull();
    expect(dialogBox).not.toBeNull();
    if (viewport && dialogBox) {
      expect(dialogBox.width).toBeCloseTo(viewport.width, 1);
      expect(dialogBox.height).toBeCloseTo(viewport.height, 1);
    }
    await mobileDialog.getByRole("menuitem", { name: "Status" }).click();
    await expect(page.getByRole("dialog", { name: "Status" })).toBeVisible();
    await expect(mobileDialog.getByRole("button", { name: "Back to Filters" })).toBeVisible();
    await mobileDialog.getByRole("button", { name: "Add Backlog" }).click();
    await expect(mobileDialog).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ height: 900, width: 1440 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(page.locator(".lr-filter-popover")).toHaveCSS("animation-duration", "0.001s");
    await page.getByRole("menuitem", { name: "Status" }).hover();
    await expect(page.locator('.lr-filter-level[data-filter-depth="1"]')).toHaveCSS(
      "transition-duration",
      "0.001s",
    );
    await page.keyboard.press("Escape");
  });

  test("orders the board by a real WorkItem field and keeps the choice in the URL", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    // The popover animates in; reduced motion keeps its controls immediately stable to click.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Zulu ordering probe");
    await createTask(page, "Alpha ordering probe");

    // Read through a retrying assertion rather than a one-shot text snapshot: a reload repaints
    // the board asynchronously, and a bare read reports the empty column it passes through.
    const backlogTitles = page
      .locator(".lr-kanban-column")
      .first()
      .locator(".task-card-button .lr-task-card__title");

    // Both tasks share a priority, so the default view falls back to newest-created first.
    await expect(backlogTitles).toHaveText(["Alpha ordering probe", "Zulu ordering probe"]);

    // Both changes are made in one popover session: closing and reopening it between them adds
    // overlay transitions that say nothing about ordering.
    await page.getByRole("button", { name: "Display settings" }).click();
    const displaySettings = page.locator('.lr-popover[aria-label="Display settings"]');
    await expect(displaySettings).toBeVisible();
    await displaySettings.getByRole("combobox", { name: "Order tasks by" }).click();
    await page.getByRole("option", { name: "Title" }).click();
    await expect(page.getByRole("listbox")).toBeHidden();

    await expect(page).toHaveURL(/order=title/);
    await expect(backlogTitles).toHaveText(["Zulu ordering probe", "Alpha ordering probe"]);

    await displaySettings.getByRole("button", { name: "Sort ascending" }).click();
    await expect(page).toHaveURL(/dir=asc/);
    await expect(backlogTitles).toHaveText(["Alpha ordering probe", "Zulu ordering probe"]);

    // The ordering survives a reload because it lives in the URL, not component state.
    await page.reload();
    await expect(backlogTitles).toHaveText(["Alpha ordering probe", "Zulu ordering probe"]);
  });

  test("hides empty delivery columns only when the owner asks for it", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Only backlog work");

    const columns = page.locator(".lr-kanban-column");
    await expect(columns).toHaveCount(4);

    await page.getByRole("button", { name: "Display settings" }).click();
    const displaySettings = page.locator('.lr-popover[aria-label="Display settings"]');
    await expect(displaySettings).toBeVisible();
    await displaySettings.getByRole("switch", { name: "Show empty columns" }).click();
    await page.keyboard.press("Escape");
    await expect(displaySettings).toBeHidden();

    await expect(page).toHaveURL(/hideEmpty=true/);
    await expect(columns).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Only backlog work" })).toBeVisible();
  });

  test("emphasises the forward move and offers no placeholder actions", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Forward move probe");

    const inspector = page.getByRole("complementary", { name: "Forward move probe" });
    const footer = inspector.locator(".task-inspector__footer");

    // Backlog has exactly one meaningful move, so no disabled placeholder is rendered beside it.
    await expect(footer.getByRole("button")).toHaveCount(1);
    const toReady = footer.getByRole("button", { name: "Move to Ready" });
    await expect(toReady).toHaveClass(/lr-button--primary/);
    await toReady.click();

    // READY allows Backlog before Running in the transition matrix; the emphasised action must
    // still be the one that carries the work forward.
    await expect(footer.getByRole("button")).toHaveCount(2);
    await expect(footer.getByRole("button", { name: "Move to Running" })).toHaveClass(/lr-button--primary/);
    await expect(footer.getByRole("button", { name: "Move to Backlog" })).not.toHaveClass(
      /lr-button--primary/,
    );
    await expect(footer.getByRole("button", { name: /No available move|No secondary action/ })).toHaveCount(
      0,
    );
  });

  test("reveals the column a selected task moved into on a narrow board", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.setViewportSize({ height: 800, width: 1024 });
    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Scrolled into view");

    const board = page.locator(".kanban-board-scroll");
    expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    const inspector = page.getByRole("complementary", { name: "Scrolled into view" });
    await inspector.getByRole("button", { name: "Move to Ready" }).click();
    await inspector.getByRole("button", { name: "Move to Running" }).click();
    await inspector.getByRole("button", { name: "Move to Blocked" }).click();

    const card = page.getByRole("button", { name: "Scrolled into view" });
    await expect(card).toHaveAttribute("aria-pressed", "true");
    // The card sits in the right-most column; the board must have scrolled it back into view
    // instead of leaving the visible columns looking empty. A retrying assertion is used because
    // the move re-renders the board underneath us.
    await expect(card).toBeInViewport();
  });

  test("keeps navigation reachable and free of dead ends on a phone viewport", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await page.setViewportSize({ height: 812, width: 375 });

    // The sidebar is gone at this width, so the drawer is the only route to navigation.
    await expect(page.locator(".app-sidebar")).toBeHidden();
    const openNavigation = page.getByRole("button", { name: "Open navigation" });
    await expect(openNavigation).toBeVisible();
    await openNavigation.click();

    const drawer = page.getByRole("dialog", { name: "Workspace" });
    await expect(drawer).toBeVisible();
    // Project switching and the settings entry both have to survive the narrow layout.
    await expect(drawer.getByRole("button", { name: "Switch project" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Open settings" })).toBeVisible();

    await drawer.getByRole("link", { name: "Human requests" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/summary=needsYou/);
  });

  test("offers no navigation entry that leads nowhere", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    // Every sidebar entry resolves to a view the product actually serves.
    const links = page.locator(".app-sidebar .app-nav-link");
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("href", /^\//);
      await expect(link).not.toHaveAttribute("aria-disabled", "true");
    }

    // No control in the frame or the board toolbar is present purely for decoration.
    const disabledControls = await page
      .locator(".app-sidebar, .app-topbar, .board-toolbar")
      .locator("button:disabled, [aria-disabled='true']")
      .count();
    expect(disabledControls).toBe(0);

    // Every board scope tab switches the board rather than sitting there inert.
    for (const [name, expected] of [
      ["Backlog", /scope=backlog/],
      ["All issues", /scope=all/],
      ["Active", /^(?!.*scope=).*$/],
    ] as const) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page).toHaveURL(expected);
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
    }
  });

  test("shows the newest activity first and loads older pages on demand", async ({ page }) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail activity "));
    try {
      const databasePath = join(temporaryDirectory, "local-state.sqlite");
      const title = "Task with a long audit trail";
      const total = await seedLongActivity(databasePath, title);

      daemon = await startDaemon({
        bootstrapToken: randomBytes(32).toString("base64url"),
        logger: false,
        stateDatabasePath: databasePath,
        webRoot: resolve("apps/web/dist"),
      });

      await page.goto(daemon.bootstrapUrl);
      await page.getByRole("button", { name: "All issues", exact: true }).click();
      await page.getByRole("button", { name: title }).click();

      const inspector = page.getByRole("complementary", { name: title });
      const rows = inspector.locator(".inspector-activity > li");
      await expect(rows).toHaveCount(30);

      // The count admits that the loaded rows are not the whole log.
      await expect(inspector.getByText("30+", { exact: true })).toBeVisible();

      // The newest Event leads, so the current state is readable without scrolling or paging.
      await expect(rows.first()).toContainText("State changed");
      await expect(rows.first()).toContainText("Ready → Backlog");
      await expect(inspector.getByText("Task created", { exact: true })).toHaveCount(0);

      const loadMore = inspector.getByRole("button", { name: "Show more" });
      await expect(loadMore).toBeVisible();
      await loadMore.click();

      await expect(rows).toHaveCount(total);
      await expect(inspector.getByText("Task created", { exact: true })).toBeVisible();
      await expect(inspector.getByText(total.toString(), { exact: true })).toBeVisible();
      await expect(loadMore).toHaveCount(0);
    } finally {
      // The daemon holds this database open, and Windows refuses to unlink a file that still has
      // a handle on it. Releasing it here rather than in afterEach keeps the removal ordered.
      await daemon?.close();
      daemon = undefined;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("draws inspector rules inset from the panel edge and none below the last section", async ({
    page,
  }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Inspector rule alignment");

    const inspector = page.getByRole("complementary", { name: "Inspector rule alignment" });
    const sections = inspector.locator(".lr-inspector-section");
    await expect(sections).toHaveCount(4);

    // Every rule stops short of the panel edge by the same inset the content sits at.
    const inset = await sections.first().evaluate((element) => {
      const rule = window.getComputedStyle(element, "::after");
      return { content: rule.content, left: rule.left, right: rule.right };
    });
    expect(inset.content).not.toBe("none");
    expect(inset.left).toBe("16px");
    expect(inset.right).toBe("16px");

    // The last section - the activity log - has nothing below it to separate from.
    const trailing = await sections
      .last()
      .evaluate((element) => window.getComputedStyle(element, "::after").content);
    expect(trailing).toBe("none");
  });

  test("gathers browser preferences in settings and applies board density", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);
    await createTask(page, "Density probe");

    const card = page.locator(".lr-task-card").first();
    await expect(card).toHaveCSS("padding", "12px");

    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    // Both registered fixture projects are listed, with the active one marked.
    await expect(settings.getByRole("button", { name: /Fixture/ })).toHaveCount(2);

    await settings
      .getByRole("group", { name: "Board density" })
      .getByRole("button", { name: "Compact" })
      .click();
    await expect(card).toHaveCSS("padding", "8px");

    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    // The preference belongs to this browser, so it has to survive a reload.
    await page.reload();
    await expect(page.locator(".lr-task-card").first()).toHaveCSS("padding", "8px");
  });

  test("keeps a resized panel across a reload without the loading shell jumping", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);
    await initializeWorkspace(page);

    const sidebar = page.locator(".app-sidebar");
    expect((await sidebar.boundingBox())?.width).toBe(240);

    // Drag the divider rather than writing storage directly, so the whole path is exercised.
    const handle = page.getByRole("separator", { name: "Resize the sidebar" });
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    if (handleBox) {
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 200);
      await page.mouse.down();
      await page.mouse.move(320, handleBox.y + 200, { steps: 8 });
      await page.mouse.up();
    }
    expect((await sidebar.boundingBox())?.width).toBe(320);

    await page.reload();
    // The width has to be in place on the very first paint, before React hydrates, or the loading
    // shell renders at the default and the layout jumps once the app mounts.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--lr-size-sidebar").trim(),
      ),
    ).toBe("320px");
    expect((await sidebar.boundingBox())?.width).toBe(320);
  });
});
