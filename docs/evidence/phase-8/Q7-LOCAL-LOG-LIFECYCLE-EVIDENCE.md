# Q7 local-log lifecycle evidence

**Date:** 2026-09-02

**Scope:** local implementation and macOS/Windows CI evidence

## Persistence and redaction observations

The CLI local-log suite passes 5/5 files and 28/28 tests. Its Q7 cases prove:

- closed-field sanitization removes bearer/query/assignment secrets, headers, body, prompt, stack and POSIX/Windows
  path canaries before bytes reach a segment;
- malformed input becomes a constant `LOG_LINE_DROPPED` record without source bytes;
- a writer holds the exclusive lease, so export/delete fail while its process is live; a valid dead-PID lease is
  reclaimed, while invalid locks are preserved and refused;
- owned segments rotate under injected size/age bounds, expired files and oldest over-capacity files are removed, and
  the retained total remains bounded;
- matching directories/non-regular entries fail closed, while an unknown sibling survives export, cleanup and
  delete; POSIX observations show `0700` for `logs/` and `0600` for segments;
- export re-parses and re-redacts complete ordered input before returning NDJSON; delete removes only exact owned
  segment names.

A built-launcher smoke used an isolated explicit data directory. `logs export` returned exit 1 with the safe
stopped-daemon instruction while the daemon held the lease. After `SIGINT`, the export contained two schema-v1 daemon
records and neither the bootstrap fragment nor the data path. `logs delete` removed one 356-byte segment; the next
export was empty.

## Clean package observation

`pnpm pack:release && pnpm test:release` passed locally. The dirty-source development receipt contained the same 60
closed allowlisted package files as Q6; the bundled CLI entrypoint therefore carries the log module without a new
unlisted runtime file. The final candidate tarball was 1,357,709 bytes in this observation.

The clean consumer install added 189 packages with lifecycle scripts disabled and reported zero vulnerabilities.
The installed launcher then proved:

1. doctor/data-path and the existing runtime smoke still work;
2. active-daemon export is refused without partial stdout or data-path disclosure;
3. graceful/terminated launcher closure leaves a reclaimable management boundary;
4. post-stop output is non-empty schema-v1 redacted NDJSON;
5. packaged delete removes retained segments and a second export is empty.

The receipt records `source.tree=DIRTY`, as required for a pre-commit local candidate. The committed CI candidate
produced `CLEAN` receipts on macOS and Windows before clean installation.

## Repository gates

- Prettier check, public-tree check for 576 files and pinned Node/pnpm toolchain check pass.
- Full non-landing ESLint passes. Repository `pnpm verify` stops only at the three protected
  `apps/landing/src/main.ts` diagnostics on lines 630, 631 and 634.
- Full TypeScript build/typecheck passes, including the landing typecheck.
- Full `pnpm test` passes after installing the declared Playwright Chromium prerequisite. The first attempt correctly
  failed only because that executable was absent; no product or Browser QA test was changed. The passing run includes
  Browser QA 18/18, persistence 102/102, daemon 188/188 and Plugin SDK 11/11. The final focused CLI rerun is 28/28
  after adding the owner-only permissions case.
- `pnpm test:fault-injection` passes its 486 focused tests and process-boundary drill: one interrupted run, no replay,
  one durable report.
- Workspace production audit reports no known vulnerabilities.

## Cross-platform CI observation

[GitHub Actions run 33676031870](https://github.com/loomrail/loomrail/actions/runs/33676031870) exercised commit
`bdc70f2` on both blocking platforms:

| Lane               | macOS                                                                 | Windows                                                               |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Clean install      | CLI 5/5 files, 28/28 tests; clean receipt, audit and lifecycle passed | CLI 5/5 files, 28/28 tests; clean receipt, audit and lifecycle passed |
| Browser smoke      | Passed                                                                | Passed                                                                |
| Fault/recovery     | Passed                                                                | Passed                                                                |
| Full source verify | Stopped only at protected landing lines 630, 631 and 634              | Stopped only at protected landing lines 630, 631 and 634              |

Both clean consumers reported zero vulnerabilities and the packaged launcher confirmed that the receipt, installed
files and log lifecycle matched. The Q7-specific gate is therefore complete; the overall workflow remains red only
because `apps/landing/**` is owned by a separate development session.

## Authority and remaining evidence

Operational segments remain diagnostics rather than Event/Decision/acceptance authority. Q7 adds no provider raw
output capture, HTTP route, telemetry, upload, recursive data removal, publish action or landing change. A process
running as the same OS user can still inspect or tamper with local files; therefore exported logs are not integrity
evidence and must be reviewed before sharing.

Registry provenance, private dogfood and the protected landing lint remain separate stable-release gates. Q7 does not
claim or close any of them.
