# Q17 Project verification evidence

**Date:** 2026-09-05

**Scope:** implemented, independently reviewed and verified owner-approved Project verification gate; automated
macOS/Windows CI evidence recorded below; Windows live-provider verification remains deferred

## Implemented boundary

Project verification is daemon-measured evidence, not a provider claim. A bounded read-only scanner proposes exact
recipes from repository manifests, and the owner must inspect and adopt executable, argv, cwd, timeout, environment
and network policy before anything can run. The marker-bound publisher writes only the versioned
`.loomrail/verification-plan.json`; scanning and publishing never invoke a package manager or lifecycle hook.

The runner executes an adopted recipe as argv with no shell in the exact WorkItem workspace. It uses a scrubbed
environment, canonical cwd, explicit network-policy admission, output and time bounds, process-tree termination and
tree checks before and after execution. It has no package-install, commit, push, merge, cleanup or deploy authority.
Bounded redacted output stays in the app artifact directory and is loaded on demand; Events and Acceptance export
carry only normalized identities and measurements.

Run, Check, Failure, correction, shared budget position, workflow state, Event, follow-up dispatch and command receipt
are committed transactionally. Restart turns unknown active execution into one durable `INTERRUPTED` result without
replay. Required `FAILED | ERROR | INTERRUPTED | STALE` evidence blocks Browser QA and Acceptance; optional failure
remains visible but advisory. Correction requires a fresh IMPLEMENT tree, independent Review and an exact rerun of
the active owner-approved Plan.

Project verification and Browser QA keep distinct failure identities while sharing one delivery ceiling: two
automatic positions and at most one owner-authorized final position. Alternating evaluator order, nested handoff,
owner cancellation, idempotent replay and SQLite reopen retain exact lineage. A passing Run is immutable when its
tree or Plan becomes stale: one append-only `STALE` failure is materialized and the current QA gate re-enters the
remaining shared budget. If a previously passing correction supplied that Run, it remains historically `PASSED`;
the next correction or owner gate receives new authority. The same owner gate now resolves daemon-restart
interruptions after the automatic budget is spent.

Owner cancellation is a durable two-phase operation. The HUMAN command first records `CANCELLING` and leaves the
workspace reservation intact. A create-new launch intent and trusted supervisor bind repository execution to a
bounded process record; loss of the daemon control pipe stops resistant descendants and writes `STOPPED`. Only this
proof allows the SYSTEM finalizer or startup reconciliation to release the Run. Startup validates PID creation time
and fails closed on missing, invalid, reused or still-running identities instead of treating a DB row as evidence that
the OS process ended. Windows startup also blocks when the recorded root vanished before identity verification, so it
never signals descendants derived only from a reusable numeric PID. Recovery retains `INTENT | STOPPED` proof until
the corresponding bounded SQLite reconciliation batch commits, so a crash between process cleanup and durable state
cannot turn the next startup into an unrecoverable missing-record state. Manual durable terminal runs wake a parked QA
dispatch; non-terminal runner failures do not create automatic retry loops.

Task Cockpit groups adopted recipes, exact commands, required/optional labels, measured status, duration, platform,
stale reasons, correction history and output-on-demand behind one primary action. The correction owner gate also
recognizes a historically passed correction whose evidence later became stale. It is verified in English/light and
Russian/dark, by keyboard, at 320 px and across a real daemon restart over the same SQLite database.

## T48 threat-to-test matrix

| Threat                                 | Enforced boundary                                                  | Verification                                               |
| -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Hostile script or shell metacharacters | Owner adopts exact argv; runner uses `shell: false`                | scanner, proposal/adoption and runner injection tests      |
| cwd/path/symlink escape                | Canonical workspace-relative cwd and marker-bound publication      | publisher and runner path/symlink tests                    |
| Secret/environment disclosure          | Closed baseline environment and redacted bounded output            | env canaries plus output/privacy tests                     |
| Unsupported network denial             | Fail closed before spawn                                           | runner network-policy tests                                |
| Timeout/output exhaustion              | Bounded capture followed by process-tree stop                      | supervised-process and runner integration tests            |
| Resistant descendant/orphan            | Durable supervisor identity, control-loss reap, STOPPED proof      | root-exit and process-supervision lifecycle/recovery tests |
| Tree changed during verification       | Before/after tree observation produces typed failure               | runner tree-mutation tests                                 |
| Duplicate/late completion              | Expected versions, terminal-state checks and command receipt       | domain/persistence idempotency and rollback tests          |
| Daemon crash/restart                   | Reap proven identity before release; fail closed; never replay     | PID reuse, 1001 batching, SQLite-failure and fault tests   |
| Stale passing evidence                 | Append-only failure; immutable pass; bounded new authority         | domain/SQLite/UI stale-after-pass regression tests         |
| Forged workflow or owner action        | Internal actor IDs, HUMAN-only resolution, Origin/CSRF             | domain forbidden matrix and daemon HTTP tests              |
| Acceptance bypass                      | Latest active Plan + current tree + every required Check must pass | acceptance binding/export and workflow tests               |

