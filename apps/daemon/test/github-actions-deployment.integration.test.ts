import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SupervisedProcessOptions, SupervisedProcessResult } from "@loomrail/process-supervision";
import { afterEach, describe, expect, it } from "vitest";

import { createGithubActionsDeploymentDriver } from "../src/github-actions-deployment.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const processResult = (output: string, overrides: Partial<SupervisedProcessResult> = {}) => ({
  termination: "EXITED" as const,
  spawnErrorCode: null,
  exitCode: 0,
  signal: null,
  durationMs: 1,
  output: {
    text: output,
    capturedBytes: Buffer.byteLength(output),
    stdoutBytes: Buffer.byteLength(output),
    stderrBytes: 0,
    truncated: false,
  },
  ...overrides,
});

const fixture = async (workflowAsSymlink = false) => {
  const root = await mkdtemp(join(tmpdir(), "loomrail deploy Репозиторий with spaces "));
  roots.push(root);
  const repositoryPath = join(root, "Recurkit проект");
  await mkdir(join(repositoryPath, ".github", "workflows"), { recursive: true });
  const workflowPath = join(repositoryPath, ".github", "workflows", "deploy-production.yml");
  if (workflowAsSymlink) {
    const target = join(root, "outside-workflow.yml");
    await writeFile(target, "name: deploy\non: workflow_dispatch\n", "utf8");
    await symlink(target, workflowPath);
  } else {
    await writeFile(workflowPath, "name: deploy\non: workflow_dispatch\n", "utf8");
  }
  await execFileAsync("git", ["init", "--quiet", "-b", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "loomrail@example.invalid"], {
    cwd: repositoryPath,
  });
  await execFileAsync("git", ["config", "user.name", "Loomrail Test"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "-A"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:recurkit/recurkit.git"], {
    cwd: repositoryPath,
  });
  const commitSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })
  ).stdout.trim();
  const releaseTree = (
    await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })
  ).stdout.trim();
  return { repositoryPath, workflowPath, commitSha, releaseTree };
};

