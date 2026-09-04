import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { VerificationPlan } from "@loomrail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectVerificationPublicationError,
  publishVerificationPlan,
  scanVerificationPlanProposal,
  verificationPlanContentHash,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const makeRepository = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `loomrail-verification-publisher-${name}-`));
  roots.push(root);
  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: root });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@10.17.1", scripts: { test: "vitest run" } }),
  );
  return root;
};

const planFrom = (
  proposal: Awaited<ReturnType<typeof scanVerificationPlanProposal>>,
  revision = 1,
): VerificationPlan => {
  const content = {
    schemaVersion: 1 as const,
    id: `verification-plan-${revision.toString()}`,
    projectId: proposal.projectId,
    revision,
    status: "ACTIVE" as const,
    recipes: proposal.recipes,
    sourceProposalHash: proposal.proposalHash,
    createdAt: "2026-09-05T09:00:00.000Z",
  };
  return { ...content, contentHash: verificationPlanContentHash(content) };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("verification plan publisher", () => {
  it("atomically publishes and idempotently recovers exact marker-bound content", async () => {
    const repositoryPath = await makeRepository("path with spaces-ёж");
    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });
    const plan = planFrom(proposal);

    await publishVerificationPlan({
      repositoryPath,
      expectedTargetDigest: proposal.target.digest,
      plan,
    });
    await publishVerificationPlan({
      repositoryPath,
      expectedTargetDigest: proposal.target.digest,
      plan,
    });

    const published = JSON.parse(
      await readFile(join(repositoryPath, ".loomrail", "verification-plan.json"), "utf8"),
    ) as unknown;
    expect(published).toEqual(plan);
  });

  it("detects an unknown existing target and never overwrites it", async () => {
    const repositoryPath = await makeRepository("unknown-target");
    await mkdir(join(repositoryPath, ".loomrail"));
    const ownerContent = '{"owner":"keep me"}\n';
    await writeFile(join(repositoryPath, ".loomrail", "verification-plan.json"), ownerContent);

    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });
    expect(proposal.target).toEqual({ state: "BLOCKED", digest: null });
    expect(proposal.warnings).toContainEqual(expect.objectContaining({ code: "PLAN_TARGET_BLOCKED" }));

    await expect(
      publishVerificationPlan({ repositoryPath, expectedTargetDigest: null, plan: planFrom(proposal) }),
    ).rejects.toBeInstanceOf(ProjectVerificationPublicationError);
    expect(await readFile(join(repositoryPath, ".loomrail", "verification-plan.json"), "utf8")).toBe(
      ownerContent,
    );
  });

  it("refuses a symlinked .loomrail directory without writing outside the repository", async () => {
    const repositoryPath = await makeRepository("symlink-target");
    const outside = await makeRepository("outside");
    await symlink(outside, join(repositoryPath, ".loomrail"));

    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });
    expect(proposal.target.state).toBe("BLOCKED");
    await expect(
      publishVerificationPlan({ repositoryPath, expectedTargetDigest: null, plan: planFrom(proposal) }),
    ).rejects.toMatchObject({ code: "TARGET_OUTSIDE_REPOSITORY" });
    await expect(readFile(join(outside, "verification-plan.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses publication when package.json changed after owner preview", async () => {
    const repositoryPath = await makeRepository("manifest-drift");
    const proposal = await scanVerificationPlanProposal({ projectId: "project-1", repositoryPath });
    const plan = planFrom(proposal);
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.17.1", scripts: { test: "vitest run --changed" } }),
    );

    await expect(
      publishVerificationPlan({ repositoryPath, expectedTargetDigest: null, plan }),
    ).rejects.toMatchObject({ code: "PROPOSAL_CHANGED" });
    await expect(
      readFile(join(repositoryPath, ".loomrail", "verification-plan.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
