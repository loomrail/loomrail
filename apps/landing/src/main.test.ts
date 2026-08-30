import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { initializeLanding } from "./main";

const writeTextMock = vi.fn<(value: string) => Promise<void>>();

function renderControls(): void {
  document.documentElement.innerHTML = `
    <head></head>
    <body>
      <button data-theme-toggle><span data-theme-label></span></button>
      <button data-copy="npm install -g loomrail@next">Copy</button>
      <button data-command-open>Menu</button>
      <dialog data-command-dialog>
        <input data-command-search />
        <button data-command-close>Close</button>
        <ul>
          <li><a class="command-link" href="#route">Route Section</a></li>
          <li><a class="command-link" href="#install">Install Section</a></li>
        </ul>
        <p data-command-empty hidden>Empty</p>
      </dialog>
    </body>
  `;
  delete document.documentElement.dataset["landingReady"];
}

describe("landing interactions", () => {
  beforeEach(() => {
    renderControls();
    localStorage.clear();
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
    expect(toggle).not.toBeNull();
    toggle?.click();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("loomrail-landing-theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
  });

  test("copies the explicit pre-alpha install command", async () => {
    const copy = document.querySelector<HTMLButtonElement>("[data-copy]");
    copy?.click();
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith("npm install -g loomrail@next");
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
    document.querySelector<HTMLButtonElement>("[data-command-close]")?.click();
    expect(dialog?.open).toBe(false);
  });
});

describe("landing public contract", () => {
  test("uses local resources and includes the canonical descriptor", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const resources = parsed.querySelectorAll<HTMLScriptElement | HTMLImageElement | HTMLLinkElement>(
      'script[src], img[src], link[rel="icon"], link[rel="stylesheet"], link[rel="preload"]',
    );
    for (const resource of resources) {
      const value = resource.getAttribute("src") ?? resource.getAttribute("href");
      expect(value?.startsWith("http")).toBe(false);
    }
    expect(html).toContain("The local control plane for accountable AI software teams.");
    expect(html).toContain("Public pre-alpha");
    expect(html).toContain("No account · No analytics");
    expect(html).not.toMatch(/plausible|segment|google-analytics|gtag|mixpanel/i);
  });
});
