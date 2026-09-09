# Q20.9 — Acceptance structured-output compatibility: private-dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete

**Основание:** PD-020, PD-023, ADR-0017, ADR-0021, Threat Model T63/T70

## Outcome

Codex и Claude Code получают один provider-neutral Acceptance contract, который сохраняет exact binding к текущим
criteria/Review/QA checks, но не помещает недоверенные строки в provider-native JSON Schema literals.

## Архитектурная граница

- schema содержит только bounded zero-based references и свободные advisory explanation fields;
- ordered reference table находится в prompt как недоверенный контекст;
- `provider-core` разрешает refs по тому же immutable input и создаёт прежний domain claim;
- domain повторно проверяет total ordered coverage и current evidence membership;
- adapters владеют только native CLI schema transport/stream parsing;
- финальный `Accept | Return | Reject` остаётся исключительно человеческим решением.

## Реализация и проверки

1. Зафиксировать ADR-0021, PD-023 и T70 до изменения production-кода. **Done.**
2. RED: hostile exact values с кавычками, backslash и Unicode не должны попадать в JSON Schema; refs обязаны
   разрешаться обратно без изменения текста.
3. GREEN: заменить dynamic string enums на bounded indices, добавить deterministic prompt table и shared decoder.
4. Проверить out-of-range, reordered и duplicate criterion refs; проверить обе adapter schemas.
5. Собрать Loomrail и перезапустить daemon, не меняя текущий Recurkit tree.
6. Ответить на уже созданный operational HumanRequest только через обычный retry и получить настоящий
   AcceptancePackage на exact reviewed/verified/QA tree.
7. Продолжить зависимый Epic до owner Acceptance, затем выполнить полный `pnpm verify`, product E2E и release-package
   verification.

## Non-goals

Ослабление evidence vocabulary, строковый fallback по ошибке provider, synthetic package, automatic final
acceptance, прямой OpenAI/Anthropic API или изменение локальной CLI-auth границы.

## Дополнительный dogfood finding

Первый обычный ответ operational request был корректно отклонён существующим blanket guard для всей ACCEPTANCE
stage, хотя AcceptancePackage ещё не существовал. Q20.7 уточнён: dedicated acceptance route защищает только exact
HumanRequest уже созданного package; pre-package provider/runtime request использует обычный versioned answer/resume.
Domain и persistence получают exact package request identity, не анализируют title/context и не расширяют authority.
