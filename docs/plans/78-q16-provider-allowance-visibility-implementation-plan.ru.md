# Q16 — План реализации provider allowance visibility

**Дата:** 2026-09-04

**Статус:** implementation started

**Спецификация:**
[77-q16-provider-allowance-visibility-spec.ru.md](77-q16-provider-allowance-visibility-spec.ru.md)

## Q16.1 — Contract и deterministic projection

- [ ] Добавить strict normalized snapshot/bucket/unavailable schemas и provider advisory projection.
- [ ] Расширить capability contract `canReportRateLimits` и optional adapter read/session-update seams.
- [ ] Проверить bounds, freshness, reset, multi-bucket, spend-limit >100, label inversion и advisory-only behavior.

## Q16.2 — Provider bridges

- [ ] Добавить bounded Codex App Server JSON-RPC reader только для rate-limit read/update.
- [ ] Добавить ephemeral Claude status-data bridge без изменения user settings и без raw payload persistence.
- [ ] Привязать capability к exact verified target/auth mode; unsupported и drift должны fail closed.
- [ ] Добавить sanitized fixtures/negative corpus и process cleanup tests для POSIX/Windows path shapes.

## Q16.3 — Durable observation и API

- [ ] Добавить append-only migration для последнего normalized provider snapshot.
- [ ] Добавить idempotent command/event/query, stale-order rejection и restart freshness projection.
- [ ] Добавить authenticated read/refresh endpoints с Origin/CSRF, deadline и refresh coalescing.
- [ ] Доказать, что allowance не меняет budget, permissions, workflow, acceptance или существующий AgentRun.

## Q16.4 — Product surface

- [ ] Добавить общий Provider Allowance strip в Command Center и Task Cockpit отдельно от Hard budget.
- [ ] Добавить explicit remaining/window/reset/freshness/unavailable labels, RU/EN и refresh feedback.
- [ ] Добавить typed `PROVIDER_RATE_LIMITED` attention и видимый advisory scheduling hint без скрытого veto.
- [ ] Проверить keyboard, light/dark, narrow viewport, restart и stale UI через Playwright.

## Q16.5 — Exit

- [ ] Выполнить focused lint/typecheck/unit/integration/E2E и packaged release checks.
- [ ] Выполнить independent Standards/Spec review и исправить P0–P2.
- [ ] Зафиксировать macOS/Windows fixture CI evidence; Windows live-provider evidence оставить отдельным pending gate.
- [ ] Обновить T47, master plan и evidence; не менять `apps/landing/**` и не публиковать пакет.

## Module boundary

Provider-specific parsers и subprocess lifecycle остаются в adapters; `provider-core` владеет normalized interface и
pure advisory/freshness semantics; daemon владеет admission/persistence/API; web только отображает validated wire
projection. Ни один слой не получает права интерпретировать allowance как Loomrail budget.
