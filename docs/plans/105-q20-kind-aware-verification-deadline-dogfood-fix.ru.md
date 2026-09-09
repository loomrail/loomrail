# Q20.10 — Kind-aware Project Verification deadline: private-dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete

**Основание:** QD-003, ADR-0022, Threat Model T48/T71

## Outcome

Полный owner-approved Recurkit E2E получает достаточно времени для честного measured result, не обходя runner и не
ослабляя общий deadline contract.

## Архитектурная граница

- scanner выбирает default только по закрытому allowlisted recipe kind;
- `E2E` получает 900 секунд, остальные известные kinds сохраняют 300;
- exact timeout остаётся частью proposal hash, owner preview, Plan revision и runner policy;
- schema ceiling 900 секунд, cancellation, output limits и process-tree supervision не меняются;
- repository text не задаёт timeout и не интерпретируется как инструкция.

## Реализация и проверки

1. RED: scanner test одновременно ожидает unit=300 и E2E=900.
2. GREEN: добавить один kind-aware default в глубокий scanner contract.
3. Обновить Q17 spec, QD-003, ADR-0022 и T71 до production-кода.
4. Выполнить focused scanner/publisher/runner tests и build.
5. Перезапустить daemon, получить новый proposal и принять его только owner-versioned route.
6. Создать новый Recurkit WorkItem на текущем tree и не менять workspace во время Run.
7. Провести оба local providers, full Project Verification, Browser QA и owner Acceptance.
8. После dogfood выполнить полный Loomrail verify/E2E/release-package gate.

## Non-goals

Unlimited timeout, анализ script body, repository-controlled timeout override, shell command string, скрытый retry,
synthetic pass, прямой provider API, Windows evidence или live SMTP/deploy.

## Dogfood correction

Revision 5 с 600 секундами была честно остановлена по deadline при concurrent host load и не создала evidence.
Финальная proposal использует существующий contract maximum 900; Task 5 отменён также из-за T72 overlap и не
считается доказательством.
