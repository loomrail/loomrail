# Быстрый старт

> Публичная pre-alpha · [English version](GETTING-STARTED.md)

Этот маршрут подключает Loomrail к официальному Codex CLI или Claude Code CLI, уже установленному и
авторизованному на вашей машине. Используется существующая подписочная сессия CLI; API-ключ Loomrail не нужен и не
принимается. Для оценки начните в новом пустом каталоге.

## 1. Войдите в один локальный агент

Установите официальный CLI и один раз войдите через него:

```bash
codex login
# или
claude auth login
```

Если CLI уже работает локально, больше ничего передавать Loomrail не нужно. Loomrail проверяет executable, точную
версию и статус входа, но не читает и не сохраняет credential подписочной сессии.

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

Сначала команда выполняет read-only preflight. Отсутствующий, несовместимый или неавторизованный CLI, некорректный
override `LOOMRAIL_PROVIDER`, отсутствующий Chromium или небезопасное обновление local state блокирует запуск без
записи данных. При готовности Loomrail показывает локальные side effects, привязывает daemon к `127.0.0.1` и
открывает одноразовый authenticated URL.

Для отдельного preflight используйте `npx loomrail setup --mode live`, для подробного отчёта —
`npx loomrail doctor`.

## 2. Создайте guided task

1. Нажмите **Подготовить demo workspace**.
2. В **Настройки → ИИ-провайдер** выберите **Codex CLI**, **Claude Code CLI** или оставьте **Авто**.
3. Создайте показанную задачу и переведите её в **Готово**.
4. Проверьте token budget и model tier, затем запустите workflow.
5. Ответьте на durable Human Request во **Внимании** и проверяйте каждое изменение бюджета до одобрения.
6. Изучите evidence провайдера перед решением владельца.

Оба локальных адаптера выполняют все шесть стадий, включая Implementation и QA. Они не получают путь репозитория и
не наследуют секреты проекта. Файлы и команды доступны только через ограниченные workspace tools Loomrail с явными
разрешениями, лимитами, audit-записями и измеримыми evidence. Текст модели сам по себе не доказывает изменение файла
или запуск теста.

Локальные CLI сообщают расход токенов после завершения сессии. Loomrail ограничивает время, число ходов, tools и
объём вывода и может заблокировать последующие сессии по durable ledger, но не обещает точную остановку внутри уже
идущей CLI-сессии на заданном числе токенов.

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
[совместимость локальных провайдеров](PROVIDER-COMPATIBILITY.ru.md), [Browser QA](BROWSER-QA.ru.md) и
[threat model](../security/THREAT-MODEL.md).
