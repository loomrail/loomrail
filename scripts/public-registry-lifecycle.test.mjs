import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertContainedHarnessPath,
  assertPublicLifecycleTarget,
  assertSanitizedLifecycleEvidence,
  parsePublicRegistryLifecycleArguments,
} from "./public-registry-lifecycle.mjs";

test("accepts only an exact Beta to Stable lifecycle pair", () => {
  assert.deepEqual(parsePublicRegistryLifecycleArguments(["--beta", "0.1.0-beta.1", "--stable", "0.1.0"]), {
    betaVersion: "0.1.0-beta.1",
    stableVersion: "0.1.0",
  });

  for (const args of [
    ["--beta", "next", "--stable", "latest"],
    ["--beta", "0.1.0", "--stable", "0.1.0"],
    ["--beta", "0.1.0-beta.1", "--stable", "0.1.0-rc.1"],
    ["--beta", "0.1.0-beta.1", "--stable", "0.1.0", "--root", "/tmp/owner"],
  ]) {
    assert.throws(() => parsePublicRegistryLifecycleArguments(args));
  }
});

test("runs the live lifecycle only on the documented Stable support target", () => {
  assert.doesNotThrow(() => assertPublicLifecycleTarget("darwin", "arm64"));
  for (const target of [
    ["darwin", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
    ["linux", "arm64"],
  ]) {
    assert.throws(() => assertPublicLifecycleTarget(target[0], target[1]));
  }
});

test("contains every operation below the canonical harness root and rejects symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "loomrail lifecycle root space Юникод-"));
  const child = join(root, "child");
  await mkdir(child);
  assert.equal(await assertContainedHarnessPath(root, child), await realpath(child));
  await assert.rejects(assertContainedHarnessPath(root, root));
  await assert.rejects(assertContainedHarnessPath(root, join(root, "..")));

  const link = join(root, "external-link");
  await symlink(tmpdir(), link, "dir");
  await assert.rejects(assertContainedHarnessPath(root, link));
});

test("rejects bootstrap, credential, provider payload and absolute-root canaries from evidence", () => {
  const safe = JSON.stringify({ schemaVersion: 1, result: "PASSED", beta: "0.1.0-beta.1" });
  assert.doesNotThrow(() =>
    assertSanitizedLifecycleEvidence(safe, {
      harnessRoot: "/tmp/Loomrail private root",
      canaries: ["owner-secret-value"],
    }),
  );

  for (const unsafe of [
    "http://127.0.0.1:4176/#bootstrap=secret",
    "OPENAI_API_KEY=owner-secret-value",
    '{"type":"item.completed","rawProviderPayload":true}',
    "/tmp/Loomrail private root/data/state.sqlite",
  ]) {
    assert.throws(() =>
      assertSanitizedLifecycleEvidence(unsafe, {
        harnessRoot: "/tmp/Loomrail private root",
        canaries: ["owner-secret-value"],
      }),
    );
  }
});
