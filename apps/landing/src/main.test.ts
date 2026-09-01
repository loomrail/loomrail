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
      <video data-product-demo poster="./demo/mock-route-light.webp">
        <source data-demo-format="webm" src="./demo/mock-route-light.webm" type="video/webm" />
        <source data-demo-format="mp4" src="./demo/mock-route-light.mp4" type="video/mp4" />
      </video>
      <button data-copy><span data-copy-label data-i18n="copy">Copy</span></button>
      <section data-reveal><p data-i18n="whyTitle">Why</p></section>
      <ol data-flow><li>Backlog</li><li>Ready</li><li>Running</li></ol>
    </body>
  `;
  delete document.documentElement.dataset["landingReady"];
  delete document.documentElement.dataset["theme"];
  delete document.documentElement.dataset["motion"];
}

function stubMatchMedia(reducedMotion: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("reduced-motion") ? reducedMotion : false,
      addEventListener: vi.fn(),
    })),
  });
}

describe("landing interactions", () => {
  beforeEach(() => {
    renderControls();
    localStorage.clear();
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: "en-US",
    });
    stubMatchMedia(false);
    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    initializeLanding(document, window);
  });

  test("switches and stores the selected theme across the hero recording", () => {
    const toggle = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    const sources = () => [...document.querySelectorAll<HTMLSourceElement>("source[data-demo-format]")];
    const poster = () => document.querySelector<HTMLVideoElement>("[data-product-demo]")?.poster ?? "";
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(sources().every((source) => source.src.includes("mock-route-light"))).toBe(true);
    expect(poster()).toContain("mock-route-light.webp");

    toggle?.click();

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("loomrail-landing-theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
    expect(sources().every((source) => source.src.includes("mock-route-dark"))).toBe(true);
    expect(poster()).toContain("mock-route-dark.webp");
    expect(sources().map((source) => source.dataset["demoFormat"])).toEqual(["webm", "mp4"]);
  });

  test("switches the full document and guide destination to Russian", () => {
    document.querySelector<HTMLButtonElement>("[data-locale-toggle]")?.click();

    expect(document.documentElement.lang).toBe("ru");
    expect(document.title).toBe("Loomrail — задача не заканчивается вместе с чатом.");
    expect(localStorage.getItem("loomrail-landing-locale")).toBe("ru");
    expect(document.querySelector<HTMLElement>('[data-i18n="heroTitle"]')?.textContent).toBe(
      "Задача не заканчивается вместе с чатом.",
    );
    expect(document.querySelector<HTMLElement>('[data-i18n="whyTitle"]')?.textContent).toBe(
      "Чат — плохое место для задачи.",
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

  test("marks exactly one workflow stage as current", () => {
    expect(document.querySelectorAll("[data-flow] .is-current")).toHaveLength(1);
  });

  test("leaves revealed sections untouched when the browser cannot observe them", () => {
    expect(document.documentElement.dataset["motion"]).toBeUndefined();
    expect(document.querySelector("[data-reveal]")?.className).toBe("");
  });
});

describe("landing reveal", () => {
  function stubObserver(): void {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element): void {
          this.callback(
            [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        unobserve(): void {
          // The reveal stub fires once on observe; nothing ever needs to be detached.
        }
      },
    });
  }

  beforeEach(() => {
    renderControls();
    localStorage.clear();
    stubObserver();
  });

  test("arms motion and reveals observed sections", () => {
    stubMatchMedia(false);
    initializeLanding(document, window);

    expect(document.documentElement.dataset["motion"]).toBe("ready");
    expect(document.querySelector("[data-reveal]")?.classList.contains("is-visible")).toBe(true);
  });

  test("never hides content for a reader who asked for reduced motion", () => {
    stubMatchMedia(true);
    initializeLanding(document, window);

    expect(document.documentElement.dataset["motion"]).toBeUndefined();
  });
});

describe("landing public contract", () => {
  const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");

  test("uses local resources only", () => {
    const resources = parsed.querySelectorAll<HTMLScriptElement | HTMLImageElement | HTMLLinkElement>(
      'script[src], img[src], link[rel="icon"], link[rel="stylesheet"], link[rel="preload"]',
    );
    for (const resource of resources) {
      const value = resource.getAttribute("src") ?? resource.getAttribute("href");
      expect(value?.startsWith("http")).toBe(false);
    }
    expect(html).not.toMatch(/plausible|segment|google-analytics|gtag|mixpanel/i);
  });

  test("keeps the declared style-src policy satisfiable", () => {
    expect(parsed.querySelectorAll("style")).toHaveLength(0);
    expect(parsed.querySelectorAll("[style]")).toHaveLength(0);
  });

  test("publishes one heading outline and one product recording", () => {
    expect(parsed.querySelectorAll("h1")).toHaveLength(1);
    const demo = parsed.querySelectorAll<HTMLVideoElement>("[data-product-demo]");
    expect(demo).toHaveLength(1);
    // Muted and inline are what let the recording autoplay at all; a poster keeps the hero
    // meaningful before the file loads, and both codecs keep it playable outside Chromium.
    expect(demo[0]?.hasAttribute("muted")).toBe(true);
    expect(demo[0]?.hasAttribute("loop")).toBe(true);
    expect(demo[0]?.hasAttribute("playsinline")).toBe(true);
    expect(demo[0]?.getAttribute("poster")).toBe("./demo/mock-route-light.webp");
    expect([...(demo[0]?.querySelectorAll("source") ?? [])].map((s) => s.getAttribute("type"))).toEqual([
      "video/webm",
      "video/mp4",
    ]);
    expect(parsed.querySelectorAll("[data-copy-label][aria-live='polite']")).toHaveLength(1);
    expect(html).toContain("data-locale-toggle");
  });

  test("publishes the honest bilingual alpha.2 boundary", () => {
    expect(html).toContain("The task outlives the chat.");
    expect(html).toContain("0.1.0-alpha.2");
    expect(html).toContain("Apache-2.0");
    expect(html).not.toContain("· MIT ·");
    expect(html).toContain("npm install loomrail@next");
    expect(html).toContain("Try Loomrail without giving it a repository.");
    expect(html).toContain("Automatic commit, push, merge, deploy, or browser execution.");
    expect(html).toContain("A complete operating-system sandbox");
  });

  test("repeats the never-does guarantees the README makes", () => {
    for (const promise of ["Never commits", "Never pushes", "Never merges", "Never deploys"]) {
      expect(html).toContain(promise);
    }
  });
});
