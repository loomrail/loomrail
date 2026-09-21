import { expect, test } from "@playwright/test";

import cliPackage from "../../cli/package.json" with { type: "json" };
import guidedActivationSource from "../../../packages/contracts/src/guided-activation.v1.json" with { type: "json" };

const installCommand = guidedActivationSource.install.commands.join("\n");

test.describe("protected landing canonical activation", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText(value: string): Promise<void> {
            localStorage.setItem("loomrail-landing-e2e-clipboard", value);
            return Promise.resolve();
          },
        },
      });
    });
    await page.goto("/");
  });

  test("renders and copies the canonical safe route with the current public version", async ({ page }) => {
    const commands = page.locator("[data-install-commands] .line");
    await expect(commands).toHaveCount(guidedActivationSource.install.commands.length);
    expect(await commands.allTextContents()).toEqual(guidedActivationSource.install.commands);
    await expect(page.locator("[data-product-version]")).toHaveText(cliPackage.version);

    const copy = page.getByRole("button", { name: "Copy the safe install and launch commands" });
    await copy.focus();
    await expect(copy).toBeFocused();
    const [copyFeedback] = await Promise.all([
      page.evaluate(
        () =>
          new Promise<{ label: string; state: string }>((resolve) => {
            const button = document.querySelector<HTMLButtonElement>("[data-copy]");
            if (button === null) throw new Error("Copy button is missing");
            const observer = new MutationObserver(() => {
              if (button.dataset["state"] !== "success") return;
              observer.disconnect();
              resolve({
                label: button.querySelector<HTMLElement>("[data-copy-label]")?.textContent ?? "",
                state: button.dataset["state"],
              });
            });
            observer.observe(button, { attributes: true, childList: true, subtree: true });
          }),
      ),
      copy.press("Enter"),
    ]);
    expect(copyFeedback).toEqual({ label: "Copied", state: "success" });
    expect(await page.evaluate(() => localStorage.getItem("loomrail-landing-e2e-clipboard"))).toBe(
      installCommand,
    );
  });

  test("keeps the real-provider boundary explicit in both themes and both locales", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByText(/local CLI's existing subscription login/)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/\bMock\b/i);
    const lightBackground = await page
      .locator("body")
      .evaluate((body) => getComputedStyle(body).backgroundColor);

    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const darkBackground = await page
      .locator("body")
      .evaluate((body) => getComputedStyle(body).backgroundColor);
    expect(darkBackground).not.toBe(lightBackground);

    await page.getByRole("button", { name: "Switch to Russian" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByText(/подписочный login локального CLI/)).toBeVisible();
    expect(await page.locator("[data-install-commands] .line").allTextContents()).toEqual(
      guidedActivationSource.install.commands,
    );
  });

  test("starts with a visible keyboard skip target", async ({ page }) => {
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await expect(skipLink).toBeFocused();
    await skipLink.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  test("explores all six stages by keyboard without starting a provider", async ({ page }) => {
    const route = page.locator(".route-stage");
    await expect(route).toHaveCount(6);
    for (let index = 0; index < 6; index += 1) {
      const stage = route.nth(index);
      const summary = stage.locator("summary");
      await summary.focus();
      await expect(summary).toBeFocused();
      expect(await summary.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
      if (!(await stage.evaluate((node) => node.hasAttribute("open")))) await summary.press("Enter");
      await expect(stage.locator(".route-detail")).toBeVisible();
      await summary.press("Enter");
      await expect(stage.locator(".route-detail")).toBeHidden();
    }
    await page.getByRole("button", { name: "Switch to Russian" }).click();
    await expect(page.locator('[data-i18n="researchBody"]')).toContainText(
      "пока исследование, не готовый режим",
    );
    await expect(page.locator('[data-i18n="starterNewLimit"]')).toContainText("один шаблон");
    await expect(page.locator('[data-i18n="routeNote"]')).toContainText("не живой запуск");
  });

  test("keeps content readable with reduced motion and doubled text size", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Switch to Russian" }).click();
    await page.getByRole("button", { name: "Переключить на тёмную тему" }).click();
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expect(page.locator(".route-stage").first().locator(".route-detail")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator("html").evaluate((node) => getComputedStyle(node).scrollBehavior)).toBe("auto");
  });

  for (const width of [320, 375, 414, 768]) {
    test(`has no page overflow at ${width.toString()}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
      await expect(page.locator("[data-install-commands]")).toBeVisible();
      for (const locale of ["en", "ru"]) {
        if (locale === "ru") await page.getByRole("button", { name: "Switch to Russian" }).click();
        for (const theme of ["light", "dark"]) {
          if (theme === "dark") await page.locator("[data-theme-toggle]").click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await expect(page.locator(".route-map")).toBeVisible();
          await expect(page.locator(".starter-feature")).toBeVisible();
        }
        await page.locator("[data-theme-toggle]").click();
      }
    });
  }
});
