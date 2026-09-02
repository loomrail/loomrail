# Q12 private Insights and reporting evidence

**Date:** 2026-09-03

**Implementation commit:** `4bfa789`

**Scope:** deterministic aggregate reporting, authenticated local Insights, owner-initiated exact JSON download

## Product and privacy boundary

Q12 adds a global **Insights** screen with local delivery, review, QA, Human Request, usage and restart-recovery
metrics. SQLite supplies only numeric counts through one statement; one domain function derives rates and the two
public payloads. Strict schemas at every nested object reject identifiers, names, paths, timestamps, free text, logs,
artifacts, messages and stack traces.

The screen renders the complete parsed aggregate payload before its download action. A crash payload appears only
when durable `RecoveryReport(reason = DAEMON_RESTART)` state exists. The downloaded bytes are serialized from that
same in-memory object. Public alpha has no collector, reporting endpoint, account, stable installation identifier,
cookie, beacon, schedule, retry queue or persistent consent toggle. One download does not authorize a future sender;
ADR-0009 requires a new decision and threat review before any direct transport.

## Layer evidence

- contracts accept bounded counts/runtime categories and reject impossible subsets plus sensitive fields at the
  top-level and nested metric/incident boundaries;
- domain tests prove deterministic integer rates, `null` with no denominator, exact aggregate payloads and no
  invented crash report;
- persistence tests prove zero facts and populated restart-recovery facts from one coherent SQLite statement without
  returning rows, IDs or text;
- daemon tests require the authenticated browser session, inject private project/path/work-item canaries, reconcile
  an interrupted workflow and prove none of those strings enter the crash response;
- web tests prove stable exact serialization and fail closed rather than silently removing a stack field;
- browser E2E opens the real Insights route, observes local-only/no-crash state, downloads the exact preview bytes
  after explicit owner action and records no external request;
- the existing dead-end navigation E2E now includes the fourth real sidebar route and still opens every entry.
- named `test:reporting` builds the product and runs 12 exact schema/domain/SQLite/daemon/web reporting tests before
  repository-wide lint, so the protected landing failure cannot hide this privacy boundary on either CI platform.

## Local verification

- full build and workspace typecheck pass;
- format passes, and landing-excluded ESLint reports no findings;
- full workspace tests pass, including 144 contracts, 197 domain, 103 persistence, 202 daemon, 70 web and 34 CLI
  tests;
- the complete browser suite passes 53/53;
- the fault-injection gate passes every focused suite and the process crash drill: one interrupted run, no replay and
  one durable recovery report;
- the public-tree gate passes 631 files with Node 24.19.0 and pnpm 11.21.0;
- production dependency audit reports no known vulnerabilities;
- `0.1.0-alpha.5` receipt/tarball verification installs 189 packages with scripts disabled, reports zero
  vulnerabilities, checks exact installed files and passes samples, setup, launcher and log lifecycle;
- repository-wide `pnpm verify` passes format, public-tree, toolchain and full build, then stops only on the three
  protected `apps/landing/src/main.ts` lint findings at lines 630, 631 and 634.

Q12 does not modify `apps/landing/**`, add remote infrastructure, start a provider, publish a package or claim a
stable release.

## Cross-platform verification

Pending the GitHub Actions run for implementation commit `4bfa789`. Q12 remains open until the macOS and Windows
reporting, fault, clean-package and browser lanes finish and the exact run is recorded here.

## Remaining release evidence

Private dogfood, an exact live-provider compatibility row, final security review, protected landing gate and trusted
registry provenance remain separate stable-release requirements.
