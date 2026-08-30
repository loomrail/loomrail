# Loomrail domain context

Этот файл фиксирует короткий ubiquitous language map. Нормативные продуктовые решения остаются в
[`PRODUCT-DECISIONS.ru.md`](../product/PRODUCT-DECISIONS.ru.md), а полная модель — в
[`MASTER-PLAN.ru.md`](../product/MASTER-PLAN.ru.md).

## Work orchestration

**WorkItem**:
Задача пользователя с brief, критериями, work state и текущей workflow stage.
_Не означает_: чат или provider session.

**PipelineRun**:
Один запуск конкретной версии WorkflowTemplate для одного WorkItem.
_Не означает_: отдельный агент.

**StageAttempt**:
Повторяемая попытка одной workflow stage внутри PipelineRun.
_Не означает_: колонка Kanban или work state.

**WorkflowDispatch**:
Durable намерение запустить или возобновить StageAttempt.
_Не означает_: уже выполненный provider turn.

**HumanRequest**:
First-class запрос внимания с типом ответа, контекстом, последствиями и blocking semantics.
_Не означает_: модалка, уведомление или канал передачи секретов.

**Decision**:
Неизменяемая запись принятого человеком ответа на HumanRequest.
_Не означает_: свободный комментарий без workflow effect.

**Attention Inbox**:
Проекция открытых HumanRequest, требующих внимания человека.
_Не означает_: отдельный источник истины.

**ProviderAdapter**:
Capability-checked граница start/resume/interrupt/events/usage для конкретного provider.
_Не означает_: прямая shell-интеграция из браузера.

## Project rules

**Repository Scan**:
Ограниченное наблюдение известных файлов и структуры зарегистрированного репозитория.
_Не означает_: инструкции, разрешение исполнить найденную команду или полный индекс исходного кода.

**Constitution Preset**:
Встроенный versioned baseline доверенных Loomrail guardrails.
_Не означает_: boilerplate, installer или автоматическая смена стека проекта.

**Constitution Proposal**:
Неизменяемый draft Project Constitution с provenance, warnings и snapshot конкретного Repository Scan.
_Не означает_: активные правила Project.

**Project Constitution Version**:
Неизменяемая версия правил Project, явно утверждённая владельцем.
_Не означает_: найденный `AGENTS.md`, provider output или Constitution Proposal.

**Constitution Publication**:
Durable compare-and-set запись утверждённой версии в `.loomrail/constitution.md`.
_Не означает_: Git commit, push или самостоятельное approval сканером.

## M6 relationship

```text
WorkItem
  └── PipelineRun
        ├── StageAttempt
        │     └── WorkflowDispatch
        ├── EvidenceArtifact (Review / QA)
        ├── AcceptancePackage
        └── HumanRequest
              └── Decision
```

Blocking HumanRequest переводит только связанный WorkItem в `BLOCKED` и StageAttempt в `WAITING_HUMAN`.
`Answer & resume` атомарно сохраняет Decision, закрывает HumanRequest и создаёт resume WorkflowDispatch. Независимые
WorkItem не меняются. Обычный first-attempt путь PipelineRun допускает не более одного provider-authored owner gate:
после первого HumanRequest последующие ProviderInvocation, включая автоматически следующие стадии, получают
`humanRequests: DISALLOWED`. Явный retry (`StageAttempt.attempt > 1`) получает один новый gate. Operational
fail-closed request не продвигает стадию и не считается ответом провайдера.

Acceptance — отдельный owner gate: обычный ответ на HumanRequest и generic pipeline controls его не обходят. Только
versioned `Accept`, `Return to work` или `Reject` закрывают AcceptancePackage; лишь `Accept` переводит WorkItem в
`DONE`. Review/QA evidence остаётся append-only, AcceptancePackage меняется только optimistic-versioned transition.
