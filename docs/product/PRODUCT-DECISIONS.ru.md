# Loomrail — зафиксированные продуктовые и архитектурные решения

**Дата фиксации:** 2026-08-22
**Последнее дополнение:** 2026-09-04 — activation, provider allowance и project verification
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

### PD-007 — Вторая persona: разработчик без опыта запуска продукта

**Дата:** 2026-08-25. Расширяет PD-002, не отменяет его.

Loomrail обслуживает две persona с общим ядром:

1. **Опытный solo developer** — ведёт несколько задач и репозиториев, хочет управлять множеством агентов и видеть,
   кто на какой стадии. Это persona из PD-002 и MASTER-PLAN §3.
2. **Разработчик без опыта запуска продукта** — умеет писать код с агентами, но не знает, как выбрать стек,
   настроить безопасность, что нужно юридически и как принимать платежи.

Вторая persona **не превращает Loomrail в конструктор сайтов**. Её потребности выражаются через уже принятые
механизмы: workflow templates, Project Constitution и Human Requests. Продукт остаётся control plane; он подсказывает
новичку и не мешает опытному.

Следствие: код проекта всегда принадлежит пользователю. Выбор стека или бойлерплейта не создаёт привязки к Loomrail
и не прячет генерируемые файлы за собственным форматом.

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

Каждый adapter сообщает поддерживаемые start/resume/steer/interrupt/approval/usage/rate-limit-window/browser
capabilities. UI не показывает неподдерживаемое действие как рабочее.

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

Один ProviderSession сохраняет один финальный cumulative usage report. Provider adapter нормализует `inputTokens`
как весь input провайдера; cached/reasoning breakdown остаётся attribution и не суммируется повторно. Положительный
`input + output` атомарно попадает в единый UsageRecord ledger. Исчерпание pipeline либо immutable AgentRun envelope
блокирует текущий workflow до versioned owner Budget Override прежде, чем начнётся следующая сессия.

### BD-003 — Loop guard

Повторяющиеся tool calls, одинаковые failures, исчерпание fix/review rounds и отсутствие прогресса переводят run в
attention state вместо бесконечного auto-continue.

### BD-004 — Provider allowance не является бюджетом Loomrail

Если официальный provider surface отдаёт rate-limit windows, adapter может нормализовать bucket, `usedPercent`,
`windowDurationMins`, `resetsAt`, `observedAt` и freshness. UI явно подписывает «использовано» либо «осталось» и
показывает `LIVE | STALE | UNAVAILABLE`; остаток вычисляется только из provider-reported usage, а не из локальной
оценки.

Provider allowance — внешний advisory capacity signal. Он не заменяет и не изменяет authoritative hard budgets из
BD-001, не доказывает стоимость и сам по себе не отменяет уже разрешённую работу. Фактически достигнутый provider
limit создаёт typed attention state с известным reset time, если provider его сообщил. Account identifiers,
credentials и raw provider status output не сохраняются.

## 9. Browser QA

### QD-001 — Общий BrowserDriver

- `PlaywrightDriver` — обязательный воспроизводимый baseline;
- `CodexBrowserDriver` — provider-native Codex browser/Chrome capability;
- `ClaudeBrowserDriver` — provider-native Claude Chrome/MCP capability;
- дополнительные drivers подключаются позднее.

Все drivers нормализуют steps, screenshots, traces, console/network failures и findings. Provider-native browser
полезен для exploratory/authenticated flows, но не заменяет детерминированный Playwright gate.
Публичные async-операции driver используют один экспортируемый typed error с закрытым code vocabulary; raw browser,
filesystem и callback messages не переходят через эту границу.

### QD-002 — Evidence gate

Сообщение агента «всё работает» не проходит QA. Evidence связано с точным code snapshot и становится stale после
существенного изменения.

### QD-003 — Versioned Project Verification Plan

