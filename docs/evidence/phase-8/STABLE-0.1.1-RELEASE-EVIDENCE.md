# Stable 0.1.1 release evidence

**Date:** 2026-09-12

**Release:** `loomrail@0.1.1`, npm tag `latest`, Git tag `v0.1.1`

**Release Support Target:** `MACOS_ARM64` (`darwin/arm64`)

**Exact source:** `7dcacc05509eb5fbbaa4114bed30da061a29910f`

## Gate state

- Stable gate: 9/9 gates required by `MACOS_ARM64` passed.
- The full compatibility index remains 9/11. `codexWindowsCompatibility` and `claudeWindowsCompatibility` remain
  `PENDING`; Windows source/package CI is not reinterpreted as real Windows local-provider evidence.
- Local `pnpm verify`, crash/fault injection, 65/65 product E2E scenarios, 7/7 protected landing scenarios,
  release packaging, clean-package verification and the public-registry lifecycle passed before staging.
- Exact-source [CI run 34689374255](https://github.com/loomrail/loomrail/actions/runs/34689374255) completed all six
  macOS/Windows Verify, Browser smoke and Clean install jobs successfully.

## Trusted staging and registry publication

- The protected `npm-release` GitHub Environment required owner review and admitted only `main`, the exact source,
  `STABLE`, version `0.1.1` and the `MACOS_ARM64` target.
- Exact-source [stage run 34690933465](https://github.com/loomrail/loomrail/actions/runs/34690933465) repeated source,
  fault-recovery, browser and exact-package gates before producing signed stage
  `2fcf8af5-1c39-4d89-bf64-b813d086d8ca`.
- Separate owner WebAuthn approval published the stage. The public registry reports SHA-1
  `417e01bf13b60bde18d9c51668df068926a57cd6` and integrity
  `sha512-CaAl2rE/KpPLqfrLaWvP31st/lB5K0cTQyBVy7MQDRr3L8F3L3Nphsw8bvsuWHzYk5sZhdA0ynM2WNMmL48+bg==`.
- `latest` resolves to `0.1.1`; `next` remains on `0.1.0-beta.1`.
- The provenance statement is recorded at
  [Sigstore log index 2807470260](https://search.sigstore.dev/?logIndex=2807470260).

## Public-registry lifecycle

The reproducible lifecycle harness installed exact public `0.1.0-beta.1` and `0.1.1` versions with lifecycle scripts
disabled into isolated roots containing spaces and Unicode. It passed setup, Doctor, data-path, loopback
start/readiness/stop, stopped backup, schema-neutral upgrade, matching-version restore, package uninstall with owner
data preserved, root containment and symlink-escape refusal. A separate clean `0.1.1` installation verified registry
signatures for all 189 installed packages and attestations for 24 packages.

## Full published-package dogfood

The exact public `loomrail@0.1.1` binary registered the private Recurkit repository and created a task-specific
worktree. A bounded documentation task then completed Discovery, Plan, Implementation, independent Review, Project
verification, measured Browser QA and owner Acceptance using existing locally authenticated provider subscriptions.

The run retained all non-happy-path evidence:

- automatic independent Review selected Claude, whose weekly allowance was exhausted; Loomrail created a typed
  blocking Human Request and did not fallback;
- the owner explicitly changed the Project preference to Codex and resumed through a separate reviewer run;
- Review found a High mismatch between the requested `/health/ready` path and the repository's actual `/health`
  route; the correction stage opened a typed choice and the owner durably accepted the existing route rather than
  expanding application scope;
- Project verification initially failed because local test services were unavailable; the owner explicitly started
  the repository-defined PostgreSQL and Redis services and installed the exact lockfile toolchain in the isolated
  worktree;
- Browser QA initially blocked because the repository-owned dashboard was unavailable; after the owner explicitly
  started that target, Loomrail reran QA rather than accepting an unmeasured report.

The accepted implementation tree `f35feee0d911` changed only `docs/runbooks/local-health-check.md`. Required Project
checks `lint`, `build`, `test` and `test:e2e` all passed. Measured Browser QA passed six of six executions: login,
forgot-password and invalid-reset-link scenarios at `1280 x 800 / ru-RU / light` and
`320 x 720 / ru-RU / dark`, including keyboard access and horizontal-overflow assertions. The final durable state was
`WorkItem DONE / PipelineRun SUCCEEDED / AcceptancePackage ACCEPTED`.

After that terminal result, the public daemon was stopped and started against the same data root. A fresh
authenticated UI session restored the same Project, terminal task, completed workflow, accepted package, Project
verification and Browser QA evidence. No stage replayed. Test-owned dashboard, database and cache processes were then
stopped; no target-repository change was committed or pushed.

## Multiple Projects and support boundary

The same exact release source had already passed a three-Project local profile check: switching Projects restored each
isolated board and the global Attention flow opened the exact selected Project and Task. Scheduler coverage retains
global, per-Project, per-provider and workspace-writer limits. This proves concurrent ownership and isolation for
multiple local Projects; it is not a hosted multi-user or cloud-sync claim.

Stable support remains macOS Apple Silicon-only. Windows and Linux live-provider dispatch remain unsupported and fail
closed. There is no Mock, direct provider API route, API key, synthetic success, hidden fallback, automatic provider
login/update or automatic Git publication. No credentials, `.env` values, provider transcripts, raw provider
payloads, cookies, bootstrap URLs or absolute personal paths are recorded in this evidence.
