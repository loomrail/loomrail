import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { runGit } from "@loomrail/workspace";

import {
  ConstitutionPublicationError,
  proposeProjectConstitution,
  publishProjectConstitution,
  recommendConstitutionPreset,
  scanProjectRepository,
} from "../src/index.js";

const makeRepository = async (prefix = "loomrail-constitution-"): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const result = await runGit(["init"], { cwd: path });
  if (result.exitCode !== 0) throw new Error("Could not create the test repository");
  return path;
};

describe("existing repository onboarding", () => {
  it("recommends the most specific trusted preset and never retains a package script body", async () => {
    const repository = await makeRepository("loomrail project-ёж-");
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node --test SECRET_CANARY_SHOULD_NOT_SURVIVE",
          "verify:types": "tsc --noEmit",
        },
      }),
    );
    await writeFile(join(repository, "tsconfig.json"), "{}\n");
    await writeFile(join(repository, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const scan = await scanProjectRepository(repository);
    const proposal = proposeProjectConstitution({ projectName: "Проект с пробелом", scan });

    expect(recommendConstitutionPreset(scan)).toBe("typescript-pnpm-workspace");
    expect(proposal.presetId).toBe("typescript-pnpm-workspace");
    expect(scan.verificationCommands).toEqual([
      { name: "test", argv: ["pnpm", "test"], sourcePath: "package.json" },
      { name: "verify:types", argv: ["pnpm", "verify:types"], sourcePath: "package.json" },
    ]);
    expect(JSON.stringify({ scan, proposal })).not.toContain("SECRET_CANARY_SHOULD_NOT_SURVIVE");
    expect(proposal.sections).toHaveLength(7);
    expect(proposal.renderedMarkdown).toContain("# Проект с пробелом Project Constitution");
  });

  it("falls back to the language-neutral baseline without inventing a stack", async () => {
    const repository = await makeRepository();
    await writeFile(join(repository, "README.md"), "# Plain repository\n");

    const scan = await scanProjectRepository(repository);
    const proposal = proposeProjectConstitution({ projectName: "plain", scan });

    expect(scan.languages).toEqual([]);
    expect(proposal.recommendedPresetId).toBe("repository-baseline");
    expect(proposal.renderedMarkdown).toContain("No language was inferred");
  });

  it("does not follow repository symlinks or read an env canary", async () => {
    const repository = await makeRepository();
    const outside = await mkdtemp(join(tmpdir(), "loomrail-outside-"));
    await writeFile(join(outside, "outside.md"), "SYMLINK_CANARY_SHOULD_NOT_SURVIVE\n");
    await mkdir(join(repository, "docs"));
    await symlink(outside, join(repository, "docs", "architecture"));
    await writeFile(join(repository, ".env.local"), "ENV_CANARY_SHOULD_NOT_SURVIVE=1\n");

    const scan = await scanProjectRepository(repository);

    expect(JSON.stringify(scan)).not.toContain("SYMLINK_CANARY_SHOULD_NOT_SURVIVE");
    expect(JSON.stringify(scan)).not.toContain("ENV_CANARY_SHOULD_NOT_SURVIVE");
    expect(scan.files.some((file) => file.path.includes("outside.md"))).toBe(false);
    expect(scan.files.some((file) => file.path.startsWith(".env"))).toBe(false);
  });

  it("blocks adoption when the existing Constitution cannot be reviewed within bounds", async () => {
    const repository = await makeRepository();
    await mkdir(join(repository, ".loomrail"));
    await writeFile(join(repository, ".loomrail", "constitution.md"), "x".repeat(512 * 1024 + 1));

    const scan = await scanProjectRepository(repository);

    expect(scan.targetConstitution).toEqual({ state: "BLOCKED", digest: null });
    expect(scan.warnings).toContainEqual(
      expect.objectContaining({ code: "FILE_TOO_LARGE", path: ".loomrail/constitution.md" }),
    );
  });

  it("creates, replaces, and idempotently recovers the approved portable Constitution", async () => {
    const repository = await makeRepository();
    const scan = await scanProjectRepository(repository);
    const proposal = proposeProjectConstitution({ projectName: "portable", scan });

    await publishProjectConstitution({
      repositoryPath: repository,
      expectedTargetDigest: null,
      renderedMarkdown: proposal.renderedMarkdown,
      contentDigest: proposal.contentDigest,
    });
    await publishProjectConstitution({
      repositoryPath: repository,
      expectedTargetDigest: null,
      renderedMarkdown: proposal.renderedMarkdown,
      contentDigest: proposal.contentDigest,
    });

    expect(await readFile(join(repository, ".loomrail", "constitution.md"), "utf8")).toBe(
      proposal.renderedMarkdown,
    );
  });

  it("preserves a target that changed after review", async () => {
    const repository = await makeRepository();
    await mkdir(join(repository, ".loomrail"));
    await writeFile(join(repository, ".loomrail", "constitution.md"), "reviewed\n");
    const scan = await scanProjectRepository(repository);
    const proposal = proposeProjectConstitution({ projectName: "race", scan });
    if (scan.targetConstitution.state !== "PRESENT") throw new Error("Expected a present target");
    await writeFile(join(repository, ".loomrail", "constitution.md"), "owner changed this\n");

    await expect(
      publishProjectConstitution({
        repositoryPath: repository,
        expectedTargetDigest: scan.targetConstitution.digest,
        renderedMarkdown: proposal.renderedMarkdown,
        contentDigest: proposal.contentDigest,
      }),
    ).rejects.toMatchObject({ code: "CONSTITUTION_TARGET_CHANGED" });
    expect(await readFile(join(repository, ".loomrail", "constitution.md"), "utf8")).toBe(
      "owner changed this\n",
    );
  });

  it("refuses a .loomrail directory that escapes through a symlink", async () => {
    const repository = await makeRepository();
    const outside = await mkdtemp(join(tmpdir(), "loomrail-publish-outside-"));
    await symlink(outside, join(repository, ".loomrail"));
    const scan = await scanProjectRepository(repository);
    const proposal = proposeProjectConstitution({ projectName: "escape", scan });

    expect(scan.targetConstitution.state).toBe("BLOCKED");
    await expect(
      publishProjectConstitution({
        repositoryPath: repository,
        expectedTargetDigest: null,
        renderedMarkdown: proposal.renderedMarkdown,
        contentDigest: proposal.contentDigest,
      }),
    ).rejects.toBeInstanceOf(ConstitutionPublicationError);
    await expect(readFile(join(outside, "constitution.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
