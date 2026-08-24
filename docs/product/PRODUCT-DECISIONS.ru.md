# Loomrail — зафиксированные продуктовые и архитектурные решения

**Дата фиксации:** 2026-08-22
**Статус:** approved baseline
**Основание:** последовательный product/architecture grilling с владельцем проекта

Этот документ — короткий нормативный реестр уже принятых решений. Master plan объясняет продукт целиком, ADR будут
фиксировать технические механизмы, а implementation plans — порядок реализации. Если более ранний текст расходится с
этим реестром, до явного нового решения действует этот реестр.

## 1. Продукт и границы

### PD-001 — Название и позиционирование

- продукт называется **Loomrail**;
- GitHub organization и основной repository: `loomrail/loomrail`;
- CLI: `loomrail`, npm scope: `@loomrail/*`, repo-local directory: `.loomrail/`;
- descriptor: **The local control plane for accountable AI software teams.**

### PD-002 — Первый пользователь

Первый продукт оптимизируется для solo developer. Небольшие команды остаются целевой аудиторией, но общая
синхронизация, RBAC и multi-machine execution не входят в MVP.

### PD-003 — Local-first и browser-first

- обязательного аккаунта и облака нет;
- основной runtime работает локально;
- основной интерфейс открывается в браузере;
- desktop shell появится после стабильного browser-first ядра;
- macOS и Windows — приоритетные платформы, Linux — best effort.

### PD-004 — Несколько проектов

Один локальный daemon управляет несколькими зарегистрированными Project/repository. Их runtime state, правила,
артефакты, бюджеты и execution workspaces изолированы.

### PD-005 — Собственная система управления работой

Loomrail владеет локальными Epic, WorkItem, Kanban, workflow, decisions и audit history. GitHub Issues, Jira,
YouTrack и Linear могут появиться только как дополнительные adapters/import/export, а не как source of truth.

### PD-006 — Task-centric, не chat-centric

Task и её доказуемый lifecycle являются центром продукта. Чат — вспомогательный канал guidance; provider session не
заменяет WorkItem, acceptance criteria, artifacts, findings или decisions.

## 2. Runtime и архитектура

### AD-001 — TypeScript-first Phase 0

Первый skeleton — TypeScript strict monorepo: Node.js daemon, React/Vite web, общие contracts и pnpm workspace.
Rust, Tauri и Electron не входят в Phase 0.

### AD-002 — Один daemon, loopback-only

- daemon слушает только `127.0.0.1`/`::1`;
- UI получает локальную `HttpOnly` session через одноразовый bootstrap flow;
- remote/LAN access выключен и отсутствует в MVP;
- закрытие browser tab не останавливает daemon или очередь.

### AD-003 — Гибридное локальное хранение

- SQLite — source of truth текущего операционного состояния;
- append-only Event log хранит audit trail;
- `.loomrail/` хранит переносимые и Git-versioned configuration, rules и workflows;
- тяжёлые logs, transcripts и QA artifacts хранятся отдельными локальными файлами вне Git;
- перед миграциями создаётся backup.

### AD-004 — CLI-first provider integration

Первые реальные Codex/Claude adapters запускают официальные локально установленные CLI как управляемые дочерние
процессы и используют уже существующую авторизацию пользователя. Прямые API, provider SDK и remote runtimes могут
быть добавлены тем же adapter contract позднее.

### AD-005 — Provider capabilities, а не фальшивая одинаковость

Каждый adapter сообщает поддерживаемые start/resume/steer/interrupt/approval/usage/browser capabilities. UI не
показывает неподдерживаемое действие как рабочее.

### AD-006 — Разделение профиля, запуска и provider session

- `AgentProfile` — постоянная роль, policy, provider/model defaults и budget;
- `AgentRun` — конкретный проверяемый запуск для stage/work item;
- `ProviderSession` — provider-native сессия, если её можно продолжить или наблюдать.

### AD-007 — Изолированная параллельная работа

- default: отдельные Git branch + worktree на исполняемый WorkItem;
- одновременно в один worktree пишет только один AgentRun;
- reviewer и QA работают read-only либо по отдельному snapshot;
- работа в основной папке — явный небезопасный opt-in с single-writer lease;
- worktree изолирует изменения, но сам по себе не является security sandbox.

### AD-008 — Безопасное восстановление

- состояние workflow, очереди и budgets восстанавливается после restart;
- оборванный run становится `Interrupted`;
- автоматический повтор оборванного agent run запрещён;
- человек выбирает resume provider session или новый run от Git checkpoint;
- переходы state machine и фоновые операции проектируются идемпотентными.

### AD-009 — Изолированные плагины

Codex, Claude, Git и Playwright сначала встроены. Будущий third-party plugin запускается отдельным процессом,
объявляет permissions в manifest и общается через versioned typed protocol. Marketplace не входит в первые этапы.

## 3. Work management и workflow

### WD-001 — Единое дерево WorkItem

