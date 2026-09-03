# Q12 — План реализации Private Insights и diagnostic reporting

**Дата:** 2026-09-03

**Статус:** закрыт; implementation и macOS/Windows gate завершены

**Спецификация:** [69-q12-private-insights-and-reporting-spec.ru.md](69-q12-private-insights-and-reporting-spec.ru.md)

## 1. Порядок работы

### Q12.1 — Closed reporting contract

- [x] Добавить strict local metrics, runtime и public report schemas в contracts.
- [x] Реализовать deterministic reporting module и negative privacy tests в domain.
- [x] Зафиксировать public-alpha transport decision в ADR-0009 и threat T46.

### Q12.2 — Coherent local facts and daemon read

- [x] Добавить один aggregate SQLite read без rows/IDs/text на выходе.
- [x] Покрыть empty/populated/recovery state и migration compatibility.
- [x] Добавить authenticated `GET /api/v1/insights` и runtime categorization.

### Q12.3 — Insights UI and one-shot opt-in

- [x] Добавить route/navigation/query для Insights.
- [x] Показать local-only metrics, exact aggregate/crash previews и privacy exclusions.
- [x] Скачать bytes из exact preview object без второго fetch или background transport.
- [x] Покрыть serializer, translations и browser path.

### Q12.4 — Verification

- [x] Прогнать focused tests, build, typecheck, format и landing-excluded lint.
- [x] Прогнать full test/release/browser gates без изменения `apps/landing/**`.
- [x] Прогнать named `test:reporting` на macOS/Windows, записать evidence и обновить Phase 8 status.

## 2. Module interface

Внешний interface domain-модуля — одна pure функция `buildReportingSnapshot(input)`. SQL adapter отвечает только за
coherent numeric facts, daemon — за platform/version injection и authenticated delivery, web — за presentation и
owner-initiated serialization. Privacy allowlist не копируется между слоями.

## 3. Release boundary

Q12 закрывает Phase 8 opt-in reporting для public alpha без background collection. Он не разрешает remote telemetry,
stable claim или npm publish; security review, private dogfood, exact live row, registry provenance и protected
landing gate остаются отдельными.
