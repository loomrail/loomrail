# Q10 bundled-sample catalog evidence

**Date:** 2026-09-03

**Scope:** local implementation; macOS/Windows CI evidence pending

## Repository and policy observations

`web-app-a` is now a dependency-free server-rendered task list with a pure renderer, optional explicit loopback
server, five baseline tests and two exact Task recipes. `api-service-b` is a pure in-memory HTTP-style issue handler
with three baseline tests and two exact Task recipes. Neither manifest declares dependencies or install lifecycle
scripts; tests use only the Node.js standard library.

`pnpm test:samples` validates and executes the exact two-entry source catalog. Its policy rejects unknown/missing
files, changed fixture/package identity, dependencies, changed scripts, symbolic or special entries, oversized files,
personal absolute paths and recipes without exactly two acceptance blocks. Three policy tests prove the valid catalog,
dependency refusal and extra-file refusal.

Daemon fixture integration passes 12/12. Both actual bundled templates are copied into separate temporary paths,
initialized as Git repositories with committed heads, and pass `node --test` after materialisation. The full daemon
suite passes 25/25 files and 198/198 tests; registration, idempotency, symlink refusal, repository isolation and the
updated change-diff fixture remain green.

## Workflow and role observations

The public EN/RU catalog names the one shipped `mock-delivery-v1` revision 4 sequence and the five roles dispatched by
the standard squad. It also states that Lead PM and Acceptance Manager are catalogued but not dispatched, that the
Acceptance Package is deterministic, and that only the owner may Accept, Return or Reject. README, both quick starts
and both Browser QA guides distinguish the executable sample from the no-second-server Mock readiness plan and the
quota-bearing D2 live route.

## Package and repository gates

- Full build and workspace typecheck pass.
- Full workspace tests pass, including 198/198 daemon and the new standard-library policy suite.
- Focused changed-source ESLint and repository-wide Prettier pass; public-tree validates 607 files with the pinned
  Node/pnpm toolchain.
- Production dependency audit reports no known vulnerabilities.
- Full Playwright browser E2E passes 52/52 after keeping the change-summary seed to an exact one-line README edit.
- `pnpm test:fault-injection` passes all focused suites and the process drill: one interrupted run, no replay and one
  durable report.
- `pnpm pack:release && pnpm test:release` passes. The dirty local receipt contains 70 allowlisted files; the tarball
  is 1,366,581 bytes and 6,332,093 bytes unpacked. A clean consumer installs 189 packages with lifecycle scripts
  disabled, reports zero vulnerabilities, validates and runs both bundled samples from the installed package, then
  completes the existing setup/receipt/files/start/log lifecycle checks.

Repository-wide `pnpm verify` passes format, public-tree, toolchain and full build, then reports only the three
protected `apps/landing/src/main.ts` ESLint findings on lines 630, 631 and 634. The named sample step and clean-package
evidence will be recorded after the committed macOS/Windows CI run; no Q10 source file is under `apps/landing/**`.

## Remaining release evidence

Q10 remains locally complete until the same source/package checks pass on macOS and Windows. Even after that, this
slice is not an exact live-provider row, private dogfood, telemetry, public issue/roadmap, final security review,
registry provenance or permission to publish the stable package.
