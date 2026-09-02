# Q3 — План реализации criterion-bound Acceptance Package и export

**Дата:** 2026-09-02

**Статус:** implementation complete; shared release gate pending

**Спецификация:**
[51-q3-criterion-bound-acceptance-export-spec.ru.md](51-q3-criterion-bound-acceptance-export-spec.ru.md)

## 1. Порядок работы

### Q3.1 — Contracts и чистый domain

- [x] Добавить bounded `AcceptanceCriterionClaim` в `READY_FOR_ACCEPTANCE` provider contract.
- [x] Расширить criterion evidence selected Review/QA checks и owner verification с legacy-read compatibility.
- [x] Реализовать один pure builder полного ordered mapping и exact check membership.
- [x] Запретить новый AcceptancePackage без criteria или с неполным/stale/unrelated evidence.
- [x] Обновить mock/live adapter structured schemas и fixtures без передачи authority IDs провайдером.

### Q3.2 — Persistence и совместимость

- [x] Сохранять новые fields внутри существующего bounded `criteria_json` без новой mutable authority table.
- [x] Доказать чтение pre-Q3 package/Events/command receipts с отсутствующими additive fields.
- [x] Доказать restart, idempotency и отсутствие state change при invalid mapping.

### Q3.3 — ReleaseSummary read model и daemon route

- [x] Реализовать pure escaped Markdown renderer с stable order и 512 KiB ceiling.
- [x] Собрать exact WorkItem/package/artifact/QA/Decision/Event snapshot без storage keys и paths.
- [x] Прочитать полный audit page-by-page до 1000 Events и fail closed при overflow.
- [x] Добавить authenticated exact-correlation GET route с private/no-store, nosniff и portable attachment filename.
- [x] Покрыть stable byte identity, PENDING/resolved status и bounded concurrent-version re-read.

### Q3.4 — Task Cockpit

- [x] Показать implementation, selected Review/QA checks, owner verification и known risk per criterion.
- [x] Явно маркировать legacy unbound rows.
- [x] Добавить download action без mutation/token/path authority.
- [x] Добавить RU/EN, light/dark, keyboard и 320 px states.

## 2. Security gate

- [x] Обновить threat model одновременно с executable export route.
- [x] Проверить IDOR/correlation, unauthenticated access и отсутствие CSRF-требования для read-only GET.
- [x] Проверить Markdown/HTML/filename injection и allowlisted export fields.
- [x] Проверить no storage key/absolute path/session/provider-transcript leakage.
- [x] Проверить event/byte bounds и complete-or-error semantics.

## 3. Verification gate

- [x] Unit: total mapping, check membership, legacy compatibility, escaping и deterministic renderer.
- [x] Persistence: valid/invalid package, restart, idempotency и historical payloads.
- [x] Daemon: auth/correlation/headers/content/overflow и bounded consistency re-read.
- [x] Browser: full Q2 path → bound matrix → download; legacy/responsive/localized states.
- [x] Full non-landing lint/typecheck/unit/E2E, production audit и clean-install tarball.
- [ ] Полный `pnpm verify` и macOS/Windows CI; publish остаётся запрещён до общего release gate.

Локальный Q3 gate: full build/typecheck/unit зелёный, browser E2E `52/52`, production audit без уязвимостей и
`0.1.0-alpha.5` tarball проходит clean install. `pnpm verify` и новый CI остаются общим gate: предшествующий run
33643071539 доказал macOS/Windows browser и clean-install, но оба Verify останавливаются на трёх lint-ошибках
параллельно разрабатываемого `apps/landing/src/main.ts`. Q3 этот каталог не меняет.

## 4. Release boundary

Q3 закрывает Phase 7 acceptance/export deliverables, но сам по себе не объявляет Loomrail stable. После Q3 нужен
private dogfood exit-gate run по полному checklist Master Plan, включая multi-provider roles, restart recovery, budget,
human acceptance и сохранённый export. npm publish запрещён до прохождения этого общего gate.
