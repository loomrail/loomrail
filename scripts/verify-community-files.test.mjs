import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyCommunityFiles } from "./verify-community-files.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const publicFiles = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "ROADMAP.md", "docs/README.md"];

const copiedCommunityTree = async () => {
  const root = await mkdtemp(join(tmpdir(), "loomrail community policy "));
  await mkdir(join(root, ".github"), { recursive: true });
  await cp(join(sourceRoot, ".github", "ISSUE_TEMPLATE"), join(root, ".github", "ISSUE_TEMPLATE"), {
    recursive: true,
  });
  for (const relativePath of publicFiles) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await cp(join(sourceRoot, relativePath), join(root, relativePath));
  }
  return root;
};

test("accepts the closed public intake and roadmap", async () => {
  await assert.doesNotReject(verifyCommunityFiles(sourceRoot));
});

test("refuses public blank issues", async () => {
  const root = await copiedCommunityTree();
  try {
    const path = join(root, ".github", "ISSUE_TEMPLATE", "config.yml");
    const config = await readFile(path, "utf8");
    await writeFile(
      path,
      config.replace("blank_issues_enabled: false", "blank_issues_enabled: true"),
      "utf8",
    );

    await assert.rejects(verifyCommunityFiles(root), /public blank issues must remain disabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a bug form without the private security route", async () => {
  const root = await copiedCommunityTree();
  try {
    const path = join(root, ".github", "ISSUE_TEMPLATE", "bug.yml");
    const form = await readFile(path, "utf8");
    await writeFile(path, form.replace("security/advisories/new", "issues/new"), "utf8");

    await assert.rejects(verifyCommunityFiles(root), /missing the private security route/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a bug form with a weakened required field", async () => {
  const root = await copiedCommunityTree();
  try {
    const path = join(root, ".github", "ISSUE_TEMPLATE", "bug.yml");
    const form = await readFile(path, "utf8");
    const reproduction = form.replace(
      /(?<prefix> {4}id: reproduction[\s\S]*? {4}validations:\n {6})required: true/,
      "$<prefix>required: false",
    );
    assert.notEqual(reproduction, form);
    await writeFile(path, reproduction, "utf8");

    await assert.rejects(verifyCommunityFiles(root), /required-field contract changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a dated roadmap commitment", async () => {
  const root = await copiedCommunityTree();
  try {
    const path = join(root, "ROADMAP.md");
    const roadmap = await readFile(path, "utf8");
    await writeFile(path, `${roadmap}\nTarget: Q4 2027.\n`, "utf8");

    await assert.rejects(verifyCommunityFiles(root), /must not contain a calendar commitment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