Типы: `Epic`, `Feature`, `Task`, `Bug`, `Spike`, `Subtask`. Иерархия строится через `parentId`, зависимости
`blocks/blocked-by/relates-to` существуют отдельно. Исполняются только leaf work items, а мелкие критерии остаются
checklist items.

### WD-002 — State отдельно от workflow stage

Canonical work states:

```text
BACKLOG | READY | IN_PROGRESS | BLOCKED | DONE | CANCELLED
```

Canonical default stages:

```text
DISCOVERY | PLAN | IMPLEMENT | REVIEW | QA | ACCEPTANCE
```

Board можно группировать по work state или stage. Blocking Human Request меняет attention/blocking state конкретной
работы, но не останавливает независимые задачи.

### WD-003 — Декларативные workflow

Встроенный default flow:

```text
Discovery -> Plan -> Implement -> Review -> QA -> Acceptance -> Done
```

Workflow, transitions, gates, role assignment и budgets хранятся в versioned declarative config. Arbitrary
executable scripts и visual workflow marketplace не входят в MVP.

### WD-004 — Risk-based профили

- `Quick`: brief -> implement -> review -> deterministic checks;
- `Standard`: полный feature flow;
- `Epic`: decomposition, parallel leaf tasks, integration review и regression QA.

PM предлагает профиль, человек может изменить его до старта. Security, migrations, billing и production
infrastructure не могут автоматически идти через `Quick`.

### WD-005 — Readiness gate

Код не пишется, пока человек не подтвердил brief с goal, scope/non-goals, acceptance criteria, dependencies, risk и
budget. Простая natural-language идея сначала становится Draft WorkItem.

### WD-006 — Scheduler

- default concurrency: три AgentRun;
- отдельные global/project/provider limits;
- scheduler учитывает DAG, priorities, budgets, worktree/writer/browser leases и rate limits;
- review запускается только по стабильному checkpoint.

## 4. Команда агентов и ответственность

### TD-001 — Ограниченный PM

PM может декомпозировать, предлагать приоритет, создавать work items, назначать roles, планировать и повторять этапы
внутри approved budget. PM не может сам повышать budget, ослаблять criteria, менять security rules, одобрять свою
работу, обходить Review/QA, merge или закрывать финальную acceptance.

### TD-002 — Независимая проверка

- исполнитель не проверяет собственную работу;
- reviewer получает fresh context: brief, rules, diff и test evidence без chain-of-thought автора;
- при наличии обоих providers используется cross-provider review;
- один provider допустим только отдельным run, предпочтительно другой моделью;
- QA — отдельная роль, не заменяемая code review.

### TD-003 — Artifact-first handoff

Между ролями передаются versioned structured artifacts, а не полный transcript. Raw logs доступны для audit и
точечного расследования, но не попадают автоматически в следующий prompt. До запуска показывается оценка размера
контекста.

## 5. Human-in-the-loop

### HD-001 — HumanRequest как отдельная сущность

Поддерживаются single choice, multiple choice, confirmation и free text; для вариантов есть `Other`. Request бывает
blocking или informational, виден в global Inbox, на WorkItem и в timeline. Ответ становится Decision и возвращается
в workflow. Секреты через HumanRequest не передаются.

### HD-002 — Управляемое вмешательство

Доступны Pause, Resume, Cancel, Retry и Send guidance. Guidance и изменения criteria записываются событиями.
Существенное изменение upstream requirements инвалидирует старые Plan/Review/QA artifacts. Manual override требует
причины и не исчезает из audit log.

### HD-003 — Финальная authority

Merge и `Done` по умолчанию требуют человека. Автоматический final acceptance может появиться только как явный trust
policy для конкретного проекта после MVP.

## 6. Git и история

### GD-001 — Task branches и checkpoints

Agent может создавать технические checkpoint commits только в task branch. Loomrail не push'ит изменения без явного
разрешения.

### GD-002 — Чистый итоговый commit

Перед acceptance пользователь видит итоговый diff, состав файлов и Conventional Commit message. По умолчанию task
checkpoints squash'ятся в один содержательный commit. Transcripts, prompts и runtime artifacts не попадают в Git.

## 7. Правила проекта

### RD-001 — Версионируемая иерархия

```text
.loomrail/constitution.md
.loomrail/architecture/
.loomrail/rules/
.loomrail/agents/
.loomrail/workflows/
```

`AGENTS.md` и `CLAUDE.md` импортируются provider adapters. Более конкретное правило уточняет общее, но не ослабляет
constitution или security invariant. Каждый run хранит snapshot реально применённых правил.

### RD-002 — Safe onboarding

Scanner читает manifests, repository structure, CI, docs и существующие agent instructions, предлагает architecture
map, commands и rules, затем задаёт grill-вопросы. Запись `.loomrail/` и первый dry run требуют подтверждения.

## 8. Бюджеты и защита от циклов

### BD-001 — Иерархические hard budgets

Лимиты задаются на run, WorkItem, Project и rolling day: tokens/cost estimate, time, attempts, turns, concurrency и
browser/runtime minutes. Alerts: 50%, 80%, 95%; при 100% stage hard-paused до ручного подтверждения.

### BD-002 — Честные usage данные

