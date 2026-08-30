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
      <button data-locale="en">EN</button>
      <button data-locale="ru">RU</button>
      <p data-i18n="heroTitle">Hero</p>
      <a data-doc-link="quick-start" href="https://example.test/start">Guide</a>
      <button data-theme-toggle><span data-theme-label></span></button>
      <img data-product-image data-i18n-alt="workbenchAlt" alt="Workbench" />
      <button data-copy=""><span data-copy-label data-i18n="copy">Copy</span></button>
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

  test("switches and stores the selected theme with the matching product capture", () => {
    const toggle = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    const image = document.querySelector<HTMLImageElement>("[data-product-image]");
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(image?.getAttribute("src")).toContain("workbench-light.png");

    toggle?.click();

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("loomrail-landing-theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
    expect(image?.getAttribute("src")).toContain("workbench-dark.png");
  });

  test("switches the full document and guide destination to Russian", () => {
    document.querySelector<HTMLButtonElement>('[data-locale="ru"]')?.click();

    expect(document.documentElement.lang).toBe("ru");
    expect(document.title).toBe("Loomrail — локальный центр управления ответственной работой AI-команды.");
    expect(localStorage.getItem("loomrail-landing-locale")).toBe("ru");
    expect(document.querySelector<HTMLElement>('[data-i18n="heroTitle"]')?.textContent).toBe(
      "Локальный центр управления ответственной работой AI-команды",
    );
    expect(document.querySelector<HTMLAnchorElement>('[data-doc-link="quick-start"]')?.href).toContain(
      "GETTING-STARTED.ru.md",
    );
    expect(document.querySelector('[data-locale="ru"]')?.getAttribute("aria-pressed")).toBe("true");
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
    expect(html).toContain("The local control plane for accountable AI software teams.");
    expect(html).toContain("0.1.0-alpha.2");
    expect(html).toContain("npm install loomrail@next");
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('data-locale="ru"');
    expect(html).toContain("No automatic commit, push, merge, or deploy.");
    expect(html).toContain("A complete operating-system security sandbox");
    expect(parsed.querySelector("[data-product-image]")?.getAttribute("loading")).toBe("lazy");
    expect(html).not.toMatch(/plausible|segment|google-analytics|gtag|mixpanel/i);
  });
});
