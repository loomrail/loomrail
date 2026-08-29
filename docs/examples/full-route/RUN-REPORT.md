# D2 Codex run report

**Status:** real provider route reached pending owner Acceptance successfully

**Fixture:** [`fixture/`](fixture/)

**Procedure:** [`README.md`](README.md)

A fresh isolated Codex route completed Discovery, Plan, Implement, Review, QA and Acceptance preparation. Discovery
opened the expected punctuation HumanRequest, the owner selected a period, and the durable Decision was present in
every later context pack. No later provider-authored owner gate opened. The route stopped at the separate pending
AcceptancePackage; it was not accepted automatically and the WorkItem was not moved to Done.

Earlier diagnostic runs exposed two related boundaries before this successful observation. Seven isolated runs showed
that prompt wording and branch order could not prevent a resumed Discovery from selecting `NEEDS_HUMAN` again. After
that same-attempt branch was removed, one more isolated run completed Discovery but opened a process-confirmation
request in the automatically following Plan attempt even though its own context said no owner answer was missing. All
diagnostic daemons were closed. ADR-0004 now carries the used gate across automatically following first attempts and
reopens one only for an explicit retry (`StageAttempt.attempt > 1`).

## Environment

- Date: 2026-08-29
- Loomrail revision: `a628de9` plus the uncommitted D2 working tree described by this report
- Codex CLI version: `0.151.0-alpha.7.1`
- Provider shown by launcher: `CODEX`; CLI available; all six stages declared
- Fixture baseline check before the route: 1 test passed

## Durable decision

- HumanRequest: `Farewell punctuation` (`SINGLE_CHOICE`, blocking)
- Owner answer: `Period (.)`
- Decision visible after resume: yes
- Provider-authored HumanRequests after that Decision: none
- Final stage states: Discovery, Plan, Implement, Review and QA `SUCCEEDED`; Acceptance preparation reached its
  owner-only pending gate

## Changes

- `src/greeting.mjs`: exports `farewell(name)` returning `Goodbye, ${name}.`
- `test/greeting.test.mjs`: keeps the existing greet assertion and adds a focused period-farewell assertion
- Diff summary: 2 modified files, 7 insertions, 1 deletion
- `git diff --check`: passed
- Independent `node --test`: 2 passed, 0 failed

## Evidence and gate

- Review artifact (`provider: CODEX`): `Farewell with owner-chosen punctuation — Review`
  - Standards: pass; no findings
  - Spec: pass; no findings
  - Decision, standard-library tests, whitespace and bounded scope recorded
- QA artifact (`provider: CODEX`): `Farewell with owner-chosen punctuation — QA`
  - period Decision matches implementation
  - `farewell` export and focused test present
  - existing `greet` preserved
  - 2/2 Node tests passed; no dependency or whitespace changes
- AcceptancePackage: `PENDING`
- Owner action: intentionally not performed by this run

## Sanitization check

- [x] no bootstrap/session/CSRF value
- [x] no raw provider transcript
- [x] no absolute personal or data-directory path
- [x] no SQLite database or worktree contents
- [x] no credentials or environment secrets
