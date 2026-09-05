import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { repositoryRoot } from "./release-manifest.mjs";
import {
  parseStableReleaseGateManifest,
  requiredStableReleaseGates,
  stableReleaseEvidencePaths,
  summarizeStableReleaseGates,
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
  schemaVersion: 1,
  releaseVersion: "0.1.0",
  gates: Object.fromEntries(requiredStableReleaseGates.map((name) => [name, passedGate(name)])),
});

test("records the current honest stable readiness without promoting pending gates", async () => {
  const content = await readFile(`${repositoryRoot}/docs/evidence/phase-8/STABLE-RELEASE-GATES.json`, "utf8");
  const summary = summarizeStableReleaseGates(parseStableReleaseGateManifest(content));
  assert.equal(summary.releaseVersion, null);
  assert.deepEqual(summary.pending, [
    "privateDogfood",
    "protectedLandingCanonicalActivation",
    "codexWindowsCompatibility",
    "claudeWindowsCompatibility",
  ]);
  assert.equal(summary.passed.length, 6);
});

test("accepts a complete exact evidence manifest", async () => {
  const summary = await verifyStableReleaseGates({
    releaseVersion: "0.1.0",
    sourceCommit,
    root: repositoryRoot,
    loadEvidence: async () => evidence,
    loadCommittedEvidence: async () => evidence,
    isAncestor: () => true,
    manifestOverride: completeManifest(),
  });
  assert.deepEqual(summary.pending, []);
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
  unrelated.gates.privateDogfood.evidencePath = stableReleaseEvidencePaths.finalSecurityReview;
  assert.throws(
    () => parseStableReleaseGateManifest(JSON.stringify(unrelated)),
    /privateDogfood evidencePath/,
  );

  const terminalControl = completeManifest();
  terminalControl.gates.privateDogfood = { status: "PENDING", reason: "Waiting\u001b[2J" };
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(terminalControl)), /pending reason/);

  const prerelease = completeManifest();
  prerelease.releaseVersion = "0.1.0-alpha.5";
  assert.throws(() => parseStableReleaseGateManifest(JSON.stringify(prerelease)), /stable semver/);
});

test("rejects every incomplete gate before reading evidence", async () => {
  const manifest = completeManifest();
  manifest.gates.privateDogfood = { status: "PENDING", reason: "Owner action is required." };
  await assert.rejects(
    verifyStableReleaseGates({
      releaseVersion: "0.1.0",
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
