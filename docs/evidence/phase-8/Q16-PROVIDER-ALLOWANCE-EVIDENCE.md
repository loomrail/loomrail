# Q16 provider allowance evidence

**Date:** 2026-09-05

**Scope:** locally and cross-platform verified implementation with macOS live diagnostics and completed independent
review; Windows live-provider verification remains deferred by the owner

## Implemented module

One strict normalized contract represents `LIVE | STALE | UNAVAILABLE` provider observations and one pure domain
projection derives freshness and `CAPACITY_AVAILABLE | LOW_CAPACITY | LIMIT_REACHED | UNKNOWN`. A provider allowance
never enters `BudgetPolicy`: it cannot start, stop, accept, resume or increase an AgentRun. Only a separately measured
structured provider HTTP 429 creates `PROVIDER_RATE_LIMITED` Attention.

Codex has a bounded App Server reader whose outbound vocabulary is only `initialize`, `initialized` and
`account/rateLimits/read`. It uses argv without a shell, a minimal environment, response/deadline limits and observed
process termination. Provider response objects are projected field-by-field before strict validation, so account,
credit, plan and spend-control fields never cross the adapter seam.

The daemon admits allowance only behind an allowance-specific exact version/OS/architecture/auth-mode row, coalesces
concurrent refreshes and persists one normalized snapshot plus its audit Event transactionally. The admitted Codex
rows are `0.153.1 / darwin / arm64 / ChatGPT` and `0.153.4 / darwin / arm64 / ChatGPT`; each is intentionally
independent from execution compatibility. Older
observations cannot replace newer ones; restart recalculates freshness. The daemon's three-second outer deadline
releases a timed-out coalescing slot so a later retry can start a fresh bounded read. Authenticated GET and
Origin/CSRF-protected POST routes expose only the normalized projection.

Command Center and Task Cockpit reuse one compact strip. It explicitly names the provider, remaining percentage,
window, reset and freshness, keeps used percentage in details, and renders Hard budget separately. Unavailable is
unknown capacity, never zero. RU/EN, keyboard refresh, light/dark and narrow layout use the existing semantic tokens.
The earlier model-control correction remains in the same surface: the owner chooses `Auto`, `Codex`, `Claude Code` or
`Mock`, then the Model control shows the exact model mapped by the selected tier/provider rather than a bare tier name.
Hard token budget and Model occupy the same first form row and a browser assertion compares their visible control
boundaries, preventing the earlier vertical-offset regression.

## Live findings on macOS arm64

Read-only Doctor found Claude Code `2.1.260` verified/authenticated and Codex `0.153.1` installed but unverified. No
version was promoted merely because its executable was present.

The first bounded Codex App Server read returned `PROVIDER_SCHEMA_DRIFT`. The locally generated official 0.153.1
protocol schema showed nullable `limitId`, `windowDurationMins` and `resetsAt`, plus new adjacent account/credit/
spend-control fields. The reader was corrected to select only admitted nested fields, use a validated map key when a
group id is absent, and omit incomplete windows. A second read returned `LIVE` with three bounded windows and reset
timestamps. The diagnostic printed only shape/validity facts; no percentages, account metadata or raw JSON were
stored. This exact read-only capability can be shown for a Project that explicitly selects Codex, but the separate
execution compatibility row remains unverified, so `0.153.1` is not selected for dispatch by `AUTO` and cannot start
a provider session.

On 2026-09-05 the bundled CLI advanced to exact `0.153.4`. A fresh version/auth guard and the same bounded production
reader returned `LIVE` with three complete windows through the closed normalized projection; only provider, freshness,
window shape and bounded capacity fields were observed. No model turn, login, update or repository access occurred.
This exact allowance row was admitted separately from the `0.153.4` execution row verified by the Q14 refresh.

Claude Code's official rate-limit fields are inputs to its interactive status-line command. Two minimal owner-
authorized FAST `claude -p` probes completed with actual usage, but the ephemeral command was not invoked after the
first response, including after a bounded settle wait; the result remained `DATA_NOT_PRESENT`. The current headless
adapter therefore claims `canReportRateLimits=false` and injects no settings. Claude Desktop is not parsed or treated
as a machine-readable source. No raw provider transcript was saved and `--no-session-persistence` remained active.

## Local verification

- Final `pnpm typecheck` built and typechecked all 22 workspace projects.
- Final sequential `pnpm test` passed every workspace package. Relevant counts include contracts 166/166, domain
  223/223, provider-core 65/65, Codex 94/94, Claude 48/48, persistence 126/126 and daemon 221/221.
- `pnpm test:e2e`: 57/57 passed. The allowance cases include shared Command Center/Task Cockpit state, unknown-not-zero
  rendering and a real daemon stop/start over the same SQLite database; the walking skeleton also asserts exact
  Hard-budget/Model top alignment.
- `pnpm test:fault-injection`: passed with one interrupted run, no replay and one durable report.
- `pnpm pack:release && pnpm test:release`: bundle, receipt, dependency audit (`0 vulnerabilities`), clean install,
  samples, setup, guided try and log lifecycle passed; nothing was published.
- `pnpm test:public-readiness` and focused ESLint for every changed Q16 TypeScript/JavaScript file passed.
- The corrected Codex adapter covers the expanded/nullable schema, incomplete windows, multi-bucket ordering, legacy
  fallback, wrong id, error, timeout, premature exit and forced termination. Its bounded exact auth-mode probe reads
  stdout/stderr independently and returned only the closed value `CHATGPT` against the installed CLI.
- The corrected Claude adapter proves the headless negative capability and absence of `--settings` while retaining its
  existing structured result, MCP and typed 429 behavior.
- Independent Standards and Spec reviews completed with no remaining P0–P2 findings. The review caught the Codex
  auth-mode stream mismatch; the stderr-aware fail-closed fix and its negative two-stream test passed 94/94 adapter
  tests before re-review.
- Repository-wide formatting remains blocked only by unrelated untracked research files. Repository-wide lint still
  has the same three protected `apps/landing/src/main.ts` findings at lines 630, 631 and 634; neither surface is part of
  Q16, and `apps/landing/**` was not changed.

## Fixed-commit macOS/Windows CI

Q16 shipped in `765e458`; Windows CI then exposed one platform-invalid timing assertion in the stubborn-child test.
On Windows, Node terminates a child immediately for `SIGTERM` instead of delivering the catchable POSIX signal, so
the reader had correctly waited for real `close` but the test incorrectly required the additional POSIX grace period.
Commit `66e8fad` retained the POSIX escalation assertion and verified the Windows immediate-termination branch.

[CI run 33925446778](https://github.com/loomrail/loomrail/actions/runs/33925446778) on `66e8fad` recorded:

- Clean install passed on macOS and Windows, including tarball build, local-log lifecycle, Chromium prerequisite and
  clean-install release verification;
- Browser smoke passed 57/57 on macOS and 57/57 on Windows;
- provider compatibility, private reporting and the complete crash/fault-recovery gate passed on both platforms;
- the Windows process-tree lifecycle gate passed;
- each repository-wide Verify job stopped only at the same protected landing ESLint findings on lines 630, 631 and 634. The CI run therefore has an honest `failure` conclusion, while every Q16 and pre-landing cross-platform gate is
  green. The landing failure is not reclassified as Q16 success and remains a separate authorized work item.

## Remaining gates

- Windows live provider rows, protected landing, private dogfood and trusted publisher provenance remain separate
  stable-release gates.
