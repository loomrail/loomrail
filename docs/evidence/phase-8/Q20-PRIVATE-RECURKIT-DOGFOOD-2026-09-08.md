# Q20 private Recurkit dogfood — 2026-09-08/09

## Result

**One private full-stack WorkItem passed the complete production workflow and the owner accepted its Acceptance
Package on macOS.** It is not promoted as the stable `privateDogfood` gate: the approved Dogfood Alpha contract
requires a domain-owned Epic with 2–3 durable dependent WorkItems, while this run kept three ordered implementation
parts inside one WorkItem brief/plan.

The completed work is the password-reset core and dashboard surface in Recurkit. Delivery remains an intentional
dry run: the service stores only a token hash and discards the raw token, and no email/outbox adapter sends a reset
link. This safely exercises the private repository but is not a claim that public users can yet receive recovery
email.

## Scope and authority

- The owner explicitly approved live use of the already-authenticated local Codex and Claude Code CLIs and later
  selected `Accept delivery` in Loomrail.
- The target was the existing Recurkit working tree in explicit shared-current-directory mode. Its base commit was
  `6becf4158d5339434e9ddc0a111d134b5da169a9`; pre-existing modified and untracked files were carried into the
  baseline and preserved.
- The WorkItem was `6464C405`, titled `Private beta: безопасное восстановление пароля`. Its brief ordered backend,
  dashboard, then verification/documentation work and explicitly prohibited credential, charging, deployment and
  Git-history changes.
- No direct OpenAI/Anthropic API transport, API key, login change, CLI update, purchase, npm publication, Recurkit
  commit/push/deploy or external email was used. Test doubles were not used for the live workflow.
- Runtime state, raw provider streams, credentials, MCP capability values, command output, private file content and
  absolute owner paths are not retained in this evidence.

## Runtime and workflow evidence

| Property                  | Observed value                                     |
| ------------------------- | -------------------------------------------------- |
| Platform                  | macOS (`darwin`, `arm64`)                          |
| Node                      | `24.19.0`                                          |
| Codex CLI                 | `0.153.4`                                          |
| Claude Code CLI           | `2.1.260`                                          |
| Authentication            | existing provider-owned local sessions             |
| Authoring/QA/Acceptance   | Codex                                              |
| Independent Review        | Claude Code, cross-provider                        |
| Accounting                | `POST_SESSION`, authoritative terminal usage       |
| Recorded WorkItem usage   | 13,222,791 / 20,000,000 estimated tokens (66%)     |
| Accepted measured QA tree | `2d53c8d8`                                         |
| Owner disposition         | `ACCEPTED`; WorkItem `DONE`; PipelineRun completed |

The workflow completed Discovery, Plan, bounded Implement, three independent Review rounds with correction,
daemon-owned Project verification, measured Browser QA with correction/retest, provider QA synthesis and
Acceptance. All three required owner-approved Project checks passed on the accepted tree. The daemon was restarted
during the workflow and continued from durable state without replaying an uncertain tool effect or editing the
database by hand.

The final Browser QA evidence used Chromium on macOS and passed the locked password-reset scope on desktop light
`1280×800` and mobile dark `320×720`. The final correction/retest resolved the recorded route/title/focus defects;
the Acceptance Package projected only the measured scenario vocabulary and reported all three Project checks as
passed. Historical failed/returned/cancelled Recurkit runs remain historical and were not renamed into this pass.

## Recurkit implementation produced by the run

The accepted slice added:

- password-reset request/confirm controller, DTOs, service and Nest module wiring;
- a migration plus matching Prisma `PasswordResetToken` model and Account relation;
- one-time hashed-token claim, expiry, session invalidation, non-enumerating unknown/Yandex-only behavior and
  existing anti-abuse gates;
- forgot/reset dashboard routes and forms, a discoverable login link, anonymous auth-guard admission and explicit
  loading/success/invalid/retryable-failure states;
- service/controller tests, dashboard guard tests, Playwright password-reset coverage and an architecture/runbook
  note that documents the dry-run delivery boundary.

The first independent review found five actionable issues, including missing navigation, missing browser/controller
coverage, a retry trap after transient failure and Prisma schema/migration drift. Later independent reviews marked
them resolved on newer trees and passed. No finding was waived and no provider prose substituted for Project
verification or measured Browser QA.

