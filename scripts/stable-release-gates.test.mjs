import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { repositoryRoot } from "./release-manifest.mjs";
import {
  releaseEvidenceGates,
  requiredMacosArm64ReleaseGates,
  parseStableReleaseGateManifest,
  stableReleaseEvidencePaths,
  summarizeStableReleaseGates,
  verifyBetaReleaseGates,
  verifyStableReleaseGates,
} from "./stable-release-gates.mjs";

const sourceCommit = "f".repeat(40);
const evidenceCommit = "e".repeat(40);
const evidence = Buffer.from("bounded stable evidence\n", "utf8");
const evidenceSha256 = createHash("sha256").update(evidence).digest("hex");
const passedGate = (name) => ({
  status: "PASSED",
  evidencePath: stableReleaseEvidencePaths[name],
  evidenceSha256,
  evidenceCommit,
});

const completeManifest = () => ({
  schemaVersion: 5,
  betaReleaseVersion: "0.1.0-beta.1",
  betaReleaseTarget: "MACOS_ARM64",
  stableReleaseVersion: "0.1.0",
  stableReleaseTarget: "MACOS_ARM64",
  gates: Object.fromEntries(releaseEvidenceGates.map((name) => [name, passedGate(name)])),
});

test("records the approved macOS release target while keeping Windows evidence pending", async () => {
  const content = await readFile(`${repositoryRoot}/docs/evidence/phase-8/STABLE-RELEASE-GATES.json`, "utf8");
  const summary = summarizeStableReleaseGates(parseStableReleaseGateManifest(content));
  assert.equal(summary.betaReleaseVersion, "0.1.0-beta.1");
  assert.equal(summary.betaReleaseTarget, "MACOS_ARM64");
  assert.equal(summary.stableReleaseVersion, "0.1.1");
  assert.equal(summary.stableReleaseTarget, "MACOS_ARM64");
  assert.deepEqual(summary.pending, ["codexWindowsCompatibility", "claudeWindowsCompatibility"]);
  assert.equal(summary.passed.length, 9);
  assert.deepEqual(requiredMacosArm64ReleaseGates, releaseEvidenceGates.slice(0, 9));
});

test("rejects the superseded schema-v4 contract without support targets", () => {
  const manifest = completeManifest();
  manifest.schemaVersion = 4;
  delete manifest.betaReleaseTarget;
  delete manifest.stableReleaseTarget;

  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(manifest)), /fields must be exactly/);
});

test("rejects a version-five manifest that omits the local CLI workspace-execution gate", () => {
  const manifest = completeManifest();
  delete manifest.gates.q20LocalSubscriptionWorkspaceExecution;

  assert.throws(
    () => parseStableReleaseGateManifest(JSON.stringify(manifest)),
    /stable gate manifest gates fields must be exactly/,
  );
});

test("accepts a complete exact evidence manifest", async () => {
  const summary = await verifyStableReleaseGates({
    releaseVersion: "0.1.0",
    supportTarget: "MACOS_ARM64",
    sourceCommit,
    root: repositoryRoot,
    loadEvidence: async () => evidence,
    loadCommittedEvidence: async () => evidence,
    isAncestor: () => true,
    manifestOverride: completeManifest(),
  });
  assert.deepEqual(summary.pending, []);
});

test("accepts Beta with the exact nine non-Windows gates and keeps Windows pending", async () => {
  const manifest = completeManifest();
  manifest.stableReleaseVersion = null;
  manifest.stableReleaseTarget = null;
  manifest.gates.codexWindowsCompatibility = {
    status: "PENDING",
    reason: "No live Codex CLI evidence exists for Windows.",
  };
  manifest.gates.claudeWindowsCompatibility = {
    status: "PENDING",
    reason: "No live Claude Code CLI evidence exists for Windows.",
  };

  const summary = await verifyBetaReleaseGates({
    releaseVersion: "0.1.0-beta.1",
    supportTarget: "MACOS_ARM64",
    sourceCommit,
    root: repositoryRoot,
    loadEvidence: async () => evidence,
    loadCommittedEvidence: async () => evidence,
    isAncestor: () => true,
    manifestOverride: manifest,
  });
  assert.equal(summary.betaReleaseVersion, "0.1.0-beta.1");
  assert.deepEqual(summary.pending, ["codexWindowsCompatibility", "claudeWindowsCompatibility"]);
});

test("Beta rejects a pending non-Windows gate and version drift", async () => {
  const manifest = completeManifest();
  manifest.gates.privateDogfood = { status: "PENDING", reason: "Dogfood is incomplete." };

  await assert.rejects(
    verifyBetaReleaseGates({
      releaseVersion: "0.1.0-beta.1",
      supportTarget: "MACOS_ARM64",
      sourceCommit,
      manifestOverride: manifest,
    }),
    /Beta release gates are still pending: privateDogfood/,
  );
  await assert.rejects(
    verifyBetaReleaseGates({
      releaseVersion: "0.1.0-beta.2",
      supportTarget: "MACOS_ARM64",
      sourceCommit,
      manifestOverride: completeManifest(),
    }),
    /does not approve this Beta release version/,
  );
});

