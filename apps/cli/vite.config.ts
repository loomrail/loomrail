import { builtinModules } from "node:module";

import { defineConfig } from "vite";

import { releaseDependencies } from "../../scripts/release-manifest.mjs";

/**
 * Bundles the launcher for distribution.
 *
 * Workspace code is inlined so the published artifact does not depend on unpublished `@loomrail/*`
 * packages. Third-party runtime dependencies stay external and are installed from the registry;
 * the list comes from the workspace manifests so it cannot drift from what the daemon imports.
 *
 * The bundle is emitted at `apps/cli/dist/index.js` inside the package directory because the
 * launcher and the daemon locate the web assets and the bundled fixtures relative to their own
 * module URL. Keeping the published layout identical to the repository layout keeps those lookups
 * correct without teaching the product about packaging.
 */
const externalDependencies: readonly string[] = [...Object.keys(releaseDependencies()), ...builtinModules];

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: "bundle/apps/cli/dist",
    rollupOptions: {
      input: "src/index.ts",
      output: { entryFileNames: "index.js", format: "esm" },
    },
    ssr: true,
    target: "node24",
  },
  ssr: {
    external: [...externalDependencies],
    noExternal: true,
  },
});
