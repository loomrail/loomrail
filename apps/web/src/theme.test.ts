import { beforeEach, describe, expect, it } from "vitest";

import { applyThemePreference, isThemePreference, readThemePreference } from "./theme";

describe("theme preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to the system theme", () => {
    expect(readThemePreference()).toBe("system");
  });

  it("stores and applies an explicit theme", () => {
    applyThemePreference("dark");

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(readThemePreference()).toBe("dark");
  });

  it("rejects unknown persisted values", () => {
    expect(isThemePreference("midnight")).toBe(false);
  });
});