Кроме Browser QA, Project может иметь owner-approved build/test/lint/integration/E2E recipes. Onboarding scanner
только предлагает найденные команды: он не исполняет их до preview exact executable/argv, working directory,
environment/network policy и явного подтверждения владельца. Принятая revision хранится в `.loomrail/` и входит в
policy snapshot запуска.

Verification result создаёт daemon-owned evidence с recipe revision, exact tested tree, platform, exit status,
duration и bounded/redacted output. Изменение tree делает результат `STALE`; обязательная failing, error либо stale
проверка блокирует Acceptance. Запуск tests не даёт authority на commit, push, merge или deploy.

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

### SD-005 — Public-alpha reporting требует preview и одноразового действия владельца

Local Insights вычисляются по запросу из aggregate counts и остаются внутри authenticated loopback session. Public
alpha не содержит telemetry collector, фонового sender, stable installation ID, cookie, расписания или постоянного
toggle согласия. Opt-in означает одно явное скачивание ровно того strict JSON payload, который владелец уже видит
целиком; aggregate и crash reports не содержат code, prompts, provider responses, IDs, names, paths, timestamps,
artifacts, logs, error strings или stack traces.

Crash payload существует только при durable `RecoveryReport(reason = DAEMON_RESTART)`. Любой будущий direct/network
transport требует нового ADR с owned endpoint, retention/deletion и отдельным consent lifetime; прежнее скачивание
не является согласием на последующие отправки. Полный seam и rationale —
[ADR-0009](../adr/0009-previewed-owner-initiated-reporting.md).

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

### UXD-007 — Бесплатная guided activation mission

Публичный entrypoint ведёт не в общую документацию, а в один canonical пошаговый маршрут с локальным progress,
маленькими действиями, inline-пояснениями и copy controls. Одна команда или один copy-block могут открыть onboarding,
но не скрывают install scripts, provider login, Chromium download, запись repository или иной authority-bearing шаг.
Landing, README, RU/EN guides и CLI help получают install sequence из одного versioned contract.

Первый zero-quota маршрут использует Mock и готовую Q10 Task recipe, проходит Human Request, budget, Review,
измеряемый QA и owner Acceptance, затем показывает Acceptance Package. Progress на marketing page хранится только
локально; внутри приложения он всегда выводится из durable domain state и после restart продолжается с той же точки.
Дальше владелец явно выбирает: продолжить бесплатно, подключить свой repository/provider или запросить paid guided
onboarding.

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

## 13. Дорожная карта после Phase 0

**Дата:** 2026-08-25; трек D добавлен 2026-08-27. Декомпозиция принята; порядок утверждён владельцем.

Работа после Phase 0 разбита на четыре трека и один фундамент. Подробности, зависимости и обоснование порядка —
в [`docs/plans/06-post-phase-0-decomposition.ru.md`](../plans/06-post-phase-0-decomposition.ru.md).

- **E1 — workspace execution capability**: ФС, shell и Git под permission contract. Блокирует весь трек B.
- **Трек A — глубина оркестрации**: A1 session handoff, A2 живые адаптеры, A3 параллельные squads, A4 Attention Inbox.
- **Трек B — guardrails для второй persona**: B1 пресеты Constitution, B2 чек-листы готовности к запуску,
  B3 проверка безопасности, B4 скаффолдинг нового проекта, B5 онбординг существующего репозитория.
- **Трек C — расширяемость**: C1 MCP, C2 plugin SDK, C3 Context7 по умолчанию.
- **Трек D — дистрибуция и первое впечатление**: D1 гайд пользователя, D2 примеры полного маршрута, D3 лендинг
  пакета. Ничего не блокирует и идёт после E1.5: до неё публичная страница описывала бы намерение, а не продукт.

Утверждённый порядок: M7 → **A1** → A1.5 → A2 → E1 → E1.5 → D1 → D2 → D3 → B5+B1 → B3+B2 → C1 → C3 → C2 → B4.

