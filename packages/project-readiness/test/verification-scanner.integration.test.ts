import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanVerificationPlanProposal } from "../src/index.js";

const roots: string[] = [];

const makeRoot = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `loomrail-verification-${name}-`));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("verification plan scanner", () => {
  it("proposes only allowlisted package scripts without executing their untrusted bodies", async () => {
    const repositoryPath = await makeRoot("path with spaces-ёж");
    const marker = join(repositoryPath, "must-not-exist");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.17.1",
        scripts: {
          preinstall: `touch ${marker}`,
          test: `touch ${marker}`,
          "test:e2e": "playwright test",
          deploy: "publish-everything",
        },
      }),
    );

    const first = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });
    const second = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });

    expect(first.recipes).toHaveLength(2);
    expect(first.recipes[0]).toMatchObject({
      id: "package-test",
      kind: "UNIT",
      executable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      required: true,
    });
    expect(first.recipes[0]?.provenance.scriptName).toBe("test");
    expect(first.recipes[0]?.provenance.scriptBodyPreview).toBe(`touch ${marker}`);
    expect(first.recipes[1]).toMatchObject({
      id: "package-test-e2e",
      kind: "E2E",
      executable: "pnpm",
      argv: ["run", "test:e2e"],
    });
    expect(first.proposalHash).toBe(second.proposalHash);
    expect(JSON.stringify(first)).not.toContain("preinstall");
    expect(JSON.stringify(first)).not.toContain("publish-everything");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns warning-only inert proposals for a symlink, oversized file, and invalid JSON", async () => {
    const outside = await makeRoot("outside");
    const symlinked = await makeRoot("symlinked");
    await writeFile(join(outside, "package.json"), JSON.stringify({ scripts: { test: "SECRET_CANARY" } }));
    await symlink(join(outside, "package.json"), join(symlinked, "package.json"));

    const symlinkProposal = await scanVerificationPlanProposal({
      projectId: "project-symlink",
      repositoryPath: symlinked,
    });

    expect(symlinkProposal.recipes).toEqual([]);
    expect(symlinkProposal.warnings).toContainEqual(expect.objectContaining({ code: "MANIFEST_SYMLINK" }));
    expect(JSON.stringify(symlinkProposal)).not.toContain("SECRET_CANARY");

    const oversized = await makeRoot("oversized");
    await writeFile(join(oversized, "package.json"), "x".repeat(256 * 1024 + 1));
    const oversizedProposal = await scanVerificationPlanProposal({
      projectId: "project-oversized",
      repositoryPath: oversized,
    });
    expect(oversizedProposal.recipes).toEqual([]);
    expect(oversizedProposal.warnings).toContainEqual(
      expect.objectContaining({ code: "MANIFEST_TOO_LARGE" }),
    );

    const invalid = await makeRoot("invalid");
    await writeFile(join(invalid, "package.json"), "not json");
    const invalidProposal = await scanVerificationPlanProposal({
      projectId: "project-invalid",
      repositoryPath: invalid,
    });
    expect(invalidProposal.recipes).toEqual([]);
    expect(invalidProposal.warnings).toContainEqual(expect.objectContaining({ code: "MANIFEST_INVALID" }));
  });

  it("keeps unsupported or unsafe script values inert", async () => {
    const repositoryPath = await makeRoot("unsupported");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint\u0000 --fix", custom: "node custom.js" } }),
    );

    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });

    expect(proposal.recipes).toEqual([]);
    expect(proposal.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCRIPT_UNSAFE" }),
        expect.objectContaining({ code: "NO_SUPPORTED_SCRIPTS" }),
      ]),
    );
  });

  it("does not propose a package script with an implicit pre/post lifecycle hook", async () => {
    const repositoryPath = await makeRoot("hidden-hooks");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({
        scripts: {
          pretest: "node hidden-before.js",
          test: "node visible-test.js",
          posttest: "node hidden-after.js",
        },
      }),
    );

    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });

    expect(proposal.recipes).toEqual([]);
    expect(proposal.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SCRIPT_UNSAFE" }),
        expect.objectContaining({ code: "NO_SUPPORTED_SCRIPTS" }),
      ]),
    );
  });

  it("fails closed when the manifest has more script entries than the bounded scanner limit", async () => {
    const repositoryPath = await makeRoot("too-many-scripts");
    const scripts = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`script:${index.toString()}`, "node noop.js"]),
    );
    scripts["test"] = "node test.js";
    await writeFile(join(repositoryPath, "package.json"), JSON.stringify({ scripts }));

    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });

    expect(proposal.recipes).toEqual([]);
    expect(proposal.warnings).toContainEqual(expect.objectContaining({ code: "SCRIPT_LIMIT_REACHED" }));
  });
});
