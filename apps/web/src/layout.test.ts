import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

import { beforeEach, describe, expect, it } from "vitest";

import {
  applyPanelWidth,
  clampPanelWidth,
  hasCustomPanelWidths,
  panelBounds,
  panels,
  readPanelWidth,
  resetPanelWidths,
} from "./layout";

const tokens = readFileSync(createRequire(import.meta.url).resolve("@loomrail/ui/tokens.css"), "utf8");

describe("panel layout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    for (const panel of panels) document.documentElement.style.removeProperty(panelBounds[panel].property);
  });

  it("keeps its defaults in step with the design tokens", () => {
    // The stylesheet owns the default width; this module only mirrors it for clamping.
    for (const panel of panels) {
      const { defaultWidth, property } = panelBounds[panel];
      expect(tokens).toContain(`${property}: ${defaultWidth.toString()}px;`);
    }
  });

  it("is restored before hydration with the same bounds", () => {
    // The pre-hydration script cannot import this module, so it restates the bounds. Drift there
    // would let a stored width through unclamped, or make the loading shell jump on first paint.
    const bootstrap = readFileSync(resolve(process.cwd(), "public/theme-bootstrap.js"), "utf8");

    for (const panel of panels) {
      const { max, min, property } = panelBounds[panel];
      expect(bootstrap).toContain(`"loomrail-panel-${panel}"`);
      expect(bootstrap).toContain(`max: ${max.toString()}`);
      expect(bootstrap).toContain(`min: ${min.toString()}`);
      expect(bootstrap).toContain(`property: "${property}"`);
    }
  });

  it("clamps a width to the panel's bounds", () => {
    expect(clampPanelWidth("sidebar", 10)).toBe(panelBounds.sidebar.min);
    expect(clampPanelWidth("sidebar", 9000)).toBe(panelBounds.sidebar.max);
    expect(clampPanelWidth("inspector", 400)).toBe(400);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampPanelWidth("inspector", Number.NaN)).toBe(panelBounds.inspector.defaultWidth);
  });

  it("stores and applies a custom width", () => {
    applyPanelWidth("sidebar", 300);

    expect(document.documentElement.style.getPropertyValue("--lr-size-sidebar")).toBe("300px");
    expect(readPanelWidth("sidebar")).toBe(300);
    expect(hasCustomPanelWidths()).toBe(true);
  });

  it("hands the default back to the stylesheet instead of pinning it", () => {
    applyPanelWidth("sidebar", 300);
    applyPanelWidth("sidebar", panelBounds.sidebar.defaultWidth);

    // Pinning the default would defeat the narrower default the stylesheet uses on small desktops.
    expect(document.documentElement.style.getPropertyValue("--lr-size-sidebar")).toBe("");
    expect(hasCustomPanelWidths()).toBe(false);
  });

  it("ignores a stored value outside the bounds", () => {
    window.localStorage.setItem("loomrail-panel-inspector", "5000");

    expect(readPanelWidth("inspector")).toBe(panelBounds.inspector.max);
  });

  it("resets every panel at once", () => {
    applyPanelWidth("sidebar", 300);
    applyPanelWidth("inspector", 420);

    resetPanelWidths();

    expect(hasCustomPanelWidths()).toBe(false);
    expect(readPanelWidth("inspector")).toBe(panelBounds.inspector.defaultWidth);
  });
});
