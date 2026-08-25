import { beforeEach, describe, expect, it } from "vitest";

import { applyDensityPreference, isDensityPreference, readDensityPreference } from "./density";

describe("density preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-density");
  });

  it("defaults to comfortable", () => {
    expect(readDensityPreference()).toBe("comfortable");
  });

  it("stores and applies a compact board", () => {
    applyDensityPreference("compact");

    expect(document.documentElement.dataset["density"]).toBe("compact");
    expect(readDensityPreference()).toBe("compact");
  });

  it("clears the attribute when returning to the default", () => {
    applyDensityPreference("compact");
    applyDensityPreference("comfortable");

    // The stylesheet carries comfortable as its base, so the default must leave no attribute behind.
    expect(document.documentElement.hasAttribute("data-density")).toBe(false);
    expect(window.localStorage.getItem("loomrail-density")).toBeNull();
  });

  it("rejects unknown persisted values", () => {
    expect(isDensityPreference("cosy")).toBe(false);
  });
});