test("rejects unknown fields, unsafe paths and malformed release identities", () => {
  const manifest = completeManifest();
  assert.throws(
    () => parseStableReleaseGateManifest(JSON.stringify({ ...manifest, approved: true })),
    /fields must be exactly/,
  );

  const unsafe = completeManifest();
  unsafe.gates.privateDogfood.evidencePath = "docs/evidence/../secret.md";
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(unsafe)), /evidencePath/);

  const unrelated = completeManifest();
  unrelated.gates.privateDogfood.evidencePath = stableReleaseEvidencePaths.q13FinalSecurityReliabilityReview;
  assert.throws(
    () => parseStableReleaseGateManifest(JSON.stringify(unrelated)),
    /privateDogfood evidencePath/,
  );

  const terminalControl = completeManifest();
  terminalControl.gates.privateDogfood = { status: "PENDING", reason: "Waiting\u001b[2J" };
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(terminalControl)), /pending reason/);

  const invalidBeta = completeManifest();
  invalidBeta.betaReleaseVersion = "0.1.0-alpha.5";
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(invalidBeta)), /Beta semver/);

  const prereleaseStable = completeManifest();
  prereleaseStable.stableReleaseVersion = "0.1.0-beta.1";
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(prereleaseStable)), /stable semver/);

  const unknownTarget = completeManifest();
  unknownTarget.stableReleaseTarget = "WINDOWS_X64";
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(unknownTarget)), /supported target/);

  const missingTarget = completeManifest();
  missingTarget.stableReleaseTarget = null;
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(missingTarget)), /selected together/);
});

test("rejects every incomplete gate before reading evidence", async () => {
  const manifest = completeManifest();
  manifest.gates.privateDogfood = { status: "PENDING", reason: "Owner action is required." };
  await assert.rejects(
    verifyStableReleaseGates({
      releaseVersion: "0.1.0",
      supportTarget: "MACOS_ARM64",
      sourceCommit,
      root: repositoryRoot,
      manifestOverride: manifest,
      loadEvidence: async () => assert.fail("must not read evidence"),
      loadCommittedEvidence: async () => assert.fail("must not read committed evidence"),
      isAncestor: () => assert.fail("must not inspect ancestry"),
    }),
    /privateDogfood/,
  );
});

test("rejects evidence drift and non-ancestor evidence commits", async () => {
  await assert.rejects(
    verifyStableReleaseGates({
      releaseVersion: "0.1.0",
      supportTarget: "MACOS_ARM64",
      sourceCommit,
      root: repositoryRoot,
      manifestOverride: completeManifest(),
      loadEvidence: async () => Buffer.from("changed evidence\n", "utf8"),
      loadCommittedEvidence: async () => evidence,
      isAncestor: () => true,
    }),
    /current evidence digest does not match/,
  );

  await assert.rejects(
    verifyStableReleaseGates({
      releaseVersion: "0.1.0",
      supportTarget: "MACOS_ARM64",
      sourceCommit,
      root: repositoryRoot,
      manifestOverride: completeManifest(),
      loadEvidence: async () => evidence,
      loadCommittedEvidence: async () => evidence,
      isAncestor: () => false,
    }),
    /not an ancestor/,
  );
});

test("source CI verifies recorded stable evidence from full history", async () => {
  const workflow = await readFile(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8");
  const verifyJob = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("\n  browser:"));
  assert.ok(verifyJob.includes("fetch-depth: 0"));
  assert.ok(verifyJob.includes("name: Verify recorded stable release evidence"));
  assert.ok(verifyJob.includes("run: pnpm release:status"));
});

test("accepts a macOS-scoped Stable release while preserving pending Windows evidence", async () => {
  const manifest = completeManifest();
  manifest.gates.codexWindowsCompatibility = {
    status: "PENDING",
    reason: "No live Codex CLI evidence exists for Windows.",
  };
  manifest.gates.claudeWindowsCompatibility = {
    status: "PENDING",
    reason: "No live Claude Code CLI evidence exists for Windows.",
  };

  const summary = await verifyStableReleaseGates({
    releaseVersion: "0.1.0",
    supportTarget: "MACOS_ARM64",
    sourceCommit,
    root: repositoryRoot,
    loadEvidence: async () => evidence,
    loadCommittedEvidence: async () => evidence,
    isAncestor: () => true,
    manifestOverride: manifest,
  });
  assert.equal(summary.stableReleaseTarget, "MACOS_ARM64");
  assert.deepEqual(summary.pending, ["codexWindowsCompatibility", "claudeWindowsCompatibility"]);
});

test("rejects Stable support-target drift before reading evidence", async () => {
  await assert.rejects(
    verifyStableReleaseGates({
      releaseVersion: "0.1.0",
      supportTarget: "WINDOWS_X64",
      sourceCommit,
      manifestOverride: completeManifest(),
      loadEvidence: async () => assert.fail("must not read evidence"),
    }),
    /support target is invalid/,
  );
});
