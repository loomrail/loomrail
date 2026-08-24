# Loomrail Phase 0 — implementation plan

**Дата:** 2026-08-22
**Статус:** approved; M2 locally complete, Windows CI evidence pending
**Phase outcome:** безопасный mocked vertical slice локальной control plane
**Нормативные входы:**

- [Master plan](../product/MASTER-PLAN.ru.md)
- [Approved product decisions](../product/PRODUCT-DECISIONS.ru.md)

План не разбит на календарные sprint. Работа идёт последовательными проверяемыми milestones. Следующий milestone
начинается после evidence предыдущего, а не после условной даты.

**Current execution:** M2 contracts, deterministic WorkItem decisions, SQLite state/events, fixture registration and
authenticated command/query HTTP slice are complete on macOS. The same build, tests, SQLite portability check and
browser smoke are wired as blocking macOS/Windows CI. Windows evidence remains pending until the intentionally
reviewed first commit/push; this is not treated as a passed gate.

## 1. Цель Phase 0

Новый contributor должен суметь клонировать repository, запустить Loomrail на macOS или Windows и увидеть, как
полностью локальная mocked Task:

1. появляется на Kanban;
2. запускает декларативный workflow;
3. останавливается на Human Request;
4. продолжает работу после ответа;
5. hard-pauses на тестовом budget limit;
6. восстанавливается после restart daemon;
7. доходит до human acceptance;
8. оставляет читаемый event/audit trail.

Phase 0 проверяет boundaries, contracts, persistence, realtime и основную UX-модель. Она намеренно не запускает
Codex, Claude, shell, Git mutations или browser automation.

## 2. Scope

### 2.1. Обязательные результаты

- TypeScript strict/pnpm monorepo;
- минимальный CLI для запуска daemon + web;
- loopback-only local daemon;
- SQLite schema, migrations, backup hook и append-only events;
- регистрация нескольких fixture projects;
- versioned contracts для WorkItem, workflow, agents, HumanRequest, budget и events;
- deterministic workflow engine;
- mock provider adapter;
- HTTP command/query API и resumable WebSocket event stream;
- Command Center, Kanban и Task Cockpit foundations;
- equal light/dark themes;
- simulated Human Request, pause/resume, budget stop и acceptance;
- restart/recovery integration scenario;
- unit, integration и browser smoke tests;
- macOS/Windows CI;
- contributor setup, architecture overview и threat-model outline.

### 2.2. Явные non-goals

- реальные Codex/Claude processes или API;
- provider authentication;
- shell execution, PTY и arbitrary commands;
- Git branch/worktree/write operations;
- product Playwright BrowserDriver и browser QA agents;
- repository scanner и запись `.loomrail/`;
- Environment Setup Center и реальные secrets;
- plugin SDK/marketplace;
- remote/LAN access;
- cloud/team sync, RBAC и multi-user editing;
- GitHub/Jira/YouTrack sync;
- desktop shell, tray, installers и auto-update;
- polished final design system или mobile UI;
- production telemetry.

## 3. Архитектурные invariants

1. UI не получает filesystem, database, shell или provider access.
2. Domain state изменяется только command handler/state machine, не прямым SQL из route/UI.
3. State mutation и audit Event записываются одной SQLite transaction.
4. WebSocket доставляет уже committed Events и не является source of truth.
5. Mock provider использует тот же public adapter contract, который позднее реализуют Codex и Claude.
6. Runtime timer не является единственным носителем workflow progress; restart не теряет queued work.
7. Provider payload не становится domain model и не протекает в UI.
8. Human Request и budget stop — durable state, а не transient modal/toast.
9. Final `DONE` недоступен без recorded human acceptance.
10. Никакой fixture не выполняет произвольный command и не читает содержимое пользовательского repository.
11. Light/dark используют semantic tokens, а не две разрозненные таблицы цветов в components.
12. Platform-specific process/path logic не попадает в domain packages.

## 4. Предлагаемая структура repository