Трек B целиком идёт после A2 и E1: без живых провайдеров и доступа к репозиторию guardrails нечего проверять.

### PD-008 — Handoff проектируется до живых провайдеров

A1 идёт первым после M7 по одной причине: сегодня Loomrail durable по состоянию (WorkItem, стадии, бюджеты,
evidence, Decisions), но **контекст исполнения агента не хранится нигде**. С mock-провайдером это незаметно. С живым
провайдером задача упрётся в лимит контекста посреди работы, и продолжить будет нечем.

Handoff — это **не перенос истории диалога**. Это пересборка нового контекста из состояния, которым Loomrail уже
владеет: бриф, план, принятые Decisions, evidence, диффы. Новая сессия получает вход, а не продолжает разговор,
поэтому handoff переживает смену провайдера.

Отсюда следует, что A1 проектируется **до** A2: иначе адаптеры придётся переделывать под контракт, которого на момент
их написания не существовало.

### PD-009 — Provider выбирается в Project, AUTO является обычным путём

`LOOMRAIL_PROVIDER` не является обязательным шагом установки. Новый Project получает `AUTO`: daemon безопасно
проверяет наличие и авторизацию официальных Codex/Claude Code CLI и выбирает готовый адаптер для новой
ProviderSession. В Project Settings владелец может закрепить Codex, Claude Code либо явный Mock demo mode.

Выбор versioned и durable, но не меняет provider уже запущенной ProviderSession. Environment variable остаётся
только видимым startup override для automation/debugging. Loomrail не хранит provider credentials, не читает вывод
auth-status глубже exit outcome и никогда не включает permission bypass. Полный контракт —
[`docs/plans/31-provider-selection-auto-detection-spec.ru.md`](../plans/31-provider-selection-auto-detection-spec.ru.md).

### PD-010 — MCP проходит через daemon-owned gateway

Project хранит immutable MCP Connection Profile Revisions, owner Consent и versioned tool Grant. ProviderSession
получает snapshot конкретных revisions/grants, но provider adapter не запускает реальные MCP servers напрямую:
provider подключается только к scoped Loomrail proxy, daemon владеет stdio process, policy, bounded audit, revoke и
recovery.

C1 поддерживает только local stdio и owner-granted read-only tools. Remote HTTP/OAuth, env/secrets, Registry install,
ambient provider MCP config и автоматические side-effect approvals не входят. Полный контракт —
[`docs/plans/33-c1-mcp-connections-spec.ru.md`](../plans/33-c1-mcp-connections-spec.ru.md), причина gateway seam —
ADR-0005.

### PD-011 — Context7 поставляется как встроенный MCP preset, а не скрытая интеграция

Loomrail включает exact-pinned `@upstash/context7-mcp` в собственную runtime-дистрибуцию и строит из него
project-scoped C1 Profile Proposal. Пользователю не нужны глобальная установка, `npx` или ручной поиск executable.
Preset использует только bundled Node runtime, local stdio и два заявленных read-only tool:
`resolve-library-id` и `query-docs`.

«По умолчанию» означает, что безопасный preset доступен в каждом Project без подготовки машины, но не означает
автоматический запуск или grant. Owner всё равно подтверждает точный executable/argv, запускает capability probe и
отдельно выдаёт tool allowlist. Loomrail не записывает auto-invoke rule в repository/provider config и не передаёт
Context7 API key: запросы идут в anonymous tier, а credentials/env остаются за границей C1/C3.

Context7 обращается к внешнему API, поэтому UI явно сообщает, что query покидает машину и не должен содержать secrets,
персональные данные или proprietary code. Полный контракт —
[`docs/plans/35-c3-context7-preset-spec.ru.md`](../plans/35-c3-context7-preset-spec.ru.md).

### PD-012 — Plugin SDK v1 расширяет tool surface, но не workflow authority

