import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { releaseVersion, repositoryRoot } from "./release-manifest.mjs";

const manifestRelativePath = "docs/evidence/phase-8/STABLE-RELEASE-GATES.json";
const maximumManifestBytes = 64 * 1024;
const maximumEvidenceBytes = 1024 * 1024;
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const betaVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const commitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const evidencePathPattern = /^docs\/evidence\/[A-Za-z0-9._/-]+\.md$/;

export const releaseSupportTargets = Object.freeze(["MACOS_ARM64"]);

export const releaseEvidenceGates = Object.freeze([
  "q13FinalSecurityReliabilityReview",
  "q15CanonicalActivationNonLanding",
  "q17MeasuredProjectVerification",
  "q20LocalSubscriptionWorkspaceExecution",
  "managedPublicDogfoodRehearsal",
  "codexMacosCompatibility",
  "claudeMacosCompatibility",
  "privateDogfood",
  "protectedLandingCanonicalActivation",
  "codexWindowsCompatibility",
  "claudeWindowsCompatibility",
]);

export const requiredMacosArm64ReleaseGates = Object.freeze([
  "q13FinalSecurityReliabilityReview",
  "q15CanonicalActivationNonLanding",
  "q17MeasuredProjectVerification",
  "q20LocalSubscriptionWorkspaceExecution",
  "managedPublicDogfoodRehearsal",
  "codexMacosCompatibility",
  "claudeMacosCompatibility",
  "privateDogfood",
  "protectedLandingCanonicalActivation",
]);

