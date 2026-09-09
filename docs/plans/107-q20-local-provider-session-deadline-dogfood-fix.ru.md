# Q20.12 — Local provider session deadline: private-dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete

**Основание:** PD-025, ADR-0024, Threat Model T73

## Outcome

Оба local CLI adapters получают один bounded session deadline, достаточный для одной максимально долгой
owner-approved verification recipe и доставки её результата provider.

## Архитектурная граница

- 900-секундный максимум recipe экспортирует contracts и продолжает владеть validation;
- provider-core добавляет фиксированный 300-секундный control-plane reserve и экспортирует 20-минутный session
  deadline;
- Codex/Claude adapters только применяют общий policy к supervised child process;
- executor deadline, output bounds, cancellation, T72 drain и отсутствие automatic replay не меняются;
- provider-specific plan parsing и unlimited timeout не появляются.

## Реализация и проверки

1. Зафиксировать PD-025, ADR-0024, Q20.1 invariant и T73 до production-кода.
2. RED: contracts принимают exact maximum и отклоняют maximum + 1; provider-core связывает session limit с recipe
   maximum и reserve.
3. GREEN: экспортировать constants, удалить adapter-local deadlines, применить общий policy в обоих adapters.
4. Выполнить focused contracts/provider-core/provider tests и build.
5. Убедиться, что нет живых provider/tool processes, затем перезапустить daemon.
6. Ответить на уже открытый typed HumanRequest и продолжить тот же IMPLEMENT StageAttempt с checkpoint.
7. Получить terminal E2E result внутри сессии, исправить Recurkit только через audited executor и пройти следующий
   workflow без `STARTED` calls между stages.
8. Завершить Project Verification, Browser QA, Acceptance и полный Loomrail release gate.

## Non-goals

Unlimited provider session, сумма всех возможных recipes как один deadline, ослабление Plan/executor authority,
скрытый retry, synthetic evidence, direct provider API, live SMTP/deploy, commit/push Recurkit или Windows evidence.
