import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

for (const invalidPort of ["not-a-port", "4173oops"]) {
  test(`refuses invalid loopback port ${invalidPort} before listening`, () => {
    const result = spawnSync(process.execPath, [serverPath], {
      env: { ...process.env, LOOMRAIL_SAMPLE_PORT: invalidPort },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOOMRAIL_SAMPLE_PORT must be an integer between 1 and 65535/);
  });
}
