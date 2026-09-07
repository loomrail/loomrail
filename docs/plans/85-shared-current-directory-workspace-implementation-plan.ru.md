# Shared current-directory workspace — план реализации

**Спецификация:** [`84-shared-current-directory-workspace-spec.ru.md`](84-shared-current-directory-workspace-spec.ru.md)

**Метод:** test-first по трём публичным швам: strategy selection, workspace/authority, Settings/Cockpit.

## Constraints

- isolated worktree остаётся default и не меняет поведение;
- применённые миграции не редактируются; новая миграция `0053`;
- domain не читает filesystem/SQLite;
- provider output не выбирает strategy;
- `apps/landing/**` не изменяется;
- commit/push только после полного narrow + `pnpm verify` и отдельной проверки чужих локальных коммитов.

## Task 1 — Versioned Project Workspace Strategy

- [x] contracts: schema, GET/PUT boundary, command/result/event;
- [x] domain: deterministic CAS decision;
- [x] persistence: default read, durable selection, Event и restart/idempotency tests;
- [x] daemon: authenticated GET/PUT with CSRF/Origin.

## Task 2 — Fact on WorkItemWorkspace and migration

- [x] `WorkItemWorkspace.strategy` and published projection;
- [x] migration `0053` adds strategy defaulting existing rows to isolated;
- [x] migration widens Event vocabulary and adds project strategy table;
- [x] migration/restart tests preserve pre-0053 state exactly.

## Task 3 — Shared provisioning

- [x] test: shared repository gets no new branch/worktree/ref and current directory is recorded;
- [x] test: carry-in baseline includes dirty tracked/untracked paths without changing real index/tree;
- [x] test: detached HEAD and in-progress operation fail before provider start;
- [x] implementation chooses one deep strategy branch inside workspace preparation.

## Task 4 — Project-scoped authority

- [x] red tests across two shared WorkItems for writer and verification claims;
- [x] atomic guarded claims plus partial unique storage backstop;
- [x] read-only provider stages receive workspace without writer claim;
- [x] restart releases only proven-dead authority;
- [x] isolated workspaces remain independently claimable.

## Task 5 — Owner-facing UI

- [x] Project Settings selector with explicit shared-mode confirmation and warning;
- [x] Task Cockpit shows Mode and Working directory for shared;
- [x] carried path count/list is visible from workspace-created activity;
- [x] keyboard, visible focus, EN/RU, light/dark tests.

## Task 6 — Verification and dogfood

- [x] narrow package/integration tests green;
- [x] `pnpm verify` green without landing changes;
- [x] private dogfood Project switched explicitly to shared mode;
- [x] exact repository observation proves pre-existing tracked/untracked changes were preserved;
- [x] Q17 revision 2 measured lint/build/test passes on the exact shared tree;
- [ ] daemon restart/recovery, cross-provider review and Browser QA complete;
- [ ] live-provider continuation waits on Q18 hard token-budget capability; no further provider session may start
      under POST_SESSION enforcement;
- [ ] final Acceptance remains owner-only.
