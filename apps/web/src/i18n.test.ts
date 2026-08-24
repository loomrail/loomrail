import { beforeEach, describe, expect, it } from "vitest";

import { applyLocale, isLocale, readLocale, translate } from "./i18n";

describe("i18n", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = "en";
  });

  it("provides typed English and Russian messages", () => {
    expect(translate("en", "state.IN_PROGRESS")).toBe("Running");
    expect(translate("ru", "state.IN_PROGRESS")).toBe("В работе");
    expect(translate("ru", "task.moveTo", { state: "Готово" })).toBe("Переместить в «Готово»");
  });

  it("persists and applies the selected locale", () => {
    applyLocale("ru");
    expect(readLocale()).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("rejects unsupported locale values", () => {
    expect(isLocale("de")).toBe(false);
  });
});