## Local verification

- Changed-file Prettier and ESLint passed; repository-wide source typecheck built and typechecked every workspace
  project.
- Final sequential `pnpm test` passed every workspace package. Relevant counts include contracts 197/197,
  process-supervision 21/21, web 100/100, Browser QA 27/27, domain 299/299, Project readiness 24/24,
  persistence 143/143, daemon 241/241, provider core 68/68, provider adapters 159/159, MCP 21/21 and CLI 38/38.
  Landing passed 13/13 with its known jsdom `HTMLMediaElement` warnings.
- `pnpm test:e2e`: 58/58 passed. The Q17 case verifies exact command display, keyboard Run/output focus, inert hostile
  output, stale owner gate from a historically `PASSED` correction, no unavailable final authorization, RU/EN,
  light/dark, 320 px, no horizontal overflow and daemon restart over the same database.
- `pnpm test:fault-injection`: passed with one interrupted run, no replay and one durable recovery report.
- `pnpm pack:release && pnpm test:release`: tarball receipt, dependency audit (`0 vulnerabilities`), clean install,
  samples, setup, guided try and log lifecycle passed; nothing was published.
- The stale-after-pass regression first failed with `LINEAGE_MISMATCH`, then passed at domain, SQLite and browser
  seams. The source Run and passed correction retain their terminal state/version after materialization, owner
  cancellation and SQLite reopen; the new `VerificationFailure(STALE)` remains durable and Acceptance stays closed.
- The restart-interruption owner-gate matrix now covers both a direct Project verification correction and a Project
  verification failure nested inside active Browser QA.
- Windows missing-root recovery refuses ambiguous lineage; live supervisor root-exit cleanup, manual terminal
  workflow wake, non-terminal no-wake, 1001-Run batching, commit-before-unlink and SQLite-failure proof retention have
  dedicated regressions. Independent Standards and Spec reviewers report no remaining P0–P2 findings.
- Repository-wide lint passes. Repository-wide formatting remains blocked locally only by three unrelated untracked research
  files; they were neither changed nor included in this work. `apps/landing/**` was not changed.

## Fixed-commit macOS/Windows CI

The named Q17 lane runs scanner/publisher/runner and shared process-supervision lifecycle tests on both macOS and
Windows before repository-wide verification. Browser smoke and clean-install jobs independently exercise the packaged
application on both platforms. The final correction sequence made target exit independent from descendant cleanup,
kept Windows cleanup fail-closed, and preserved the owner's absolute `PATH` order when resolving an adopted package
manager instead of silently preferring a different global runtime copy.

Fixed-commit CI for `bb7b15e352c5f55eecda1ca82cb94bfcf174f741` is recorded in
[run 33970433849](https://github.com/loomrail/loomrail/actions/runs/33970433849):

- both repository-wide Verify jobs passed, including formatting, lint, typecheck, all workspace tests and SQLite
  portability;
- clean-install release verification passed on macOS and Windows;
- Browser smoke passed 58/58 on macOS and 58/58 on Windows;
- the named Project verification workflow gate passed on macOS and Windows;
- the Windows process-supervision suite passed 21/21, including resistant descendants, control-pipe loss, durable
  stop proof and target-exit-versus-cleanup timing;
- crash and fault recovery passed on macOS and Windows.

The overall workflow conclusion is `success`. This is automated fixture, browser, package and source evidence; it is
not a live-provider compatibility row or a private dogfood result.

## Remaining gates

- Windows live provider compatibility remains deferred by the owner; automated Windows runner, process-tree,
  browser and clean-install evidence is not a substitute for it;
- the protected landing now passes repository lint, but its separate Q15 canonical-contract integration remains open;
- private dogfood, exact live-provider promotion, trusted publisher provenance, owner Acceptance and an explicit
  publish/release decision are separate first-stable-version gates.
