import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { repositoryRoot } from "./release-manifest.mjs";
import {
  assertMinimumNpmVersion,
  requiredReleaseCiJobs,
  selectSuccessfulCiRun,
  validateReleaseEnvironmentProtection,
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

const protectedReleaseEnvironment = {
  name: "npm-release",
  protection_rules: [
    {
      type: "required_reviewers",
      reviewers: [
        {
          type: "User",
          reviewer: { id: 42, login: "release-owner" },
        },
      ],
    },
    { type: "branch_policy" },
  ],
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
};

const mainOnlyBranchPolicies = {
  total_count: 1,
  branch_policies: [{ id: 7, name: "main", type: "branch" }],
};

test("requires a reviewed main-only release environment", () => {
  assert.doesNotThrow(() =>
    validateReleaseEnvironmentProtection(protectedReleaseEnvironment, mainOnlyBranchPolicies),
  );

  const withWaitTimer = {
    ...protectedReleaseEnvironment,
    protection_rules: [...protectedReleaseEnvironment.protection_rules, { type: "wait_timer" }],
  };
  assert.doesNotThrow(() => validateReleaseEnvironmentProtection(withWaitTimer, mainOnlyBranchPolicies));
});

test("rejects an unreviewed, unrestricted or broader release environment", () => {
  assert.throws(
    () =>
      validateReleaseEnvironmentProtection(
        {
          ...protectedReleaseEnvironment,
          protection_rules: [{ type: "branch_policy" }],
        },
        mainOnlyBranchPolicies,
      ),
    /required reviewer/,
  );
  assert.throws(
    () =>
      validateReleaseEnvironmentProtection(
        {
          ...protectedReleaseEnvironment,
          deployment_branch_policy: null,
        },
        mainOnlyBranchPolicies,
      ),
    /custom branch policy/,
  );
  assert.throws(
    () =>
      validateReleaseEnvironmentProtection(protectedReleaseEnvironment, {
        total_count: 2,
        branch_policies: [
          { id: 7, name: "main", type: "branch" },
          { id: 8, name: "release/*", type: "branch" },
        ],
      }),
    /exactly one main branch policy/,
  );
  assert.throws(
    () =>
      validateReleaseEnvironmentProtection(protectedReleaseEnvironment, {
        total_count: 2,
        branch_policies: [{ id: 7, name: "main", type: "branch" }],
      }),
    /complete branch policy response/,
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
    "fetch-depth: 0",
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

  const gate = await readFile(join(repositoryRoot, "scripts", "verify-release-stage.mjs"), "utf8");
  assert.match(gate, /await verifyStableReleaseGates\(\{/);
});
