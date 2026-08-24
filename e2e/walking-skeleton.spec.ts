import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { startDaemon, type RunningDaemon } from "../apps/daemon/dist/server.js";

test.describe("authenticated walking skeleton", () => {
  let daemon: RunningDaemon | undefined;

  test.afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("opens the workbench and preserves its local session", async ({ page }) => {
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
    await expect(page.getByText("Fixture preview", { exact: true })).toBeVisible();
    await expect(page.getByText("Chrome QA adapter spike").first()).toBeVisible();
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

    const taskInspector = page.getByRole("complementary", { name: "Selected task details" });
    const budgetTask = page.getByRole("button", { name: /Budget guardrails for parallel agents/ });
    const runningTask = page.getByRole("button", { name: /Chrome QA adapter spike/ });
    await budgetTask.click();
    await expect(budgetTask).toHaveAttribute("aria-pressed", "true");
    const budgetTaskCard = budgetTask.locator(".lr-task-card");
    const runningTaskCard = runningTask.locator(".lr-task-card");
    await expect(budgetTaskCard).toHaveClass(/is-selected/);
    await expect(runningTaskCard).toHaveClass(/is-active/);
    await expect(runningTaskCard).not.toHaveClass(/is-selected/);
    await expect(budgetTaskCard).toHaveCSS("box-shadow", /0px 0px 0px 1px/);
    await expect(runningTaskCard).toHaveCSS("box-shadow", "none");
    await expect(
      taskInspector.getByRole("heading", { level: 2, name: "Budget guardrails for parallel agents" }),
    ).toBeVisible();
    await expect(taskInspector.getByText("Ready", { exact: true })).toBeVisible();
    await runningTask.click();
    await expect(
      taskInspector.getByRole("heading", { level: 2, name: "Chrome QA adapter spike" }),
    ).toBeVisible();

    const viewActions = page.locator('button[aria-label="Open view actions"]');
    const viewActionsBox = await viewActions.boundingBox();
    const viewActionsIconBox = await viewActions.locator("svg").boundingBox();
    await expect(page.locator(".board-toolbar")).toHaveCSS("background-color", "rgb(249, 249, 250)");
    await expect(page.locator(".board-toolbar")).toHaveCSS("border-bottom-color", "rgb(225, 225, 227)");
    await expect(page.locator(".workbench-heading")).toHaveCSS("background-color", "rgb(249, 249, 250)");
    await expect(viewActions).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(viewActions).toHaveCSS("box-shadow", /rgba\(0, 0, 0, 0\.14\)/);
    await expect(viewActions.locator("circle")).toHaveCount(3);
    expect(viewActionsBox).not.toBeNull();
    expect(viewActionsIconBox).not.toBeNull();
    if (viewActionsBox && viewActionsIconBox) {
      expect(viewActionsBox.width).toBe(28);
      expect(viewActionsBox.height).toBe(28);
      expect(viewActionsIconBox.width).toBe(14);
      expect(viewActionsIconBox.height).toBe(14);
    }
    await viewActions.hover();
    await expect(viewActions).toHaveCSS("background-color", "rgb(243, 243, 243)");
    await expect(viewActions).toHaveCSS("box-shadow", /rgba\(0, 0, 0, 0\.17\)/);
    await viewActions.click();
    await expect(viewActions).toHaveCSS("background-color", "rgb(240, 240, 240)");
    await expect(viewActions).toHaveCSS("box-shadow", /rgba\(0, 0, 0, 0\.18\)/);
    await page.keyboard.press("Escape");

    const backlog = page.getByRole("button", { name: "Backlog" });
    const activeView = page.getByRole("button", { name: "Active" });
    const allIssues = page.getByRole("button", { name: "All issues" });
    const activeViewBox = await activeView.boundingBox();
    const backlogBox = await backlog.boundingBox();
    const allIssuesBox = await allIssues.boundingBox();
    await expect(backlog).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(backlog).toHaveCSS("box-shadow", /rgba\(0, 0, 0, 0\.14\)/);
    await expect(activeView).toHaveCSS("background-color", "rgb(236, 236, 237)");
    await expect(activeView).toHaveCSS("box-shadow", /rgba\(0, 0, 0, 0\.14\)/);
    if (activeViewBox && backlogBox && allIssuesBox) {
      expect(backlogBox.x - (activeViewBox.x + activeViewBox.width)).toBe(4);
      expect(allIssuesBox.x - (backlogBox.x + backlogBox.width)).toBe(4);
    }

    const displaySettingsTrigger = page.getByRole("button", { name: "Display settings" });
    await displaySettingsTrigger.click();
    const displaySettings = page.locator('.lr-popover[aria-label="Display settings"]');
    await page.waitForTimeout(160);
    const displaySettingsBox = await displaySettings.boundingBox();
    const displayTabsBox = await displaySettings.locator(".lr-segmented").boundingBox();
    const displaySwitchBox = await displaySettings.locator(".lr-switch").first().boundingBox();
    expect(displaySettingsBox).not.toBeNull();
    expect(displayTabsBox).not.toBeNull();
    expect(displaySwitchBox).not.toBeNull();
    if (displaySettingsBox && displayTabsBox && displaySwitchBox) {
      expect(displaySettingsBox.width).toBeCloseTo(302, 0);
      expect(displaySettingsBox.height).toBeCloseTo(505, 0);
      expect(displayTabsBox.width).toBe(268);
      expect(displayTabsBox.height).toBe(32);
      expect(displaySwitchBox.width).toBe(22);
      expect(displaySwitchBox.height).toBe(14);
    }
    await expect(displaySettings).toHaveCSS("border-top-color", "rgb(232, 232, 234)");
    await expect(displaySettings.getByText("Sub-grouping", { exact: true })).toBeVisible();
    await expect(displaySettings.getByText("List options", { exact: true })).toBeVisible();
    await expect(displaySettings.getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(displaySettings.getByRole("button", { name: "List" })).toHaveCSS(
      "box-shadow",
      /rgba\(0, 0, 0, 0\.14\)/,
    );
    await expect(displaySettings.getByRole("button", { name: "Board" })).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await expect(displaySettings.getByRole("button", { name: "Board" })).toHaveCSS(
      "box-shadow",
      /rgba\(0, 0, 0, 0\.14\)/,
    );
    await expect(displaySettings.getByRole("button", { name: "Direction" })).toHaveCSS("height", "24px");
    const boardLayout = displaySettings.getByRole("button", { name: "Board" });
    await displaySettings.getByRole("button", { name: "List" }).press("Tab");
    await expect(boardLayout).toBeFocused();
    await boardLayout.press("Tab");
    const groupingTrigger = displaySettings.getByRole("combobox", { exact: true, name: "Group tasks by" });
    const subGroupingTrigger = displaySettings.getByRole("combobox", {
      exact: true,
      name: "Sub-group tasks by",
    });
    await expect(subGroupingTrigger).toHaveText("No grouping");
    await expect(groupingTrigger).toHaveClass(/lr-select-trigger--compact/);
    await expect(subGroupingTrigger).toHaveClass(/lr-select-trigger--compact/);
    await expect(subGroupingTrigger.locator("span").first()).toHaveCSS("white-space", "nowrap");
    await expect(subGroupingTrigger).toHaveCSS("height", "24px");
    await expect(groupingTrigger).toBeFocused();
    await expect(groupingTrigger).toHaveText("Status");
    await expect(groupingTrigger).toHaveCSS("box-shadow", /rgb\(94, 106, 210\)/);
    await groupingTrigger.click();
    await page.waitForTimeout(160);
    const groupingSelect = page.locator(".lr-select-content--compact");
    await expect(groupingSelect).toBeVisible();
    await expect(groupingSelect).toHaveCSS("z-index", "110");
    await expect(displaySettings).toHaveCSS("z-index", "90");
    const groupingOptions = page.getByRole("listbox");
    const groupingOptionsBox = await groupingOptions.boundingBox();
    const firstGroupingOptionBox = await groupingOptions.getByRole("option").first().boundingBox();
    if (groupingOptionsBox && firstGroupingOptionBox) {
      expect(groupingOptionsBox.width).toBeCloseTo(119, 0);
      expect(firstGroupingOptionBox.height).toBe(24);
    }
    await expect(groupingOptions.getByRole("option")).toHaveCount(7);
    await expect(
      groupingOptions.getByRole("option", { name: "No grouping" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "400");
    await expect(
      groupingOptions.getByRole("option", { name: "Status" }).locator(".lr-select-item__copy > span"),
    ).toHaveCSS("font-weight", "500");
    const projectGroupingOption = groupingOptions.getByRole("option", { name: "Project" });
    await projectGroupingOption.hover();
    await expect(projectGroupingOption).toHaveCSS("cursor", "default");
    await expect(projectGroupingOption).toHaveCSS("user-select", "none");
    await page.keyboard.press("Escape");
    await expect(groupingTrigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(displaySettingsTrigger).toBeFocused();

    await page.getByRole("button", { name: "Change color theme" }).click();
    await page.getByRole("menuitem", { name: /^Dark/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(viewActions).toHaveCSS("background-color", "rgb(36, 36, 38)");

    await page.reload();
    await expect(page.getByText("Fixture preview", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("heading", { level: 1, name: "Current work" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Components" })).toHaveCount(0);
  });

  test("keeps product overlays aligned, dismissible, and responsive", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);

    const actionsTrigger = page.getByRole("button", { name: "Open actions" });
    const chevron = actionsTrigger.locator("svg").last();
    const centers = await Promise.all([actionsTrigger.boundingBox(), chevron.boundingBox()]);

    expect(centers[0]).not.toBeNull();
    expect(centers[1]).not.toBeNull();
    if (centers[0] && centers[1]) {
      expect(
        Math.abs(centers[0].y + centers[0].height / 2 - (centers[1].y + centers[1].height / 2)),
      ).toBeLessThan(1);
    }

    await actionsTrigger.click();
    const deleteItem = page.getByRole("menuitem", { name: /Delete task/ });
    await deleteItem.hover();
    await expect(deleteItem).toBeVisible();
    await expect(deleteItem).toHaveCSS("color", /rgb/);
    await page.keyboard.press("Escape");
    await expect(actionsTrigger).toBeFocused();

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

  test("keeps navigation, form controls, and timeline rows optically aligned", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);

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
    const newTaskDialog = page.getByRole("dialog", { name: "New task" });
    await expect(newTaskDialog.getByRole("button", { name: "Create task" })).toBeDisabled();
    const textField = newTaskDialog.locator(".lr-text-field");
    const projectTrigger = page.getByRole("combobox", { name: "Project" });
    const priorityTrigger = page.getByRole("combobox", { name: "Priority" });
    await expect(textField).toHaveCSS("height", "34px");
    await expect(projectTrigger).toHaveCSS("height", "34px");
    await expect(priorityTrigger).toHaveCSS("height", "34px");
    const controlBoxes = await Promise.all([
      textField.boundingBox(),
      projectTrigger.boundingBox(),
      priorityTrigger.boundingBox(),
    ]);

    expect(controlBoxes.every((box) => box !== null)).toBe(true);

    const taskLabel = newTaskDialog.locator('label[for="new-task-title"]');
    const briefLabel = newTaskDialog.locator('label[for="new-task-brief"]');
    const briefField = newTaskDialog.locator("#new-task-brief");
    const briefDescription = newTaskDialog.locator("#new-task-brief-description");
    const fieldBoxes = await Promise.all([
      taskLabel.boundingBox(),
      textField.boundingBox(),
      briefLabel.boundingBox(),
      briefField.boundingBox(),
      briefDescription.boundingBox(),
    ]);
    expect(fieldBoxes.every((box) => box !== null)).toBe(true);
    if (fieldBoxes[0] && fieldBoxes[1]) {
      const taskLabelGap = fieldBoxes[1].y - (fieldBoxes[0].y + fieldBoxes[0].height);
      expect(Math.abs(taskLabelGap - 6)).toBeLessThan(0.1);
    }
    if (fieldBoxes[2] && fieldBoxes[3] && fieldBoxes[4]) {
      const briefLabelGap = fieldBoxes[3].y - (fieldBoxes[2].y + fieldBoxes[2].height);
      const briefDescriptionGap = fieldBoxes[4].y - (fieldBoxes[3].y + fieldBoxes[3].height);
      expect(Math.abs(briefLabelGap - 6)).toBeLessThan(0.1);
      expect(Math.abs(briefDescriptionGap - 3)).toBeLessThan(0.1);
    }
    await expect(briefDescription).toHaveCSS("font-size", "11px");
    await expect(briefDescription).toHaveCSS("line-height", "14px");

    await projectTrigger.click();
    await page.waitForTimeout(160);
    const projectContent = page.locator(".lr-select-content");
    const projectContentBox = await projectContent.boundingBox();
    expect(projectContentBox).not.toBeNull();
    if (controlBoxes[1] && projectContentBox) {
      expect(projectContentBox.width).toBeGreaterThanOrEqual(controlBoxes[1].width - 1);
    }
    await expect(page.getByRole("option", { name: "Web app" }).locator(".lr-icon")).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Loomrail core" }).locator(".lr-icon")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    const policyEvent = page
      .locator(".lr-timeline-event")
      .filter({ hasText: "Policy file loaded from project rules." })
      .first();
    const timelineBoxes = await Promise.all([
      policyEvent.boundingBox(),
      policyEvent.locator(".lr-timeline-event__icon").boundingBox(),
      policyEvent.locator("time").boundingBox(),
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

  test("supports cascading task filters on desktop and mobile", async ({ page }) => {
    daemon = await startDaemon({
      bootstrapToken: randomBytes(32).toString("base64url"),
      logger: false,
      webRoot: resolve("apps/web/dist"),
    });

    await page.goto(daemon.bootstrapUrl);

    const trigger = page.getByRole("button", { name: "Filter tasks" });
    const triggerBoxBeforeOpen = await trigger.boundingBox();
    await trigger.click();
    await expect(page.locator(".lr-filter-popover")).toBeVisible();
    await expect(page.getByRole("menu", { name: "Filters options" })).toBeVisible();
    await expect(page.locator(".lr-filter-level__title")).toHaveCount(0);
    const rootFilterPopover = page.locator(".lr-filter-popover");
    await expect(rootFilterPopover).toHaveCSS("width", "191px");
    await expect(rootFilterPopover).toHaveCSS("border-top-color", "rgb(232, 232, 234)");
    await expect(rootFilterPopover.locator(".lr-filter-list").first()).toHaveCSS("padding-top", "6px");
    await expect(rootFilterPopover.locator(".lr-filter-item__icon svg").first()).toHaveCSS("width", "14px");
    await expect(rootFilterPopover.getByRole("separator")).toHaveCount(1);

    const statusItem = page.getByRole("menuitem", { name: /Status/ });
    await statusItem.hover();
    await expect(statusItem).toHaveCSS("background-color", "rgb(244, 244, 245)");

    await page.getByRole("menuitem", { name: /Agent session/ }).hover();
    await expect(page.getByRole("menu", { name: "Agent session options" })).toBeVisible();
    const firstSubmenu = page.locator('.lr-filter-level[data-filter-depth="1"]');
    await expect(firstSubmenu).toHaveAttribute("data-filter-column", "agent-session");
    await expect(firstSubmenu).toHaveCSS("transition-duration", "0.12s, 0.12s");
    const agentSessionSearch = page.getByRole("searchbox", { name: "Search Agent session" });
    await expect(agentSessionSearch).toBeVisible();
    await expect(agentSessionSearch).toHaveAttribute("placeholder", "Filter…");
    await page.getByRole("menuitem", { name: /Provider/ }).hover();
    await expect(page.getByRole("menu", { name: "Provider options" })).toBeVisible();
    const providerSearch = page.getByRole("searchbox", { name: "Search Provider" });
    await expect(providerSearch).toBeVisible();
    await expect(providerSearch).toHaveAttribute("placeholder", "Filter…");
    await page.waitForTimeout(160);

    const rootBox = await page.locator(".lr-filter-main-panel").boundingBox();
    const firstSubmenuBox = await page.locator('.lr-filter-level[data-filter-depth="1"]').boundingBox();
    const secondSubmenuBox = await page.locator('.lr-filter-level[data-filter-depth="2"]').boundingBox();
    expect(rootBox).not.toBeNull();
    expect(firstSubmenuBox).not.toBeNull();
    expect(secondSubmenuBox).not.toBeNull();
    if (rootBox && firstSubmenuBox && secondSubmenuBox) {
      expect(firstSubmenuBox.width).toBe(200);
      expect(secondSubmenuBox.width).toBe(200);
      const firstSubmenuRight = firstSubmenuBox.x + firstSubmenuBox.width;
      const secondSubmenuRight = secondSubmenuBox.x + secondSubmenuBox.width;
      expect(firstSubmenuRight).toBeGreaterThan(rootBox.x);
      expect(firstSubmenuRight).toBeLessThanOrEqual(rootBox.x + 6);
      expect(secondSubmenuRight).toBeGreaterThan(firstSubmenuBox.x);
      expect(secondSubmenuRight).toBeLessThanOrEqual(firstSubmenuBox.x + 6);
    }

    await page
      .getByRole("menu", { name: "Filters options" })
      .getByRole("menuitem", { name: /Project/ })
      .hover();
    await expect(firstSubmenu).toHaveAttribute("data-filter-column", "project");
    await page
      .getByRole("menu", { name: "Filters options" })
      .getByRole("menuitem", { name: /Agent session/ })
      .hover();
    await page.getByRole("menuitem", { name: /Provider/ }).hover();
    await expect(page.getByRole("menu", { name: "Provider options" })).toBeVisible();

    const popoverBoxBeforeSelection = await page.locator(".lr-filter-popover").boundingBox();
    const codexCheckbox = page.getByRole("button", { name: "Add Codex" });
    await codexCheckbox.click();
    await expect(page.locator(".lr-filter-popover")).toBeVisible();
    const selectedCodexCheckbox = page.getByRole("button", { name: "Remove Codex" });
    await expect(selectedCodexCheckbox).toHaveAttribute("aria-pressed", "true");
    const selectedCodexCheckboxBox = await selectedCodexCheckbox.boundingBox();
    expect(selectedCodexCheckboxBox).not.toBeNull();
    if (selectedCodexCheckboxBox) {
      expect(selectedCodexCheckboxBox.width).toBe(12);
      expect(selectedCodexCheckboxBox.height).toBe(12);
    }
    const appliedFilters = page.getByRole("region", { name: "Applied task filters" });
    await expect(appliedFilters.locator(".lr-applied-filter")).toHaveCount(1);
    await expect(appliedFilters).toContainText("Codex");
    await expect(page.locator(".board-toolbar-stack")).toHaveClass(/has-active-filters/);
    await expect(page.locator(".board-toolbar")).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await expect(appliedFilters).toHaveCSS("background-color", "rgb(239, 239, 240)");
    await expect(appliedFilters).toHaveCSS("border-radius", "10px");
    await expect(trigger).toBeVisible();

    const triggerBoxAfterSelection = await trigger.boundingBox();
    const popoverBoxAfterSelection = await page.locator(".lr-filter-popover").boundingBox();
    if (triggerBoxBeforeOpen && triggerBoxAfterSelection) {
      expect(Math.abs(triggerBoxBeforeOpen.x - triggerBoxAfterSelection.x)).toBeLessThan(1);
      expect(Math.abs(triggerBoxBeforeOpen.y - triggerBoxAfterSelection.y)).toBeLessThan(1);
    }
    if (popoverBoxBeforeSelection && popoverBoxAfterSelection) {
      expect(Math.abs(popoverBoxBeforeSelection.x - popoverBoxAfterSelection.x)).toBeLessThan(1);
      expect(Math.abs(popoverBoxBeforeSelection.y - popoverBoxAfterSelection.y)).toBeLessThan(1);
    }

    await providerSearch.focus();
    await page.mouse.move(8, 8);
    const selectedChoice = page.locator(".lr-filter-choice").filter({ has: selectedCodexCheckbox });
    await expect(selectedChoice).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(selectedCodexCheckbox).toHaveCSS("background-color", "rgb(94, 106, 210)");
    await expect(selectedCodexCheckbox.locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");

    await page.getByRole("menuitemcheckbox", { name: /Claude Code/ }).click();
    await expect(page.locator(".lr-filter-popover")).toBeHidden();
    await expect(appliedFilters.locator(".lr-applied-filter")).toHaveCount(1);

    await expect(appliedFilters).toContainText("Provider");
    await expect(appliedFilters).toContainText("is any of");
    await expect(appliedFilters).toContainText("Codex +1");
    const addFilterButton = appliedFilters.getByRole("button", { name: "Add filter" });
    await expect(addFilterButton).toBeVisible();
    await expect(appliedFilters.getByRole("button", { name: "Clear" })).toBeVisible();
    await expect(trigger).toBeVisible();
    await expect(appliedFilters.locator(".lr-applied-filter").first()).toHaveCSS(
      "border-top-color",
      "rgb(212, 212, 215)",
    );
    await expect(appliedFilters.locator(".lr-applied-filter__property").first()).toHaveCSS(
      "font-weight",
      "400",
    );
    await expect(appliedFilters.locator(".lr-applied-filter__property .lr-icon").first()).toHaveCSS(
      "width",
      "12px",
    );
    await expect(addFilterButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(addFilterButton).toHaveCSS("box-shadow", "none");
    await expect(addFilterButton.locator(".lr-icon")).toHaveCSS("width", "12px");
    const addFilterButtonBox = await addFilterButton.boundingBox();
    expect(addFilterButtonBox).not.toBeNull();
    if (addFilterButtonBox) {
      expect(addFilterButtonBox.width).toBe(24);
      expect(addFilterButtonBox.height).toBe(24);
    }

    await appliedFilters.getByRole("button", { name: "Edit Provider filter" }).click();
    const appliedEditor = page.locator(".lr-applied-filter-popover");
    await expect(appliedEditor).toBeVisible();
    await appliedEditor.getByRole("button", { name: "Remove Codex" }).click();
    await expect(appliedEditor).toBeVisible();
    await expect(appliedFilters.locator(".lr-applied-filter")).toHaveCount(1);
    await expect(appliedFilters).toContainText("Claude Code");
    await appliedEditor.getByRole("menuitemcheckbox", { name: /Codex/ }).click();
    await expect(appliedEditor).toBeHidden();
    await expect(appliedFilters.locator(".lr-applied-filter")).toHaveCount(1);
    await expect(appliedFilters).toContainText("+1");

    await page.setViewportSize({ height: 844, width: 390 });
    await appliedFilters.getByRole("button", { name: "Add filter" }).click();
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

    await mobileDialog.getByRole("menuitem", { name: /Status/ }).click();
    await expect(page.getByRole("dialog", { name: "Status" })).toBeVisible();
    await expect(mobileDialog.getByRole("button", { name: "Back to Filters" })).toBeVisible();
    await mobileDialog.getByRole("button", { name: "Add Ready" }).click();
    await expect(mobileDialog).toBeVisible();
    const appliedFilterGroups = page.locator(".lr-applied-filter");
    await expect(appliedFilterGroups).toHaveCount(2);
    await expect(appliedFilterGroups).toContainText(["Ready", "Provider"]);
    await mobileDialog.getByRole("menuitemcheckbox", { name: /Review/ }).click();
    await expect(mobileDialog).toBeHidden();
    await expect(appliedFilters.locator(".lr-applied-filter")).toHaveCount(2);
    await expect(appliedFilters.getByRole("button", { name: "Edit Status filter" })).toContainText(
      "Ready +1",
    );
    await expect(appliedFilters.getByRole("button", { name: "Add filter" })).toBeFocused();

    await expect
      .poll(() =>
        page.evaluate<boolean>(
          "document.documentElement.scrollWidth === document.documentElement.clientWidth",
        ),
      )
      .toBe(true);

    await page.setViewportSize({ height: 900, width: 1440 });
    await page.reload();
    await expect(page.getByText("Fixture preview", { exact: true })).toBeVisible();
    const boardFilterTrigger = page.getByRole("button", { name: "Filter tasks" });
    const boardTriggerBoxBeforeSelection = await boardFilterTrigger.boundingBox();
    await boardFilterTrigger.click();
    await page.waitForTimeout(160);
    const boardPopoverBoxBeforeSelection = await page.locator(".lr-filter-popover").boundingBox();
    await page.getByRole("menuitem", { name: /Status/ }).click();
    await page.getByRole("button", { name: "Add Ready" }).click();
    await expect(page.locator(".lr-filter-popover")).toBeVisible();
    const boardAppliedFilters = page.getByRole("region", { name: "Applied task filters" });
    await expect(boardFilterTrigger).toBeVisible();
    await expect(boardAppliedFilters.getByRole("button", { name: "Add filter" })).toBeVisible();

    const boardTriggerBoxAfterSelection = await boardFilterTrigger.boundingBox();
    const boardPopoverBoxAfterSelection = await page.locator(".lr-filter-popover").boundingBox();
    if (boardTriggerBoxBeforeSelection && boardTriggerBoxAfterSelection) {
      expect(Math.abs(boardTriggerBoxBeforeSelection.x - boardTriggerBoxAfterSelection.x)).toBeLessThan(1);
      expect(Math.abs(boardTriggerBoxBeforeSelection.y - boardTriggerBoxAfterSelection.y)).toBeLessThan(1);
    }
    if (boardPopoverBoxBeforeSelection && boardPopoverBoxAfterSelection) {
      expect(Math.abs(boardPopoverBoxBeforeSelection.x - boardPopoverBoxAfterSelection.x)).toBeLessThan(1);
      expect(Math.abs(boardPopoverBoxBeforeSelection.y - boardPopoverBoxAfterSelection.y)).toBeLessThan(1);
    }

    await expect(page.getByText("Budget guardrails for parallel agents")).toBeVisible();
    await expect(page.getByText("Board keyboard navigation")).toBeVisible();
    await expect(page.locator(".kanban-board").getByText("Chrome QA adapter spike")).toBeHidden();

    await page.getByRole("menuitemcheckbox", { name: /Review/ }).click();
    await expect(page.locator(".lr-filter-popover")).toBeHidden();
    await expect(page.getByText("SQLite command replay")).toBeVisible();
    await expect(page.getByText("OAuth session recovery")).toBeHidden();
    await expect(boardAppliedFilters).toContainText("Ready +1");

    await boardAppliedFilters.getByRole("button", { name: "Add filter" }).click();
    await expect(page.locator(".lr-filter-popover")).toBeVisible();
    await expect(boardFilterTrigger).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".lr-filter-popover")).toHaveCSS("animation-duration", "0.001s");
    await page.getByRole("menuitem", { name: /Status/ }).hover();
    await expect(page.locator('.lr-filter-level[data-filter-depth="1"]')).toHaveCSS(
      "transition-duration",
      "0.001s",
    );
    await page.keyboard.press("Escape");
    await expect(boardAppliedFilters.getByRole("button", { name: "Add filter" })).toBeFocused();
  });
});
