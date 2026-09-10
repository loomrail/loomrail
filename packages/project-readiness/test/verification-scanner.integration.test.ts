import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      timeoutSeconds: 300,
      outputLimitBytes: 262_144,
    });
    expect(first.recipes[0]?.provenance.scriptName).toBe("test");
    expect(first.recipes[0]?.provenance.scriptBodyPreview).toBe(`touch ${marker}`);
    expect(first.recipes[1]).toMatchObject({
      id: "package-test-e2e",
      kind: "E2E",
      executable: "pnpm",
      argv: ["run", "test:e2e"],
      timeoutSeconds: 900,
    });
    expect(first.proposalHash).toBe(second.proposalHash);
    expect(JSON.stringify(first)).not.toContain("preinstall");
    expect(JSON.stringify(first)).not.toContain("publish-everything");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("proposes bounded service recipes from direct conventional app manifests", async () => {
    const repositoryPath = await makeRoot("monorepo with spaces-ёж");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0", scripts: { test: "pnpm -r test" } }),
    );
    const appCwd = "apps/панель with spaces";
    await mkdir(join(repositoryPath, appCwd), { recursive: true });
    await writeFile(
      join(repositoryPath, appCwd, "package.json"),
      JSON.stringify({
        scripts: {
          start: "next start -p 4001",
          predev: "node hidden-hook.js",
          dev: "next dev -p 4001",
          deploy: "must-not-be-proposed",
        },
      }),
    );

    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });

    expect(proposal.recipes).toHaveLength(2);
    expect(proposal.recipes[1]).toMatchObject({
      kind: "SERVE",
      label: "Start service · apps/панель with spaces",
      required: false,
      executable: "pnpm",
      argv: ["run", "start"],
      cwd: appCwd,
      provenance: {
        manifestPath: "package.json",
        scriptName: "start",
        scriptBodyPreview: "next start -p 4001",
      },
    });
    expect(proposal.recipes[1]?.id).toMatch(/^workspace-[a-f0-9]{16}-package-start$/u);
    expect(JSON.stringify(proposal)).not.toContain("must-not-be-proposed");
    expect(proposal.warnings).toContainEqual(expect.objectContaining({ code: "SCRIPT_UNSAFE" }));
  });

  it("does not follow an app symlink or scan an unbounded conventional directory", async () => {
    const repositoryPath = await makeRoot("bounded-monorepo");
    const outside = await makeRoot("outside-app");
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0", scripts: { test: "pnpm -r test" } }),
    );
    await writeFile(
      join(outside, "package.json"),
      JSON.stringify({ scripts: { start: "SECRET_OUTSIDE_SERVICE_CANARY" } }),
    );
    await mkdir(join(repositoryPath, "apps"));
    await symlink(
      outside,
      join(repositoryPath, "apps", "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const symlinkProposal = await scanVerificationPlanProposal({
      projectId: "project-1",
      repositoryPath,
    });
    expect(symlinkProposal.recipes).toHaveLength(1);
    expect(JSON.stringify(symlinkProposal)).not.toContain("SECRET_OUTSIDE_SERVICE_CANARY");

    await rm(join(repositoryPath, "apps", "escaped"));
    await Promise.all(
      Array.from({ length: 33 }, (_, index) =>
        mkdir(join(repositoryPath, "apps", `app-${index.toString().padStart(2, "0")}`)),
      ),
    );
    const boundedProposal = await scanVerificationPlanProposal({
      projectId: "project-1",
      repositoryPath,
    });
    expect(boundedProposal.recipes).toHaveLength(1);
    expect(boundedProposal.warnings).toContainEqual(
      expect.objectContaining({ code: "SCRIPT_LIMIT_REACHED" }),
    );
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
