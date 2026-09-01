import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "@loomrail/workspace";
import { afterEach, describe, expect, test } from "vitest";

import { proposeProjectScaffold, ProjectScaffoldingError } from "../src/index.js";
import { validateScaffoldRecipe, type ScaffoldRecipe } from "../src/recipe.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("project scaffold proposal", () => {
  test("renders one deterministic, bounded preview without writing the target", async () => {
    const parent = await temporaryDirectory("loomrail scaffold родитель ");
    const targetPath = join(parent, "sample-project");

    const first = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });
    const second = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      packageName: "sample-project",
      projectName: "sample-project",
      recipeId: "typescript-node",
      recipeVersion: 1,
      schemaVersion: 1,
      systemFiles: [".loomrail/scaffold.json"],
    });
    expect(first.targetPath).toBe(join(await realpath(parent), "sample-project"));
    expect(first.proposalDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.files.map((file) => file.path)).toEqual([
      ".gitignore",
      "README.md",
      "package.json",
      "src/index.ts",
      "test/index.test.ts",
      "tsconfig.json",
    ]);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses a target that already exists", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-existing-");
    const targetPath = join(parent, "existing-project");
    await mkdir(targetPath);

    await expect(proposeProjectScaffold({ recipeId: "typescript-node", targetPath })).rejects.toMatchObject({
      code: "TARGET_EXISTS",
    });
  });

  test("refuses a new target nested inside an existing repository", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-repository-");
    const git = await runGit(["-c", "init.templateDir=", "init"], { cwd: parent });
    expect(git.exitCode).toBe(0);

    await expect(
      proposeProjectScaffold({ recipeId: "typescript-node", targetPath: join(parent, "nested-project") }),
    ).rejects.toMatchObject({ code: "TARGET_INSIDE_REPOSITORY" });
  });

  test.each(["Project Name", ".hidden", "CON", "UPPERCASE"])(
    "refuses the unsupported portable directory name %s",
    async (name) => {
      const parent = await temporaryDirectory("loomrail-scaffold-name-");
      const action = proposeProjectScaffold({ recipeId: "typescript-node", targetPath: join(parent, name) });
      await expect(action).rejects.toBeInstanceOf(ProjectScaffoldingError);
    },
  );
});

describe("built-in recipe validation", () => {
  const recipe: ScaffoldRecipe = {
    id: "typescript-node",
    version: 1,
    render: () => [],
  };

  test("rejects traversal and the reserved marker path", () => {
    expect(() =>
      validateScaffoldRecipe(recipe, [
        { path: "../outside", content: "no\n" },
        { path: "package.json", content: "{}\n" },
      ]),
    ).toThrow(/portable/u);
    expect(() =>
      validateScaffoldRecipe(recipe, [
        { path: ".loomrail/scaffold.json", content: "{}\n" },
        { path: "package.json", content: "{}\n" },
      ]),
    ).toThrow(/reserved/u);
  });

  test("rejects package lifecycle scripts", () => {
    expect(() =>
      validateScaffoldRecipe(recipe, [
        {
          path: "package.json",
          content: `${JSON.stringify({ scripts: { postinstall: "node payload.js" } })}\n`,
        },
      ]),
    ).toThrow(/lifecycle/u);
  });

  test("does not inspect or execute commands in ordinary documentation", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-inert-");
    const canary = join(parent, "must-not-exist");
    validateScaffoldRecipe(recipe, [
      { path: "README.md", content: `Do not run: touch ${canary}\n` },
      { path: "package.json", content: "{}\n" },
    ]);
    await expect(readFile(canary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