```text
apps/
  cli/                         # local entrypoint; starts and opens Loomrail
  daemon/                      # loopback HTTP/WS composition root
  web/                         # React/Vite product UI

packages/
  contracts/                   # versioned wire schemas and generated TS types
  domain/                      # entities, commands, invariants, state machines
  persistence-sqlite/          # schema, migrations, repositories, transaction boundary
  workflow-engine/             # deterministic orchestration and durable dispatch
  provider-core/               # provider capability and lifecycle port
  provider-mock/               # deterministic fixture adapter
  ui/                          # tokens and reusable accessible primitives
  testkit/                     # builders, fake clock, fixture DB/project helpers

fixtures/
  projects/
    web-app-a/
    api-service-b/
  workflows/
    standard-feature.yaml
    budget-stop.yaml

docs/
  adr/
  architecture/
  plans/
  product/
  security/
```

Не создавать package только ради будущей архитектуры. Указанная граница сохраняется, если package имеет собственный
public contract и независимые tests; иначе код начинает жизнь модулем внутри ближайшего package.

## 5. Toolchain baseline

Точные версии pin'ятся в первом implementation milestone после проверки актуального Node.js LTS и библиотек.
Нормативное направление:

- Node.js active LTS, одинаковая major version локально и в CI;
- pnpm с pinned `packageManager`;
- TypeScript strict без `any` в public contracts;
- Vite + React для web;
- schema-first runtime validation для HTTP/events/config;
- SQLite driver с проверенной macOS/Windows установкой;
- Vitest для unit/integration;
- Playwright только как repository browser smoke runner — не как продуктовый QA adapter;
- ESLint + Prettier и единые root configs;
- changesets/release automation не подключать до появления публикуемых packages.

До выбора SQLite driver выполняется короткий cross-platform spike. Критерии: prebuilt binaries или native-free
install, transactions, WAL, backup API, migrations, Node LTS compatibility и отсутствие обязательного Python/C++
toolchain на чистой Windows machine.

## 6. Domain contracts Phase 0

Все ID — opaque branded strings. Wire format использует ISO-8601 UTC timestamps, explicit enums и `schemaVersion`.
Unknown enum/version не интерпретируется молча.

### 6.1. Workspace и Project

```text
Workspace
  id, name, createdAt, updatedAt

Project
  id, workspaceId, name, repositoryPath, status
  createdAt, updatedAt
```

В Phase 0 `repositoryPath` указывает только на bundled fixture directory. Daemon проверяет canonical path и не читает
файлы проекта кроме безопасного fixture manifest.

### 6.2. WorkItem

```text
WorkItem
  id, projectId, parentId?
  type: EPIC | FEATURE | TASK | BUG | SPIKE | SUBTASK
  title, description
  state: BACKLOG | READY | IN_PROGRESS | BLOCKED | DONE | CANCELLED
  currentStage?
  priority, risk
  acceptanceCriteria[]
  budgetPolicyId?
  version
  createdAt, updatedAt
```

Rules:

- parent/child cycle запрещён;
- leaf-only execution;
- `DONE` требует resolved final acceptance;
- `CANCELLED` terminal, возврат создаёт явную command/event;
- optimistic concurrency использует `version`;
- существенное изменение acceptance criteria увеличивает revision и помечает downstream artifacts stale.

### 6.3. Workflow execution

```text
WorkflowTemplate
  id, version, name, stages[], transitions[], gates[]

PipelineRun
  id, workItemId, workflowTemplateId, workflowVersion
  status, currentStageAttemptId?, policySnapshotId

StageAttempt
  id, pipelineRunId, stage, attempt
  status: PENDING | QUEUED | RUNNING | WAITING_HUMAN | HARD_PAUSED
          | SUCCEEDED | FAILED | CANCELLED | INTERRUPTED | STALE
  startedAt?, finishedAt?, failureCode?
```

Phase 0 default stages: `DISCOVERY`, `PLAN`, `IMPLEMENT`, `REVIEW`, `QA`, `ACCEPTANCE`.

### 6.4. Agent contracts

```text
AgentProfile
  id, name, role, provider, modelPolicy, permissionProfile, budgetPolicyId

AgentRun
  id, stageAttemptId, agentProfileId
  provider: MOCK
  status, inputArtifactIds[], outputArtifactIds[]
  usageSummary, startedAt?, finishedAt?

ProviderSession
  id, agentRunId, provider, externalSessionId?, capabilitiesSnapshot
```

