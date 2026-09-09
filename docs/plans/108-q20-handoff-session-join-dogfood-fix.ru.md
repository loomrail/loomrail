# Q20.13 — Context-handoff session join: private-dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete with zero cross-session overlap

**Основание:** PD-026, ADR-0025, Threat Model T74

## Outcome

Context-handoff deadline не может открыть следующую ProviderSession, пока session task предыдущей не прошла MCP
lease drain и все принятые workspace calls не стали terminal.

## Реализация и проверки

1. Зафиксировать PD-026, ADR-0025, Q20 invariant и T74 до production-кода.
2. RED: forced handoff deadline завершает provider transport, но blocked MCP close удерживает первую durable session
   в `RUNNING` и не допускает вторую.
3. GREEN: создать один named session promise; после `abortSession` join-ить его до terminal state transition.
4. Уточнить test double: успешный `abortSession` обязан завершать его `start`, как production adapters.
5. Выполнить session-loop, gateway, cancellation и restart focused tests.
6. Перезапустить daemon только при нуле `STARTED` calls/running sessions.
7. Создать новый Recurkit WorkItem; отменённый Run с overlap не считать evidence.
8. Подтвердить отсутствие cross-session/cross-stage overlap, затем пройти verification/QA/Acceptance.

## Non-goals

Отмена owner-approved recipe только из-за context handoff, automatic replay, synthetic result, новый provider
protocol, ослабление deadline/output limits, live SMTP/deploy, commit/push Recurkit или Windows evidence.