export const stableReleaseEvidencePaths = Object.freeze({
  q13FinalSecurityReliabilityReview: "docs/evidence/phase-8/Q13-FINAL-SECURITY-RELIABILITY-EVIDENCE.md",
  q15CanonicalActivationNonLanding: "docs/evidence/phase-8/Q15-GUIDED-ACTIVATION-EVIDENCE.md",
  q17MeasuredProjectVerification: "docs/evidence/phase-8/Q17-PROJECT-VERIFICATION-EVIDENCE.md",
  q20LocalSubscriptionWorkspaceExecution:
    "docs/evidence/phase-8/Q20-LOCAL-SUBSCRIPTION-WORKSPACE-EXECUTION-EVIDENCE.md",
  managedPublicDogfoodRehearsal: "docs/evidence/phase-8/Q20-MANAGED-PUBLIC-DOGFOOD-EVIDENCE.md",
  codexMacosCompatibility: "docs/evidence/phase-8/Q20-LOCAL-SUBSCRIPTION-WORKSPACE-EXECUTION-EVIDENCE.md",
  claudeMacosCompatibility: "docs/evidence/phase-8/Q20-LOCAL-SUBSCRIPTION-WORKSPACE-EXECUTION-EVIDENCE.md",
  privateDogfood: "docs/evidence/phase-8/STABLE-PRIVATE-DOGFOOD-EVIDENCE.md",
  protectedLandingCanonicalActivation: "docs/evidence/phase-8/STABLE-PROTECTED-LANDING-EVIDENCE.md",
  codexWindowsCompatibility: "docs/evidence/phase-8/STABLE-WINDOWS-LIVE-PROVIDERS-EVIDENCE.md",
  claudeWindowsCompatibility: "docs/evidence/phase-8/STABLE-WINDOWS-LIVE-PROVIDERS-EVIDENCE.md",
});

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const assertExactKeys = (value, expected, label) => {
  assert(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} fields must be exactly: ${wanted.join(", ")}`,
  );
};

const assertSafeEvidencePath = (path, label) => {
  assert(typeof path === "string" && evidencePathPattern.test(path), `${label} is not a safe evidence path`);
  assert(!isAbsolute(path), `${label} must be repository-relative`);
  assert(!path.split("/").includes(".."), `${label} must not traverse outside the repository`);
  assert(!path.includes("//") && !path.includes("\\"), `${label} must use a canonical POSIX path`);
};

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const containsControlCharacter = (value) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });

export const parseStableReleaseGateManifest = (text) => {
  assert(
    Buffer.byteLength(text, "utf8") <= maximumManifestBytes,
    "stable gate manifest exceeds the byte limit",
  );
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("stable gate manifest is not valid JSON");
  }

  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "betaReleaseVersion",
      "betaReleaseTarget",
      "stableReleaseVersion",
      "stableReleaseTarget",
      "gates",
    ],
    "stable gate manifest",
  );
  assert(manifest.schemaVersion === 5, "stable gate manifest schemaVersion must be 5");
  assert(
    manifest.betaReleaseVersion === null ||
      (typeof manifest.betaReleaseVersion === "string" &&
        betaVersionPattern.test(manifest.betaReleaseVersion)),
    "stable gate manifest betaReleaseVersion must be null or Beta semver",
  );
  assert(
    manifest.stableReleaseVersion === null ||
      (typeof manifest.stableReleaseVersion === "string" &&
        stableVersionPattern.test(manifest.stableReleaseVersion)),
    "stable gate manifest stableReleaseVersion must be null or stable semver",
  );
  assert(
    manifest.betaReleaseTarget === null || releaseSupportTargets.includes(manifest.betaReleaseTarget),
    "stable gate manifest betaReleaseTarget must be null or a supported target",
  );
  assert(
    manifest.stableReleaseTarget === null || releaseSupportTargets.includes(manifest.stableReleaseTarget),
    "stable gate manifest stableReleaseTarget must be null or a supported target",
  );
  assert(
    (manifest.betaReleaseVersion === null) === (manifest.betaReleaseTarget === null),
    "stable gate manifest Beta version and target must be selected together",
  );
  assert(
    (manifest.stableReleaseVersion === null) === (manifest.stableReleaseTarget === null),
    "stable gate manifest Stable version and target must be selected together",
  );
  assertExactKeys(manifest.gates, releaseEvidenceGates, "stable gate manifest gates");

  for (const gateName of releaseEvidenceGates) {
    const gate = manifest.gates[gateName];
    assert(isRecord(gate), `${gateName} gate must be an object`);
    if (gate.status === "PENDING") {
      assertExactKeys(gate, ["status", "reason"], `${gateName} gate`);
      assert(
        typeof gate.reason === "string" &&
          gate.reason.length > 0 &&
          gate.reason.length <= 300 &&
          !containsControlCharacter(gate.reason),
        `${gateName} pending reason must contain 1-300 characters`,
      );
      continue;
    }

    assert(gate.status === "PASSED", `${gateName} gate status must be PENDING or PASSED`);
    assertExactKeys(gate, ["status", "evidencePath", "evidenceSha256", "evidenceCommit"], `${gateName} gate`);
    assertSafeEvidencePath(gate.evidencePath, `${gateName} evidencePath`);
    assert(
      gate.evidencePath === stableReleaseEvidencePaths[gateName],
      `${gateName} evidencePath must be ${stableReleaseEvidencePaths[gateName]}`,
    );
    assert(
      typeof gate.evidenceSha256 === "string" && digestPattern.test(gate.evidenceSha256),
      `${gateName} evidenceSha256 must be an exact lowercase SHA-256`,
    );
    assert(
      typeof gate.evidenceCommit === "string" && commitPattern.test(gate.evidenceCommit),
      `${gateName} evidenceCommit must be an exact lowercase commit`,
    );
  }

  return manifest;
};

export const summarizeStableReleaseGates = (manifest) => ({
  betaReleaseVersion: manifest.betaReleaseVersion,
  betaReleaseTarget: manifest.betaReleaseTarget,
  stableReleaseVersion: manifest.stableReleaseVersion,
  stableReleaseTarget: manifest.stableReleaseTarget,
  passed: releaseEvidenceGates.filter((name) => manifest.gates[name].status === "PASSED"),
  pending: releaseEvidenceGates.filter((name) => manifest.gates[name].status === "PENDING"),
});

const readBoundedRegularFile = async (root, relativePath, maximumBytes, label) => {
  const absoluteRoot = await realpath(root);
  const absolutePath = resolve(absoluteRoot, relativePath);
  const relativePathFromRoot = relative(absoluteRoot, absolutePath);
  assert(
    relativePathFromRoot.length > 0 &&
      !relativePathFromRoot.startsWith(`..${sep}`) &&
      relativePathFromRoot !== ".." &&
      !isAbsolute(relativePathFromRoot),
    `${label} escapes the repository`,
  );
  const metadata = await lstat(absolutePath);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert(metadata.size <= maximumBytes, `${label} exceeds the byte limit`);
  const canonicalPath = await realpath(absolutePath);
  assert(canonicalPath.startsWith(`${absoluteRoot}${sep}`), `${label} resolves outside the repository`);
  const content = await readFile(canonicalPath);
  assert(content.byteLength <= maximumBytes, `${label} exceeds the byte limit`);
  return content;
};

const loadStableReleaseManifest = async (root, manifestOverride) =>
  manifestOverride === undefined
    ? parseStableReleaseGateManifest(
        (
          await readBoundedRegularFile(
            root,
            manifestRelativePath,
            maximumManifestBytes,
            "stable gate manifest",
          )
        ).toString("utf8"),
      )
    : parseStableReleaseGateManifest(JSON.stringify(manifestOverride));

export const verifyRecordedStableReleaseEvidence = async ({
  manifest,
  sourceCommit,
  root = repositoryRoot,
  loadEvidence,
  loadCommittedEvidence,
  isAncestor,
} = {}) => {
  assert(
    typeof sourceCommit === "string" && commitPattern.test(sourceCommit),
    "stable release source commit is invalid",
  );
  const parsedManifest = parseStableReleaseGateManifest(JSON.stringify(manifest));
  const evidenceLoader =
    loadEvidence ?? ((path) => readBoundedRegularFile(root, path, maximumEvidenceBytes, `${path} evidence`));
  const committedEvidenceLoader =
    loadCommittedEvidence ??
    ((commit, path) =>
      execFileSync("git", ["show", `${commit}:${path}`], {
        cwd: root,
        encoding: null,
        maxBuffer: maximumEvidenceBytes + 1,
      }));
  const ancestorCheck =
    isAncestor ??
    ((commit, descendant) => {
      const result = spawnSync("git", ["merge-base", "--is-ancestor", commit, descendant], {
        cwd: root,
        encoding: "utf8",
      });
      assert(result.error === undefined, "could not verify stable evidence commit ancestry");
      return result.status === 0;
    });

  for (const gateName of releaseEvidenceGates) {
    const gate = parsedManifest.gates[gateName];
    if (gate.status === "PENDING") continue;
    assert(
      ancestorCheck(gate.evidenceCommit, sourceCommit),
      `${gateName} evidence commit is not an ancestor of the release source`,
    );
    const currentEvidence = await evidenceLoader(gate.evidencePath);
    assert(currentEvidence.byteLength <= maximumEvidenceBytes, `${gateName} evidence exceeds the byte limit`);
    assert(
      sha256(currentEvidence) === gate.evidenceSha256,
      `${gateName} current evidence digest does not match`,
    );
    const committedEvidence = await committedEvidenceLoader(gate.evidenceCommit, gate.evidencePath);
    assert(
      committedEvidence.byteLength <= maximumEvidenceBytes,
      `${gateName} committed evidence exceeds the byte limit`,
    );
    assert(
      sha256(committedEvidence) === gate.evidenceSha256,
      `${gateName} committed evidence digest does not match`,
    );
  }

  return summarizeStableReleaseGates(parsedManifest);
};

export const verifyStableReleaseGates = async ({
  releaseVersion,
  supportTarget,
  sourceCommit,
  root = repositoryRoot,
  manifestOverride,
  loadEvidence,
  loadCommittedEvidence,
  isAncestor,
} = {}) => {
  assert(
    typeof releaseVersion === "string" && stableVersionPattern.test(releaseVersion),
    "stable release version is invalid",
  );
  assert(
    typeof sourceCommit === "string" && commitPattern.test(sourceCommit),
    "stable release source commit is invalid",
  );
  assert(
    typeof supportTarget === "string" && releaseSupportTargets.includes(supportTarget),
    "stable release support target is invalid",
  );

  const manifest = await loadStableReleaseManifest(root, manifestOverride);
  assert(
    manifest.stableReleaseVersion === releaseVersion,
    "stable gate manifest does not approve this release version",
  );
  assert(
    manifest.stableReleaseTarget === supportTarget,
    "stable gate manifest does not approve this release support target",
  );

  const pending = requiredMacosArm64ReleaseGates.filter((name) => manifest.gates[name].status === "PENDING");
  assert(pending.length === 0, `stable release gates are still pending: ${pending.join(", ")}`);
  return verifyRecordedStableReleaseEvidence({
    manifest,
    sourceCommit,
    root,
    loadEvidence,
    loadCommittedEvidence,
    isAncestor,
  });
};

export const verifyBetaReleaseGates = async ({
  releaseVersion,
  supportTarget,
  sourceCommit,
  root = repositoryRoot,
  manifestOverride,
  loadEvidence,
  loadCommittedEvidence,
  isAncestor,
} = {}) => {
  assert(
    typeof releaseVersion === "string" && betaVersionPattern.test(releaseVersion),
    "Beta release version is invalid",
  );
  assert(
    typeof sourceCommit === "string" && commitPattern.test(sourceCommit),
    "Beta release source commit is invalid",
  );
  assert(
    typeof supportTarget === "string" && releaseSupportTargets.includes(supportTarget),
    "Beta release support target is invalid",
  );

  const manifest = await loadStableReleaseManifest(root, manifestOverride);
  assert(
    manifest.betaReleaseVersion === releaseVersion,
    "stable gate manifest does not approve this Beta release version",
  );
  assert(
    manifest.betaReleaseTarget === supportTarget,
    "stable gate manifest does not approve this Beta release support target",
  );

  const pending = requiredMacosArm64ReleaseGates.filter((name) => manifest.gates[name].status === "PENDING");
  assert(pending.length === 0, `Beta release gates are still pending: ${pending.join(", ")}`);
  return verifyRecordedStableReleaseEvidence({
    manifest,
    sourceCommit,
    root,
    loadEvidence,
    loadCommittedEvidence,
    isAncestor,
  });
};

const printStatus = async () => {
  const manifest = await loadStableReleaseManifest(repositoryRoot);
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const summary = await verifyRecordedStableReleaseEvidence({
    manifest,
    sourceCommit,
  });
  const betaPending = requiredMacosArm64ReleaseGates.filter(
    (name) => manifest.gates[name].status === "PENDING",
  );
  process.stdout.write(`Beta release version: ${summary.betaReleaseVersion ?? "not selected"}\n`);
  process.stdout.write(`Beta release target: ${summary.betaReleaseTarget ?? "not selected"}\n`);
  process.stdout.write(
    `Beta passed gates: ${(requiredMacosArm64ReleaseGates.length - betaPending.length).toString()}/${requiredMacosArm64ReleaseGates.length.toString()}\n`,
  );
  process.stdout.write(`Stable release version: ${summary.stableReleaseVersion ?? "not selected"}\n`);
  process.stdout.write(`Stable release target: ${summary.stableReleaseTarget ?? "not selected"}\n`);
  process.stdout.write(
    `Compatibility evidence: ${summary.passed.length.toString()}/${releaseEvidenceGates.length.toString()}\n`,
  );
  const stablePending = requiredMacosArm64ReleaseGates.filter(
    (name) => manifest.gates[name].status === "PENDING",
  );
  process.stdout.write(
    `Stable required gates: ${(requiredMacosArm64ReleaseGates.length - stablePending.length).toString()}/${requiredMacosArm64ReleaseGates.length.toString()}\n`,
  );
  for (const name of summary.pending)
    process.stdout.write(`PENDING ${name}: ${manifest.gates[name].reason}\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "--beta") {
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    const summary = await verifyBetaReleaseGates({
      releaseVersion: releaseVersion(),
      supportTarget: "MACOS_ARM64",
      sourceCommit,
    });
    process.stdout.write(
      `Beta release gate passed for loomrail@${summary.betaReleaseVersion}: ${requiredMacosArm64ReleaseGates.length.toString()}/${requiredMacosArm64ReleaseGates.length.toString()} required gates.\n`,
    );
  } else {
    await printStatus();
  }
}
