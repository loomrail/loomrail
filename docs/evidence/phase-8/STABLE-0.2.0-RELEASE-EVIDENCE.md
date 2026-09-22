# Stable 0.2.0 release evidence

**Date:** 2026-09-22

**Release:** `loomrail@0.2.0`, npm tag `latest`, support target `MACOS_ARM64` (`darwin/arm64`).

**Exact source:** `5445157a7350af3e752a453d623f0cd84b80d388`.

## Source and staging

- [Main CI 35649826043](https://github.com/loomrail/loomrail/actions/runs/35649826043), push-triggered, passed all six
  macOS/Windows Verify, Browser smoke and Clean install jobs for the exact source. Windows Verify took 36m14s against
  the 60-minute limit raised for that job before `0.1.3`.
- The same six jobs passed on the release branch as
  [PR CI 35645858527](https://github.com/loomrail/loomrail/actions/runs/35645858527) before merge.
- [Protected stage run 35710423698](https://github.com/loomrail/loomrail/actions/runs/35710423698) staged the package
  after owner review of the `npm-release` environment. Staged id `6302289c-90a9-42cf-bc41-85a9f406fd8b`, tag `latest`,
  public access, signed provenance published to the transparency log at index `2908907738`.
- The release gate reported 9/9 required gates for `MACOS_ARM64`. Both Windows live-provider rows remain `PENDING`;
  no Windows or Linux live execution is claimed.

## Reproducibility

The workflow's `loomrail-0.2.0-candidate` artifact was downloaded and compared against the tarball and receipt built
locally from the same commit on a clean tree. They are identical:

| Property      | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| SHA-256       | `6863523e313367dd61e4efeb928ed61cc3d4333b56ffe71e8656fc2879230415` |
| shasum        | `7939d1a9864f8d91208e828279d43d32d9f1e097`                         |
| Packed size   | 1,843,116 bytes                                                    |
| Unpacked size | 8,750,986 bytes                                                    |
| Files         | 105                                                                |
| Source tree   | `CLEAN`                                                            |

Comparing the two receipts file by file found no path present in only one of them and no differing SHA-256 among the
105 entries. This is a byte-for-byte reproduction of the CI build from the recorded source, which is a stronger
statement than a matching receipt alone.

## Registry identity and signatures

- `npm view loomrail dist-tags` returns `latest = 0.2.0` and `next = 0.1.0-beta.1`.
- Published `dist.shasum` is `7939d1a9864f8d91208e828279d43d32d9f1e097` and `dist.integrity` is
  `sha512-/lvVc9KeYgPDbPYqOz8Hi43Iiq6aMMRVMcTYR//K+PMEU00XODEpE1vxdBpq4Jk8tcRbuY037vgR/LfOlxgtUA==`, both matching
  the staged package and the local receipt.
- The registry serves a `https://slsa.dev/provenance/v1` attestation for the version.
- Before approval, `npm view loomrail@0.2.0` returned `E404`, confirming that staging had not published anything.
- A fresh `npm install --ignore-scripts loomrail@latest` into an empty directory installed 189 packages and resolved
  `loomrail@0.2.0` at the integrity above. `npm audit signatures` reported 189 verified registry signatures and 27
  verified attestations.
- The installed launcher ran and `loomrail doctor --json` reported `runtime PASS` on Node 24.19.0, `git PASS`,
  `dataDirectory PASS` and `expectedMigrations: 62`, confirming that this release adds no migration.

## Local verification before release

- `pnpm verify` passed on the release source: 2,059 package tests plus 49 script tests, no failures.
- `pnpm test:fault-injection` passed, including the crash-recovery drill: one interrupted run, no replay, one durable
  report.
- `pnpm test:e2e` passed 69/69 product scenarios.
- `pnpm pack:release` produced a `CLEAN` receipt from the exact commit, and `pnpm test:release` verified samples,
  setup, local CLI diagnostics, runtime version, receipt, installed files and log lifecycle from a clean install with
  0 vulnerabilities in the consumer audit.
- The packaged tree contains no state database, log, `.env` or `node_modules` entry, and no absolute developer path
  appears in the bundle.

## Test determinism repaired for this release

Two test files were repaired rather than the code they cover. Both held the same defect: a real timeout used as
scaffolding, short enough that a loaded host lost the race and the branch under test never executed.

- `provider-codex/test/allowance-reader.unit.test.ts` (`c808bfa`) — a 1,000 ms read deadline expired before the
  spawned child answered, and a 150 ms deadline delivered SIGTERM to a child that had not yet installed its handler.
  The escalation test now proves its branch from the signal the child records rather than from wall-clock timing.
- `browser-qa/test/playwright-driver.test.ts` (`10480f7`) — a 1,000 ms driver step timeout that Chromium startup alone
  could consume. The file's existing 30 s literal became a shared named constant for the three tests that assert a
  non-timeout outcome; the two that measure the timeout keep their short budgets.

Two of these failed during this release's own verification, so they were release-blocking rather than cosmetic.

## Boundaries

- Staging is not publication. The staged package became public only through the owner's separate approval.
- The coordinator is experimental and off by default. No token saving and no quality non-inferiority is claimed by
  this release; the single paired smoke observation recorded in the
  [coordinator evidence](CODE-BLIND-COORDINATOR-EVIDENCE.md) is not a full-task measurement.
- The exact Codex CLI `0.155.0-alpha.9.2 / darwin / arm64` admission grants nothing to allowance reporting, an
  adjacent version, another architecture or another platform. All remain fail-closed.
- Windows and Linux live-provider execution stays unsupported even though source, browser and package CI pass on
  Windows.
- No full accepted paid provider workflow was purchased for this publication. The last such run belongs to `0.1.1`;
  the coordinator's own native qualification is recorded separately and is not a substitute for it.
- A separately reported intermittent failure of the Windows `guided-deployment-state` migration test remains open. It
  did not affect the release source, whose push-triggered CI run was green on all six jobs.