Mock capabilities должны проходить тем же runtime validation, что будущие реальные adapters.

### 6.5. HumanRequest и Decision

```text
HumanRequest
  id, workItemId, stageAttemptId?
  kind: SINGLE_CHOICE | MULTIPLE_CHOICE | CONFIRMATION | FREE_TEXT
  blocking, title, context, recommendation?
  options[], allowOther
  status: OPEN | RESOLVED | EXPIRED | CANCELLED
  createdAt, resolvedAt?

Decision
  id, humanRequestId, answer, actor, reason?, createdAt
```

Answer command проверяет актуальный request version, допускает ровно одно resolution и атомарно создаёт Decision,
Event и следующий durable workflow dispatch.

### 6.6. Budget и usage

```text
BudgetPolicy
  id, maxEstimatedTokens?, maxWallTimeMs?, maxRuns?, maxAttempts?
  warningThresholds: [0.5, 0.8, 0.95]

UsageRecord
  id, agentRunId, kind, amount, quality: ACTUAL | PROVIDER_ESTIMATE | LOOMRAIL_ESTIMATE
```

Mock adapter детерминированно генерирует usage, чтобы budget scenario воспроизводился без внешнего provider.

### 6.7. Event envelope

```text
Event
  sequence             # монотонный DB cursor
  id                   # globally unique
  schemaVersion
  type
  aggregateType
  aggregateId
  actor
  correlationId
  causationId?
  occurredAt
  payload
```

Минимальные события:

```text
ProjectRegistered
WorkItemCreated | WorkItemUpdated | WorkItemStateChanged
PipelineStarted | StageQueued | StageStarted | StageSucceeded | StageInterrupted
AgentRunStarted | AgentRunUsageRecorded | AgentRunFinished
HumanRequestOpened | HumanRequestResolved
BudgetWarningRaised | BudgetLimitReached | BudgetOverrideApproved
WorkflowPaused | WorkflowResumed
AcceptanceRequested | WorkItemAccepted
RecoveryCompleted
```

## 7. State machine и command model

### 7.1. Commands Phase 0

```text
RegisterFixtureProject
CreateWorkItem
UpdateWorkItem
MoveWorkItem
StartPipeline
PausePipeline
ResumePipeline
AnswerHumanRequest
ApproveBudgetOverride
AcceptWorkItem
CancelPipeline
RecoverInterruptedRun
```

Каждый command содержит `commandId`, `actor`, `expectedVersion?` и correlation metadata. Повтор command с тем же ID
возвращает прежний результат и не создаёт duplicate Event.

### 7.2. Default flow

```text
READY
  -> DISCOVERY/RUNNING
  -> DISCOVERY/WAITING_HUMAN
  -> PLAN/SUCCEEDED
  -> IMPLEMENT/RUNNING
  -> IMPLEMENT/HARD_PAUSED       # budget fixture
  -> IMPLEMENT/SUCCEEDED
  -> REVIEW/SUCCEEDED
  -> QA/SUCCEEDED                # simulated evidence only
  -> ACCEPTANCE/WAITING_HUMAN
  -> DONE
```

Mock stages не используют случайные delays. Fake clock/explicit tick делает тесты воспроизводимыми. Production-like
demo mode может визуально задерживать события, но durable state не зависит от browser timer.

### 7.3. Pause semantics Phase 0

- `PausePipeline` запрещает новый dispatch после текущей mock operation;
- `ResumePipeline` создаёт отдельное Event и возобновляет только eligible stage;
- `BudgetLimitReached` переводит stage в `HARD_PAUSED`;
- `ApproveBudgetOverride` создаёт новую budget revision, а не переписывает старый limit;
- restart в `RUNNING` переводит run в `INTERRUPTED`; продолжение требует command.

## 8. Persistence model

Минимальные tables:

```text
schema_migrations
workspaces
projects
work_items
work_item_acceptance_criteria
workflow_templates
pipeline_runs
stage_attempts
agent_profiles
agent_runs
provider_sessions
human_requests
decisions
budget_policies
usage_records
events
commands
dispatch_queue
app_sessions
```

Обязательные свойства:

- foreign keys включены;
- WAL mode и busy timeout настроены явно;
- migration выполняется до открытия HTTP listener;
- DB path находится в platform app-data directory, не в repository;
- перед non-empty migration создаётся timestamped backup;
- `events.sequence` используется для WebSocket replay;
- `commands.command_id` обеспечивает idempotency;
- `dispatch_queue` обрабатывается через lease/attempt metadata;
- tests используют отдельную temporary DB, а не production path.

Полное event sourcing не используется: relational tables — current truth, Events — audit/realtime/reconciliation.

## 9. Local API и realtime

### 9.1. Session/security endpoints

```text
GET  /health/live
GET  /health/ready
POST /api/session/exchange
POST /api/session/logout
```

CLI создаёт одноразовый короткоживущий bootstrap token, запускает daemon и открывает browser URL. UI обменивает token
на `HttpOnly`, `SameSite=Strict` session cookie. Token нельзя использовать повторно и нельзя писать в logs/history.

### 9.2. Query endpoints

```text
GET /api/v1/command-center
GET /api/v1/projects
GET /api/v1/projects/:projectId/board
GET /api/v1/work-items/:workItemId
GET /api/v1/work-items/:workItemId/activity
GET /api/v1/human-requests?status=open
GET /api/v1/runs?status=active
```

### 9.3. Command endpoints

```text
POST /api/v1/projects/fixtures/register
POST /api/v1/work-items
POST /api/v1/work-items/:id/move
POST /api/v1/work-items/:id/pipeline/start
POST /api/v1/pipelines/:id/pause
POST /api/v1/pipelines/:id/resume
POST /api/v1/human-requests/:id/answer
POST /api/v1/pipelines/:id/budget-override
POST /api/v1/work-items/:id/accept
```

Commands возвращают accepted domain result, но UI обновляет activity через committed Events. Ошибки имеют стабильный
machine code, human message, correlation ID и optional field errors.

### 9.4. WebSocket

```text
GET /api/v1/events?after=<sequence>   # authenticated WebSocket upgrade
```

- client хранит последний applied sequence;
- reconnect запрашивает replay после cursor;
- gap приводит к query refetch, а не молчаливой потере state;
- heartbeat не создаёт domain Event;
- slow consumer отключается с объяснимым close code;
- payload проходит тот же schema validation, что HTTP contracts.

## 10. UI vertical slice

### 10.1. App shell

- project switcher;
- navigation: Command Center, Board, Attention, Runs, Settings placeholder;
- global connection/recovery indicator;
- theme switch: Light, Dark, System;
- keyboard-visible focus и skip navigation;
- semantic status tokens с icon/text fallback.

### 10.2. Command Center

- Needs attention;
- active mocked runs и queue;
- blocked/at-risk work items;
- budget summary;
- recently completed/failed;
- `New task`, `Pause`, `Resume` actions.

Не создавать набор декоративных KPI cards: каждый блок должен вести к task/action.

### 10.3. Kanban

Columns: Backlog, Ready, In Progress, Blocked, Done, Cancelled. Phase 0 допускает buttons/menu вместо drag-and-drop,
если keyboard alternative и domain transition понятнее. Card показывает WorkItem type, current stage, attention,
active role/provider и budget state.

### 10.4. Task Cockpit

Phase 0 tabs:

- Overview — description, criteria, state, budget;
- Workflow — stage rail и attempts;
- Runs — mock run/session data;
- Activity — normalized event timeline;
- Review/QA/Changes — честные empty/placeholder states до следующих phases.

Context panel показывает active Human Request и Pause/Resume/Accept actions. Raw mock payload не является основным UI.

### 10.5. Attention Inbox

- open blocking/informational requests;
- single/multi/confirmation/text controls;
- `Other`;
- recommendation и affected task;
- atomic `Answer & resume`;
- resolved request visible in Task Activity.

### 10.6. Theme foundation

