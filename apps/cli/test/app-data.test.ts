import { describe, expect, it } from "vitest";

import { resolveLoomrailDataDirectory, resolveLoomrailDataLocation } from "../src/app-data.js";

describe("Loomrail application-data paths", () => {
  it("uses Application Support on macOS", () => {
    expect(
      resolveLoomrailDataDirectory({
        platform: "darwin",
        homeDirectory: "/Users/local owner",
        environment: {},
      }),
    ).toBe("/Users/local owner/Library/Application Support/Loomrail");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveLoomrailDataDirectory({
        platform: "win32",
        homeDirectory: "C:\\Users\\local owner",
        environment: { LOCALAPPDATA: "C:\\Users\\local owner\\AppData\\Local" },
      }),
    ).toBe("C:\\Users\\local owner\\AppData\\Local\\Loomrail");
  });

  it("allows an explicit local data override", () => {
    expect(
      resolveLoomrailDataDirectory({
        platform: "linux",
        homeDirectory: "/home/local",
        environment: { LOOMRAIL_DATA_DIR: "/tmp/loomrail isolated" },
      }),
    ).toBe("/tmp/loomrail isolated");
    expect(
      resolveLoomrailDataLocation({
        platform: "linux",
        homeDirectory: "/home/local",
        environment: { LOOMRAIL_DATA_DIR: "/tmp/loomrail isolated" },
      }),
    ).toEqual({
      directory: "/tmp/loomrail isolated",
      source: "ENVIRONMENT_OVERRIDE",
    });
  });
});
