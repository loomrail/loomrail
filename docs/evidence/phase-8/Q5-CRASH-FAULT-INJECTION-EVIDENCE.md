# Q5 crash and fault-injection evidence

**Date:** 2026-09-02

**Scope:** local macOS gate plus macOS/Windows GitHub Actions confirmation

## Release command

```bash
pnpm test:fault-injection
```

The command builds the whole workspace, runs the selected fault suites sequentially, and then runs the
process-boundary daemon crash drill. It is also a named CI step on macOS and Windows before repository-wide
verification, so an unrelated lint failure cannot hide recovery evidence.

## Fault matrix observed locally

| Layer                | Test files |   Tests | Covered failure boundary                                                        |
| -------------------- | ---------: | ------: | ------------------------------------------------------------------------------- |
| persistence-sqlite   |          8 |     102 | transaction rollback, migrations, reopen, orphan process/workspace and recovery |
| provider-core        |          5 |      49 | process lifecycle, deadlines, abort and malformed provider data                 |
| provider-codex       |          2 |      51 | fixed argv/no shell, stream/exit/termination faults                             |
| provider-claude-code |          2 |      34 | fixed argv/no shell, stream/exit/termination faults                             |
| mcp-gateway          |          5 |      25 | bounded shutdown, orphan records and unknown outcome without retry              |
| project-scaffolding  |          2 |      19 | marker-bound partial publication and fail-closed recovery                       |
| browser-qa           |          2 |      18 | origin/resource/artifact failures and bounded cleanup                           |
| daemon               |         24 |     188 | startup reconciliation, worker/provider/tool/QA faults and HTTP refusal paths   |
| **Total**            |     **50** | **486** | all selected component boundaries                                               |

All 486 tests passed. The following process drill passed after them:

```text
Crash-recovery drill passed: one interrupted run, no replay, one durable report.
Fault-injection gate passed.
```

Full repository typecheck and tests also passed. The clean-install `0.1.0-alpha.5` tarball contained 60 allowlisted
files, did not contain the crash fixture, and launched successfully from an empty temporary project. During this gate
the production audit detected newly disclosed `fast-uri` 3.x/4.x advisories; the workspace lock now overrides the two
affected resolutions to patched 3.1.6 and 4.1.3. The repeated production audit reported no known vulnerabilities, and
the complete fault/package gates passed again on that graph.

## Process-boundary claim

The parent process created an isolated temporary data root, authenticated through the normal session/CSRF API,
started a real daemon child and waited until its test-only blocking Mock adapter reported a durably started
ProviderSession. It then sent `SIGKILL` to that exact child handle.

A fresh daemon process opened the same SQLite/WAL state and exposed:

- one `INTERRUPTED` PipelineRun;
- one `INTERRUPTED` StageAttempt with `DAEMON_RESTART`;
- exactly one `DAEMON_RESTART` RecoveryReport;
- no running ProviderSession;
- no running AgentRun in the Fleet projection.

After a graceful stop, a third daemon process exposed the same single report and no running session/run. The
blocking adapter was not invoked again, proving that startup reconciliation did not automatically replay work whose
outcome was unknown.

## Safety boundary

- The fixture uses only bundled synthetic project `web-app-a`, a test-owned Mock adapter and an exact `mkdtemp`
  directory.
- No provider CLI, MCP server, BrowserDriver, network request, owner repository or ambient PID is accepted.
- The parent signals only the `ChildProcess` handle it created and cleans only still-live children plus that exact
  temporary directory.
- No production failpoint, crash route, environment switch or automatic-resume contract was added.
- The test fixture is outside the release-package staging manifest; the clean-install tarball gate must continue to
  verify that boundary.

## Cross-platform CI evidence

[GitHub Actions run 33658781891](https://github.com/loomrail/loomrail/actions/runs/33658781891) ran the named gate on
both release platforms after installing the pinned Playwright Chromium prerequisite. The macOS and Windows
`Verify crash and fault recovery` steps both passed. The same run also passed the production audit, release-tarball
clean install and independent Browser smoke jobs on both platforms.

Both repository-wide Verify jobs then passed formatting, the 564-file public-tree check, toolchain validation and the
full build before stopping at the same three protected landing lint errors in
`apps/landing/src/main.ts:630,631,634`. No Q5 or cross-platform portability failure was reported.

## Remaining evidence boundary

These runs do not certify power-loss/filesystem corruption or real provider crashes. Phase 8's private dogfood exit
gate and the repository-wide release gate remain separate requirements.

CI run 33657047573 proved the production audit and clean-install path but initially failed the named macOS fault step
because a fresh Verify runner had the Playwright package without its Chromium binary. The gate correctly refused to
reinterpret that `DRIVER_CRASHED` result as BrowserDriver fault evidence. CI now installs Chromium explicitly before
the unchanged matrix.

Replacement run 33657337447 proved the macOS fault gate and every clean-install/browser job. Its Windows daemon suite
passed 183 of 188 tests but reported three failures, including one setup hook, after existing deadlines were exhausted
while test files competed for SQLite/process/server resources. The Q5 runner now executes daemon files with one
Vitest worker, matching the specification's sequential reliability boundary without lengthening test deadlines;
run 33658781891 verified that correction on Windows.
