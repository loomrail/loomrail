import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectRepository } from "@loomrail/workspace";
import { afterEach, describe, expect, it } from "vitest";

import {
  materialiseFixtureRepository,
  resolveRegisteredRepository,
  type ResolvedFixtureProject,
} from "../src/fixtures.js";

// An integration suite rather than a unit one: every case here copies real directories and spawns
// real `git`, which is the whole point -- a bundled fixture becoming a repository is filesystem work
// or it is nothing.

describe("fixture materialisation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  const scratch = async (label: string): Promise<string> => {
    const path = await mkdtemp(join(tmpdir(), `loomrail ${label} `));
    temporaryDirectories.push(path);
    return path;
  };

  const templateFixture = (templatePath: string): ResolvedFixtureProject => ({
    fixtureId: "web-app-a",
    projectId: "project-fixture-web-app-a",
    name: "Fixture web application",
    templatePath,
  });

  it("never carries a .git directory out of the template", async () => {
    const templatePath = await scratch("materialise template git ");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");
    // A `.git` cannot be committed to Loomrail's repository, but a developer running the daemon
    // from a working copy can easily have one sitting in the template directory. Carrying it would
    // hand the demo a repository nobody chose, with whatever history that directory happened to
    // hold, instead of the one `git init` is about to create.
    await mkdir(join(templatePath, ".git"));
    await writeFile(join(templatePath, ".git", "HEAD"), "ref: refs/heads/smuggled\n", "utf8");
    await mkdir(join(templatePath, "src"));
    await mkdir(join(templatePath, "src", ".git"));
    await writeFile(join(templatePath, "src", ".git", "HEAD"), "ref: refs/heads/nested\n", "utf8");
    const demoProjectsRoot = await scratch("materialise root git ");

    const { repositoryPath: materialised } = await materialiseFixtureRepository(
      templateFixture(templatePath),
      demoProjectsRoot,
    );

    await expect(access(join(materialised, "src", ".git", "HEAD"))).rejects.toThrow();
    const repository = await inspectRepository(materialised);
    expect(repository?.headCommit).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/));
    // The repository is the one this call created, not one smuggled in with the template.
    expect(await readFile(join(materialised, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  });

  it("refuses a template holding a symbolic link rather than copying it", async () => {
    const templatePath = await scratch("materialise template link ");
    const outside = await scratch("materialise outside ");
    await writeFile(join(outside, "secret.txt"), "not the fixture's to carry\n", "utf8");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");
    await symlink(outside, join(templatePath, "escape"), process.platform === "win32" ? "junction" : "dir");
    const demoProjectsRoot = await scratch("materialise root link ");

    await expect(
      materialiseFixtureRepository(templateFixture(templatePath), demoProjectsRoot),
    ).rejects.toMatchObject({ code: "FIXTURE_TEMPLATE_UNSUPPORTED_ENTRY" });
    // The refused attempt leaves nothing behind for the next registration to adopt.
    await expect(access(join(demoProjectsRoot, "web-app-a"))).rejects.toThrow();
  });

  it("hands back an already materialised repository untouched", async () => {
    const templatePath = await scratch("materialise template again ");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");
    const demoProjectsRoot = await scratch("materialise root again ");
    const fixture = templateFixture(templatePath);

    const first = await materialiseFixtureRepository(fixture, demoProjectsRoot);
    expect(first.created).toBe(true);
    const firstCommit = (await inspectRepository(first.repositoryPath))?.headCommit;
    await writeFile(join(first.repositoryPath, "owners-note.txt"), "work in progress\n", "utf8");
    const second = await materialiseFixtureRepository(fixture, demoProjectsRoot);

    // Adopted, not rebuilt -- and the caller is told which, because "I just created this" and "this
    // was already here" are different claims about what the path can be trusted to be.
    expect(second).toEqual({ repositoryPath: first.repositoryPath, created: false });
    expect((await inspectRepository(second.repositoryPath))?.headCommit).toBe(firstCommit);
    expect(await readFile(join(second.repositoryPath, "owners-note.txt"), "utf8")).toBe("work in progress\n");
  });

  it("refuses a path inside another repository with the reason that is actually true", async () => {
    const demoProjectsRoot = await scratch("materialise root inside ");
    const templatePath = await scratch("materialise template inside ");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");
    const { repositoryPath: outer } = await materialiseFixtureRepository(
      templateFixture(templatePath),
      demoProjectsRoot,
    );
    const inner = join(outer, "packages", "inner");
    await mkdir(inner, { recursive: true });

    // Not "there is no repository here" -- `git status` works perfectly well in this directory.
    // What is true is narrower: registering here would branch the repository it sits inside.
    await expect(resolveRegisteredRepository(inner)).rejects.toMatchObject({
      code: "REPOSITORY_PATH_INSIDE_REPOSITORY",
    });
    await expect(resolveRegisteredRepository(inner)).rejects.toThrow(await realpath(outer));
  });
});
