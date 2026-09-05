# Releasing the Loomrail launcher

**Status:** alpha.4 published; alpha.5 release candidate under verification; managed public dogfood accepted; private dogfood and remaining stable gates pending
**Updated:** 2026-09-04

Loomrail ships as a single npm package named `loomrail`. It contains a bundled Node launcher, the prebuilt Workbench,
the SQLite migrations and the bundled fixture projects. Consumers install one package and run one binary; they never
install the `@loomrail/*` workspace packages, which stay private.

## Build the artifact

```bash
pnpm install --frozen-lockfile
pnpm pack:release
```

`pnpm pack:release` builds the workspace, bundles the launcher, stages `dist-release/package/` and writes
`dist-release/loomrail-<version>.tgz` plus `dist-release/loomrail-<version>.receipt.json`. Both `dist-release/` and the
intermediate `bundle/` directory are ignored by Git and must never be committed.

Packaging consumes the structured `npm pack --json` result and rejects an unexpected package identity, path, file
type, symlink, bundled dependency tree, size, or digest. The closed receipt records source commit plus clean/dirty
observation, Node/npm/pnpm versions, tarball SHA-1/SHA-256/SHA-512, and SHA-256 for every allowlisted package file. It
contains no build timestamp, runner name, local path, environment, or credential.

The receipt is unsigned integrity metadata, not registry provenance. It detects changed candidate bytes and gives a
trusted workflow an exact artifact to publish, but it does not prove who built it.

## Verify the artifact

Before packaging, run the named crash and fault-injection gate:

```bash
pnpm exec playwright install chromium
pnpm test:activation
pnpm test:fault-injection
```

`test:activation` validates the one versioned guided-activation contract against CLI help, the exact marked install
blocks, the bundled Q10 recipe and the named macOS/Windows CI step. It also rejects unknown fields and unsafe command
mutations. This keeps `loomrail try`, the Workbench route and public documentation on one fail-closed contract.

It builds the repository, runs the persistence/provider/MCP/scaffolding/Browser QA/daemon fault suites sequentially,
then kills a test-owned daemon child during a durably active ProviderSession. Fresh daemon processes on the same
SQLite/WAL state must expose exactly one interruption report, no active provider/agent run and no automatic replay.
Run this gate on both macOS and Windows; it is a separate CI step so repository-wide lint cannot hide crash evidence.
It uses only a synthetic fixture and is not a substitute for the private dogfood recovery gate.

Run the provider compatibility process gate separately as well:

```bash
pnpm test:provider-compatibility
```

It exercises exact version parsing, timeout/output bounds and redaction through a real synthetic child process. CI
runs it on macOS and Windows before repository-wide lint. This is admission-mechanism evidence, not a live-provider
matrix row.

```bash
pnpm test:release
```

This is the clean-machine gate. It installs the tarball into an empty temporary project using only the public
registry. Before install it verifies the receipt and all tarball digests; after install it compares every
package-owned extracted file with the receipt and audits the actual npm production graph at High severity. It then
launches the installed binary on a free loopback port with an isolated `LOOMRAIL_DATA_DIR` and asserts that:

- non-TTY setup requires an explicit route, while `setup --mode mock --json` reports the clean installation READY
  after the CI lane's explicit Chromium installation and creates no state;
- `loomrail try --no-open` reports the guided Mock route READY and prints an authenticated `/try` URL;
- the daemon reports `/health/ready`;
- the installed launcher serves the built Workbench shell, not just the API;
- the launcher prints the one-time sign-in URL, so a headless install can authenticate;
- `loomrail doctor --json` inspects the isolated installation without creating state or leaking its path;
- `loomrail data-path` resolves that exact isolated path explicitly.

Run it on macOS and on Windows before tagging a release. A green `pnpm verify` does not imply a working package: the
repository resolves assets through the workspace layout, and only this check exercises the published layout.
The CI release lane additionally rejects a receipt whose source-tree observation is not `CLEAN`.

Owner-facing install, diagnostic, upgrade, rollback and uninstall semantics are maintained in the
[operations guide](guides/OPERATIONS.md). A release that changes package layout, migrations or retention must update
that contract in the same change.

## Why the package mirrors the repository layout

The launcher resolves the Workbench, the daemon resolves the bundled fixtures, and the persistence package resolves
its SQL migrations relative to their own module URL:

