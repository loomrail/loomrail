# Loomrail supply-chain policy

> Public pre-alpha · [Русская версия](SUPPLY-CHAIN.ru.md) · [Threat model](THREAT-MODEL.md)

This policy covers repository dependencies, build inputs, release-candidate integrity, publishing authority, and
post-publication verification. It does not claim that a dependency, build, or provenance statement is harmless.

## Dependency intake

The repository uses the public npm registry, a committed `pnpm-lock.yaml`, exact Node and pnpm toolchain pins, and
full-commit GitHub Actions references. CI installs with `pnpm install --frozen-lockfile`; a pull request cannot update
the dependency graph without changing the reviewed lockfile.

The committed pnpm policy enforces these controls for direct and transitive packages:

- a version must be at least 24 hours old, with strict refusal when no eligible version or publication time exists;
- publisher trust may not regress from trusted publishing to weaker evidence;
- the committed lockfile is rechecked rather than treated as an automatic trust root;
- exotic transitive Git and tarball sources are blocked;
- dependency lifecycle scripts are denied unless an exact reviewed `allowBuilds` entry permits them;
- runtime dependencies published in `loomrail` may use only exact or caret semver registry ranges.

`pnpm audit --prod --audit-level high` runs on macOS and Windows. The release tarball is also installed with npm in
an empty project and that consumer graph receives its own production High-severity audit.

These controls reduce exposure; they do not prove that an old, signed, or vulnerability-free package is safe.

## Update review

Dependabot proposes patch and minor npm updates weekly. Major updates are separate compatibility changes. Every
dependency change must include:

1. manifest and lockfile diff review, including new maintainers, source, licenses, lifecycle scripts, native code,
   network/process/filesystem behavior, and new transitives;
2. a production audit and the tests for every affected boundary;
3. crash/fault and clean-install gates when runtime or packaging code changes;
4. an exact documented exception if a release-age or publisher-trust gate must be bypassed.

An active High/Critical advisory may justify bypassing the 24-hour wait only for the exact patched version. Record
the advisory, why waiting is more dangerous, and remove the exception after the version matures. Do not use a
wildcard exception or disable the repository-wide policy.

### Current exact exception

| Selector       | Scope                                    | Reason                                                               | Removal condition                         |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `semver@6.3.1` | dev-only Babel/ESLint transitive, locked | 2023 publication predates stronger trust evidence on another release | upstream Babel graph no longer selects v6 |

The exception grants no lifecycle-script permission and does not affect the published runtime graph. Production
audit currently reports no known vulnerability for it.

## Release candidate integrity

`pnpm pack:release` emits two files under ignored `dist-release/`:

- `loomrail-<version>.tgz` — the candidate artifact;
- `loomrail-<version>.receipt.json` — a closed unsigned integrity receipt.

The receipt binds the package identity, source commit and clean/dirty observation, Node/npm/pnpm versions, tarball
SHA-1/SHA-256/SHA-512, and SHA-256 plus byte size for every allowlisted package file. Packaging rejects unsafe paths,
symlinks, unexpected file types, bundled dependency trees, inconsistent npm metadata, or digest mismatches.

`pnpm test:release` verifies the receipt before installation, installs the exact tarball, compares every
package-owned extracted file with the receipt, audits the resulting npm production graph, and then runs the launcher
smoke. CI accepts only a receipt produced from a clean source tree.

The receipt is not signed. It detects accidental change and gives a trusted workflow an exact subject to attest, but
it is not npm provenance and cannot identify its builder by itself.

## Publishing authority and provenance

Ordinary CI has read-only repository permission and never runs `npm publish`. No publish is authorized while the
stable-release, cross-platform, and private-dogfood gates remain open.

Before a future public release, maintainers must configure npm trusted publishing for the exact public repository and
dedicated GitHub-hosted workflow. The publish job must use OIDC with `id-token: write`, build and verify the artifact
inside that trusted job, and publish the exact tarball with provenance. The staged package sets
`publishConfig.provenance: true`, so an unsupported local/manual publish cannot silently omit provenance. Long-lived
npm write tokens are not the default publication credential.

npm provenance links the published bytes to source and build instructions through Sigstore and a transparency log.
It does not certify code quality or safety. The local receipt, a checksum in release notes, a Git tag, and a
maintainer statement are not substitutes.

After publication, verify the exact version rather than a moving dist-tag:

```bash
npm view loomrail@<exact-version> dist.integrity --json
npm install --ignore-scripts loomrail@<exact-version>
npm audit signatures
```

`npm audit signatures` verifies registry signatures and available provenance attestations for the installed graph.
It requires a registry install; a local pre-publication tarball has no registry attestation yet.

## Update, rollback, and incident response

Loomrail never self-updates. Owners select an exact target or explicitly follow the pre-alpha `next` channel, stop
the daemon, preserve the whole data directory, install, run `doctor`, and complete the Mock walkthrough. Database
rollback is restore-based: reinstall the version matching a pre-upgrade whole-directory backup. There is no
down-migration or silent dist-tag rollback contract.

For suspected dependency or release compromise:

1. stop publication and do not reuse the candidate;
2. compare registry integrity/provenance with the trusted workflow and source commit;
3. identify affected exact versions and dependency paths;
4. prepare a reviewed patch or exact temporary override and rerun all release gates;
5. deprecate affected registry versions and coordinate disclosure; unpublish only when npm policy and impact justify
   it;
6. rotate/revoke any credential that may have been exposed and record the incident evidence without user data.

Owner backup, upgrade, rollback, and uninstall steps are in the [operations guide](../guides/OPERATIONS.md). Maintainer
artifact gates are in the [release guide](../RELEASE.md).

## Primary references

- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm registry signature verification](https://docs.npmjs.com/verifying-registry-signatures/)
- [pnpm supply-chain security](https://pnpm.io/supply-chain-security)
- [pnpm dependency policy](https://pnpm.io/settings/dependency-resolution)
- [pnpm lifecycle-script policy](https://pnpm.io/settings/build)
