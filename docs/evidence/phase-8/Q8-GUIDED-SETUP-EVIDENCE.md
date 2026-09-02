# Q8 guided-setup evidence

**Date:** 2026-09-02

**Scope:** local implementation and clean macOS/Windows CI

## Closed setup observation

The CLI suite passes 6/6 files and 33/33 tests. Its setup cases prove:

- empty, `1` and `mock` select the zero-quota Mock route, while only `2` and `live` select Live;
- free-text/overlong choices are rejected without echoing their content;
- a missing data directory/database and no live login remain `READY` for Mock without creating the path;
- Live is blocked until a non-Mock provider is observed installed and authenticated;
- pending migration, missing Chromium and any provider environment override produce closed failures and ordered
  `BACK_UP_DATA`, `INSTALL_CHROMIUM`, `CLEAR_PROVIDER_OVERRIDE` actions;
- Doctor/browser probe exceptions become fixed unavailable codes without exposing a path/error canary.

A built launcher was run against an isolated nonexistent data path. `setup --mode mock --json` returned schema v1,
`READY`, `BROWSER_READY` and the exact actions `RUN_START`, `INITIALIZE_DEMO_WORKSPACE`, `SELECT_MOCK`; the data path
remained absent. A non-TTY `setup` without explicit mode exited 1 with empty stdout and a bounded mode instruction.

The same launcher was also observed against existing state with a pending migration. It returned `BLOCKED` and only
`BACK_UP_DATA`, rather than applying a migration or claiming first-run readiness.

## Clean package observation

`pnpm pack:release && pnpm test:release` passed locally. The dirty-source development receipt contains the same 60
closed allowlisted files as Q7; the bundled setup module needs no extra runtime asset. The candidate tarball was
1,359,550 bytes and 6,308,028 bytes unpacked.

The clean consumer install added 189 packages with lifecycle scripts disabled and reported zero vulnerabilities. Its
installed launcher then proved non-TTY setup refusal, `setup --mode mock --json` readiness after the explicit local
Chromium prerequisite, no state creation, the existing doctor/data-path boundary, daemon readiness/Workbench serving
and the full redacted log export/delete lifecycle.

The local receipt records `source.tree=DIRTY`, as required before commit. The committed candidate was then exercised
by [CI run 33680374866](https://github.com/loomrail/loomrail/actions/runs/33680374866):

| Gate                              | macOS                        | Windows                      |
| --------------------------------- | ---------------------------- | ---------------------------- |
| CLI suite before package smoke    | 6/6 files, 33/33 tests       | 6/6 files, 33/33 tests       |
| Guided-setup browser prerequisite | Chromium installation passed | Chromium installation passed |
| Clean consumer audit              | zero vulnerabilities         | zero vulnerabilities         |
| Packaged setup/receipt/files/logs | passed                       | passed                       |
| Browser smoke                     | 52/52                        | 52/52                        |
| Crash/fault gate                  | passed                       | passed                       |

The two source Verify jobs reached ESLint only after the crash/fault gate passed. Both reported exactly the same
three protected `apps/landing/src/main.ts` diagnostics on lines 630, 631 and 634; no Q8 or other non-landing failure
was present.

## Repository gates

- Prettier, public-tree (581 files) and pinned Node/pnpm checks pass.
- Full non-landing ESLint, repository build/typecheck and production audit pass.
- Full `pnpm test` passes, including Browser QA 18/18, persistence 102/102, daemon 188/188 and CLI 33/33.
- `pnpm test:fault-injection` passes the focused suites and process drill: one interrupted run, no replay and one
  durable report.
- Repository `pnpm verify` reaches ESLint and reports only the three protected `apps/landing/src/main.ts` findings on
  lines 630, 631 and 634.

## Authority and remaining gates

Setup Route and Setup Readiness Report are transient guidance. They are not Provider Preference, an installation
receipt, durable state, migration approval or permission to run any next action. The command performs only the
existing bounded Git/provider status probes plus a local `stat` of the Playwright-reported Chromium executable; it
does not launch an agent session, browser, login, package manager or network download.

Q8's local and clean macOS/Windows gate is complete. Provider version compatibility, registry provenance, private
dogfood, protected landing lint and npm publication remain separate stable-release gates.
