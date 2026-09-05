import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { releaseVersion, repositoryRoot, toolCommand, toolSpawnOptions } from "./release-manifest.mjs";
import { verifyStableReleaseGates } from "./stable-release-gates.mjs";

const expectedRepository = "loomrail/loomrail";
const expectedRef = "refs/heads/main";
const expectedReleaseEnvironment = "npm-release";
const maximumResponseBytes = 2 * 1024 * 1024;
const minimumNpmVersion = [11, 15, 0];
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[0-9a-f]{40}$/;

export const requiredReleaseCiJobs = Object.freeze([
  "Verify (macos-latest)",
  "Verify (windows-latest)",
  "Browser smoke (macos-latest)",
  "Browser smoke (windows-latest)",
  "Clean install (macos-latest)",
  "Clean install (windows-latest)",
]);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const parseNumericVersion = (version, label) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  assert(match !== null, `${label} must be numeric semver`);
  return match.slice(1, 4).map((part) => Number.parseInt(part, 10));
};

export const assertMinimumNpmVersion = (version) => {
  const actual = parseNumericVersion(version, "npm version");
  let comparison = 0;
  for (let index = 0; index < minimumNpmVersion.length; index += 1) {
    if (actual[index] === minimumNpmVersion[index]) continue;
    comparison = actual[index] > minimumNpmVersion[index] ? 1 : -1;
    break;
  }
  const supported = comparison >= 0;
  assert(supported, "npm 11.15.0 or newer is required for staged trusted publishing");
};

export const validateReleaseStageIntent = ({
  version,
  sourceCommit,
  confirmation,
  repository,
  ref,
  workflowCommit,
  checkedOutCommit,
  packageVersion,
}) => {
  assert(stableVersionPattern.test(version), "release version must be stable semver without a prerelease");
  assert(commitPattern.test(sourceCommit), "source commit must be an exact lowercase SHA-1");
  assert(repository === expectedRepository, "release staging is restricted to the canonical repository");
  assert(ref === expectedRef, "release staging is restricted to the main branch");
  assert(workflowCommit === sourceCommit, "source commit must match the workflow commit");
  assert(checkedOutCommit === sourceCommit, "checked-out commit must match the approved source commit");
  assert(packageVersion === version, "release package version must match the approved version");
  assert(
    confirmation === `STAGE loomrail@${version} FROM ${sourceCommit}`,
    "release confirmation does not match the exact package and commit",
  );
  return { version, sourceCommit };
};

export const selectSuccessfulCiRun = (payload, sourceCommit) => {
  assert(payload !== null && typeof payload === "object", "GitHub workflow response must be an object");
  const runs = payload.workflow_runs;
  assert(Array.isArray(runs), "GitHub workflow response is missing workflow_runs");
  const matches = runs.filter(
    (run) =>
      run !== null &&
      typeof run === "object" &&
      run.head_sha === sourceCommit &&
      run.head_branch === "main" &&
      run.event === "push" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      Number.isSafeInteger(run.id) &&
      run.id > 0,
  );
  assert(matches.length > 0, "the exact source commit has no successful main CI push run");
  return matches.sort((left, right) => right.id - left.id)[0];
};

export const validateReleaseCiJobs = (payload) => {
  assert(payload !== null && typeof payload === "object", "GitHub jobs response must be an object");
  const jobs = payload.jobs;
  assert(Array.isArray(jobs), "GitHub jobs response is missing jobs");
  for (const requiredName of requiredReleaseCiJobs) {
    const matches = jobs.filter(
      (job) => job !== null && typeof job === "object" && job.name === requiredName,
    );
    assert(matches.length === 1, `CI run must contain exactly one ${requiredName} job`);
    assert(
      matches[0].status === "completed" && matches[0].conclusion === "success",
      `${requiredName} must complete successfully`,
    );
  }
};

