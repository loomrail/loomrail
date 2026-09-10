# L4a GitHub Actions Guided Deploy — Recurkit

**Status:** MECHANISM PASSED on macOS; eligible live dispatch and Windows evidence remain pending

**Observed:** 2026-09-11

**Target:** installed Loomrail release package against a disposable copy of durable Recurkit state

## Production-shaped dogfood

The receipt-backed release tarball was installed into a fresh temporary directory. A consistent SQLite online
backup copied the existing Loomrail state; the original database and the Recurkit repository were not migrated or
changed. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` were explicitly absent from the process environment.

Read-only diagnostics reported Node `24.19.0`, Git and both subscription-backed local providers ready:

- Codex CLI `0.153.4`, authenticated and verified for all six workflow stages;
- Claude Code CLI `2.1.260`, authenticated and verified for all six workflow stages;
- no direct OpenAI or Anthropic API transport and no API billing credential.

The copied database began at migration 59. Starting the installed package applied migration 60 and preserved the
existing Project/workflow state. The three new tables were readable and initially contained zero Plans,
Deployments and Approvals. The authenticated Workbench selected Recurkit normally after restart.

The real Recurkit state contains four owner-accepted successful PipelineRuns with durable Acceptance Packages. Each
has successful IMPLEMENT and QA evidence; Codex performed authoring/QA and Claude Code supplied independent Review
evidence. This confirms that the existing full private dogfood remains readable after the L4a migration. Counts were
read from bounded relational state; raw provider streams, repository contents and local paths were not copied into
this document.

## Fail-closed deployment result

The current immutable Recurkit Release remains `0/24`: required readiness and launch-measurement evidence is absent,
and selected workflow evidence is stale for the current aggregate tree. The new Guided Deploy surface therefore
showed a clear blocked state before plan adoption or external authority.

An independent production-adapter preflight against the real registered repository returned typed
`BLOCKED / SOURCE_DIRTY`. The repository has a large pre-existing modified/untracked working set, so Loomrail did not
run GitHub CLI authentication or remote-branch checks after that boundary. The existing Release is also Production,
while L4a intentionally supports Preview only.

No deployment Plan or Approval was persisted, no `gh workflow run` command was executed, no GitHub Actions run was
created or observed, and no retry, rollback, Recurkit commit, push, merge, deployment or external message occurred.

The new panel was inspected in both dark and light themes. Its blocked notice, existing-workflow boundary and
unavailable rollback remained readable without relying on color. Keyboard confirmation, mobile layout and exact-run
states are covered by the browser suite.

## Candidate verification

After the dogfood finding and selector regression fix, the exact Loomrail candidate passed:

- focused domain, persistence, daemon and web tests for the new slice, including every closed dispatch/observation
  outcome, idempotency, restart recovery, migration immutability, Unicode/spaces and portable Windows path fixtures;
- `pnpm verify`: formatting, 913-file public-tree/security inspection, toolchain and activation contracts, lint,
  production builds, strict typechecks, 37/37 Node checks and 1,819/1,819 Vitest tests across 23 packages;
- `pnpm test:e2e`: 65/65 Playwright scenarios, including two keyboard confirmations, exact one-shot dispatch,
  exact-run observation, light/dark themes and narrow layout;
- `pnpm pack:release` and `pnpm test:release`: receipt-backed `loomrail-0.1.0-alpha.5.tgz` installed and executed from
  a clean directory, with zero installed-package vulnerabilities.

Every GitHub interaction in automated tests used injected test transport or test doubles in test code. The dogfood
temporary package, logs and database copy were removed after the local daemon shut down cleanly.

## Remaining gates

L4a production code is complete and verified on macOS, but no public Beta claim follows from this evidence. A live
dispatch still requires a new clean, published, fully passing Preview Release plus a separate owner confirmation of
that exact immutable target. Windows remains a blocking platform gate. Production deployment, hotfix and rollback
remain explicitly unavailable rather than simulated.
