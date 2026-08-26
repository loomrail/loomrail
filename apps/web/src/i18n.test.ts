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

  it("does not describe a running session's window occupancy as a handoff", () => {
    // Occupancy is saved on every report now (migration 0009), not only the reading that crosses
    // the handoff threshold, so the label a session gets by default must not claim a handoff
    // happened. "At handoff" survives as its own key, which the cockpit picks only for a session
    // that actually asked to wind down.
    expect(translate("en", "workflow.sessions.occupancy", { percent: 40 })).toBe("40% of the window used");
    expect(translate("en", "workflow.sessions.occupancyAtHandoff", { percent: 92 })).toBe(
      "92% of the window at handoff",
    );
    for (const locale of ["en", "ru"] as const) {
      expect(translate(locale, "workflow.sessions.occupancy", { percent: 40 })).not.toBe(
        translate(locale, "workflow.sessions.occupancyAtHandoff", { percent: 40 }),
      );
    }
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
