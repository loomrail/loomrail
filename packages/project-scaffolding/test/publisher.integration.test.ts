import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectRepository, runGit } from "@loomrail/workspace";
import { afterEach, describe, expect, test } from "vitest";

import { proposeProjectScaffold, publishProjectScaffold } from "../src/index.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("marker-bound project scaffold publication", () => {
  test("creates only the proposal files, marker and a Git repository without a commit", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-publish-");
    const targetPath = join(parent, "new-project");
    const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });

    const publication = await publishProjectScaffold({ operationId: "operation-0001", proposal });

    expect(publication).toEqual({
      operationId: "operation-0001",
      proposalDigest: proposal.proposalDigest,
      repositoryPath: proposal.targetPath,
      status: "PUBLISHED",
    });
    expect((await inspectRepository(targetPath))?.headCommit).toBeNull();
    const marker = JSON.parse(await readFile(join(targetPath, ".loomrail", "scaffold.json"), "utf8")) as {
      operationId: string;
      proposalDigest: string;
    };
    expect(marker).toMatchObject({ operationId: "operation-0001", proposalDigest: proposal.proposalDigest });
    const packageJson = JSON.parse(await readFile(join(targetPath, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts).toEqual({
      build: "tsc -p tsconfig.json",
      test: "node --test test/*.test.ts",
      typecheck: "tsc -p tsconfig.json --noEmit",
    });
    expect(Object.keys(packageJson.scripts).some((name) => /^(?:pre|post)/u.test(name))).toBe(false);
  });

  test("is idempotent for the same operation and exact marker", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-idempotent-");
    const proposal = await proposeProjectScaffold({
      recipeId: "typescript-node",
      targetPath: join(parent, "idempotent-project"),
    });

    const first = await publishProjectScaffold({ operationId: "operation-0002", proposal });
    const second = await publishProjectScaffold({ operationId: "operation-0002", proposal });

    expect(second).toEqual(first);
  });

  test("resumes an exact marker-bound publication after only its first file was durable", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-partial-");
    const targetPath = join(parent, "partial-project");
    const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });
    await mkdir(join(targetPath, ".loomrail"), { recursive: true });
    await writeFile(
      join(targetPath, ".loomrail", "scaffold.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          operationId: "operation-partial",
          proposalDigest: proposal.proposalDigest,
          recipeId: proposal.recipeId,
          recipeVersion: proposal.recipeVersion,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    await writeFile(
      join(targetPath, ".gitignore"),
      "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n.DS_Store\n",
      {
        flag: "wx",
      },
    );

    await expect(
      publishProjectScaffold({ operationId: "operation-partial", proposal }),
    ).resolves.toMatchObject({ status: "PUBLISHED" });
    expect(await readFile(join(targetPath, "package.json"), "utf8")).toContain('"private": true');
    expect((await inspectRepository(targetPath))?.topLevel).toBe(proposal.targetPath);
  });

  test("never overwrites a directory created by another writer", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-race-");
    const targetPath = join(parent, "raced-project");
    const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });
    const canary = "owner data\n";
    await mkdir(targetPath);
    await writeFile(join(targetPath, "owner.txt"), canary, { flag: "wx" });

    await expect(publishProjectScaffold({ operationId: "operation-0003", proposal })).rejects.toMatchObject({
      code: "MARKER_MISMATCH",
    });
    expect(await readFile(join(targetPath, "owner.txt"), "utf8")).toBe(canary);
  });

  test("fails closed when a published file changes and preserves the changed bytes", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-conflict-");
    const targetPath = join(parent, "changed-project");
    const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });
    await publishProjectScaffold({ operationId: "operation-0004", proposal });
    await writeFile(join(targetPath, "README.md"), "owner changed this file\n", "utf8");

    await expect(publishProjectScaffold({ operationId: "operation-0004", proposal })).rejects.toMatchObject({
      code: "FILE_CONFLICT",
    });
    expect(await readFile(join(targetPath, "README.md"), "utf8")).toBe("owner changed this file\n");
  });

  test("fails closed on an unknown recovery path and preserves it", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-unknown-");
    const targetPath = join(parent, "unknown-project");
    const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });
    await publishProjectScaffold({ operationId: "operation-unknown", proposal });
    await writeFile(join(targetPath, "owner.txt"), "owner data\n", { flag: "wx" });

    await expect(
      publishProjectScaffold({ operationId: "operation-unknown", proposal }),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(await readFile(join(targetPath, "owner.txt"), "utf8")).toBe("owner data\n");
  });

  test("does not follow a marker symlink during recovery", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-symlink-");
    const targetPath = join(parent, "symlink-project");
    const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });
    await publishProjectScaffold({ operationId: "operation-0005", proposal });
    const markerPath = join(targetPath, ".loomrail", "scaffold.json");
    const savedMarker = join(parent, "saved-marker.json");
    await writeFile(savedMarker, await readFile(markerPath));
    await rm(markerPath);
    await symlink(savedMarker, markerPath);

    await expect(publishProjectScaffold({ operationId: "operation-0005", proposal })).rejects.toMatchObject({
      code: "MARKER_MISMATCH",
    });
    expect((await lstat(markerPath)).isSymbolicLink()).toBe(true);
  });

  test("allows only one of two racing operations to claim the target", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-concurrent-");
    const targetPath = join(parent, "concurrent-project");
    const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });

    const results = await Promise.allSettled([
      publishProjectScaffold({ operationId: "operation-0006-a", proposal }),
      publishProjectScaffold({ operationId: "operation-0006-b", proposal }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await readFile(join(targetPath, "README.md"), "utf8")).toContain("TypeScript and Node.js");
  });

  test("ignores ambient Git repository and template variables", async () => {
    const parent = await temporaryDirectory("loomrail-scaffold-git-env-");
    const ambientRepository = join(parent, "ambient");
    const template = join(parent, "template");
    await mkdir(ambientRepository);
    await mkdir(join(template, "hooks"), { recursive: true });
    expect((await runGit(["-c", "init.templateDir=", "init"], { cwd: ambientRepository })).exitCode).toBe(0);
    await writeFile(join(template, "hooks", "post-checkout"), "ambient hook\n", { flag: "wx" });
    const originalGitDirectory = process.env["GIT_DIR"];
    const originalTemplate = process.env["GIT_TEMPLATE_DIR"];
    process.env["GIT_DIR"] = join(ambientRepository, ".git");
    process.env["GIT_TEMPLATE_DIR"] = template;
    try {
      const targetPath = join(parent, "isolated-project");
      const proposal = await proposeProjectScaffold({ recipeId: "typescript-node", targetPath });
      await publishProjectScaffold({ operationId: "operation-git-env", proposal });
      expect((await lstat(join(targetPath, ".git"))).isDirectory()).toBe(true);
      await expect(
        readFile(join(targetPath, ".git", "hooks", "post-checkout"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (originalGitDirectory === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env["GIT_DIR"] = originalGitDirectory;
      if (originalTemplate === undefined) Reflect.deleteProperty(process.env, "GIT_TEMPLATE_DIR");
      else process.env["GIT_TEMPLATE_DIR"] = originalTemplate;
    }
  });
});