export const validateReleaseEnvironmentProtection = (environment, branchPolicies) => {
  assert(isRecord(environment), "release environment response must be an object");
  assert(
    environment.name === expectedReleaseEnvironment,
    `release environment must be ${expectedReleaseEnvironment}`,
  );
  assert(Array.isArray(environment.protection_rules), "release environment protection_rules are missing");

  const reviewerRules = environment.protection_rules.filter(
    (rule) => isRecord(rule) && rule.type === "required_reviewers",
  );
  assert(reviewerRules.length === 1, "release environment must have exactly one required reviewer rule");
  const reviewers = reviewerRules[0].reviewers;
  assert(
    Array.isArray(reviewers) && reviewers.length > 0 && reviewers.length <= 6,
    "release environment must have at least one required reviewer",
  );
  for (const reviewer of reviewers) {
    assert(isRecord(reviewer), "release environment reviewer must be an object");
    assert(
      reviewer.type === "User" || reviewer.type === "Team",
      "release environment reviewer type must be User or Team",
    );
    assert(isRecord(reviewer.reviewer), "release environment reviewer identity is missing");
    assert(
      Number.isSafeInteger(reviewer.reviewer.id) && reviewer.reviewer.id > 0,
      "release environment reviewer identity is invalid",
    );
  }

  const branchRules = environment.protection_rules.filter(
    (rule) => isRecord(rule) && rule.type === "branch_policy",
  );
  assert(branchRules.length === 1, "release environment must have exactly one branch policy rule");
  assert(
    isRecord(environment.deployment_branch_policy) &&
      environment.deployment_branch_policy.protected_branches === false &&
      environment.deployment_branch_policy.custom_branch_policies === true,
    "release environment must use a custom branch policy",
  );

  assert(isRecord(branchPolicies), "release branch policy response must be an object");
  assert(
    Number.isSafeInteger(branchPolicies.total_count) && Array.isArray(branchPolicies.branch_policies),
    "release branch policy response is invalid",
  );
  assert(
    branchPolicies.total_count === branchPolicies.branch_policies.length,
    "release environment requires a complete branch policy response",
  );
  assert(
    branchPolicies.branch_policies.length === 1,
    "release environment must have exactly one main branch policy",
  );
  const policy = branchPolicies.branch_policies[0];
  assert(
    isRecord(policy) &&
      Number.isSafeInteger(policy.id) &&
      policy.id > 0 &&
      policy.name === "main" &&
      (policy.type === undefined || policy.type === "branch"),
    "release environment must have exactly one main branch policy",
  );
};

const readBoundedJson = async (url, options, label) => {
  const response = await fetch(url, options);
  assert(response.ok, `${label} request failed closed with HTTP ${response.status.toString()}`);
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  assert(
    !Number.isFinite(declaredLength) || declaredLength <= maximumResponseBytes,
    `${label} response exceeds the byte limit`,
  );
  const text = await response.text();
  assert(Buffer.byteLength(text, "utf8") <= maximumResponseBytes, `${label} response exceeds the byte limit`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
};

const githubRequestOptions = (token) => ({
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  },
});

const verifyRegistryVersionIsUnused = async (version) => {
  const response = await fetch(`https://registry.npmjs.org/loomrail/${encodeURIComponent(version)}`, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (response.status === 404) return;
  assert(response.status !== 200, "the approved package version already exists in the npm registry");
  throw new Error(`npm registry availability check failed closed with HTTP ${response.status.toString()}`);
};

export const verifyReleaseStage = async (environment = process.env) => {
  const token = environment.GITHUB_TOKEN;
  assert(typeof token === "string" && token.length > 0, "GitHub Actions token is required for CI proof");

  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const npmVersion = execFileSync(toolCommand("npm"), ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...toolSpawnOptions(),
  }).trim();
  assertMinimumNpmVersion(npmVersion);

  const intent = validateReleaseStageIntent({
    version: environment.LOOMRAIL_RELEASE_VERSION ?? "",
    sourceCommit: environment.LOOMRAIL_SOURCE_COMMIT ?? "",
    confirmation: environment.LOOMRAIL_RELEASE_CONFIRMATION ?? "",
    repository: environment.GITHUB_REPOSITORY ?? "",
    ref: environment.GITHUB_REF ?? "",
    workflowCommit: environment.GITHUB_SHA ?? "",
    checkedOutCommit,
    packageVersion: releaseVersion(),
  });
  await verifyStableReleaseGates({
    releaseVersion: intent.version,
    sourceCommit: intent.sourceCommit,
  });

  const encodedEnvironment = encodeURIComponent(expectedReleaseEnvironment);
  const [releaseEnvironment, branchPolicies] = await Promise.all([
    readBoundedJson(
      `https://api.github.com/repos/${expectedRepository}/environments/${encodedEnvironment}`,
      githubRequestOptions(token),
      "GitHub release environment",
    ),
    readBoundedJson(
      `https://api.github.com/repos/${expectedRepository}/environments/${encodedEnvironment}/deployment-branch-policies?per_page=100`,
      githubRequestOptions(token),
      "GitHub release branch policies",
    ),
  ]);
  validateReleaseEnvironmentProtection(releaseEnvironment, branchPolicies);

  const query = new URLSearchParams({
    event: "push",
    head_sha: intent.sourceCommit,
    per_page: "20",
    status: "completed",
  });
  const runs = await readBoundedJson(
    `https://api.github.com/repos/${expectedRepository}/actions/workflows/ci.yml/runs?${query.toString()}`,
    githubRequestOptions(token),
    "GitHub CI runs",
  );
  const run = selectSuccessfulCiRun(runs, intent.sourceCommit);
  const jobs = await readBoundedJson(
    `https://api.github.com/repos/${expectedRepository}/actions/runs/${run.id.toString()}/jobs?per_page=100`,
    githubRequestOptions(token),
    "GitHub CI jobs",
  );
  validateReleaseCiJobs(jobs);
  await verifyRegistryVersionIsUnused(intent.version);

  process.stdout.write(
    `Release stage gate passed for loomrail@${intent.version} from ${intent.sourceCommit}.\n`,
  );
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await verifyReleaseStage();
}
