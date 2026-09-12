# Token efficiency — план реализации

**Дата:** 2026-09-12

**Статус:** implementation verified; actual efficiency target not demonstrated

**Baseline:** `12bb55548c9fb550cdf0db1bbf7b177abd1822be`; public Stable 0.1.1 Recurkit dogfood.

## Граница

Все шесть стадий, independent Review, Project verification, measured Browser QA, human Acceptance,
permissions, append-only usage/audit и explicit recovery остаются обязательными. Quick workflow не вводится.
Local Codex/Claude subscription CLI остаётся единственным production transport; POST_SESSION не становится
обещанием точного in-flight token cap. Новый механизм описывает ADR-0033; TD-003/PD-008 уже разрешают artifact handoff.

## Порядок

- [x] Изучить product authority, планы 07/86/91/109/122–123, ADR-0010/0015/0021/0026 и threat model.
- [x] Сверить baseline с read-only aggregate queries к исходному локальному ledger без raw payloads.
- [x] Устранить повторную сериализацию tool results, дать stage-specific инструкции и bounded context caps.
- [x] Передавать latest successful Discovery/Plan checkpoint следующему этапу; сохранить fresh Review.
- [x] Исключить optional audit activity, стабилизировать инструкции и сохранить все обязательные Decisions.
- [x] Показать cached/uncached breakdown и честное предупреждение до старта.
- [x] Создать детерминированный old/new benchmark, отдельно обозначить byte estimates и actual provider usage.
- [x] Unit/integration/restart/security/E2E, полный verify и fault injection.
- [x] Один bounded local Codex dogfood после локальных проверок; sanitized evidence с честным HARD_PAUSED outcome.
- [x] Подготовить ветку и sanitized evidence к разрешённому commit/push после зелёных локальных проверок.

## Измерение и acceptance

По каждому этапу: reports, input/output/cached/raw, uncached = input - cached + output (unknown cache остаётся unknown).
Byte/4 — оценка только assembled text; provider hidden prefix, tool-turn replay, output и cache заранее неизвестны.
Benchmark использует один и тот же fixture и старый renderer из baseline. Он не доказывает реальную cache экономию.
Целевые actual reductions: uncached >=50%, raw >=40%. Недостижение или несопоставимость фиксируются явно.

Никакие migrations в shared history не редактируются. Restart восстанавливает context из durable entities,
не переносит provider transcript, не возобновляет side effects автоматически. Обязательные данные не обрезаются:
переполнение по байтам даёт durable CONTEXT_FLOOR_EXCEEDED; превышение 200 sources даёт typed
CONTEXT_SOURCE_LIMIT_EXCEEDED и durable owner gate до provider dispatch.

## Фактический результат

[Evidence](../evidence/phase-8/TOKEN-EFFICIENCY-EVIDENCE.md) разделяет public baseline, детерминированные байты
и реальный incomplete dogfood. Модель повторной передачи стала меньше на 43,77%, полный Loomrail prompt — на 24,14%.
Один production pipeline дошёл до независимого Review и HARD_PAUSED перед QA: 151 891 tokens в Review против
неизменённого AgentRun cap 150 000. Project verification, Browser QA и Acceptance в нём не выполнены.
Повышения budget, второго pipeline, direct API и synthetic success не было. Restart сохранил pause и usage.

Цели actual uncached −50% / raw −40% **не доказаны**. Точные прогнозы неизвестного provider output/cache невозможны
в текущем terminal-only CLI контракте; статистическая калибровка и контролируемое same-project сравнение остаются
следующим шагом. Полные Review findings и measured evidence намеренно не заменены потерянными или недоказанными summary.

Дополнительный разрешённый run и release проходят по [плану 125](125-token-efficiency-release-implementation-plan.ru.md).
Он завершил все provider stages, independent Review, четыре Project checks и шесть Browser QA executions;
финальное human Acceptance остаётся явным действием владельца. Actual comparative token targets не объявляются
достигнутыми на основании другого проекта.
