import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { repositoryRoot } from "./release-manifest.mjs";

/**
 * Keeps the toolchain pinned in one place each.
 *
 * `.nvmrc` is the only pinned Node version: nvm, fnm and `actions/setup-node` all read it, and CI
 * points at the file rather than repeating the number. `packageManager` is the only pinned pnpm
 * version; Corepack installs it from there.
 *
 * Two fields remain that state something different and therefore cannot simply be deleted:
 * `engines.node` is the range of versions the workspace supports, and `engines.pnpm` is what makes
 * pnpm refuse to run under the wrong version. This check asserts they agree with the pins instead
 * of letting them drift.
 */
const read = (relativePath) => readFileSync(resolve(repositoryRoot, relativePath), "utf8");

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const pinnedNode = read(".nvmrc").trim();
expect(/^\d+\.\d+\.\d+$/.test(pinnedNode), `.nvmrc must pin an exact version, found "${pinnedNode}"`);

const manifest = JSON.parse(read("package.json"));

// The supported range has to actually contain the version everyone develops and ships on.
const range = manifest.engines.node;
const bounds = /^>=(\d+)\.(\d+) <(\d+)$/.exec(range);
if (!bounds) {
  failures.push(`engines.node has an unrecognised shape: "${range}"; update this check with it`);
} else {
  const [major, minor] = pinnedNode.split(".").map(Number);
  const [, lowMajor, lowMinor, highMajor] = bounds.map(Number);
  const atLeastLowerBound = major > lowMajor || (major === lowMajor && minor >= lowMinor);
  expect(
    atLeastLowerBound && major < highMajor,
    `.nvmrc pins ${pinnedNode}, which engines.node "${range}" does not allow`,
  );
}

const pinnedPnpm = manifest.packageManager.replace(/^pnpm@/, "");
expect(
  manifest.engines.pnpm === pinnedPnpm,
  `engines.pnpm is "${manifest.engines.pnpm}" but packageManager pins ${pinnedPnpm}`,
);

// CI must derive both versions rather than restate them.
const workflow = read(".github/workflows/ci.yml");
expect(
  !/node-version:\s*\d/.test(workflow),
  "the CI workflow hardcodes a Node version; use `node-version-file: .nvmrc`",
);
expect(
  !/corepack prepare pnpm@\d/.test(workflow),
  "the CI workflow hardcodes a pnpm version; `corepack enable` reads packageManager",
);

if (failures.length > 0) {
  process.stderr.write(`Toolchain check failed:\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Toolchain check passed: Node ${pinnedNode}, pnpm ${pinnedPnpm}.\n`);
}