Минимальные token groups:

```text
color.canvas/surface/elevated/inset
color.text.primary/secondary/muted/inverse
color.border.subtle/default/focus
color.accent
color.status.running/queued/waiting/paused/success/warning/danger/stale
space, radius, typography, shadow, motion
```

Light/dark screenshots входят в review evidence. Никакой screen/component не использует raw status color без
semantic token.

## 11. Mock provider и fixtures

`provider-mock` поддерживает capability discovery, start, resume, interrupt, event stream и usage reporting. Каждый
scenario задаётся fixture, а не hard-coded ветками UI:

### Scenario A — human question

Discovery создаёт single-choice Human Request с recommendation и `Other`. Только ответ продолжает workflow.

### Scenario B — budget stop

Implementation генерирует usage до 50/80/95% warnings и затем до 100%. Stage hard-pauses. Budget override продолжает
тот же PipelineRun новой attempt/revision.

### Scenario C — daemon restart

Workflow останавливается в `WAITING_HUMAN`, daemon завершается и запускается снова. UI восстанавливает board/request,
ответ продолжает flow. Отдельный test завершает daemon в `RUNNING` и ожидает `INTERRUPTED` + recovery action.

### Scenario D — final acceptance

Review и QA создают simulated typed artifacts. Acceptance показывает criterion/evidence matrix. Только human `Accept`
переводит WorkItem в Done.

## 12. Security/threat delta Phase 0

До реализации создаётся `docs/security/THREAT-MODEL.md` минимум со следующими assets и threats:

- local repository paths and metadata;
- browser session and bootstrap token;
- SQLite/events/artifacts;
- untrusted WorkItem/Markdown content;
- malicious website requests to localhost;
- CSRF, WebSocket hijacking и origin confusion;
- stored/reflected XSS в titles/descriptions/events;
- path traversal при fixture registration;
- denial of service через event flood/oversized payload;
- accidental public Git history.

Required controls:

- loopback bind + startup assertion;
- exact allowed origins, CSRF protection и SameSite session;
- one-time bootstrap token hashed at rest and short TTL;
- CSP и безопасный Markdown renderer без raw HTML;
- request/body/event size limits;
- runtime schema validation;
- canonical path containment для fixtures;
- secret/path redaction в errors/logs;
- no arbitrary process execution;
- dependency lockfile и automated vulnerability scan;
- tests, доказывающие отсутствие unauthenticated HTTP/WS access.

Phase 0 не заявляет repository/worktree sandbox, потому что такого runtime ещё нет.

## 13. Ordered implementation milestones

### M0 — Technical decisions and repository contract

**Работа:**

1. проверить current Node LTS, pnpm и выбранные library versions по primary docs;
2. выполнить SQLite driver spike на macOS/Windows CI;
3. принять ADR: monorepo boundaries;
4. принять ADR: relational state + append-only events;
5. принять ADR: loopback bootstrap session;
6. создать threat-model outline;
7. зафиксировать root coding/testing conventions.

**Evidence:** ADRs merged locally, clean dependency install на macOS/Windows, SQLite smoke test без внешнего toolchain.

### M1 — Toolchain and walking skeleton

**Работа:**

1. создать pnpm workspace и root scripts;
2. поднять `apps/daemon`, `apps/web`, `apps/cli`;
3. добавить health endpoints;
4. CLI запускает daemon, ждёт readiness и открывает browser;
5. web показывает authenticated connection status;
6. добавить lint, format, typecheck, unit test и build commands.

**Evidence:** один documented command запускает local app; unauthenticated health policy явна; production build
собирается на macOS/Windows.

### M2 — Contracts, domain and persistence

**Работа:**

1. реализовать runtime schemas и versioned event envelope;
2. реализовать WorkItem/state invariants;
3. добавить SQLite migrations/repositories/transaction unit;
4. command idempotency и optimistic concurrency;
5. Project fixture registration;
6. CRUD/query для WorkItem;
7. persist Event той же transaction.

**Evidence:** state transition table покрыта tests; duplicate command не создаёт duplicate state/event; DB повторно
открывается после process restart.

