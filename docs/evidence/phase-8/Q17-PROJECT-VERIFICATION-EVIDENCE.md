# Q17 Project verification evidence

**Date:** 2026-09-05

**Scope:** implemented and locally verified owner-approved Project verification gate; automated macOS/Windows CI
evidence recorded below; independent Standards/Spec review and Windows live-provider verification remain open

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

Task Cockpit groups adopted recipes, exact commands, required/optional labels, measured status, duration, platform,
stale reasons, correction history and output-on-demand behind one primary action. The correction owner gate also
recognizes a historically passed correction whose evidence later became stale. It is verified in English/light and
Russian/dark, by keyboard, at 320 px and across a real daemon restart over the same SQLite database.

## T48 threat-to-test matrix

| Threat                                 | Enforced boundary                                                  | Verification                                                   |
| -------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Hostile script or shell metacharacters | Owner adopts exact argv; runner uses `shell: false`                | scanner, proposal/adoption and runner injection tests          |
| cwd/path/symlink escape                | Canonical workspace-relative cwd and marker-bound publication      | publisher and runner path/symlink tests                        |
| Secret/environment disclosure          | Closed baseline environment and redacted bounded output            | env canaries plus output/privacy tests                         |
| Unsupported network denial             | Fail closed before spawn                                           | runner network-policy tests                                    |
| Timeout/output exhaustion              | Bounded capture followed by process-tree stop                      | supervised-process and runner integration tests                |
| Resistant descendant/orphan            | Platform process-tree termination, verified with real PIDs         | process-supervision lifecycle test in named macOS/Windows lane |
| Tree changed during verification       | Before/after tree observation produces typed failure               | runner tree-mutation tests                                     |
| Duplicate/late completion              | Expected versions, terminal-state checks and command receipt       | domain/persistence idempotency and rollback tests              |
| Daemon crash/restart                   | Interrupt once, release reservation, never replay child            | persistence/daemon restart and fault-injection tests           |
| Stale passing evidence                 | Append-only failure; immutable pass; bounded new authority         | domain/SQLite/UI stale-after-pass regression tests             |
| Forged workflow or owner action        | Internal actor IDs, HUMAN-only resolution, Origin/CSRF             | domain forbidden matrix and daemon HTTP tests                  |
| Acceptance bypass                      | Latest active Plan + current tree + every required Check must pass | acceptance binding/export and workflow tests                   |

## Local verification

- Changed-file Prettier and ESLint passed; repository-wide source typecheck built and typechecked every workspace
  project.
- Final sequential `pnpm test` passed every workspace package. Relevant counts include contracts 194/194,
  process-supervision 10/10, web 95/95, Browser QA 27/27, domain 292/292, Project readiness 17/17,
  persistence 138/138, daemon 234/234, provider adapters 159/159, MCP 20/20 and CLI 38/38. Landing passed 13/13 with
  its known jsdom `HTMLMediaElement` warnings.
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
- Repository-wide formatting remains blocked only by unrelated untracked research files. Repository-wide lint still
  has the same three protected `apps/landing/src/main.ts` findings at lines 630, 631 and 634. Neither surface belongs
  to Q17, and `apps/landing/**` was not changed.

## Fixed-commit macOS/Windows CI

The named Q17 lane was added in `160ea72`. It runs scanner/publisher/runner and shared process-supervision lifecycle
tests on both macOS and Windows before repository-wide lint. Browser smoke and clean-install jobs independently
exercise the packaged application on both platforms. Follow-up commits `ae2045d` and `05cab62` close stale-after-pass
and restart-interruption owner-gate recovery without changing Windows product scope.

Fixed-commit CI for `05cab6279e0cf9f772cafbd32caba9558474d3fb` is recorded in
[run 33952514299](https://github.com/loomrail/loomrail/actions/runs/33952514299):

- clean-install release verification passed on macOS and Windows;
- Browser smoke passed 58/58 on macOS and 58/58 on Windows;
- the named Project verification workflow gate passed on macOS and Windows;
- the Windows MCP process-tree lifecycle passed on Windows;
- crash and fault recovery passed on macOS and Windows;
- both repository-wide Verify jobs reached source verification and failed only on the same three protected
  `apps/landing/src/main.ts` lint findings at lines 630, 631 and 634.

The overall workflow conclusion is therefore `failure`; it is not reclassified as green. All Q17, packaged-browser,
clean-install, fault-recovery and automated Windows compatibility evidence passed before that unrelated protected
surface stopped repository-wide lint.

## Remaining gates

- independent Standards and Spec review with every P0–P2 finding fixed or explicitly resolved;
- Windows live provider compatibility remains deferred by the owner; automated Windows runner, process-tree,
  browser and clean-install evidence is not a substitute for it;
- protected landing lint, private dogfood, trusted publisher provenance and an explicit publish/release decision are
  separate first-stable-version gates.
