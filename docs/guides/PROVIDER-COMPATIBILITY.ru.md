# Совместимость API провайдеров

> Публичная pre-alpha · [English version](PROVIDER-COMPATIBILITY.md)

В Loomrail есть два runtime-адаптера: OpenAI Responses и Anthropic Messages. Выбираемого синтетического провайдера и
успешного fallback нет. Если не задан ни один API credential, новая работа провайдера блокируется.

## Текущая матрица

| Выбор в UI         | Внутренний ID | Credential          | API             | Доступные стадии                    |
| ------------------ | ------------- | ------------------- | --------------- | ----------------------------------- |
| OpenAI Responses   | `CODEX`       | `OPENAI_API_KEY`    | `/v1/responses` | Discovery, Plan, Review, Acceptance |
| Anthropic Messages | `CLAUDE_CODE` | `ANTHROPIC_API_KEY` | `/v1/messages`  | Discovery, Plan, Review, Acceptance |

Внутренние ID сохранены ради совместимости с durable workflow history. Они не означают, что Loomrail запускает CLI.
Оба активных адаптера обращаются к HTTPS API и передают provider-native ограничение output tokens.

`IMPLEMENT` и `QA` намеренно недоступны. Для них нужен прошедший security review локальный workspace executor,
который создаёт измеримое evidence изменений файлов и запуска команд. Текст провайдера не считается доказательством
того, что файл изменён или тест выполнен.

## Настройка и проверка

Задайте один ключ в окружении того же процесса, из которого запускается Loomrail:

```bash
export OPENAI_API_KEY="..."
# или
export ANTHROPIC_API_KEY="..."
npx loomrail doctor
```

В PowerShell задайте `$env:OPENAI_API_KEY` или `$env:ANTHROPIC_API_KEY`. Loomrail показывает только готовность
credential и никогда не печатает и не сохраняет ключ. В **Настройки → ИИ-провайдер** выберите провайдера явно или
оставьте **Авто**. Авто выбирает только готовый адаптер, который поддерживает нужную стадию и жёсткий token budget.

`LOOMRAIL_PROVIDER=CODEX` или `LOOMRAIL_PROVIDER=CLAUDE_CODE` фиксирует выбор на уровне процесса. Некорректное значение
или отсутствующий credential блокирует работу и не перенаправляет её к другому провайдеру.

## Статус evidence

Protocol parsing, построение token cap, abort, response validation, selection, persistence и restart-пути покрыты
тестами с инъекцией сетевого транспорта и локальными integration tests. Платные вызовы они не делают. Credentialed
fixed-commit проверки на macOS и Windows остаются release gates со статусом pending до отдельного разрешения владельца
на расход quota.

Устаревшие таблицы CLI-совместимости сохранены в исторических планах и evidence как audit record. Они не описывают
текущий runtime.
