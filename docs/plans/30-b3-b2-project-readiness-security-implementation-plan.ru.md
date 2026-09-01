# B3 + B2 — план реализации Project Readiness

**Статус:** implementation complete; repo-wide gate awaits landing fix

**Дата:** 2026-08-30

**Спецификация:** [`29-b3-b2-project-readiness-security-spec.ru.md`](29-b3-b2-project-readiness-security-spec.ru.md)

## Шаг 1. Зафиксировать язык и wire contracts

- добавить Project Readiness Run, Readiness Check, Security Finding и Owner Attestation в domain context;
- описать строгие Zod schemas для catalog, snapshot, Events, commands/results и HTTP;
- покрыть closed enums, forbidden shapes и bounds contract tests.

**Gate:** contracts не знают filesystem/SQLite, а все wire states выражены без строковых соглашений.

## Шаг 2. Построить глубокий project-readiness module

- один bounded read-only entry point поверх зарегистрированного top-level Git repository;
- trusted argv для HEAD/status/tracked paths/ignore semantics с отключёнными hooks;
- allowlisted CI scan с byte/file bounds и symlink refusal;
- deterministic catalog assessment и source digest;
- fixtures для spaces/non-ASCII, secret canary, risky CI, symlink и oversize.

**Gate:** модуль различает pass/finding/unverifiable, не читает secret values и не запускает найденные команды.

## Шаг 3. Добавить domain transitions и SQLite

- pure decisions create assessment / attest owner check;
- migration 0016 для run/check/finding/attestation и новых Event types;
- transactional commands, receipts, optimistic versioning и snapshot query;
- idempotency, rollback, forbidden transition и reopen tests.

**Gate:** state + audit атомарны; latest Run и owner decisions переживают restart.

## Шаг 4. Соединить daemon boundary

- authenticated snapshot read и CSRF-protected run/attest mutations;
- repository path и active Constitution берутся только из state;
- typed readiness/domain errors мапятся без локальных paths/secret content;
- HTTP security integration для session/Origin/CSRF/project mismatch.

**Gate:** one action создаёт persisted assessment, duplicate command replay безопасен.

## Шаг 5. Сделать Project → Readiness UI

- aggregate state, Git snapshot metadata и category sections;
- findings/evidence без raw JSON;
- confirm/N/A + rationale для owner checks;
- query invalidation, live Event refresh, EN/RU;
- keyboard/focus, narrow dialog и light/dark states.

**Gate:** владелец без terminal понимает, что проверено автоматически, что требует решения и почему Run не READY.

## Шаг 6. Security и release gate

- добавить T25 и automated verification map;
- обновить decomposition checkpoint и статусы документов;
- narrow suites, `pnpm verify`, `pnpm audit --prod --audit-level high`, relevant E2E;
- browser review Project → Readiness в EN/RU, light/dark и keyboard.

**Gate:** B3+B2 отмечены complete, следующий checkpoint — C1. Commit/push выполняются только по отдельной команде
владельца.

## Фактическая верификация

- contracts: 7 files / 103 tests;
- domain: 8 files / 98 tests;
- project-readiness scanner: 1 file / 3 integration tests;
- persistence-sqlite: 4 files / 75 tests, включая restart/idempotency/stale transitions;
- daemon: 12 files / 153 tests в однопоточном режиме;
- web: 11 files / 63 tests;
- Playwright: 37/37, включая readiness + durable owner decision;
- browser QA: EN/RU, light/dark, 375 px, keyboard/scroll, empty/action-required/attested states, без console errors;
- `pnpm audit --prod --audit-level high`: известных уязвимостей нет;
- Prettier, public-tree, toolchain, readiness-owned ESLint/typecheck и `git diff --check`: зелёные.

Repo-wide `pnpm verify` пока не может стать зелёным из-за одной lint-ошибки в
`apps/landing/src/main.test.ts` последнего отдельного landing-коммита. Лендинг не входит в B3+B2 и по прямому
указанию владельца не трогался. После исправления в landing-контуре остаётся повторить общий gate; readiness-код
дополнительных исправлений не требует.