Первый Plugin SDK предназначен только для локальных read-only tool plugins. Автор описывает плагин строгим
versioned manifest и запускает отдельный MCP stdio process через helper из `loomrail/plugin-sdk`; Loomrail проверяет
его обычным C1 probe и применяет owner Grant через daemon-owned gateway. Плагин не получает интерфейса для изменения
WorkItem, StageAttempt, HumanRequest, Decision, budgets, acceptance или permission state.

Manifest не является security sandbox и не превращает утверждения стороннего кода в доказательство. Он фиксирует
identity, exact tool surface, entrypoint, license и заявленные outbound hosts, а SDK принудительно выставляет MCP
annotations read-only/destructive-false. Запуск стороннего executable по-прежнему требует отдельного owner Consent к
точной C1 launch revision; capability probe и tool Grant не заменяют это доверие.

C2 не включает registry/marketplace, package download/install, signatures, secrets/env, filesystem write, shell/Git,
workflow hooks, UI installer или side-effect tools. SDK поставляется как публичный subpath export основного npm-пакета,
а локальный fixture и C1 conformance test являются его первым совместимым consumer. Полный контракт —
[`docs/plans/37-c2-plugin-sdk-spec.ru.md`](../plans/37-c2-plugin-sdk-spec.ru.md), причина seam — ADR-0006.

### PD-013 — Новый Project создаётся из versioned recipe без installer side effects

B4 создаёт новый Git repository только из встроенного immutable Scaffold Recipe. Первый recipe — небольшой
TypeScript/Node baseline с обычными файлами, понятными без Loomrail. Владелец до записи видит canonical target,
точную версию recipe, список файлов и digest, а затем подтверждает именно этот Scaffold Proposal.

Loomrail не скачивает template, не запускает package manager, install script, hook или найденную в файлах команду,
не делает commit/push и не создаёт remote. Target должен не существовать; daemon захватывает его эксклюзивным
`mkdir` и пишет только новые файлы. Из-за отсутствия portable `rename-no-replace` для каталогов публикация не
выдаётся за filesystem transaction: durable Scaffold Operation и marker позволяют продолжить ровно свою
незавершённую публикацию после restart. Каталог с чужим или несовпадающим marker никогда не очищается и не
перезаписывается автоматически.

Успешная публикация завершается обычным зарегистрированным Project. Сгенерированный код остаётся полностью
пользовательским: recipe не добавляет runtime dependency на Loomrail и не требует собственного формата для сборки
или запуска. Полный контракт — [`docs/plans/39-b4-new-project-scaffolding-spec.ru.md`](../plans/39-b4-new-project-scaffolding-spec.ru.md).

### PD-014 — Attention Inbox является глобальной bounded-проекцией HumanRequest

Attention Inbox не хранит собственную копию workflow state. Он вычисляется из durable HumanRequest и связанных
Project, WorkItem, StageAttempt и AcceptancePackage через один deterministic domain module. Глобальный read ограничен
200 открытыми items и сообщает `hasMore`; текст запроса не используется для скрытой классификации.

Обычный item использует существующий optimistic-versioned `Answer & resume`. Final acceptance остаётся отдельным
owner gate и из Inbox только открывается в exact Task Cockpit. Первый A4 slice не добавляет OS notifications,
claim/snooze/expiry или readiness attestations: у продукта ещё нет non-blocking producer, на котором эти состояния
можно проверить end to end. Полный контракт —
[`docs/plans/41-a4-attention-inbox-spec.ru.md`](../plans/41-a4-attention-inbox-spec.ru.md).

### PD-015 — Scheduler планирует, а AgentRun резервируется транзакцией

`AgentRun`, а не `ProviderSession` и не worker promise, является единицей concurrency. Handoff меняет
ProviderSession внутри того же run и не занимает дополнительный slot. Pure scheduler сортирует bounded pending
dispatches и выдаёт machine-readable причины отсрочки, но его план не является authority: global/project/provider
limit, active StageAttempt и active WorkItem повторно проверяются в SQLite transaction, которая создаёт AgentRun до
запуска provider process. Существующий workspace lease берётся там же; первый worktree создаётся после claim, но до
spawn и записывается уже leased, пока exclusive active WorkItem claim закрывает provisioning race.

