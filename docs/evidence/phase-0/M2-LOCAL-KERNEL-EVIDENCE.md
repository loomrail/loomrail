# Phase 0 / M2 local kernel evidence

**Date:** 2026-08-24
**Status:** macOS local gate complete; Windows CI execution pending first reviewed push

## 1. Accepted implementation

- versioned strict Zod contracts for Project, WorkItem, commands, results and four explicit Event types;
- pure WorkItem decision module covering the complete M2 transition matrix, version checks, human-acceptance gate
  and leaf-only execution rule;
- deep SQLite local-state module with `execute`, `query` and `close` instead of exposed table repositories;
- immutable SQL migration with checksum verification, foreign keys, WAL, bounded busy timeout and defensive mode;
- normalized Project, WorkItem and acceptance-criteria state;
- append-only Events and command receipts protected by database triggers;
- atomic state + Event + command-result transaction;
- semantic command hashing: transport correlation IDs may change on retry, while actor/type/payload must match;
- allowlisted bundled fixture catalog with canonical realpath/symlink containment;
- authenticated query API and CSRF-protected mutation API;
- CLI platform application-data resolution for macOS, Windows and Linux, with explicit development override;
- M2 status reflected in the existing responsive Command Center.

## 2. Local verification observed

```text
pnpm build       passed
pnpm lint        passed
pnpm typecheck   passed
pnpm test        78 tests passed across 9 test files
pnpm test:e2e    4 Chromium scenarios passed
pnpm audit --prod --audit-level high
                  no known vulnerabilities
```

The 41 domain tests cover every pair in the six-state transition matrix plus create, version, both directions of the
leaf-only execution invariant, and no-op update behavior. Persistence tests cover command replay/reuse, stale
rollback, Project isolation, restart/reopen, migration backup/checksum drift and append-only triggers.

The daemon integration scenario establishes a local session, proves CSRF/Origin/correlation-ID rejection, registers
a fixture Project, creates and replays a WorkItem command, updates and moves it, restarts the daemon on the same
database, and reloads version 3 of the WorkItem with its four ordered Events.

## 3. Security and privacy evidence

- mutation authorization requires session + exact Origin + `application/json` + timing-safe CSRF comparison;
- bootstrap, cookie and CSRF headers are redacted from structured logs;
- a canary test proves bootstrap, cookie, authorization and CSRF values do not enter structured log output;
- unknown server errors log only correlation ID and error class, not database paths or payloads;
- fixture HTTP input never includes an arbitrary repository path, and both the Project directory and manifest
  realpaths are checked against symlink escape;
- persistence tests write only synthetic data to explicit temporary directories containing spaces/non-ASCII;
- no provider, shell, Git, worktree, repository scan or browser-driver capability exists.

## 4. Visual acceptance

- reviewed the running Command Center at 1440 px in explicit light and dark themes;
- reviewed the dark theme at a 390 px mobile viewport;
- compared the production toolbar, applied filters, icon buttons and display settings against the measured Linear
  interaction geometry without copying Linear assets or branding;
- browser coverage verifies theme persistence, keyboard focus return, popup dismissal, desktop/mobile filter flows,
  selected-task inspector consistency and absence of horizontal overflow;
- theme controls, status surfaces and stacked mobile sections remained readable and aligned;
- no visible clipping, horizontal overflow or M2 copy regression was observed;
- review screenshots were temporary local artifacts and were not added to the repository.

## 5. Honest limitations and pending gate

- M2 local sessions remain process-local; durable revocation/recovery is scheduled with later Phase 0 recovery work;
- realtime Event delivery/WebSocket is M3; M2 Events are queried from committed SQLite state;
- fixture registration is the only Project onboarding mode;
- the current Workbench remains a synthetic M3 design fixture and is not yet backed by the WorkItem query/command API;
- unsupported Workbench commands are visibly disabled while fixture filters, selection, display settings and theme
  controls remain interactive for design review;
- `DONE` is intentionally unreachable until final human acceptance is implemented;
- Windows behavior is configured in CI but remains unverified until an intentionally reviewed commit/push.

## 6. Repository hygiene

- SQLite databases, backups, test output and application-data files remain ignored/outside Git;
- `pnpm test:public-readiness` scans the candidate Git tree for private artifacts, personal paths and common secret
  formats on every `pnpm verify` run;
- bundled fixtures contain only synthetic manifests and explanatory README files;
- no secret, `.env`, developer-machine path, raw transcript, screenshot or provider credential entered the tree;
- no commit or push was created.
