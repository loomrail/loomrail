# B5 + B1 — план реализации онбординга существующего репозитория

**Статус:** complete

**Дата:** 2026-08-30

**Спецификация:** [`23-b5-b1-existing-repository-onboarding-spec.ru.md`](23-b5-b1-existing-repository-onboarding-spec.ru.md)

## Шаг 1. Зафиксировать язык и wire contracts

- добавить термины Repository Scan, Constitution Preset, Constitution Proposal, Project Constitution Version и
  Constitution Publication в domain context;
- добавить Zod schemas для catalog, scan/proposal/version/publication, Events, commands и HTTP;
- покрыть строгий parse, size/status union и forbidden shapes contract tests.

**Gate:** contracts package знает все состояния, но не читает filesystem и не знает SQLite.

## Шаг 2. Построить глубокий onboarding module

- создать `packages/project-constitution` с одним публичным scan/propose/render/publish contract;
- реализовать allowlisted bounded scanner без следования symlink;
- добавить versioned preset catalog и deterministic recommendation;
- рендерить стабильный Markdown с provenance и content digest;
- публиковать compare-and-set через same-directory temp file + rename.

**Gate:** generic/TypeScript/pnpm fixtures, non-ASCII/path-with-spaces, symlink, malformed, oversized и target-race
tests зелёные; ни одна discovered command не исполняется.

## Шаг 3. Добавить domain transitions и SQLite outbox

- pure decisions для propose/request/complete/fail/retry;
- migration 0015 с immutable proposal/version rows, publication outbox и расширенным Event CHECK;
- persistence commands/queries, optimistic versioning, command receipts и append-only audit;
- startup recovery query pending publications.

**Gate:** allowed/forbidden matrix, idempotency, stale version, atomic rollback, reopen и migration backup tests зелёные.

## Шаг 4. Соединить daemon boundary

- authenticated catalog/state reads и CSRF-protected scan/adopt/retry mutations;
- route берёт repository path только из Project и повторно валидирует root;
- publication drain запускается после adoption/retry и при startup;
- typed filesystem failures сохраняются как FAILED, не активируют версию и не скрывают старую.

**Gate:** HTTP integration закрывает T24, duplicate command, target race, session/Origin/CSRF и restart recovery.

## Шаг 5. Сделать owner review UI

- добавить Project Constitution в Settings → Projects;
- показать catalog/recommendation, proposal sections/sources/warnings и publication status;
- create/replace copy, explicit approval и retry;
- добавить query invalidation и i18n EN/RU;
- пройти keyboard, focus, light/dark и narrow dialog review.

**Gate:** owner может пройти scan → review → approve без terminal и отличает proposal от active version.

## Шаг 6. Security и release gate

- добавить T24 delta и automated verification map;
- обновить decomposition checkpoint и status документов;
- запустить narrow suites, `pnpm verify`, `pnpm audit --prod --audit-level high`;
- сделать Conventional Commit, push и проверить CI.

**Gate:** main синхронизирован, CI зелёный, B5+B1 отмечены завершёнными; следующий checkpoint — B3+B2.

## Verification

- `pnpm verify` — pass;
- `pnpm audit --prod --audit-level high` — no known vulnerabilities;
- `pnpm test:e2e` — 36/36 pass;
- landing — EN/RU, light/dark, keyboard command palette, copy states и responsive 320–1280 px проверены в браузере;
- автоматизированные security checks покрывают T24, publication CAS, restart recovery, auth, Origin и CSRF.
