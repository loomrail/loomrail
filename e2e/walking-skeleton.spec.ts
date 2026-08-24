import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

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

    await page.getByRole("button", { name: "Change color theme" }).click();
    await page.getByRole("menuitem", { name: /^Dark/ }).click();
    await page.getByRole("button", { name: "Change language" }).click();
    await page.getByRole("menuitem", { name: "Русский" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Текущая работа" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("heading", { level: 1, name: "Текущая работа" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edited persisted browser task" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Components" })).toHaveCount(0);
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

  test("stops a mock workflow on a durable HumanRequest and resumes from the answer", async ({ page }) => {
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
    await expect(
      workflowSection.getByText("Discovery and planning completed from the recorded decision."),
    ).toBeVisible();
    await expect(workflowSection.getByText("Completed", { exact: true })).toHaveCount(3);
    await expect(page.getByRole("button", { name: /Needs your decision/ })).toHaveCount(0);
    await expect(restoredInspector.getByText("Decision recorded", { exact: true })).toBeVisible();
    await expect(restoredInspector.getByText("Workflow completed", { exact: true })).toBeVisible();
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
    await viewActionsTrigger.click();
    await expect(page.getByRole("menuitem", { name: "Copy view link" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewActionsTrigger).toBeFocused();

    const filterTrigger = page.getByRole("button", { name: "Filter tasks" });
    const displayTrigger = page.getByRole("button", { name: "Display settings" });
    const filterPopover = page.locator(".lr-filter-popover");
    const displayPopover = page.locator('.lr-popover[aria-label="Display settings"]');
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

    const inbox = page.locator(".app-nav-link").filter({ hasText: "Inbox" });
    const navBackgroundBefore = await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.app-nav-link')).backgroundColor",
    );
    await inbox.hover();
    const navBackgroundAfter = await page.evaluate<string>(
      "getComputedStyle(document.querySelector('.app-nav-link')).backgroundColor",
    );
    expect(navBackgroundAfter).not.toBe(navBackgroundBefore);

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
    await expect(rootPopover.getByRole("menuitem")).toHaveCount(2);
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
    await expect(page.locator(".board-toolbar-stack")).toHaveClass(/has-active-filters/);
    await expect(page.locator(".board-toolbar")).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
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
    const groupingTrigger = displaySettings.getByRole("combobox", {
      exact: true,
      name: "Group tasks by",
    });
    await groupingTrigger.click();
    const groupingOptions = page.getByRole("listbox");
    await expect(groupingOptions.getByRole("option")).toHaveCount(7);
    await expect(
      groupingOptions.getByRole("option", { name: "No grouping" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "400");
    await expect(
      groupingOptions.getByRole("option", { name: "Status" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "500");
    const projectOption = groupingOptions.getByRole("option", { name: "Project" });
    await projectOption.hover();
    await expect(projectOption).toHaveCSS("cursor", "default");
    await expect(projectOption).toHaveCSS("user-select", "none");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

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
});
