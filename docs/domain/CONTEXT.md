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

**AgentProfile**:
Versioned постоянная роль с mission, policy defaults, permission profile, model tier, budget envelope и role
playbook.
_Не означает_: живой процесс, provider account или право расширить Project policy.

**SquadAssignment**:
Неизменяемое назначение точных ревизий AgentProfile на executable stages одного approved PipelineRun.
_Не означает_: групповой чат, весь доступный roster или автоматическое расширение scope.

**AgentRun**:
Один непрерывный запуск immutable AgentProfile revision на StageAttempt; canonical единица concurrency и
проверяемого результата. Хранит hash immutable policy snapshot (assignment/profile/provider/effective policy),
а точный состав provider input принадлежит ContextPackRecipe каждой ProviderSession. Resume после owner gate
создаёт следующий ordinal; одновременно активен максимум один.
_Не означает_: ProviderSession, worker promise или повтор stage.

**ProviderSession**:
Один provider-native запуск внутри AgentRun; handoff создаёт следующую session того же run.
_Не означает_: workflow state, роль или отдельный concurrency slot.

**Scheduler Plan**:
Bounded deterministic выбор pending WorkflowDispatch, которые можно попытаться зарезервировать сейчас, с
machine-readable причинами отсрочки.
_Не означает_: durable claim, permission grant или право запустить provider process до SQLite transaction.

**HumanRequest**:
First-class запрос внимания с типом ответа, контекстом, последствиями и blocking semantics.
_Не означает_: модалка, уведомление или канал передачи секретов.

**Decision**:
Неизменяемая запись принятого человеком ответа на HumanRequest.
_Не означает_: свободный комментарий без workflow effect.

**Attention Inbox**:
Глобальная bounded-проекция открытых HumanRequest и их Project/WorkItem/current StageAttempt. Один deterministic
module проверяет связи, классифицирует action/category и сортирует максимум 200 items; `hasMore` сообщает о хвосте.
_Не означает_: отдельный источник истины, копию workflow state или право обойти acceptance gate.

**ProviderAdapter**:
Capability-checked граница start/resume/interrupt/events/usage для конкретного provider.
_Не означает_: прямая shell-интеграция из браузера.

**Provider Preference**:
Versioned выбор Project: `AUTO`, конкретный live provider либо явный `MOCK` demo mode.
_Не означает_: provider уже запущенной ProviderSession или разрешение ослабить permission policy.

**Provider Availability**:
Короткоживущее локальное наблюдение, найден ли provider CLI и подтверждает ли его read-only status command
авторизацию.
_Не означает_: provider credential, account profile или durable domain state.

**Effective Provider**:
Provider, который resolver назначит следующей ProviderSession с учётом Project preference, текущей availability и
видимого environment override.
_Не означает_: автоматическую миграцию уже запущенной session.

**ReviewReport**:
Append-only результат одного независимого CODE_REVIEWER AgentRun над точным Git tree: проверенные свойства,
`PASSED | CHANGES_REQUESTED`, round и daemon-owned связь author/reviewer.
_Не означает_: сообщение автора «готово», raw transcript или разрешение перейти в QA без domain transition.

**ReviewFinding**:
Durable замечание одного ReviewReport с severity, portable location, reproduction и lifecycle
`OPEN -> RESOLVED | WAIVED | FALSE_POSITIVE`.
_Не означает_: право provider самому закрыть замечание или filesystem path, которому можно доверять как authority.

**Independent Review Loop**:
Последовательность IMPLEMENT(n) → fresh REVIEW(n), в которой первый failed review автоматически создаёт второй
IMPLEMENT, второй останавливается на HumanRequest, а владелец может разрешить ровно один финальный bounded round.
_Не означает_: continuation writer session, бесконечный retry или смену explicit Project provider preference.

**QARun**:
Durable измерение одного BrowserDriver над точным Git tree и выбранным QA scope; только оно владеет verdict
`PASSED | FAILED | ERROR`.
_Не означает_: provider-отчёт, workflow stage или бессрочное доказательство для изменившегося tree.

**QAEvidenceBundle**:
Append-only нормализованные executions, observations и ссылки на verified attachments одного measured QARun.
_Не означает_: raw browser log, абсолютный filesystem path или разрешение перейти в Acceptance без проверки lineage.

**QADefect**:
Durable воспроизводимая проблема, обнаруженная measured QARun, с lifecycle `OPEN -> RESOLVED | WAIVED`.
_Не означает_: ReviewFinding, driver error или право provider выбрать disposition.

**CorrectionRun**:
Один bounded цикл исправления после measured QA failure: fix, независимый review и scoped retest; имеет собственный
ordinal внутри PipelineRun и immutable source QA failure.
_Не означает_: AgentRun, StageAttempt, R1 review round или повтор environment после QARun ERROR.

