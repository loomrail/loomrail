# L4b1 environment-bound promotion evidence

**Date:** 2026-09-11  
**Scope:** PD-031, ADR-0030, plans 116–117, threats T82–T83  
**Status:** local and exact-commit macOS/Windows automation green; live dispatch not performed

## What was proved

- New deployment targets are v2 and bind `PREVIEW` only to `.github/workflows/deploy-preview.yml` and
  `PRODUCTION` only to `.github/workflows/deploy-production.yml`.
- Production adoption requires a durable v2 `SUCCEEDED` Preview from the same Project and exact
  environment-independent Release Evidence Digest. Foreign, failed, unknown, Production and legacy candidates are
  refused by typed domain errors.
- Migration 0061 preserves populated v60/v1 Plan and Deployment JSON unchanged, adds normalized nullable promotion
  identity, completes `foreign_key_check`, and keeps legacy history observable without granting dispatch authority.
- The GitHub adapter derives the workflow from Environment kind, uses no shell or caller inputs, excludes token
  variables from the child environment, bounds output/deadlines and re-runs exact preflight before dispatch.
- The authenticated HTTP/UI path shows Preview or Production explicitly, returns `PREVIEW_PROMOTION_REQUIRED`
  before GitHub preflight when evidence is missing, and preserves two owner confirmations, one-shot execution,
  restart reconciliation and fail-closed `UNKNOWN`.
- Browser E2E completes Preview, restarts the daemon, then completes Production with keyboard activation, light/dark
  themes and a 320 px viewport. All provider and GitHub interactions are injected test doubles in test code.

## Local verification

- `pnpm verify` — passed: formatting, public-tree/toolchain/activation checks, lint, build, typecheck and all package
  tests.
- `pnpm test:e2e` — 65/65 passed.
- `pnpm test:fault-injection` — passed, including crash recovery with no replay.
- `pnpm pack:release && pnpm test:release` — passed; `loomrail-0.1.0-alpha.5.tgz` installed cleanly with 189 packages
  and zero reported vulnerabilities, then passed samples, setup, CLI diagnostics, receipt, installed-file and log
  lifecycle checks.

## Cross-platform CI evidence

[GitHub Actions run 34601586505](https://github.com/loomrail/loomrail/actions/runs/34601586505) exercised final
implementation commits `ef0a13a` and `82e5743` on both release platforms:

| Job                              | Result                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| Verify (`macos-latest`)          | pass: policy gates, fault recovery and full repository verify   |
| Verify (`windows-latest`)        | pass: Windows lifecycles, fault recovery and full source verify |
| Browser smoke (`macos-latest`)   | pass: 65/65                                                     |
| Browser smoke (`windows-latest`) | pass: 65/65                                                     |
| Clean install (`macos-latest`)   | pass: receipt-checked release package                           |
| Clean install (`windows-latest`) | pass: receipt-checked release package                           |

The first exact implementation run, [34599046222](https://github.com/loomrail/loomrail/actions/runs/34599046222),
passed five jobs but exposed a test-harness limit in Windows fault injection: three successful SQLite integration
cases exceeded the package's 20-second test timeout under runner load, and timeout cleanup then reported an open
database. There was no assertion failure; two cases completed in about 24.9 seconds. Commit `82e5743` changes only
that package-level hang detector to 60 seconds. It does not increase any production, deployment, command, provider,
output or token deadline. The repeated Windows fault gate and full source verify both passed.

No live provider request or GitHub Actions deployment was sent. Recurkit was inspected read-only; its existing dirty,
unpublished and 0/24 Release state was not changed or bypassed.

## Pending

- a separately approved eligible live Preview/Production dispatch;
- HOTFIX, waiver, rollback, post-deploy probe, automatic polling/retry and L5 monitoring, all still unavailable.
