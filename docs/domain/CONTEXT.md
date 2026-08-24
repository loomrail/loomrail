# Loomrail domain context

Этот файл фиксирует короткий ubiquitous language map. Нормативные продуктовые решения остаются в
[`PRODUCT-DECISIONS.ru.md`](../product/PRODUCT-DECISIONS.ru.md), а полная модель — в
[`MASTER-PLAN.ru.md`](../product/MASTER-PLAN.ru.md).

| Термин           | Значение                                                                                   | Не означает                                      |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| WorkItem         | Задача пользователя с brief, критериями, work state и текущей workflow stage               | Чат или provider session                         |
| PipelineRun      | Один запуск конкретной версии WorkflowTemplate для одного WorkItem                         | Отдельный агент                                  |
| StageAttempt     | Повторяемая попытка одной workflow stage внутри PipelineRun                                | Колонка Kanban или work state                    |
| WorkflowDispatch | Durable намерение запустить или возобновить StageAttempt                                   | Уже выполненный provider turn                    |
| HumanRequest     | First-class запрос внимания с типом ответа, контекстом, последствиями и blocking semantics | Модалка, уведомление или канал передачи секретов |
| Decision         | Неизменяемая запись принятого человеком ответа на HumanRequest                             | Свободный комментарий без workflow effect        |
| Attention Inbox  | Проекция открытых HumanRequest, требующих внимания человека                                | Отдельный источник истины                        |
| ProviderAdapter  | Capability-checked граница start/resume/interrupt/events/usage для конкретного provider    | Прямая shell-интеграция из браузера              |

## M4 relationship

```text
WorkItem
  └── PipelineRun
        ├── StageAttempt
        │     └── WorkflowDispatch
        └── HumanRequest
              └── Decision
```

Blocking HumanRequest переводит только связанный WorkItem в `BLOCKED` и StageAttempt в `WAITING_HUMAN`.
`Answer & resume` атомарно сохраняет Decision, закрывает HumanRequest и создаёт resume WorkflowDispatch. Независимые
WorkItem не меняются.