## Loomrail defects found and closed

### Provider-visible workspace authority

The first IMPLEMENT session saw the native provider scratch as read-only and did not understand that the separate
`loomrail_workspace` MCP connector was the authoritative repository path. Loomrail did not accept synthetic
completion. The production fix adds one provider-neutral authority renderer used by both adapters. It:

- distinguishes empty native scratch from the bounded workspace without exposing repository path, branch, proxy
  arguments or capability;
- validates connector and required tool wiring before spawn with typed errors;
- instructs `READ_WRITE` sessions to read first and use compare-and-swap write/delete;
- advertises write/delete only for `READ_WRITE`, while Review/QA discovery remains read-only.

Focused provider-core, Codex, Claude and real MCP-session tests cover the allowed and missing-authority shapes.

### Browser assertion settling

The first password-reset Browser QA attempt also exposed that Loomrail evaluated assertions immediately after a
client-side navigation/streamed render. That produced measured defects which a later rerun could pass after timing
changed. The Playwright driver now gives all assertions in one scenario a shared bounded settle deadline and repeats
only the closed read-only assertion probes. It does not add an arbitrary fixed sleep or allow model-authored script.
A real client-navigation regression covers delayed URL, visible heading and focus.

During direct post-acceptance verification, an older running Next.js process also served a build whose on-disk chunks
had been replaced by a newer build. Restarting the target from an immutable standalone output restored hydration.
This was an environment/process-lifecycle issue, not evidence of a passing product tree; the failed observation was
not used as success.

## Verification outside the accepted package

After Acceptance, direct Recurkit verification found and fixed three test-harness/accessibility details: keyboard
traversal now includes the new forgot-password link, loading buttons keep stable accessible names, and the overflow
helper uses a supported Playwright polling assertion. These later changes are not attributed to the accepted
`2d53c8d8` package.

On the resulting Recurkit working tree:

- lint, build and the complete workspace test command passed;
- API reported 105 suites / 1,698 tests passed;
- dashboard unit tests reported 26 files / 141 tests passed;
- the complete dashboard Playwright suite passed 10/10 after local Postgres/Redis and Chromium prerequisites were
  present;
- no Recurkit commit, push, deploy or external email was performed.

On the resulting Loomrail tree:

- `pnpm verify` passed in full: formatting, public-tree/toolchain/activation checks, build, lint, typecheck, release
  integrity checks and all workspace tests;
- the production Browser QA package passed 29/29 tests, provider-core passed 74/74 and daemon passed 252/252;
- the complete product Playwright suite passed 61/61, including measured Browser QA, accessibility, mobile/theme,
  restart, review/correction and Acceptance states;
- `pnpm pack:release && pnpm test:release` produced `loomrail-0.1.0-alpha.5.tgz` and verified samples, setup,
  diagnostics, receipt, installed files and log lifecycle from a clean install; the clean install reported zero
  vulnerabilities;
- SQLite integration files now run through one test worker so real databases, Git worktrees and cleanup do not race
  for disk resources on a heavily loaded host. The production runtime and its deadlines are unchanged;
- the real Context7 integration allows one fresh retry only after the first five-second probe returns the honest
  `TIMED_OUT` state. Each attempt keeps the approved C1 production deadline and the retry still discovers the real
  bundled process and exact capability set.

No npm publication or direct paid provider API call is authorized by this report.

## Stable-gate interpretation

This run proves the full single-WorkItem production route on a private full-stack repository, including real
subscription-backed providers, shared-tree preservation, corrections, cross-provider Review, exact-tree Project
verification, measured Browser QA, restart recovery, budget accounting and human Acceptance.

It does **not** prove:

- a domain-owned Epic containing 2–3 durable dependent WorkItems;
- Codex or Claude Code live execution on Windows;
- production reset-link email delivery in Recurkit;
- registry provenance or a stable npm publication.

Consequently the strict release index remains 8/11: `privateDogfood`, `codexWindowsCompatibility` and
`claudeWindowsCompatibility` stay `PENDING`. Promoting the single accepted WorkItem would weaken an approved product
boundary, so no digest/commit claim is added to the manifest for it.
