import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { initializeLanding } from "./main";

const writeTextMock = vi.fn<(value: string) => Promise<void>>();

function renderControls(): void {
  document.documentElement.innerHTML = `
    <head>
      <title>Landing</title>
      <meta name="description" content="Description" />
      <meta property="og:title" content="Title" />
      <meta property="og:description" content="Description" />
    </head>
    <body>
      <button data-locale-toggle><span data-locale-toggle-label>RU</span></button>
      <p data-i18n="heroTitle">Hero</p>
      <a data-doc-link="quick-start" href="https://example.test/start">Guide</a>
      <button data-theme-toggle><span data-theme-label></span></button>
      <img data-product-image data-i18n-alt="workbenchAlt" alt="Workbench" />
      <button data-copy><span data-copy-label data-i18n="copy">Copy</span></button>
    </body>
  `;
  delete document.documentElement.dataset["landingReady"];
  delete document.documentElement.dataset["theme"];
}

describe("landing interactions", () => {
  beforeEach(() => {
    renderControls();
    localStorage.clear();
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: "en-US",
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
      }),
    });
    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    initializeLanding(document, window);
  });

  test("switches and stores the selected theme across every product capture", () => {
    const toggle = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    const images = document.querySelectorAll<HTMLImageElement>("[data-product-image]");
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect([...images].every((image) => image.src.includes("workbench-light.png"))).toBe(true);

    toggle?.click();

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("loomrail-landing-theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
    expect([...images].every((image) => image.src.includes("workbench-dark.png"))).toBe(true);
  });

  test("switches the full document and guide destination to Russian", () => {
    document.querySelector<HTMLButtonElement>("[data-locale-toggle]")?.click();

    expect(document.documentElement.lang).toBe("ru");
    expect(document.title).toBe("Loomrail — задача не заканчивается вместе с чатом.");
    expect(localStorage.getItem("loomrail-landing-locale")).toBe("ru");
    expect(document.querySelector<HTMLElement>('[data-i18n="heroTitle"]')?.textContent).toBe(
      "Задача не заканчивается вместе с чатом.",
    );
    expect(document.querySelector<HTMLAnchorElement>('[data-doc-link="quick-start"]')?.href).toContain(
      "GETTING-STARTED.ru.md",
    );
    expect(document.querySelector("[data-locale-toggle-label]")?.textContent).toBe("EN");
  });

  test("copies the complete project-local safe-start sequence", async () => {
    const copy = document.querySelector<HTMLButtonElement>("[data-copy]");
    copy?.click();
    await Promise.resolve();

    expect(writeTextMock).toHaveBeenCalledWith(
      [
        "mkdir loomrail-evaluation",
        "cd loomrail-evaluation",
        "npm install loomrail@next",
        "npx loomrail",
      ].join("\n"),
    );
    expect(copy?.dataset["state"]).toBe("success");
    expect(copy?.textContent).toBe("Copied");
  });
});

describe("landing public contract", () => {
  test("uses local resources and publishes the honest bilingual alpha.2 boundary", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const resources = parsed.querySelectorAll<HTMLScriptElement | HTMLImageElement | HTMLLinkElement>(
      'script[src], img[src], link[rel="icon"], link[rel="stylesheet"], link[rel="preload"]',
    );
    for (const resource of resources) {
      const value = resource.getAttribute("src") ?? resource.getAttribute("href");
      expect(value?.startsWith("http")).toBe(false);
    }

    expect(parsed.querySelectorAll("h1")).toHaveLength(1);
    expect(html).toContain("The task outlives the chat.");
    expect(html).toContain("0.1.0-alpha.2");
    expect(html).toContain("Apache-2.0");
    expect(html).not.toContain("· MIT ·");
    expect(html).toContain("npm install loomrail@next");
    expect(html).toContain("data-locale-toggle");
    expect(html).toContain("Try Loomrail without giving it a repository.");
    expect(html).toContain("Automatic commit, push, merge, deploy, or browser execution.");
    expect(html).toContain("A complete operating-system sandbox");
    expect(parsed.querySelectorAll("[data-product-image]")).toHaveLength(1);
    expect(parsed.querySelectorAll("[data-product-image]")[0]?.getAttribute("loading")).toBe("lazy");
    expect(parsed.querySelectorAll("[data-copy-label][aria-live='polite']")).toHaveLength(1);
    expect(html).not.toMatch(/plausible|segment|google-analytics|gtag|mixpanel/i);
  });
});