Actual provider usage, provider estimate и Loomrail estimate визуально различаются. Если CLI не сообщает точную
стоимость, UI не выдаёт оценку за факт.

### BD-003 — Loop guard

Повторяющиеся tool calls, одинаковые failures, исчерпание fix/review rounds и отсутствие прогресса переводят run в
attention state вместо бесконечного auto-continue.

## 9. Browser QA

### QD-001 — Общий BrowserDriver

- `PlaywrightDriver` — обязательный воспроизводимый baseline;
- `CodexBrowserDriver` — provider-native Codex browser/Chrome capability;
- `ClaudeBrowserDriver` — provider-native Claude Chrome/MCP capability;
- дополнительные drivers подключаются позднее.

Все drivers нормализуют steps, screenshots, traces, console/network failures и findings. Provider-native browser
полезен для exploratory/authenticated flows, но не заменяет детерминированный Playwright gate.

### QD-002 — Evidence gate

Сообщение агента «всё работает» не проходит QA. Evidence связано с точным code snapshot и становится stale после
существенного изменения.

## 10. Permissions, privacy и secrets

### SD-001 — Capability-based permissions

Role profile определяет filesystem scope, shell commands, network hosts, browser origins, Git authority и allowed
secret profiles. Loomrail использует provider-native approvals, но агрегирует их в общий Inbox. Автоматическое
включение `dangerously-skip-permissions` и аналогичных режимов запрещено.

### SD-002 — Environment Setup Center

- существующие `.env*` остаются под контролем пользователя;
- onboarding определяет названия необходимых переменных без показа значений;
- недостающий secret можно вставить в локальном UI;
- значение хранится в macOS Keychain / Windows Credential Manager;
- trusted runner подставляет environment profile процессу, не включая значение в prompt;
- при необходимости создаётся временный env-file вне repository;
- advanced opt-in может записать `.env.local`;
- logs/output/artifacts проходят redaction.

### SD-003 — Privacy-first

Source code, prompts, provider responses, paths и repository names не отправляются Loomrail. Telemetry отключена по
умолчанию. Будущая opt-in telemetry имеет публичную схему, crash payload показывается до отправки.

### SD-004 — Retention

Tasks, events, decisions, usage summaries и handoffs сохраняются бессрочно. Незакреплённые raw transcripts, logs,
screenshots, traces и временные builds по умолчанию удаляются через 30 дней после закрытия работы. Очистка не
затрагивает Git.

## 11. UX и distribution

### UXD-001 — Command Center

Домашняя страница показывает все проекты, active runs, queue, blockers, Human Requests, budgets и быстрые Pause/New
Task actions. Из неё пользователь переходит в project Board.

### UXD-002 — Task Cockpit

Task detail содержит Overview, Workflow, Runs, Changes, Review, QA и Activity. Questions/actions находятся в
contextual inspector. Raw terminal и provider logs раскрываются по запросу.

### UXD-003 — Visual direction

Профессиональный компактный control plane: нейтральные surfaces, один brand accent, минимум декоративного AI-slop,
понятная плотность и role/status semantics. Light и dark темы равноправны; status не кодируется только цветом.

### UXD-004 — Уведомления

In-app Inbox обязателен. macOS/Windows notifications используются только для human attention, budget stop, failure и
готовности к acceptance. Внешние notifications — будущие adapters.

### UXD-005 — Ранняя установка

- contributors: clone + pnpm;
- users: `npx @loomrail/cli start` или глобальный CLI;
- Docker не является основным local runtime;
- desktop runtime выбирается отдельным Electron/Tauri spike после Dogfood Alpha.

### UXD-006 — Backup и portability

Перед migrations создаются local snapshots. Workspace экспортируется в versioned archive без secrets, `.env`, Git
repository и provider credentials. Import сначала валидируется и показывает состав данных.

## 12. Утверждённая граница Phase 0

Phase 0 должна доказать безопасный mocked vertical slice:

- TypeScript/pnpm monorepo;
- local daemon, SQLite, append-only events и loopback session;
- регистрация нескольких fixture workspaces;
- contracts для WorkItem, AgentProfile, AgentRun, HumanRequest, Workflow и Event;
- mock provider и deterministic workflow;
- Command Center, Kanban и Task Cockpit foundations;
- Human Request answer/resume, Pause/Resume и simulated hard budget stop;
- WebSocket updates и restart recovery;
- equal light/dark themes;
- tests и macOS/Windows CI;
- contributor documentation.

Не входят: реальные Codex/Claude adapters, реальное выполнение shell/Git, Git worktrees, Playwright QA, plugin SDK,
desktop shell, remote access, team sync и polished final design.

## 13. Отложенные решения

Следующие решения намеренно принимаются отдельным spike/ADR после Phase 0, а не угадываются заранее:

- Electron или Tauri;
- cloud/team sync protocol;
- plugin distribution/catalog;
- bidirectional GitHub/Jira/YouTrack adapters;
- точная policy автоматического acceptance для trusted projects;
- mobile companion;
- hosted execution и remote workers.
