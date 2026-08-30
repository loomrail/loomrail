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
      <a data-doc-link="getting-started" href="https://example.test/start">Guide</a>
      <button data-theme-toggle><span data-theme-label></span></button>
      <button data-copy="npm install loomrail@next"><span data-copy-label data-i18n="copy">Copy</span></button>
      <button data-command-open>Menu</button>
      <dialog data-command-dialog>
        <input data-command-search data-i18n-placeholder="searchPlaceholder" />
        <button data-command-close>Close</button>
        <ul>
          <li><a class="command-link" href="#route"><span data-i18n="routeNav">Route</span><span>Section</span></a></li>
          <li><a class="command-link" href="#install"><span data-i18n="installNav">Install</span><span>Section</span></a></li>
        </ul>
        <p data-command-empty hidden data-i18n="noDestination">Empty</p>
      </dialog>
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
    HTMLDialogElement.prototype.showModal = function showModal(): void {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close(): void {
      this.open = false;
    };
    initializeLanding(document, window);
  });

  test("switches and stores the selected theme", () => {
    const toggle = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    toggle?.click();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("loomrail-landing-theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
  });

  test("switches the full document and guide destinations to Russian", () => {
    document.querySelector<HTMLButtonElement>('[data-locale="ru"]')?.click();
    expect(document.documentElement.lang).toBe("ru");
    expect(document.title).toBe("Loomrail — Агенты предлагают. Владелец принимает.");
    expect(localStorage.getItem("loomrail-landing-locale")).toBe("ru");
    expect(document.querySelector<HTMLElement>('[data-i18n="heroTitle"]')?.textContent).toBe(
      "Агенты предлагают. Владелец принимает.",
    );
    expect(document.querySelector<HTMLAnchorElement>('[data-doc-link="getting-started"]')?.href).toContain(
      "GETTING-STARTED.ru.md",
    );
    expect(document.querySelector('[data-locale="ru"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  test("copies the explicit project-local pre-alpha install command", async () => {
    const copy = document.querySelector<HTMLButtonElement>("[data-copy]");
    copy?.click();
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith("npm install loomrail@next");
    expect(copy?.dataset["state"]).toBe("success");
    expect(copy?.textContent).toBe("Copied");
  });

  test("opens, filters and closes the keyboard palette", () => {
    const dialog = document.querySelector<HTMLDialogElement>("[data-command-dialog]");
    const search = document.querySelector<HTMLInputElement>("[data-command-search]");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(dialog?.open).toBe(true);
    if (search !== null) {
      search.value = "install";
      search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    const routeItem = document.querySelector<HTMLAnchorElement>('a[href="#route"]')?.closest("li");
    const installItem = document.querySelector<HTMLAnchorElement>('a[href="#install"]')?.closest("li");
    expect(routeItem?.hidden).toBe(true);
    expect(installItem?.hidden).toBe(false);
    search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog?.open).toBe(false);
  });
});

describe("landing public contract", () => {
  test("uses local resources and publishes the honest bilingual install boundary", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const resources = parsed.querySelectorAll<HTMLScriptElement | HTMLImageElement | HTMLLinkElement>(
      'script[src], img[src], link[rel="icon"], link[rel="stylesheet"], link[rel="preload"]',
    );
    for (const resource of resources) {
      const value = resource.getAttribute("src") ?? resource.getAttribute("href");
      expect(value?.startsWith("http")).toBe(false);
    }
    expect(html).toContain("Agents propose. Owners accept.");
    expect(html).toContain("Public pre-alpha");
    expect(html).toContain("npm install loomrail@next");
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('data-locale="ru"');
    expect(html).toContain("No automatic commit, push, merge, or deploy.");
    expect(html).not.toMatch(/plausible|segment|google-analytics|gtag|mixpanel/i);
  });
});