AgentRun фиксирует hash immutable policy snapshot: assignment/profile revision, effective provider и применённые
capability/budget/workspace rules. Exact provider input не дублируется на этом уровне: его `contentHash` остаётся в
ContextPackRecipe конкретной ProviderSession и может закономерно измениться при handoff внутри одного AgentRun.
MCP revision ids входят только когда пересечение реально сохранило `MCP_READ`. Browser QA требует stable worktree,
но его provider policy остаётся read-only/offline; сетевой доступ к loopback target принадлежит отдельному
BrowserDriver, а не provider session.

Первый stable scope создаёт один immutable `SquadAssignment(revision = 1)` вместе с PipelineRun. Изменение состава
после старта не имеет command, HTTP/UI boundary или transition и не заявляется реализованным. Поле revision фиксирует
identity snapshot; будущий editing flow потребует новую assignment revision только для ещё не начавшихся
StageAttempt и новый exact AgentRun policy snapshot.

Acceptance разделён на две разные authority. `Acceptance Manager` является provider-executed ролью: он только
готовит criterion-bound package и поэтому, как любая фактическая agent work, получает отдельный AgentRun с immutable
profile/model/budget/capability snapshot. Этот run не получает workspace, network, MCP или право принять результат.
Следующий `Accept | Return | Reject` остаётся отдельным optimistic-versioned owner gate по HD-003. Для exact
revision 1 пятистадийных Standard assignments, созданных до этой коррекции, daemon может добавить ровно одну immutable
compatibility revision с Acceptance Manager; произвольное post-start редактирование состава по-прежнему отсутствует.

Default global concurrency — 3. Параллельные readers одного workspace допустимы только на одном immutable
checkpoint; любой writer конфликтует и с writer, и с reader. Shutdown/restart не создаёт automatic retry
оборванного AgentRun. Полный контракт —
[`docs/plans/43-a3-parallel-squads-spec.ru.md`](../plans/43-a3-parallel-squads-spec.ru.md).

Глобальный Agent Fleet является bounded authenticated projection durable AgentRun и pending dispatch state. Он
показывает Task, Project, точную роль, stage, provider, running/waiting status и machine-readable причину ожидания,
но не хранит собственную очередь и не меняет permissions, budget или acceptance. Reconnect и restart перестраивают
тот же view из SQLite и текущей validated scheduling policy.

### PD-016 — Платный слой продаёт внедрение и совместную работу, а не безопасность core

Apache-2.0 local Community остаётся полезным полным accountable workflow: durable state, budgets, Review, QA,
Acceptance, Mock и samples не становятся искусственными paid gates. Ближайшая проверяемая коммерческая ступень —
bounded `Guided Launch`: readiness/security review проекта, предложение Constitution и verification policy, настройка
первого реального маршрута, разбор Acceptance Package и ограниченный срок поддержки/обучения.

Recurring Team/Cloud tier появляется только после отдельных cloud/team решений и продаёт новую операционную ценность:
collaboration, RBAC, shared policies/audit, hosted or remote workers, enterprise identity/retention и SLA. Loomrail не
обещает lifetime updates за один платёж, экономию «в X раз», число клиентов или provider compatibility без
проверяемой методики и evidence.

## 14. Отложенные решения

Следующие решения намеренно принимаются отдельным spike/ADR после Phase 0, а не угадываются заранее:

- Electron или Tauri;
- cloud/team sync protocol;
- plugin distribution/catalog;
- bidirectional GitHub/Jira/YouTrack adapters;
- точная policy автоматического acceptance для trusted projects;
- mobile companion;
- hosted execution и remote workers.
