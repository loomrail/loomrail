import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifySamples } from "./verify-samples.mjs";

const sourceRoot = fileURLToPath(new URL("../fixtures/projects", import.meta.url));

const copiedCatalog = async () => {
  const root = await mkdtemp(join(tmpdir(), "loomrail sample policy "));
  const catalog = join(root, "projects");
  await cp(sourceRoot, catalog, { recursive: true });
  return { root, catalog };
};

test("accepts and executes the exact source catalog", async () => {
  await assert.doesNotReject(verifySamples(sourceRoot));
});

test("refuses a sample dependency before executing it", async () => {
  const { root, catalog } = await copiedCatalog();
  try {
    const manifestPath = join(catalog, "api-service-b", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = { unexpected: "1.0.0" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await assert.rejects(verifySamples(catalog), /package manifest has unexpected fields/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an unreviewed file in a sample repository", async () => {
  const { root, catalog } = await copiedCatalog();
  try {
    await writeFile(join(catalog, "web-app-a", "owner.env"), "TOKEN=not-a-real-token\n", "utf8");

    await assert.rejects(verifySamples(catalog), /unexpected file set/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
