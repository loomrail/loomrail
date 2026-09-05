import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { repositoryRoot } from "./release-manifest.mjs";
import {
  assertMinimumNpmVersion,
  requiredReleaseCiJobs,
  selectSuccessfulCiRun,
  validateReleaseCiJobs,
  validateReleaseStageIntent,
} from "./verify-release-stage.mjs";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const validIntent = {
  version: "0.1.0",
  sourceCommit,
  confirmation: `STAGE loomrail@0.1.0 FROM ${sourceCommit}`,
  repository: "loomrail/loomrail",
  ref: "refs/heads/main",
  workflowCommit: sourceCommit,
  checkedOutCommit: sourceCommit,
  packageVersion: "0.1.0",
};

test("accepts an exact stable release intent", () => {
  assert.deepEqual(validateReleaseStageIntent(validIntent), {
    version: "0.1.0",
    sourceCommit,
  });
});

test("rejects prerelease, branch, commit, package and confirmation drift", () => {
  for (const patch of [
    { version: "0.1.0-alpha.5" },
    { repository: "someone/fork" },
    { ref: "refs/heads/release" },
    { workflowCommit: "a".repeat(40) },
    { checkedOutCommit: "b".repeat(40) },
    { packageVersion: "0.1.1" },
    { confirmation: "STAGE" },
  ]) {
    assert.throws(() => validateReleaseStageIntent({ ...validIntent, ...patch }));
  }
});

test("requires npm with staged publishing support", () => {
  assert.doesNotThrow(() => assertMinimumNpmVersion("11.15.0"));
  assert.doesNotThrow(() => assertMinimumNpmVersion("12.0.2"));
  assert.throws(() => assertMinimumNpmVersion("11.14.9"), /npm 11\.15\.0 or newer/);
});

test("selects only a successful main push CI run for the exact commit", () => {
  const selected = selectSuccessfulCiRun(
    {
      workflow_runs: [
        {
          id: 1,
          head_sha: sourceCommit,
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "failure",
        },
        {
          id: 3,
          head_sha: sourceCommit,
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
        },
        {
          id: 4,
          head_sha: "f".repeat(40),
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    sourceCommit,
  );
  assert.equal(selected.id, 3);
  assert.throws(
    () =>
      selectSuccessfulCiRun(
        {
          workflow_runs: [
            {
              id: 1,
              head_sha: sourceCommit,
              head_branch: "feature",
              event: "push",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
        sourceCommit,
      ),
    /no successful main CI push run/,
  );
});

test("requires one successful job for every blocking CI lane", () => {
  const jobs = requiredReleaseCiJobs.map((name) => ({ name, status: "completed", conclusion: "success" }));
  assert.doesNotThrow(() => validateReleaseCiJobs({ jobs }));
  assert.throws(
    () => validateReleaseCiJobs({ jobs: jobs.slice(1) }),
    /must contain exactly one Verify \(macos-latest\) job/,
  );
  assert.throws(
    () =>
      validateReleaseCiJobs({
        jobs: jobs.map((job, index) => (index === 0 ? { ...job, conclusion: "failure" } : job)),
      }),
    /must complete successfully/,
  );
});

test("trusted stage workflow is manual, stage-only and OIDC-bound", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github", "workflows", "npm-stage.yml"), "utf8");
  for (const requiredText of [
    "workflow_dispatch:",
    "environment: npm-release",
    "actions: read",
    "contents: read",
    "id-token: write",
    "persist-credentials: false",
    "node scripts/verify-release-stage.mjs",
    "pnpm test:fault-injection",
    "pnpm test:e2e",
    "pnpm pack:release",
    "pnpm test:release",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "retention-days: 7",
    "npm stage publish",
    "--tag latest",
    "--access public",
    "--provenance",
  ]) {
    assert.ok(workflow.includes(requiredText), `trusted stage workflow is missing ${requiredText}`);
  }
  assert.doesNotMatch(workflow, /\bnpm publish\b/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@(?![0-9a-f]{40}(?:\s|$))/);
});
