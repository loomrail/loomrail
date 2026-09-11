# Совместимость локальных провайдеров

> Public Beta для macOS Apple Silicon · [English version](PROVIDER-COMPATIBILITY.md)

Loomrail запускает один из двух официальных локальных агентов: Codex CLI или Claude Code CLI. Выбираемого
синтетического провайдера, прямого provider API, настройки API-ключа и успешного fallback нет.

## Текущая матрица

Живое выполнение Public Beta проверено только на `darwin/arm64`: Codex CLI `0.153.4` и Claude Code CLI `2.1.260`.
Windows и Linux rows не проверены, поэтому provider dispatch на них fail closed.

| Выбор в UI      | Внутренний ID | Чей login   | Обязательная безопасная поверхность              | Стадии    |
| --------------- | ------------- | ----------- | ------------------------------------------------ | --------- |
| Codex CLI       | `CODEX`       | Codex CLI   | ephemeral exec, read-only scratch, Loomrail MCP  | Все шесть |
| Claude Code CLI | `CLAUDE_CODE` | Claude Code | restricted mode, strict allowlisted Loomrail MCP | Все шесть |

Внутренние ID сохранены ради durable workflow history. Provider-specific аргументы команд и stream payload остаются
внутри адаптеров. Workflow state, permissions, gates, budgets и acceptance принадлежат доменной модели, а не CLI.

## Установка, вход и проверка

Установите официальный CLI по документации провайдера, затем войдите через этот CLI:

```bash
codex login
# или
claude auth login
npx loomrail doctor
```

Уже работающего локального входа достаточно. Loomrail не просит `OPENAI_API_KEY` или `ANTHROPIC_API_KEY`, не читает
сохранённый OAuth/session credential и не создаёт отдельные API-списания. Doctor сообщает только факт установки,
нормализованную версию, совместимость и состояние authenticated/not-authenticated.

В **Настройки → ИИ-провайдер** выберите провайдера или оставьте **Авто**. Авто выбирает только локально
установленный, совместимый по точной версии и авторизованный CLI для нужной стадии. `LOOMRAIL_PROVIDER=CODEX` или
`LOOMRAIL_PROVIDER=CLAUDE_CODE` фиксирует выбор процесса, но не обходит проверку версии, входа, workspace permissions
или budgets.

## Граница workspace и бюджета

CLI запускается в новом пустом scratch-каталоге и не получает путь репозитория, provider API key, `.env` или
произвольное окружение проекта. Выбранный workspace доступен только через одноразовые loopback MCP tools поверх
provider-neutral executor Loomrail. Каждая операция ограничена workspace, проверена по permissions, bounded,
аудируема и идемпотентна.

Официальные CLI сообщают usage после сессии, а не предоставляют точное token-прерывание. Поэтому оба адаптера
объявляют `POST_SESSION`: Loomrail жёстко ограничивает время, число ходов, tools, command output и provider output,
после завершения сверяет реальный usage с durable ledger и при необходимости блокирует следующую работу. Текущий
CLI-ход может превысить token estimate; UI говорит об этом прямо и не изображает несуществующий hard token cap.

## Статус evidence

Потоки адаптеров, безопасные аргументы, фильтрация окружения, abort, schema validation, разрешённые и запрещённые
workspace-операции, idempotency, restart recovery, selection и persistence покрыты test-only CLI fixtures и
локальными integration tests. Автоматические тесты не вызывают платный API. Для непроверенной комбинации
OS/версии совместимость остаётся fail-closed. Windows source, browser и clean-install CI зелёный, но это не
live-provider evidence и не расширяет Public Beta support claim.

Исторические API- и старые CLI-матрицы сохранены в датированных планах и evidence как audit record. Они не описывают
активную runtime-границу.
