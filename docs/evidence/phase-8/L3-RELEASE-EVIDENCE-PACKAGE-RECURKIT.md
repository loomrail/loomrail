# L3 Release evidence package — Recurkit

**Status:** MECHANISM PASSED on macOS; candidate gates remain honestly non-passing

**Observed:** 2026-09-10

**Target:** private Recurkit working tree

## Production-shaped snapshot

The built Loomrail daemon used the durable private-dogfood state and ordinary authenticated HTTP routes. The owner
declared one `PRODUCTION / WEB_APP_V1 r1` Environment for `https://recurkit.ru` with `/api/health`, then selected the
three stable owner-accepted WorkItems. Loomrail captured this immutable Release:

- Release: `launchRelease-411dfdbd-5f03-4bcc-b183-2ccd58ac4c8f`;
- tree: `2d7dcefbef52126a3abedc25b76a3d33a9fa0198`;
- selected WorkItems: 3, each linked to its accepted package and exact Review, QA and Verification lineage;
- freshness immediately after creation: `CURRENT`, with no stale reasons;
- gate catalog: 24 required gates, all represented exactly once;
- outcome: 0 `PASSED`, 20 `ACTION_REQUIRED`, 0 `FAILED`, 4 `STALE`.

The 20 action-required gates record that this durable Project has no current readiness or launch-measurement source
selected for the Release. The four workflow gates are stale because the three accepted WorkItems were independently
verified on earlier trees rather than this current aggregate tree. Loomrail did not turn either condition into
success, and Release creation itself did not grant deploy approval.

## Dogfood findings

The first open correctly stopped on a known pre-release migration-56 checksum difference. The accepted compatibility
is one pinned historical/current SHA-256 pair; the migration ledger was not rewritten and unrelated drift remains a
typed refusal in both startup and read-only doctor paths.

The first Release create also stopped with `EVIDENCE_BOUNDARY_INVALID`. Real correction history contains superseded
Review artifacts in the same PipelineRun, while the accepted package names only the final authority-bound Review/QA
pair. The domain boundary now selects only exact `AcceptancePackage.artifactIds`, ignores superseded history and
still refuses a named missing or cross-boundary artifact. A deterministic regression reproduces both outcomes.

## Export and privacy

The evidence package was downloaded through the authenticated production endpoint after an unauthenticated request
returned 401.

- UTF-8 bytes: 7,842, matching the API's declared size;
- SHA-256: `71b1105407b4fa063f11c2bef580d5abc312e5c11bd0b56e4311a6b5ea426e75`;
- gate headings: 24;
- limitation statement present: the package is not a production-safety verdict or deploy approval;
- leak scan: no personal repository path, `.env` value, OpenAI/Anthropic key marker, token-like canary or raw provider
  payload marker.

L3 did not contact the declared public origin, inspect hosting credentials, start Codex or Claude, make a paid API
request, mutate the Recurkit repository, deploy, push, merge or publish anything.

## Candidate verification

After the dogfood regression, the exact Loomrail candidate passed:

- focused domain, persistence, daemon and web suites: 339, 170, 266 and 115 tests;
- `pnpm verify`: formatting, 897-file public-tree/security inspection, toolchain and activation contracts, lint,
  production builds, strict typechecks, 37/37 Node checks and 1,797/1,797 Vitest tests in 186 files across 23 packages;
- `pnpm test:e2e`: 64/64 Playwright scenarios, including the new Release UI/export flow;
- `pnpm test:fault-injection`: one interrupted run, no replay and one durable recovery report;
- `pnpm audit --prod --audit-level high`: no known vulnerabilities;
- `pnpm pack:release && pnpm test:release`: receipt-backed `loomrail-0.1.0-alpha.5.tgz` built and ran from a clean
  install with zero installed-package vulnerabilities;
- `pnpm release:status`: 9/11; only the two explicitly deferred Windows provider compatibility rows remain pending.

The main-branch remote CI result is checked after the owner-authorized commit and push and is not inferred here.

## Remaining release gates

Recurkit is not production-ready on this evidence. It needs current-tree readiness, current launch measurement and a
new accepted workflow scope verified on the aggregate release tree. Loomrail itself still requires L4 Guided Deploy,
L5 post-launch lifecycle and both blocking Windows compatibility rows before the first public Beta can be claimed.