describe("GitHub Actions deployment preflight", () => {
  it("accepts a clean published repository with Unicode and spaces without passing token env", async () => {
    const repository = await fixture();
    const invocations: SupervisedProcessOptions[] = [];
    const runProcess = (options: SupervisedProcessOptions): Promise<SupervisedProcessResult> => {
      invocations.push(options);
      return Promise.resolve(
        processResult(options.args[0] === "api" ? `${repository.commitSha}\n` : "authenticated\n"),
      );
    };
    const driver = createGithubActionsDeploymentDriver({
      runProcess,
      systemEnvironment: {
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        GH_TOKEN: "gh-secret-canary",
        GITHUB_TOKEN: "github-secret-canary",
      },
      platform: process.platform,
    });

    const result = await driver.preflight({
      repositoryPath: repository.repositoryPath,
      releaseTree: repository.releaseTree,
    });
    expect(result).toMatchObject({
      type: "READY",
      target: {
        repositorySlug: "recurkit/recurkit",
        branch: "main",
        commitSha: repository.commitSha,
        workflowPath: ".github/workflows/deploy-production.yml",
      },
    });
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(invocation.env).not.toHaveProperty("GH_TOKEN");
      expect(invocation.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(
        JSON.stringify({ args: invocation.args, cwd: invocation.cwd, env: invocation.env }),
      ).not.toContain("gh-secret-canary");
      expect(
        JSON.stringify({ args: invocation.args, cwd: invocation.cwd, env: invocation.env }),
      ).not.toContain("github-secret-canary");
    }
  });

  it("refuses dirty source and a committed symlink workflow", async () => {
    const dirty = await fixture();
    await writeFile(join(dirty.repositoryPath, "неотслеживаемый файл.txt"), "dirty", "utf8");
    const runProcess = (): Promise<SupervisedProcessResult> =>
      Promise.resolve(processResult(dirty.commitSha));
    expect(
      await createGithubActionsDeploymentDriver({ runProcess }).preflight({
        repositoryPath: dirty.repositoryPath,
        releaseTree: dirty.releaseTree,
      }),
    ).toEqual({ type: "BLOCKED", code: "SOURCE_DIRTY" });

    const linked = await fixture(true);
    expect(
      await createGithubActionsDeploymentDriver({ runProcess }).preflight({
        repositoryPath: linked.repositoryPath,
        releaseTree: linked.releaseTree,
      }),
    ).toEqual({ type: "BLOCKED", code: "WORKFLOW_NOT_REGULAR" });
  });

  it("revalidates the exact target immediately before dispatch", async () => {
    const repository = await fixture();
    const runProcess = (options: SupervisedProcessOptions): Promise<SupervisedProcessResult> => {
      if (options.args[0] === "api") return Promise.resolve(processResult(repository.commitSha));
      if (options.args[0] === "workflow") {
        return Promise.resolve(processResult("https://github.com/recurkit/recurkit/actions/runs/98765\n"));
      }
      return Promise.resolve(processResult("authenticated\n"));
    };
    const driver = createGithubActionsDeploymentDriver({ runProcess });
    const prepared = await driver.preflight({
      repositoryPath: repository.repositoryPath,
      releaseTree: repository.releaseTree,
    });
    if (prepared.type !== "READY") throw new Error(`Unexpected preflight ${prepared.code}`);
    await expect(
      driver.dispatch({
        repositoryPath: repository.repositoryPath,
        releaseTree: repository.releaseTree,
        target: prepared.target,
      }),
    ).resolves.toEqual({
      type: "DISPATCHED",
      runId: 98765,
      runUrl: "https://github.com/recurkit/recurkit/actions/runs/98765",
    });

    await writeFile(repository.workflowPath, "name: changed\non: workflow_dispatch\n", "utf8");
    await expect(
      driver.dispatch({
        repositoryPath: repository.repositoryPath,
        releaseTree: repository.releaseTree,
        target: prepared.target,
      }),
    ).resolves.toEqual({ type: "REFUSED" });
  });

  it("keeps every post-admission timeout, cancellation, overflow or rejected runner outcome unknown", async () => {
    const repository = await fixture();
    const endings: readonly (SupervisedProcessResult | "REJECT")[] = [
      processResult("", { termination: "TIMED_OUT", exitCode: null }),
      processResult("", { termination: "CANCELLED", exitCode: null }),
      processResult("truncated", {
        termination: "OUTPUT_LIMIT_REACHED",
        exitCode: null,
        output: {
          text: "truncated",
          capturedBytes: 9,
          stdoutBytes: 64_000,
          stderrBytes: 0,
          truncated: true,
        },
      }),
      "REJECT",
    ];

    for (const ending of endings) {
      let dispatching = false;
      const runProcess = (options: SupervisedProcessOptions): Promise<SupervisedProcessResult> => {
        if (options.args[0] === "workflow" && dispatching) {
          if (ending === "REJECT") {
            return Promise.reject(new Error("test runner rejected after admission"));
          }
          return Promise.resolve(ending);
        }
        return Promise.resolve(
          processResult(options.args[0] === "api" ? `${repository.commitSha}\n` : "authenticated\n"),
        );
      };
      const driver = createGithubActionsDeploymentDriver({ runProcess });
      const prepared = await driver.preflight({
        repositoryPath: repository.repositoryPath,
        releaseTree: repository.releaseTree,
      });
      if (prepared.type !== "READY") throw new Error(`Unexpected preflight ${prepared.code}`);
      dispatching = true;
      await expect(
        driver.dispatch({
          repositoryPath: repository.repositoryPath,
          releaseTree: repository.releaseTree,
          target: prepared.target,
        }),
      ).resolves.toEqual({ type: "UNKNOWN" });
    }
  });
});
