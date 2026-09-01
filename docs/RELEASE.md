# Releasing the Loomrail launcher

**Status:** alpha.4 release candidate; not yet published
**Updated:** 2026-09-01

Loomrail ships as a single npm package named `loomrail`. It contains a bundled Node launcher, the prebuilt Workbench,
the SQLite migrations and the bundled fixture projects. Consumers install one package and run one binary; they never
install the `@loomrail/*` workspace packages, which stay private.

## Build the artifact

```bash
pnpm install --frozen-lockfile
pnpm pack:release
```

`pnpm pack:release` builds the workspace, bundles the launcher, stages `dist-release/package/` and writes
`dist-release/loomrail-<version>.tgz`. Both `dist-release/` and the intermediate `bundle/` directory are ignored by
Git and must never be committed.

## Verify the artifact

```bash
pnpm test:release
```

This is the clean-machine gate. It installs the tarball into an empty temporary project using only the public
registry, launches the installed binary on a free loopback port with an isolated `LOOMRAIL_DATA_DIR`, and asserts
that:

- the daemon reports `/health/ready`;
- the installed launcher serves the built Workbench shell, not just the API;
- the launcher prints the one-time sign-in URL, so a headless install can authenticate.

Run it on macOS and on Windows before tagging a release. A green `pnpm verify` does not imply a working package: the
repository resolves assets through the workspace layout, and only this check exercises the published layout.

## Why the package mirrors the repository layout

The launcher resolves the Workbench, the daemon resolves the bundled fixtures, and the persistence package resolves
its SQL migrations relative to their own module URL:

| Asset      | Lookup                       | Location in the package |
| ---------- | ---------------------------- | ----------------------- |
| Workbench  | `../../web/dist`             | `apps/web/dist`         |
| Fixtures   | `../../../fixtures/projects` | `fixtures/projects`     |
| Migrations | `../migrations`              | `apps/cli/migrations`   |

Bundling collapses the launcher and the daemon into `apps/cli/dist/index.js`, so the packaged tree reproduces the
directory depths those lookups expect. This keeps packaging entirely inside the release scripts: no product code
branches on whether it is running from a clone or from an install.

Adding a new asset that is read relative to `import.meta.url` therefore requires a matching entry in
`scripts/pack-release.mjs`. `pnpm test:release` is what catches an omission.

## Runtime dependencies

`scripts/release-manifest.mjs` derives the published `dependencies` from the workspace manifests of the packages that
run inside the launcher. A dependency added to the daemon is published automatically, and the same package required at
two different ranges fails the build instead of resolving silently.

`apps/web` and `packages/ui` are deliberately excluded: React, TanStack and Radix are compiled into `apps/web/dist`
and are never installed by a consumer.

## Publishing

Publishing is a deliberate, human action and is not automated. Nothing in CI runs `npm publish`.

1. Decide the version and set it in `apps/cli/package.json`; the release manifest reads it from there.
2. `pnpm verify && pnpm test:e2e`
3. `pnpm pack:release && pnpm test:release` on macOS and Windows.
4. Inspect `dist-release/package/` — confirm no local paths, no state databases and no logs were staged.
5. Publish the tarball from an account with rights to the `loomrail` name.

### Pre-alpha channel

The current release candidate is `0.1.0-alpha.4`. Pre-alpha versions use the explicit `next` dist-tag. Future
pre-alpha releases must advance the version and keep the same channel unless a product decision changes it. Check the
registry before publishing; a prepared repository version is not evidence that the registry has already advanced.

```bash
npm publish ./dist-release/loomrail-0.1.0-alpha.4.tgz --tag next --access public
```

Before running that command, authenticate the local npm CLI, satisfy the account's current 2FA requirements and
review the [release notes](releases/0.1.0-alpha.4.md). After publishing, verify the registry rather than the local
tarball:

```bash
npm view loomrail@next name version dist-tags --json
npm install loomrail@next
npx loomrail --no-open --port 4176
```

Until a stable release exists, documentation and release checks use `loomrail@next` or an exact version so the
intended pre-alpha channel stays explicit. Treat `npm view loomrail@next version` as the source of truth for what a
new install will receive.
