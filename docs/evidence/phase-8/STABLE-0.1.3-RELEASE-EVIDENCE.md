# Stable 0.1.3 release evidence

**Date:** 2026-09-20

**Release:** `loomrail@0.1.3`, npm tag `latest`, support target `MACOS_ARM64` (`darwin/arm64`).

**Exact source:** `868be0ee9c2054cefeffda1ecc516c62ec2f8099`.

## Source and staging

- [Main CI 35447755752](https://github.com/loomrail/loomrail/actions/runs/35447755752) passed all six macOS/Windows
  Verify, Browser smoke and Clean install jobs for the exact source.
- [Protected stage run 35447779462](https://github.com/loomrail/loomrail/actions/runs/35447779462), attempt 2, passed
  source, crash/fault recovery, browser and exact-package checks. Attempt 1 failed on an npm audit HTTP 503 during
  registry maintenance, before staging; only the failed job in the same run was retried after recovery and owner
  environment review. No protection, trust relationship or source was changed.
- Candidate artifact `10591835192` contains a CLEAN receipt and exact tarball. Candidate and separately downloaded
  npm stage `f96b82c1-fc56-44a8-a993-00acae532f9d` matched all recorded digests and all 105 extracted package files.
- The obsolete `0.1.2` stage was rejected before this publication and was not approved as the new release.

## Registry identity and signatures

Owner WebAuthn approval published the exact staged package. The public tarball matches the candidate receipt:

| Field             | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Size              | 1798374 bytes                                                                                     |
| Files             | 105                                                                                               |
| Unpacked size     | 8560739 bytes                                                                                     |
| SHA-1             | `bf43417f191939e80c67763cf47d30c731b6693b`                                                        |
| SHA-256           | `3dbd2033457b77b73efb3e810777c1e88a9a51b2e7903bffecaaa8ddc72e477d`                                |
| SHA-512 integrity | `sha512-xsvk+SCSFSmbewoymo9A8WsKuwds+nt2tX9NzxHtNTUvQY6D6EWMiseHMFftqi35RqHeWx0dXjwKJyDYrIxm+Q==` |

`latest` resolves to `0.1.3`; `next` remains `0.1.0-beta.1`. The public npm publish and SLSA provenance subjects match
the tarball SHA-512. Provenance binds the exact source, `.github/workflows/npm-stage.yml`, `refs/heads/main`, and
run `35447779462/attempts/2`. [Transparency entry](https://search.sigstore.dev/?logIndex=2893365315).

A fresh registry installation with lifecycle scripts disabled verified all 105 package-owned files. `npm audit
signatures` verified signatures for 189 packages and attestations for 27 packages; the production High-severity
dependency audit also passed. These establish identity/integrity, not a general safety certification.

## Public-registry lifecycle

The published binary passed clean setup/Doctor without creating the data directory, loopback readiness,
authenticated runtime version `0.1.3` and the served Workbench shell. Separate installations from the public registry
rehearsed both `0.1.1 -> 0.1.3` and `0.1.0-beta.1 -> 0.1.3` using synthetic fixture projects and isolated paths with
spaces and Unicode. No owner database was opened.

For each upgrade, the old binary was stopped and the entire data directory was copied and byte-checked. The new
Doctor reported `STATE_UPGRADE_REQUIRED` with 61/62 migrations before startup. All existing file bytes remained
unchanged; SQLite's read-only inspection could create SHM and an empty WAL sidecar, which were checked explicitly
rather than treated as a data migration. Startup applied migration 0062, and Doctor then reported `STATE_READY`
with 62/62 migrations. The project survived upgrade and a further restart. The untouched backup was copied into a
separate restore directory and opened only by the matching old binary; the project remained visible.

After these checks, uninstalling the test-installed package left the clean data directory byte-for-byte unchanged.
The release-specific harness reused the existing lifecycle helpers but asserted the actual 61-to-62 migration:
the historical schema-neutral lifecycle assertion was not weakened or reinterpreted as evidence for this release.
Temporary installations, logs, archives and test state remain outside Git.

## Boundaries

No paid provider session was run for this publication, and no compatibility admission was changed. Earlier live
provider evidence remains scoped to its recorded exact versions and invocation contracts. Windows source/package CI
does not promote Windows/Linux live-provider execution. The code-blind coordinator from PR #33 is excluded from
this source and release. No credentials, raw transcripts, private databases or personal paths are retained here.
