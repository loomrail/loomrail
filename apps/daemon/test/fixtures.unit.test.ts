import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FixtureResolutionError, resolveBundledFixture } from "../src/fixtures.js";

describe("bundled fixture containment", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("resolves an allowlisted bundled fixture", async () => {
    await expect(resolveBundledFixture("web-app-a")).resolves.toMatchObject({
      fixtureId: "web-app-a",
      projectId: "project-fixture-web-app-a",
    });
  });

  it("rejects a fixture symlink that escapes the catalog root", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail fixture root "));
    const outside = await mkdtemp(join(tmpdir(), "loomrail fixture outside "));
    temporaryDirectories.push(root, outside);
    await writeFile(
      join(outside, "loomrail-fixture.json"),
      JSON.stringify({
        schemaVersion: 1,
        fixtureId: "web-app-a",
        projectId: "project-escape",
        name: "Escaped fixture",
      }),
    );
    await mkdir(join(root, "catalog"));
    await symlink(
      outside,
      join(root, "catalog", "web-app-a"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(resolveBundledFixture("web-app-a", join(root, "catalog"))).rejects.toBeInstanceOf(
      FixtureResolutionError,
    );
  });

  it("rejects a manifest symlink that escapes its fixture directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "loomrail fixture manifest root "));
    const outside = await mkdtemp(join(tmpdir(), "loomrail fixture manifest outside "));
    temporaryDirectories.push(root, outside);
    await mkdir(join(root, "web-app-a"));
    const outsideManifest = join(outside, "loomrail-fixture.json");
    await writeFile(
      outsideManifest,
      JSON.stringify({
        schemaVersion: 1,
        fixtureId: "web-app-a",
        projectId: "project-manifest-escape",
        name: "Escaped manifest",
      }),
    );
    await symlink(outsideManifest, join(root, "web-app-a", "loomrail-fixture.json"), "file");

    await expect(resolveBundledFixture("web-app-a", root)).rejects.toMatchObject({
      code: "FIXTURE_PATH_ESCAPE",
    });
  });
});
