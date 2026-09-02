# Q5 crash and fault-injection evidence

**Date:** 2026-09-02

**Scope:** local macOS gate; macOS/Windows CI confirmation pending

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

## Remaining evidence

This local run does not certify power-loss/filesystem corruption, real provider crashes or Windows process
semantics. The CI matrix must show this named gate green on both macOS and Windows. Phase 8's private dogfood exit
gate and the repository-wide release gate remain separate requirements.

CI run 33657047573 proved the production audit and clean-install path but initially failed the named macOS fault step
because a fresh Verify runner had the Playwright package without its Chromium binary. The gate correctly refused to
reinterpret that `DRIVER_CRASHED` result as BrowserDriver fault evidence. CI now installs Chromium explicitly before
the unchanged matrix; replacement cross-platform evidence remains pending.
