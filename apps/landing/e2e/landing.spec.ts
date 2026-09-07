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
    await copy.press("Enter");
    await expect(copy).toHaveAttribute("data-state", "success");
    await expect(copy).toContainText("Copied");
    expect(await page.evaluate(() => localStorage.getItem("loomrail-landing-e2e-clipboard"))).toBe(
      installCommand,
    );
  });

  test("keeps the real-provider boundary explicit in both themes and both locales", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByText(/OpenAI Responses API or Anthropic Messages API/)).toBeVisible();
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
    await expect(page.getByText(/OpenAI Responses API или Anthropic Messages API/)).toBeVisible();
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
    });
  }
});
