import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The published launcher's name and the workspace packages whose code it bundles. */
export const releaseName = "loomrail";

/**
 * Workspace packages that run inside the Node launcher.
 *
 * `apps/web` and `packages/ui` are deliberately absent: their dependencies are compiled into
 * `apps/web/dist` at build time and are never installed by a consumer.
 */
const runtimeWorkspacePackages = [
  "apps/cli",
  "apps/daemon",
  "packages/context-assembly",
  "packages/contracts",
  "packages/domain",
  "packages/mcp-gateway",
  "packages/persistence-sqlite",
  "packages/plugin-sdk",
  "packages/project-constitution",
  "packages/project-readiness",
  "packages/project-scaffolding",
  "packages/scheduler",
  "packages/provider-claude-code",
  "packages/provider-codex",
  "packages/provider-core",
  "packages/provider-mock",
  "packages/workflow-engine",
  "packages/workspace",
];

const readPackageJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath, "package.json"), "utf8"));

/**
 * The third-party packages the launcher still needs at run time, as a name → range map.
 *
 * Derived from the workspace rather than restated, so a dependency added to the daemon cannot be
 * forgotten in the published manifest. A package required at two different ranges is a mistake we
 * want to fail loudly rather than resolve silently.
 */
export const releaseDependencies = () => {
  const dependencies = new Map();
  for (const workspacePackage of runtimeWorkspacePackages) {
    const manifest = readPackageJson(workspacePackage);
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@loomrail/")) continue;
      const existing = dependencies.get(name);
      if (existing !== undefined && existing.range !== range) {
        throw new Error(
          `${name} is required as ${existing.range} by ${existing.from} and as ${range} by ${workspacePackage}`,
        );
      }
      dependencies.set(name, { range, from: workspacePackage });
    }
  }
  return Object.fromEntries(
    [...dependencies]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, { range }]) => [name, range]),
  );
};

export const releaseVersion = () => readPackageJson("apps/cli").version;

const onWindows = process.platform === "win32";

/**
 * Spawn options for a Node toolchain executable.
 *
 * On Windows `npm` and `npx` are `.cmd` shims. Node refuses to spawn those without a shell, so the
 * shell is opted into there — which in turn means no argument may contain a space. Callers keep
 * paths out of the argument list and pass them through `cwd` instead, so a repository or temporary
 * directory containing spaces cannot break the release.
 */
export const toolCommand = (name) => (onWindows ? `${name}.cmd` : name);
export const toolSpawnOptions = () => (onWindows ? { shell: true } : {});
