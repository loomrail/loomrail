import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  releaseDependencies,
  releaseName,
  releaseVersion,
  repositoryRoot,
  toolCommand,
  toolSpawnOptions,
} from "./release-manifest.mjs";

/**
 * Assembles the publishable launcher from an already-built workspace and packs it into a tarball.
 *
 * The staged tree mirrors the repository layout on purpose: the launcher resolves the web assets and
 * the daemon resolves the bundled fixtures relative to their own module URL, so an identical layout
 * keeps both lookups correct in the package without any packaging-aware code in the product.
 */
const stagingDirectory = resolve(repositoryRoot, "dist-release");
const packageDirectory = resolve(stagingDirectory, "package");

const copyInto = async (from, to) => {
  await cp(resolve(repositoryRoot, from), resolve(packageDirectory, to), { recursive: true });
};

const assertNotEmpty = async (relativePath, hint) => {
  const entries = await readdir(resolve(packageDirectory, relativePath)).catch(() => []);
  if (entries.length === 0) throw new Error(`${relativePath} is empty in the staged package; ${hint}`);
};

const run = async () => {
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(packageDirectory, { recursive: true });

  await copyInto("apps/cli/bundle/apps/cli/dist", "apps/cli/dist");
  await copyInto("apps/web/dist", "apps/web/dist");
  await copyInto("packages/plugin-sdk/dist", "packages/plugin-sdk/dist");
  await copyInto("fixtures/projects", "fixtures/projects");
  // The bundled code keeps the persistence package's `../migrations` lookup, which now resolves
  // beside the launcher instead of beside that package.
  await copyInto("packages/persistence-sqlite/migrations", "apps/cli/migrations");
  for (const file of ["README.md", "LICENSE", "NOTICE"]) await copyInto(file, file);

  await assertNotEmpty("apps/cli/dist", "run `pnpm bundle` first");
  await assertNotEmpty("apps/web/dist", "run `pnpm build` first");
  await assertNotEmpty("packages/plugin-sdk/dist", "the Plugin SDK build is missing");
  await assertNotEmpty("apps/cli/migrations", "the SQLite migrations are missing");
  await assertNotEmpty("fixtures/projects", "the bundled fixture projects are missing");

  const manifest = {
    name: releaseName,
    version: releaseVersion(),
    description: "The local control plane for accountable AI software teams.",
    keywords: ["ai-agents", "developer-tools", "local-first", "workflow", "codex", "claude"],
    license: "Apache-2.0",
    homepage: "https://github.com/loomrail/loomrail#readme",
    bugs: { url: "https://github.com/loomrail/loomrail/issues" },
    repository: { type: "git", url: "git+https://github.com/loomrail/loomrail.git" },
    type: "module",
    bin: { loomrail: "apps/cli/dist/index.js" },
    exports: {
      "./plugin-sdk": {
        types: "./packages/plugin-sdk/dist/index.d.ts",
        default: "./packages/plugin-sdk/dist/index.js",
      },
    },
    engines: { node: ">=24.19 <25" },
    dependencies: releaseDependencies(),
    files: [
      "apps/cli/dist",
      "apps/cli/migrations",
      "apps/web/dist",
      "packages/plugin-sdk/dist",
      "fixtures/projects",
      "README.md",
      "LICENSE",
      "NOTICE",
    ],
  };
  await writeFile(
    resolve(packageDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  // `npm pack` writes to its working directory, so no path needs to travel through the argument
  // list; on Windows those arguments would go through a shell.
  const packed = execFileSync(toolCommand("npm"), ["pack"], {
    cwd: packageDirectory,
    encoding: "utf8",
    ...toolSpawnOptions(),
  })
    .trim()
    .split("\n")
    .at(-1);

  const tarball = resolve(stagingDirectory, packed);
  await rename(resolve(packageDirectory, packed), tarball);
  process.stdout.write(`${tarball}\n`);
};

await run();
