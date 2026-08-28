import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectRepository } from "@loomrail/workspace";
import { afterEach, describe, expect, it } from "vitest";

import {
  isRegisteredRepositoryUsable,
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

  // The copy is built in a staging directory and moved into place with a single rename, which is
  // what makes a half-populated repository impossible to observe. The price is that a process killed
  // mid-copy leaves that directory behind, in the owner's data folder, with nothing to remove it.
  it("sweeps a staging directory an earlier materialisation abandoned, and leaves a live one alone", async () => {
    const demoProjectsRoot = await scratch("materialise sweep root ");
    const templatePath = await scratch("materialise sweep template ");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");

    const abandoned = join(demoProjectsRoot, ".materialising-web-app-a-abandoned");
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, "half-copied.txt"), "interrupted\n", "utf8");
    // Old enough that no live copy could still be working in it: a materialisation is a directory
    // copy and three `git` invocations, seconds at most.
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1_000);
    await utimes(abandoned, longAgo, longAgo);

    // A staging directory another registration is using right now, distinguished only by its age.
    const inFlight = join(demoProjectsRoot, ".materialising-api-service-b-in-flight");
    await mkdir(inFlight, { recursive: true });

    const materialised = await materialiseFixtureRepository(templateFixture(templatePath), demoProjectsRoot);
    expect(materialised.created).toBe(true);

    await expect(access(abandoned)).rejects.toThrow();
    await expect(access(inFlight)).resolves.toBeUndefined();
  });

  it("trims the trailing space macOS adds when a folder is dragged into a terminal", async () => {
    const demoProjectsRoot = await scratch("materialise root trailing space ");
    const templatePath = await scratch("materialise template trailing space ");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");
    const { repositoryPath } = await materialiseFixtureRepository(
      templateFixture(templatePath),
      demoProjectsRoot,
    );

    // A real repository, answered for by the exact path it lives at plus one character no owner
    // typed on purpose -- not REPOSITORY_PATH_NOT_A_REPOSITORY, which would send them looking for a
    // problem with their repository instead of the stray space the terminal appended.
    const resolved = await resolveRegisteredRepository(`${repositoryPath} `);
    expect(resolved).toBe(await realpath(repositoryPath));
  });

  // The probe on `GET /api/v1/projects`, which the web client fetches to render the app's main
  // screen. `runGit` REJECTS with `GitMissingError` when `git` cannot be spawned, `inspectRepository`
  // does not catch it, and the route had no branch for it -- so on a machine with no `git` on PATH
  // one Project turned the whole list into a generic 500 and the owner could not see any of their
  // Projects at all.
  //
  // PATH is emptied for the duration of the call and restored immediately after, in a `finally`, so
  // the rest of this file still gets a working `git`. That is the one honest way to reach this from
  // a test: it is the same ENOENT on the child that a machine without the executable produces.
  it("answers for a repository it cannot inspect at all rather than failing the caller", async () => {
    const demoProjectsRoot = await scratch("materialise root no git ");
    const templatePath = await scratch("materialise template no git ");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");
    const { repositoryPath } = await materialiseFixtureRepository(
      templateFixture(templatePath),
      demoProjectsRoot,
    );
    // The premise: with `git` reachable this is a perfectly healthy repository, so the answer below
    // is attributable to the missing executable and to nothing about the path.
    expect(await isRegisteredRepositoryUsable(repositoryPath)).toBe(true);

    const realPath = process.env["PATH"];
    const probe = (async () => {
      try {
        process.env["PATH"] = "";
        return await isRegisteredRepositoryUsable(repositoryPath);
      } finally {
        process.env["PATH"] = realPath;
      }
    })();

    // Awaited through `.resolves`, not with a bare `await`: an uncontained `GitMissingError` would
    // otherwise leave this test throwing rather than failing, and a thrown Error names nothing about
    // the behaviour under test. This way "it rejected" is reported as the assertion it is.
    //
    // What is asserted is a plain "no, not usable right now" -- not a rejection the route would have
    // to turn into a 500 over a Project the owner can do nothing about from a project list.
    await expect(probe).resolves.toBe(false);
    // And nothing was broken on the way: the probe is restored with PATH.
    expect(await isRegisteredRepositoryUsable(repositoryPath)).toBe(true);
  });

  // Neither `runGit` nor `realpath` has a timeout of its own, and both block on a sleeping external
  // disk or an unreachable network mount. Without a bound, one Project registered on such a mount
  // wedged the project list for as long as the mount stayed silent, which can be forever.
  //
  // A hung mount cannot be manufactured portably, so the bound itself is what is exercised: the same
  // real repository, once with room to answer and once with none. The pair is the assertion -- the
  // second answer is `false` because the deadline passed, not because there is anything wrong with
  // the path.
  it("answers within its bound rather than waiting on a filesystem that never replies", async () => {
    const demoProjectsRoot = await scratch("materialise root probe bound ");
    const templatePath = await scratch("materialise template probe bound ");
    await writeFile(join(templatePath, "README.md"), "# Template\n", "utf8");
    const { repositoryPath } = await materialiseFixtureRepository(
      templateFixture(templatePath),
      demoProjectsRoot,
    );

    expect(await isRegisteredRepositoryUsable(repositoryPath)).toBe(true);

    // Zero, so the deadline is already past before the first `git` process could possibly report:
    // the inspection needs at least one child process, and a timer callback runs long before one
    // spawns, execs and exits.
    const startedAt = Date.now();
    expect(await isRegisteredRepositoryUsable(repositoryPath, 0)).toBe(false);
    // Bounded generously -- this asserts "did not wait on the work", not a performance figure.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
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
