# B4 Scaffolding нового Project — implementation plan

**Дата:** 2026-09-01
**Статус:** implemented; macOS and Windows release gates passed
**Спецификация:** [`39-b4-new-project-scaffolding-spec.ru.md`](39-b4-new-project-scaffolding-spec.ru.md)

## 1. Deep module

- [x] Add `packages/project-scaffolding` with one public proposal/publish interface.
- [x] Keep immutable recipes, path rules, canonical digest and filesystem recovery behind that interface.
- [x] Cover portable paths, bounded content, lifecycle-script denial and deterministic rendering.

## 2. Durable lifecycle

- [x] Add strict contracts and exhaustive Scaffold Operation transitions.
- [x] Add additive SQLite migration, idempotency, expected-version conflicts and pending-operation query.
- [x] Persist provisioning Project + Operation + Event before mutation and activate the Project transactionally.
- [x] Reconcile exact marker-bound pending publications on startup.

## 3. Product surface

- [x] Add proposal/publish/status/recovery daemon routes with the ordinary local security boundary.
- [x] Add a distinct Settings flow for creating a new project; preserve existing-repository registration.
- [x] Add RU/EN copy, keyboard focus, light/dark and actionable failure states.
- [x] Guide the owner to dependency installation and readiness after creation; never run those commands silently.

## 4. Gate

- [x] Run narrow package/domain/persistence/daemon/web tests while iterating.
- [x] Run the complete package and browser suites, then rerun every suite affected by the final Git isolation hardening.
- [x] Run format, public-tree, non-landing lint, typecheck, production audit and diff checks.
- [x] Build and launch the release tarball from a clean macOS installation.
- [x] Confirm the B4 file set excludes `apps/landing` and scan tracked output for personal paths and secrets.
- [x] Run the same release candidate in Windows CI before publishing:
      [run 33502010465](https://github.com/loomrail/loomrail/actions/runs/33502010465).

## 5. Local evidence

- `@loomrail/project-scaffolding`: 19/19 tests;
- workspace: 69/69 tests;
- daemon: 169/169 tests in the focused run;
- root `pnpm verify`: passed after the final Git environment isolation change, including all package tests;
- Playwright: 42/42 scenarios after the same hardening;
- clean `loomrail-0.1.0-alpha.3.tgz`: 50 files, 1.2 MB, installed and launched outside the monorepo;
- public `loomrail@next` resolved to `0.1.0-alpha.3`, installed into an empty temporary directory, reached
  `/health/ready` and served the Workbench shell;
- production audit found no known vulnerabilities;
- macOS and Windows `verify`, browser smoke and clean-install jobs passed in the release-gate CI run;
- the B4 change set does not modify `apps/landing`; the independent landing-owned lint fix was present during the
  final repository-wide verification.
