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
    expect(translate("ru", "task.moveTo", { state: "Бэклог" })).toBe("Переместить в «Бэклог»");
  });

  it("keeps the ready and done state labels distinguishable", () => {
    // READY is a queue position, DONE is the end of the route: a reader must never confuse them.
    for (const locale of ["en", "ru"] as const) {
      expect(translate(locale, "state.READY")).not.toBe(translate(locale, "state.DONE"));
    }
    expect(translate("ru", "state.READY")).toBe("Готово к работе");
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
