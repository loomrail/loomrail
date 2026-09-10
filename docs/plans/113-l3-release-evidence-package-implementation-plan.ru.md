# L3 — план реализации Release evidence package

**Дата:** 2026-09-10

**Статус:** Complete on macOS; Windows verification pending

**Спецификация:** [112-l3-release-evidence-package-spec.ru.md](112-l3-release-evidence-package-spec.ru.md)

## Порядок

1. Добавить closed contracts и domain tests для Environment, immutable Release, gates, freshness и renderer.
2. Реализовать deterministic L3 domain module без filesystem/SQLite/provider imports.
3. Добавить migration, transactional commands/queries, idempotency, immutable triggers и restart tests.
4. Добавить authenticated daemon API с current-tree capture/recheck и без network/deploy authority.
5. Добавить Project Settings UI и bounded Markdown export.
6. Покрыть allowed/forbidden sources, cross-boundary mixing, Unicode/spaces/Windows redaction и secret canaries.
7. Добавить browser E2E и production-shaped Recurkit dogfood.
8. Выполнить focused suites, `pnpm verify`, fault injection, release pack/install и CI.
9. Зафиксировать sanitized evidence; commit/push по действующей команде владельца.

## Exit gate

Release фиксирует exact owner-selected evidence на одном Project/tree, не может быть изменён после записи, честно
показывает отсутствующие/failed/stale gates и экспортируется без path/secret/provider leakage. Ни один L3 endpoint не
исполняет команду и не обращается во внешнюю сеть.

## Dogfood finding

Первое открытие durable Recurkit state новым L3 build честно остановилось на `MIGRATION_DRIFT`: owner-approved
pre-release build применил migration 56 с дополнительным завершающим LF до появления файла в shared history.
Вместо удаления базы или общего whitespace bypass добавлен один exact checksum-pair (historical/current); имя,
версия и оба SHA-256 закреплены, ledger не переписывается, любой иной drift остаётся отказом. Тот же matcher
использует read-only doctor. Regression tests покрывают разрешённую пару и произвольный запрещённый checksum.

Первый production HTTP create на реальной Recurkit history выявил второй fail-closed случай: persistence передавал
домену все исторические correction-артефакты PipelineRun, а AcceptancePackage ссылался только на финальную пару.
Domain теперь выбирает evidence строго по `AcceptancePackage.artifactIds`, игнорирует superseded history и отдельно
отказывает, если названный артефакт отсутствует или пересекает Project/WorkItem/PipelineRun boundary. Unit regression
фиксирует оба исхода.

Финальный architecture review закрыл ещё один fail-open до commit: каждый readiness gate теперь сравнивает
`repositoryHead` Run с Release tree и сохраняет tree в evidence reference. Чистый, но старый readiness Run получает
`STALE`, а не `PASSED`; regression test сначала воспроизвёл прежний результат.

## Результат

L3 реализован вертикально: contracts, deterministic domain, migration 0059, transactional SQLite commands/events/
receipts, authenticated daemon API, Project Launch UI, bounded Markdown export, restart/immutability/security tests и
browser E2E. Production-shaped вызов через собранный daemon создал immutable Release для трёх принятых Recurkit
WorkItems на текущем tree. Снимок остался `CURRENT`, но честно показал `0/24`: 20 gates требуют evidence и четыре
workflow gates устарели относительно текущего tree. Это подтверждает механизм и одновременно блокирует утверждение
Recurkit как production-ready.

Sanitized IDs, counts, export digest и ограничения зафиксированы в
[`L3-RELEASE-EVIDENCE-PACKAGE-RECURKIT.md`](../evidence/phase-8/L3-RELEASE-EVIDENCE-PACKAGE-RECURKIT.md).
L3 не обращался к public origin, не читал secrets, не запускал provider, deploy или paid API. Windows остаётся
отдельным blocking platform gate первого публичного релиза.

Финальный macOS candidate прошёл `pnpm verify` (37 Node checks и 1,797 Vitest tests), 64 Playwright E2E,
fault-injection, production dependency audit без известных уязвимостей и receipt-backed release pack/clean-install.
`pnpm release:status` остаётся 9/11 ровно из-за двух отложенных Windows provider rows.
