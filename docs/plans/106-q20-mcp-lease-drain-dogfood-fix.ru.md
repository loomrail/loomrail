# Q20.11 — MCP lease drain: private-dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete

**Основание:** PD-024, ADR-0014, ADR-0023, Threat Model T58/T72

## Outcome

ProviderSession и StageAttempt не завершаются, пока хотя бы один принятый workspace tool call сохраняет локальную
process/filesystem authority.

## Реализация и проверки

1. Зафиксировать PD-024, ADR-0023, Q20 invariant и T72 до production-кода.
2. RED: deferred direct MCP call удерживает `lease.close()`; новый call после close не исполняется.
3. GREEN: binding хранит только promises и closing flag, без arguments/results/payload persistence.
4. Добавить session-loop integration: schema-valid provider completion не закрывает stage до tool settlement.
5. Проверить owner cancellation, gateway shutdown и external MCP regression.
6. Дождаться остановки уже запущенного invalid dogfood recipe и отменить его Run без Acceptance.
7. Собрать/перезапустить daemon и запустить новый Recurkit WorkItem на неизменяемом tree.
8. Подтвердить отсутствие `STARTED` calls при каждом следующем stage, затем полный Verification/Browser QA/Acceptance.

## Non-goals

Новый tool protocol, ослабление recipe deadline, socket-level replay, automatic retry, provider-specific lifecycle в
domain, live SMTP/deploy, commit/push Recurkit или Windows evidence.
