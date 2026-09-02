import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { LOOMRAIL_VERSION } from "../src/version.js";

describe("bundled product version", () => {
  it("matches the CLI package used by the release manifest", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    expect(LOOMRAIL_VERSION).toBe(manifest.version);
  });
});