### M3 — First UI slice: project -> board -> task

**Работа:**

1. добавить session exchange и authenticated API client;
2. вывести project switcher и Board;
3. реализовать create/move WorkItem через commands;
4. добавить Task Cockpit Overview/Activity;
5. подключить WebSocket replay/reconnect;
6. реализовать semantic tokens и light/dark/system themes.

**Evidence:** две fixture projects изолированы; card update приходит realtime; refresh/reconnect не дублирует event;
light/dark browser screenshots и keyboard smoke review пройдены.

### M4 — Mock workflow and Human Request

**Работа:**

1. реализовать WorkflowTemplate validation;
2. добавить PipelineRun/StageAttempt state machine;
3. реализовать durable dispatch queue;
4. подключить provider-core и provider-mock;
5. запустить Scenario A;
6. реализовать Attention Inbox и Answer & resume;
7. вывести Workflow/Runs в Task Cockpit.

**Evidence:** Task останавливается только на durable request; повторный answer отклоняется; независимая fixture Task
продолжает выполнение.

### M5 — Budgets, pause and recovery

**Работа:**

1. добавить usage records и threshold events;
2. реализовать Scenario B и hard budget pause;
3. добавить Pause/Resume/Cancel commands;
4. реализовать startup reconciliation;
5. добавить Scenario C для WAITING_HUMAN и RUNNING;
6. сформировать recovery report/event;
7. добавить local DB backup hook перед migration.

**Evidence:** 50/80/95/100 thresholds срабатывают один раз; budget нельзя обойти повтором command; restart сохраняет
queue/request и переводит orphan RUNNING в Interrupted.

### M6 — Acceptance vertical slice

**Работа:**

1. добавить typed mock Review/QA artifacts;
2. собрать минимальную acceptance matrix;
3. реализовать final Human Request/Accept command;
4. запретить direct transition в Done;
5. завершить Scenario D;
6. добавить Command Center summaries.

**Evidence:** полный mocked flow доходит до Done только после человека; Activity связывает command, runs, request,
usage, artifacts и acceptance одним correlation chain.

### M7 — Cross-platform hardening and contributor handoff

**Работа:**

1. GitHub Actions macOS/Windows matrix;
2. unit, integration, migration, security и browser smoke suites;
3. paths with spaces/non-ASCII fixture;
4. forced restart test;
5. install/start docs и architecture diagram;
6. privacy/retention/backup notes;
7. public-history secret/path scan;
8. clean-room contributor walkthrough.

**Evidence:** CI green на macOS/Windows; новый checkout проходит README; no P0/P1 issue; exit checklist заполнен
с командами и artifacts.

## 14. Test and evaluation matrix

| Layer            | Required coverage                                                     |
| ---------------- | --------------------------------------------------------------------- |
| Contract         | valid/invalid payload, schema version, unknown enum, size limits      |
| Domain           | every allowed/forbidden WorkItem and StageAttempt transition          |
| Persistence      | transaction rollback, FK, migration, backup, reopen, concurrency      |
| Commands         | idempotency, expected version conflict, actor/correlation propagation |
| Workflow         | question, independent task, budget stop, pause/resume, acceptance     |
| Recovery         | restart in waiting, restart in running, duplicate dispatch prevention |
| API security     | auth, CSRF, origin, WebSocket session, expired bootstrap token        |
| Realtime         | replay cursor, reconnect, gap/refetch, ordering, slow consumer        |
| UI               | light/dark, keyboard flow, empty/error/reconnecting/stale states      |
| Cross-platform   | Windows paths, spaces, non-ASCII, process shutdown, app-data path     |
| Public readiness | secret/path scan, license headers where required, clean install       |

Numeric coverage target не заменяет transition/eval matrix. Для domain state machines требуется явный test на каждый
transition и invariant.

## 15. CI contract

Pull request checks после появления кода:

```text
format:check
lint
typecheck
test:unit
test:integration
build
test:browser-smoke
test:security-smoke
```

Matrix:

- Windows latest + pinned Node LTS;
- macOS latest + pinned Node LTS;
- optional Ubuntu lane для contributor feedback, не блокирующий первый milestone до стабилизации.