**QARetestPlan**:
Неизменяемый детерминированно выведенный список target/scenario cells для одного CorrectionRun: все cells, связанные
с failure и OPEN Defects, плюс regression subset из исходного locked QA plan.
_Не означает_: новый provider-authored evaluator, полный cartesian baseline или разрешение исключить неудобный defect.

## MCP connections

**MCP Profile Proposal**:
Невыполняемый candidate точной локальной stdio-команды, показанный владельцу перед Consent.
_Не означает_: сохранённый profile, permission или право spawn.

**MCP Connection Profile Revision**:
Неизменяемая project-scoped ревизия exact stdio launch с canonical digest.
_Не означает_: ambient provider config, remote URL или автоматически установленный server.

**MCP Consent**:
Неизменяемое решение владельца, подтверждающее точный launch одной Profile Revision.
_Не означает_: разрешение любого tool или доверие server output.

**MCP Capability Snapshot**:
Ограниченное наблюдение protocol version и surface конкретного consented server.
_Не означает_: permission policy или автоматически принятые новые capabilities.

**MCP Grant**:
Versioned разрешение Project на закрытый набор tool names одной consented Profile Revision.
_Не означает_: доказательство read-only semantics или permission bypass.

**MCP Session Snapshot**:
Неизменяемая копия revision digest и Grant, назначенная одной ProviderSession.
_Не означает_: lookup текущих Project Settings во время уже запущенной session.

**MCP Tool Call Record**:
Redacted audit попытки вызвать один granted tool с typed outcome и input digest.
_Не означает_: raw payload, provider transcript или workflow state.

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

**Project Readiness Run**:
Versioned снимок одной проверки готовности Project, привязанный к наблюдаемому состоянию repository.
_Не означает_: бессрочную гарантию безопасности или production readiness.

**Readiness Check**:
Один пункт закрытого catalog с категорией, способом проверки, состоянием и evidence.
_Не означает_: свободный совет provider или автоматически выполненную repository command.

**Security Finding**:
Локально наблюдаемый факт риска с кодом, severity и безопасной ссылкой на относительный path.
_Не означает_: содержимое секрета, полный security audit или доказанную эксплуатацию.

**Owner Attestation**:
Неизменяемое versioned решение владельца `Confirmed` либо обоснованное `Not applicable` для owner check.
_Не означает_: автоматический вывод сканера, юридическую консультацию или канал передачи секретов.

## Project scaffolding

**Scaffold Recipe**:
Встроенный immutable набор файлов и проектных defaults с собственными id и version.
_Не означает_: удалённый template, package installer или выполняемый repository instruction.

**Scaffold Proposal**:
Невыполняемый preview точного target, Recipe version, файлов и canonical digest перед решением владельца.
_Не означает_: созданный каталог, зарегистрированный Project или разрешение изменить похожий proposal.

**Scaffold Operation**:
Durable одноразовое намерение опубликовать один подтверждённый Scaffold Proposal.
_Не означает_: повторяемый generator, право перезаписать target или Git commit/push.

**Scaffold Publication**:
Fail-closed создание файлов в эксклюзивно захваченном ранее не существовавшем target с recovery по marker.
_Не означает_: атомарный filesystem transaction, rollback через удаление каталога или успешную регистрацию Project.

## M6 relationship

```text
WorkItem
  └── PipelineRun
        ├── SquadAssignment
        ├── StageAttempt
        │     ├── WorkflowDispatch
        │     └── AgentRun
        │           └── ProviderSession
        ├── ReviewReport
        │     └── ReviewFinding
        ├── QARun
        │     ├── QAEvidenceBundle
        │     └── QADefect
        ├── CorrectionRun
        │     └── QARetestPlan
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

Review также имеет отдельную доменную развилку. Fresh CODE_REVIEWER AgentRun не совпадает с latest successful
DEVELOPER AgentRun; AUTO предпочитает другой ready provider, explicit preference остаётся lock. Reviewer получает
stable tree, implementation handoff и OPEN findings, но не checkpoint/transcript автора. Первый
`CHANGES_REQUESTED` создаёт IMPLEMENT(2), второй — HumanRequest; owner-authorized IMPLEMENT/REVIEW(3) является
последним. `WAIVED` и `FALSE_POSITIVE` требуют HUMAN actor, reason и expected version и сами по себе не подменяют
повторный review.

Attention Inbox читает все Project одной локальной session, но state не меняет. `ANSWER_REQUEST` использует тот же
атомарный `Answer & resume`; `REVIEW_ACCEPTANCE` только открывает exact Project/WorkItem в Task Cockpit. Project name,
WorkItem title и HumanRequest text остаются untrusted data и не участвуют в machine-readable классификации.

Scheduler сортирует только bounded machine-readable candidates. Фактическое право занять global/project/provider
slot и exclusive WorkItem claim появляется лишь у durable AgentRun после повторной проверки в transaction;
существующий workspace lease берётся там же, а первый workspace записывается leased до provider spawn. Handoff
внутри run concurrency не увеличивает.
