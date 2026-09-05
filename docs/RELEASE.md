# Releasing the Loomrail launcher

**Status:** alpha.4 published; alpha.5 candidate passes automated macOS/Windows source, browser, fault and clean-install gates; private dogfood and remaining stable gates pending
**Updated:** 2026-09-05

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

Before the first stable publication, configure npm trusted publishing for the exact public repository and the
dedicated `.github/workflows/npm-stage.yml` GitHub-hosted workflow. The trust relationship must allow only
`npm stage publish`, bind the `npm-release` environment, and must not allow direct `npm publish`. Configure that
environment with required owner review and a deployment-branch policy restricted to `main` before creating the npm
trust relationship. The workflow uses OIDC `id-token: write`, builds and verifies the candidate inside the trusted
job, and stages the exact verified tarball with provenance. The generated package also sets
`publishConfig.provenance: true`. No long-lived npm write token is accepted.

The trusted job also reads that environment through GitHub's read-only API before building or staging. It requires
one non-empty `required_reviewers` rule, custom deployment-branch policies, and exactly one branch policy named
`main`; a missing, auto-created, unrestricted, incomplete or broader environment fails closed. Additional stronger
rules such as a wait timer remain allowed. This check does not create or configure the environment.

Trusted publishing requires npm `11.5.1+`; Loomrail's stage-only route requires npm `11.15.0+` and Node `22.14.0+`.
The pinned Node `24.19.0` toolchain satisfies the Node floor and the workflow fails closed if its bundled npm is too
old. After the protected GitHub environment exists, an authenticated package owner can create the stage-only trust
relationship with npm `11.15.0+` and interactive 2FA:

```bash
npm trust github loomrail --repository loomrail/loomrail --file npm-stage.yml --environment npm-release --allow-stage-publish
```

Do not run this command as an ordinary setup step. Creating the trust relationship is an owner-authorized external
mutation and remains pending until the other stable gates are ready.

The repository gate requires stable semver, an exact main SHA, matching typed confirmation, an unused registry
version, npm `11.15.0+`, and a successful push-triggered CI run for that SHA with all six macOS/Windows Verify,
Browser smoke and Clean install jobs. It also reads the versioned
[`STABLE-RELEASE-GATES.json`](evidence/phase-8/STABLE-RELEASE-GATES.json) index and refuses staging unless all ten
required gates are `PASSED`, the selected stable version matches, every evidence file is a bounded regular file with
the recorded SHA-256, and the identical bytes exist at a recorded ancestor commit. Run `pnpm release:status` to inspect
the current index without changing external state. The index currently proves six historical gates and deliberately
keeps private dogfood, protected landing integration and both Windows live-provider rows `PENDING`; no stable version
is selected. Both ordinary source-CI platforms run the same status check from full Git history, so a changed or
unreachable recorded evidence object fails the candidate before the longer verification matrix.

The passed `q13FinalSecurityReliabilityReview` row names the historical Q13 review precisely; it does not claim that
Q13 reviewed later Q14-Q17 or release-workflow changes. The protected-environment reviewer must still inspect the
exact release-source diff and all later slice evidence before allowing the trusted job to continue.

The index prevents an accidental premature workflow run; it is not a signature or an independent reviewer. A
maintainer could forge repository evidence, so protected-environment owner review must still inspect the referenced
reports and exact source diff. A staged package is still not public. A package owner must separately inspect it and
approve it with interactive 2FA before npm makes the immutable name/version public.

For every authorized candidate:

1. Close every external stable gate, record sanitized evidence, run `pnpm release:status`, decide the version, and set
   the same stable semver in `apps/cli/package.json` and `STABLE-RELEASE-GATES.json`.
2. `pnpm test:fault-injection && pnpm verify && pnpm test:e2e` passes on macOS and Windows.
3. `pnpm pack:release && pnpm test:release` passes on macOS and Windows with a clean receipt.
4. Inspect the receipt and `dist-release/package/`; confirm exact source commit, expected files, no local paths, no
   state databases, and no logs.
5. Human approval releases the manual stage-only workflow for that exact stable version and main commit. Its gate
   independently requires a successful push-triggered CI run containing all six macOS/Windows jobs.
6. Review the staged package and the workflow's seven-day candidate/receipt artifact, then use npm's separate
   interactive 2FA approval. Staging alone is not a release and must never be reported as one.
7. Verify registry integrity, source commit/workflow provenance, signature audit, install, and startup before moving
   any default channel.

Any release that claims a live provider version also requires one exact row in the
[provider compatibility matrix](guides/PROVIDER-COMPATIBILITY.md). Add no semver range or `latest` promise: promotion
must include sanitized real-CLI recordings, negative parser coverage and matching macOS/Windows evidence for that
exact version and invocation contract. The current alpha.5 candidate has exact macOS arm64 rows for Codex and Claude
Code, but no matching Windows evidence. It therefore cannot claim the cross-platform live-provider release gate;
Mock remains the only provider mode with complete macOS/Windows evidence.

### Pre-alpha channel

The currently published pre-alpha version is `0.1.0-alpha.4`; the repository prepares `0.1.0-alpha.5`. Published
pre-alpha releases use the explicit `next` dist-tag. The stable stage workflow rejects prerelease versions and must
not be used to publish the prepared alpha.5 candidate. Check the registry before any future publication: a prepared
repository version or local receipt is not evidence that the registry has advanced. Review the
[release notes](releases/0.1.0-alpha.5.md) as historical candidate evidence, not as publish authority.

The manual stable workflow invokes only the following terminal operation after every gate and owner approval:

```bash
npm stage publish ./dist-release/loomrail-<stable-version>.tgz --tag latest --access public --provenance
```

This creates a staged package, not a public version. Only a subsequent owner `npm stage approve <stage-id>` with 2FA
can make those bytes public. Neither command belongs on a maintainer laptop as an ordinary build step.
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
[trusted publisher](https://docs.npmjs.com/trusted-publishers/),
[staged publishing](https://docs.npmjs.com/staged-publishing/), and
[registry signature](https://docs.npmjs.com/verifying-registry-signatures/) documentation, plus GitHub's
[deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
and [deployment branch policy API](https://docs.github.com/en/rest/deployments/branch-policies). Provenance links
bytes to source and build instructions; it is not a safety certification.
