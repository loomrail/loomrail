# Q9 provider-compatibility evidence

**Date:** 2026-09-03

**Scope:** local implementation and macOS/Windows synthetic admission/package evidence

## Admission observations

The contracts suite passes 14/14 files and 141/141 tests. Its compatibility cases prove that Mock is always
`BUILT_IN`, an exact verified and authenticated live provider may be ready, and wire data cannot claim readiness,
version presence, missing state, or authentication before exact verification inconsistently.

The focused daemon gate passes 2/2 files and 12/12 tests. It proves:

- recorded/current recognized Codex versions remain `UNVERIFIED`, while Claude Code below 2.1.214 is `TOO_OLD`;
- exact SemVer parsing accepts prerelease/build metadata and rejects ambiguous leading-zero forms;
- malformed/path canaries, overflow, timeout and missing-process failures return only closed observations;
- the real synthetic child receives fixed argv with closed stdin and produces only a normalized version;
- auth is not invoked for `UNVERIFIED` or `TOO_OLD`; a refresh can observe an exact `VERIFIED` version and only then
  invoke auth;
- AUTO ignores an incompatible live CLI and uses Mock, while explicit selection stays visible with adapter start
  disabled rather than being silently replaced.

The full daemon suite passes 25/25 files and 197/197 tests. The dispatch refusal now describes any compatibility,
authentication or installation failure as provider readiness instead of incorrectly asserting that every
`start=false` means a missing executable.

## Owner-visible observations

The CLI suite passes 6/6 files and 33/33 tests. Doctor human/JSON output includes only normalized version and closed
compatibility state. Guided Mock remains READY without a live row. Guided Live distinguishes an exact compatibility
review from the later sign-in action and performs neither action.

The focused Playwright Settings route passes in English and Russian. It starts with a synthetic exact verified Codex
row, then observes an updated unverified version on **Check again**. AUTO moves to Mock, the exact version and closed
status stay visible, explicit Mock persists, keyboard selection works, and the compatibility list remains usable in
dark theme at 320 px without horizontal page overflow. The complete browser suite passes 52/52.

## Package and repository gates

- Full build/typecheck passes across the workspace.
- Focused changed-source ESLint, Prettier, public-tree (590 files), and pinned Node/pnpm checks pass.
- Production dependency audit reports no known vulnerabilities.
- `pnpm test:fault-injection` passes all focused suites and the process drill: one interrupted run, no replay and one
  durable report.
- `pnpm pack:release && pnpm test:release` passes. The dirty local receipt contains 60 allowlisted files; the tarball
  is 1,363,006 bytes and 6,322,053 bytes unpacked. A clean temporary consumer installs 189 packages with lifecycle
  scripts disabled, reports zero vulnerabilities, validates compatibility invariants in packaged Doctor output and
  completes setup/receipt/files/start/log lifecycle checks.

Repository-wide `pnpm verify` passes format, public-tree, toolchain and full build, then reports exactly the three
protected `apps/landing/src/main.ts` ESLint findings on lines 630, 631 and 634.

[GitHub Actions run 33686253005](https://github.com/loomrail/loomrail/actions/runs/33686253005) records the committed
Q9 gate:

| Lane                  | macOS | Windows |
| --------------------- | ----- | ------- |
| Compatibility probes  | PASS  | PASS    |
| Production audit      | PASS  | PASS    |
| Crash/fault recovery  | PASS  | PASS    |
| Clean package install | PASS  | PASS    |
| Browser smoke         | 52/52 | 52/52   |
| Repository Verify     | FAIL¹ | FAIL¹   |

¹ Both Verify jobs reached ESLint after format, public-tree, toolchain and full build, then stopped only at protected
landing lines 630, 631 and 634. No Q9 or other non-landing failure preceded that unrelated blocker.

## Matrix authority and remaining evidence

The live `VERIFIED` allowlist is intentionally empty. Local synthetic evidence proves only the admission mechanism;
it does not promote Codex or Claude Code. An exact live row still requires separately owner-authorized quota-bearing
success/failure/workspace/MCP recordings, negative stream corpus and matching macOS/Windows evidence. No provider
session, login, install, update, downgrade, npm publish or `apps/landing/**` change was performed by Q9.
