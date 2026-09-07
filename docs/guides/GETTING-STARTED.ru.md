# Быстрый старт

> Публичная pre-alpha · [English version](GETTING-STARTED.md)

Этот маршрут подключает Loomrail к настоящему API провайдера и может расходовать quota. Используйте новый пустой
каталог и ключ с подходящим для оценки account-level spending limit.

## 1. Настройте одного провайдера

Задайте `OPENAI_API_KEY` или `ANTHROPIC_API_KEY` в том терминале, где будет запущен Loomrail. Ключ читается из
окружения процесса, передаётся только выбранному провайдеру и не сохраняется в базе Loomrail.

Затем выполните каноническую последовательность установки:

<!-- loomrail-guided-activation-v1:start -->

```bash
mkdir loomrail-evaluation
cd loomrail-evaluation
npm install --ignore-scripts loomrail@next
npx playwright install chromium
npx loomrail try
```

<!-- loomrail-guided-activation-v1:end -->

Сначала команда выполняет read-only preflight. Отсутствующий credential, некорректный override
`LOOMRAIL_PROVIDER`, отсутствующий Chromium или небезопасное обновление local state блокирует запуск без записи
данных. При готовности Loomrail показывает локальные side effects, привязывает daemon к `127.0.0.1` и открывает
одноразовый authenticated URL.

Для отдельного preflight используйте `npx loomrail setup --mode live`, для подробного отчёта —
`npx loomrail doctor`.

## 2. Создайте guided task

1. Нажмите **Подготовить demo workspace**.
2. В **Настройки → ИИ-провайдер** выберите **OpenAI Responses**, **Anthropic Messages** или оставьте **Авто**.
3. Создайте показанную задачу и переведите её в **Готово**.
4. Проверьте token budget и model tier, затем запустите workflow.
5. Ответьте на durable Human Request во **Внимании** и проверяйте каждое изменение бюджета до одобрения.
6. Изучите evidence провайдера перед решением владельца.

Текущие pre-alpha API adapters выполняют Discovery, Plan, Review и Acceptance. Implementation и QA завершаются
явной ошибкой unsupported stage до появления прошедшего security review локального workspace executor. Это
намеренная граница: ответ модели не доказывает изменение файлов или запуск тестов.

## 3. Остановка и продолжение

Не закрывайте launch terminal; для остановки нажмите `Ctrl+C`. Workflow state, requests, budgets и evidence хранятся
в локальной SQLite и переживают restart. Browser служит только каналом доставки и не является источником workflow
truth.

Запуск без автоматического открытия браузера:

```bash
npx loomrail try --no-open --port 4176
```

Откройте напечатанный URL на той же машине в течение 60 секунд. Remote access при этом не включается.

Перед подключением настоящего репозитория прочитайте [руководство владельца](USER-GUIDE.ru.md),
[совместимость API провайдеров](PROVIDER-COMPATIBILITY.ru.md), [Browser QA](BROWSER-QA.ru.md) и
[threat model](../security/THREAT-MODEL.md).
