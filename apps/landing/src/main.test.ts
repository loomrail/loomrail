import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import cliPackage from "../../cli/package.json" with { type: "json" };
import guidedActivationSource from "../../../packages/contracts/src/guided-activation.v1.json" with { type: "json" };

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
      <button data-copy><span data-copy-label data-i18n="copy">Copy</span></button>
      <pre><code data-install-commands></code></pre>
      <span data-product-version></span>
      <section><p data-i18n="whyTitle">Why</p></section>
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

  test("switches and stores the selected theme", () => {
    const toggle = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
    expect(document.documentElement.dataset["theme"]).toBe("light");

    toggle?.click();

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("loomrail-landing-theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
  });

  test("switches the full document and guide destination to Russian", () => {
    document.querySelector<HTMLButtonElement>("[data-locale-toggle]")?.click();

    expect(document.documentElement.lang).toBe("ru");
    expect(document.title).toBe("Loomrail — AI-команда. Результат под контролем.");
    expect(localStorage.getItem("loomrail-landing-locale")).toBe("ru");
    expect(document.querySelector<HTMLElement>('[data-i18n="heroTitle"]')?.textContent).toBe(
      "AI-команда. Результат под контролем.",
    );
    expect(document.querySelector<HTMLElement>('[data-i18n="whyTitle"]')?.textContent).toBe(
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

    expect(writeTextMock).toHaveBeenCalledWith(guidedActivationSource.install.commands.join("\n"));
    expect(copy?.dataset["state"]).toBe("success");
    expect(copy?.textContent).toBe("Copied");
  });

  test("renders the canonical commands and current CLI version", () => {
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-install-commands] .line")].map(
        (line) => line.textContent,
      ),
    ).toEqual(guidedActivationSource.install.commands);
    expect(document.querySelector("[data-install-commands] .line-last")?.textContent).toBe(
      guidedActivationSource.install.commands.at(-1),
    );
    expect(document.querySelector("[data-product-version]")?.textContent).toBe(cliPackage.version);
  });

  test("shows an explicit error state when clipboard access is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const copy = document.querySelector<HTMLButtonElement>("[data-copy]");

    copy?.click();

    expect(copy?.dataset["state"]).toBe("error");
    expect(copy?.disabled).toBe(false);
    expect(copy?.textContent).toBe("Failed");
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

  test("publishes one heading outline and no unverified product recording", () => {
    expect(parsed.querySelectorAll("h1")).toHaveLength(1);
    expect(parsed.querySelectorAll("[data-product-demo]")).toHaveLength(0);
    expect(parsed.querySelectorAll("[data-copy-label][aria-live='polite']")).toHaveLength(1);
    expect(html).toContain("data-locale-toggle");
  });

  test("publishes the honest bilingual macOS Stable boundary without duplicating the activation contract", () => {
    expect(html).toContain("The task outlives the chat.");
    expect(html).toContain("Apache-2.0");
    expect(html).not.toContain("· MIT ·");
    expect(html).not.toContain("0.1.0-alpha.2");
    expect(html).not.toContain("npm install loomrail@latest");
    expect(html).toContain("data-install-commands");
    expect(html).toContain("data-product-version");
    expect(html).toContain("macOS Apple Silicon");
    expect(html).toContain("Windows/Linux live-provider support");
    expect(html).toContain("Try Loomrail without giving it a repository.");
    expect(html).toContain("Automatic commit, push, merge, deploy, or browser execution.");
    expect(html).toContain("A complete operating-system sandbox");
    expect(html).not.toMatch(/\bmock\b/i);
  });

  test("keeps publication control and the automatic-deployment boundary explicit", () => {
    for (const promise of ["Never commits", "Never pushes", "Never merges", "No automatic deploy"]) {
      expect(html).toContain(promise);
    }
  });
  test("uses native workflow disclosure without simulated activity or scroll reveals", () => {
    expect(parsed.querySelectorAll(".route-stage")).toHaveLength(6);
    expect([...parsed.querySelectorAll(".route-stage summary")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Discovery"),
        expect.stringContaining("Plan"),
        expect.stringContaining("Implement"),
        expect.stringContaining("Review"),
        expect.stringContaining("QA"),
        expect.stringContaining("Acceptance"),
      ]),
    );
    expect(parsed.querySelectorAll("[data-flow], [data-reveal]")).toHaveLength(0);
    expect(parsed.querySelectorAll(".route-stage[open]")).toHaveLength(1);
  });

  test("every public message is translated, with research and one-recipe limits intact", () => {
    document.documentElement.innerHTML = parsed.documentElement.innerHTML;
    delete document.documentElement.dataset["landingReady"];
    localStorage.clear();
    stubMatchMedia(true);
    initializeLanding(document, window);
    const en = [...document.querySelectorAll<HTMLElement>("[data-i18n]")].map((node) => ({
      key: node.dataset["i18n"],
      text: node.textContent,
    }));
    document.querySelector<HTMLButtonElement>("[data-locale-toggle]")?.click();
    expect(document.documentElement.lang).toBe("ru");
    const invariant = new Set(["heroPlatform", "runtimeValue", "platformValue", "footerIssues"]);
    for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
      const previous = en.find((item) => item.key === node.dataset["i18n"]);
      expect(node.textContent.trim().length).toBeGreaterThan(0);
      if (!invariant.has(node.dataset["i18n"] ?? "")) {
        expect(node.textContent, node.dataset["i18n"]).not.toBe(previous?.text);
      }
    }
    expect(document.querySelector('[data-i18n="researchBody"]')?.textContent).toContain(
      "пока исследование, не готовый режим",
    );
    expect(document.querySelector('[data-i18n="starterNewLimit"]')?.textContent).toContain("один шаблон");
    document.querySelector<HTMLButtonElement>("[data-locale-toggle]")?.click();
    expect(document.querySelector('[data-i18n="researchBody"]')?.textContent).toContain(
      "researched, not shipped",
    );
    expect(document.querySelector('[data-i18n="starterNewLimit"]')?.textContent).toContain(
      "One built-in recipe",
    );
  });
});