CI не получает production secrets. Fixture data synthetic. Browser artifacts публикуются только при failure и не
содержат local paths/tokens.

## 16. Developer commands contract

Целевые команды, которые должны появиться к M7:

```text
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm verify
```

`pnpm dev` запускает daemon/web с предсказуемым shutdown. `pnpm verify` повторяет обязательный локальный набор CI без
неожиданных network или secret requirements.

## 17. Migration, recovery and rollback

- migration files immutable после попадания в общую историю;
- migration runner использует schema version lock;
- backup создаётся до изменения non-empty DB;
- при migration failure daemon не открывает command API и показывает recovery instruction;
- rollback приложения не обещает down-migration: поддерживается восстановление backup;
- fixture DB можно reset отдельной exact command, пользовательская DB — никогда автоматически;
- UI/web version mismatch блокирует mutations и предлагает reload;
- Event schema reader поддерживает только явно заявленный compatibility range.

## 18. Observability Phase 0

Локальные structured logs содержат timestamp, level, component, event/command correlation ID и safe error code.
Запрещены bootstrap token, session cookie, raw request body и абсолютный user path без redaction. UI показывает:

- daemon connection/reconnecting;
- queue/run state;
- recovery report;
- last safe error + correlation ID;
- actual/estimated mock usage distinction.

Telemetry отсутствует.

## 19. Documentation deliverables

К выходу Phase 0:

- root README с install/run/demo flow;
- CONTRIBUTING с commands и PR verification;
- architecture overview;
- ADR index и первые три ADR;
- threat model;
- API/event contract overview;
- mocked demo walkthrough;
- backup/recovery notes;
- macOS/Windows troubleshooting;
- English canonical docs plan до public launch.

Документация не содержит personal paths, private repository names, raw transcripts или реальные secrets.

## 20. Exit gate

Phase 0 закрыта только если одновременно выполнено:

- [ ] clean clone устанавливается по README на macOS и Windows;
- [ ] один command поднимает daemon и web;
- [ ] daemon доступен только через loopback и authenticated session;
- [ ] две fixture projects отображаются раздельно;
- [ ] mocked WorkItem проходит default workflow;
- [ ] blocking Human Request виден в Inbox и Task Cockpit;
- [ ] ответ возобновляет только нужный workflow;
- [ ] budget warnings и hard stop воспроизводимы;
- [ ] restart в waiting state не теряет данные;
- [ ] restart в running state создаёт Interrupted/recovery flow;
- [ ] WebSocket reconnect не теряет и не дублирует events;
- [ ] Done невозможен без human acceptance;
- [ ] light и dark темы проходят contrast/keyboard smoke review;
- [ ] CI green на macOS и Windows;
- [ ] threat/security smoke tests green;
- [ ] repository не запускает shell/Git/provider/browser action;
- [ ] public-history scan не находит secrets, private paths или raw agent data;
- [ ] exit evidence сохранён в `docs/evidence/phase-0/` без sensitive data.

## 21. Planned local commit boundaries

Коммиты создаются только после отдельного разрешения владельца. Рекомендуемая будущая история:

```text
chore(repo): establish open-source foundation
docs(product): record approved product architecture
docs(plan): define phase zero implementation
build(repo): scaffold typescript workspace
feat(core): persist work items and domain events
feat(workflow): run mocked human-gated pipeline
feat(web): add command center board and task cockpit
feat(core): enforce budgets pause and recovery
test(repo): verify phase zero across macos and windows
```

Перед первым push историю можно интерактивно проверить и при необходимости squash/reword. Никакой commit не должен
содержать промежуточные research dumps, local DB или generated runtime artifacts.

## 22. Start condition

- [x] Владелец review/approved границу и implementation plan.
- [x] M0 library/runtime choices проверены по актуальным primary docs и зафиксированы ADR.
- [x] Изменения остаются uncommitted до согласованной checkpoint.
- [x] Secrets/private artifacts отсутствуют в working tree.

Phase 0 implementation разрешена. Windows SQLite portability остаётся обязательным CI gate и не считается заранее
пройденной.