| Asset      | Lookup                       | Location in the package |
| ---------- | ---------------------------- | ----------------------- |
| Workbench  | `../../web/dist`             | `apps/web/dist`         |
| Fixtures   | `../../../fixtures/projects` | `fixtures/projects`     |
| Migrations | `../migrations`              | `apps/cli/migrations`   |

Bundling collapses the launcher and the daemon into `apps/cli/dist/index.js` and emits the trusted MCP and verification
child-process entrypoints beside it, so the packaged tree reproduces the
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

Runtime dependency specs in the generated manifest are restricted to exact or caret semver registry ranges. The
workspace also enforces strict 24-hour release age, missing-publication-time refusal, publisher-trust no-downgrade,
lockfile re-verification, blocked exotic transitive sources, and denied dependency lifecycle scripts unless an exact
reviewed exception exists. The complete review and exception contract is the
[supply-chain policy](security/SUPPLY-CHAIN.md).

## Publishing and provenance

Publishing is a deliberate, human-authorized terminal action. Ordinary CI never runs `npm publish`, holds no npm
write token, and has only `contents: read`. No Q6 change authorizes a tag, GitHub Release, dist-tag mutation, or npm
publication.

Before the first stable publication, configure npm trusted publishing for the exact public repository and dedicated
GitHub-hosted publish workflow. That workflow must use OIDC `id-token: write`, build and verify the candidate inside
the trusted job, and publish the exact verified tarball with provenance. The generated package sets
`publishConfig.provenance: true`; an unsupported local publish must fail instead of silently producing an
unprovenanced version. Prefer short-lived workflow OIDC over a long-lived npm write token.

For every authorized candidate:

1. Decide the version and set it in `apps/cli/package.json`; the release manifest reads it from there.
2. `pnpm test:fault-injection && pnpm verify && pnpm test:e2e` passes on macOS and Windows.
3. `pnpm pack:release && pnpm test:release` passes on macOS and Windows with a clean receipt.
4. Inspect the receipt and `dist-release/package/`; confirm exact source commit, expected files, no local paths, no
   state databases, and no logs.
5. Human approval releases the dedicated trusted-publish job for that exact commit/version.
6. Verify registry integrity, source commit/workflow provenance, signature audit, install, and startup before moving
   any default channel.

Any release that claims a live provider version also requires one exact row in the
[provider compatibility matrix](guides/PROVIDER-COMPATIBILITY.md). Add no semver range or `latest` promise: promotion
must include sanitized real-CLI recordings, negative parser coverage and matching macOS/Windows evidence for that
exact version and invocation contract. The current alpha.5 candidate has exact macOS arm64 rows for Codex and Claude
Code, but no matching Windows evidence. It therefore cannot claim the cross-platform live-provider release gate;
Mock remains the only provider mode with complete macOS/Windows evidence.

### Pre-alpha channel

The currently published pre-alpha version is `0.1.0-alpha.4`; the repository prepares `0.1.0-alpha.5`. Published
pre-alpha releases use the explicit `next` dist-tag. Check the registry before publishing: a prepared repository
version or local receipt is not evidence that the registry has already advanced.

```bash
npm publish ./dist-release/loomrail-0.1.0-alpha.5.tgz --tag next --access public --provenance
```

This command belongs only inside the configured trusted workflow after explicit release approval; do not run it from
a maintainer laptop or ordinary CI. npm trusted publishing may add provenance automatically, while the explicit flag
also documents the fail-closed requirement. Review the [release notes](releases/0.1.0-alpha.5.md) before approval.
After publishing, verify the registry rather than the local tarball:

```bash
npm view loomrail@0.1.0-alpha.5 name version dist.integrity --json
npm install --ignore-scripts loomrail@0.1.0-alpha.5
npm audit signatures
npx loomrail --no-open --port 4176
```

Until a stable release exists, documentation and release checks use `loomrail@next` or an exact version so the
intended pre-alpha channel stays explicit. Treat `npm view loomrail@next version` as the source of truth for what a
new install will receive.

The trusted-publishing and verification semantics follow the primary
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/),
[trusted publisher](https://docs.npmjs.com/trusted-publishers/), and
[registry signature](https://docs.npmjs.com/verifying-registry-signatures/) documentation. Provenance links bytes to
source and build instructions; it is not a safety certification.
