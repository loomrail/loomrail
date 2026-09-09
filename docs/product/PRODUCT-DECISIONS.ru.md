# Loomrail — зафиксированные продуктовые и архитектурные решения

**Дата фиксации:** 2026-08-22
**Последнее дополнение:** 2026-09-09 — context handoff ждёт terminal MCP lease
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
capabilities, включая способность реально ограничить расход текущей сессии. UI не показывает неподдерживаемое
действие как рабочее.

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

### BD-001 — Иерархические budgets с честной enforcement capability

Лимиты задаются на run, WorkItem, Project и rolling day: tokens/cost estimate, time, attempts, turns, concurrency и
browser/runtime minutes. Alerts: 50%, 80%, 95%; при 100% stage hard-paused до ручного подтверждения.

**Уточнение 2026-09-06.** `hard` означает, что работа провайдера не может пересечь подтверждённый лимит текущей
сессии. Terminal usage, пришедший после завершения работы, годится для ledger и остановки следующей сессии, но не
является hard enforcement. Adapter обязан объявить `HARD` либо `POST_SESSION`; второй не допускается к managed run
с token hard budget. Повышение лимита не превращает неограниченную сессию в ограниченную и не служит bypass.

**Решение владельца 2026-09-07.** Для локальных subscription-authenticated Codex/Claude runtime принят честный
`POST_SESSION`: token ledger блокирует следующую сессию, но не обещает остановить уже выполняемый provider request
ровно на token boundary. Preventive hard controls остаются для времени, числа tool calls/turns, размера output,
attempts и concurrency. UI обязан называть это различие; API-only путь ради token cap удалён. Полное изменение —
ADR-0015.

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

Локальный development target может зависеть от WebSocket для hydration. Детерминированный PlaywrightDriver
перехватывает все такие соединения до навигации: разрешён только exact same-origin loopback handshake,
page-to-server frames отбрасываются, все frames имеют жёсткие количественные и byte limits, а off-origin или
превышение лимита делает evidence невалидным. После bounded `load` драйвер даёт framework 250 ms внутри того же
navigation deadline для attachment hydration перед первым interaction; он не ждёт бесконечного network idle. Это
compatibility seam для read-only QA, а не общая network или command capability (ADR-0020).

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

Scanner назначает deadline по виду проверки: 300 секунд для lint/build/unit/integration и 900 секунд для E2E. Это
owner-visible значение входит в exact proposal и принятую revision; общий contract по-прежнему ограничивает любую
recipe максимумом 900 секунд. Истечение срока остаётся typed error и не может стать passing evidence.

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

Первый маршрут использует уже авторизованный локальный Codex либо Claude Code и готовую Task recipe, проходит Human
Request, budget, Review, измеряемый QA и owner Acceptance, затем показывает Acceptance Package. Если совместимого
runtime нет, activation остаётся blocked с инструкцией установить/обновить CLI и выполнить его официальный login;
Mock и скрытого API fallback нет.

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
проверяет наличие, совместимость и авторизацию официальных Codex/Claude Code CLI и выбирает готовый адаптер для новой
ProviderSession. В Project Settings владелец может закрепить Codex либо Claude Code; активного Mock demo mode нет.

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

Apache-2.0 local Community остаётся полезным accountable workflow: durable state, budgets, Review, QA,
Acceptance и samples не становятся искусственными paid gates. Ближайшая проверяемая коммерческая ступень —
bounded `Guided Launch`: readiness/security review проекта, предложение Constitution и verification policy, настройка
первого реального маршрута, разбор Acceptance Package и ограниченный срок поддержки/обучения.

Recurring Team/Cloud tier появляется только после отдельных cloud/team решений и продаёт новую операционную ценность:
collaboration, RBAC, shared policies/audit, hosted or remote workers, enterprise identity/retention и SLA. Loomrail не
обещает lifetime updates за один платёж, экономию «в X раз», число клиентов или provider compatibility без
проверяемой методики и evidence.

### PD-017 — Историческое API-only решение (superseded by PD-019)

Решением владельца от 2026-09-06 синтетический Mock удалён из активного продукта, onboarding, provider selection и
release artifact. Новые ProviderSession направляются только в OpenAI Responses API или Anthropic Messages API.
Отсутствие ключа, неизвестный `LOOMRAIL_PROVIDER`, неподдерживаемая stage или недостаточный enforceable token budget
блокируют dispatch; успешного синтетического fallback нет.

Ключи читаются только из process environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), не попадают в prompt, SQLite,
logs или Git. Каждый API request получает provider-native верхнюю границу до отправки: `max_output_tokens` у OpenAI
или `max_tokens` у Anthropic. Transport заменяется только в тестах, где проверяются exact request, untrusted response,
usage и превышение лимита; production transport всегда выполняет реальный HTTPS request.

ADR-0013 зафиксировал промежуточную границу: API adapters объявляли только
`DISCOVERY | PLAN | REVIEW | ACCEPTANCE`, а `IMPLEMENT` и provider-authored QA оставались fail-closed до принятия
безопасного local workspace tool executor. Эту границу расширяет только PD-018/ADR-0014; прямой shell из ответа
модели по-прежнему не получает authority автоматически.

Append-only команды, Events, миграции и старые EvidenceArtifact с идентификатором `MOCK` остаются читаемыми как
исторические факты. Миграция переводит только активную Project preference `MOCK -> AUTO`; переписывать аудит задним
числом запрещено. Полный механизм — ADR-0013 и планы 87–88.

### PD-018 — Workspace tools являются daemon-owned capability, а не provider authority

Для IMPLEMENT и QA принят один provider-neutral session-scoped executor. Адаптеры локальных Codex/Claude Code
владеют только native CLI/MCP protocol и переводят его в закрытые
`LIST_DIRECTORY | READ_FILE | WRITE_FILE | EDIT_FILE | DELETE_FILE | RUN_RECIPE`.
Пути — portable relative NFC, каждый existing component проверяется canonical/no-symlink; `.git`, `.loomrail`,
`.env*` и credential/key paths не видны tools. Write/edit/delete используют expected SHA-256; `EDIT_FILE` меняет
ровно один exact UTF-8 fragment и отклоняет отсутствующее или неоднозначное совпадение. QA остаётся `READ_ONLY`,
IMPLEMENT получает `READ_WRITE` только из immutable AgentRun snapshot.

Произвольной command строки нет. `RUN_RECIPE` принимает только ID exact active owner-approved Verification Plan;
executable/argv/cwd/environment/network/deadline/output принадлежат Plan и trusted Q17 runner. Disabled/drifted Plan,
неразрешённая network policy, неизвестный recipe и любая попытка подать argv/env из provider output fail closed.
Shell, recursive cleanup, Git mutation, commit/push/merge/deploy и secret injection не входят в authority.

Каждый tool side effect резервируется durable `WorkspaceToolCall` и append-only Event до I/O, затем получает
terminal typed outcome во второй transaction. В state нет raw provider payload, file content, command output или
credentials. Provider call ID хранится только как session-bound digest; повтор с другим input запрещён, завершённый
side effect не выполняется повторно. После restart process tree сначала останавливается/доказывается, затем STARTED
call становится `UNKNOWN_OUTCOME`; automatic replay отсутствует.

Оба provider adapters передают tools только через session-scoped Loomrail MCP proxy. Runtime не получает путь
repository и встроенные shell/file tools. Finite tool/turn guard переводит отсутствие прогресса в typed failure/
attention, а terminal usage один раз попадает в immutable AgentRun ledger.

Один provider-neutral renderer объясняет runtime разницу между пустым native read-only scratch и реальным
Loomrail workspace. До spawn он проверяет наличие exact `loomrail_workspace` connector и обязательных list/read,
а для `READ_WRITE` — write/delete tools; tool, запрещённый immutable access level, также блокирует spawn. Любой такой
mismatch даёт typed internal-contract failure. Prompt не содержит workspace path, branch, proxy argv или capability.
MCP discovery публикует write/delete только для `READ_WRITE`. Это guidance и ранняя проверка wiring, а не новая
authority: разрешение по-прежнему выводится из immutable AgentRun и повторно проверяется executor на каждом вызове.

QA сохраняет две независимые authority: daemon-owned BrowserDriver сначала создаёт exact measured evidence. Только
его `PASSED` оставляет StageAttempt открытым для read-only provider synthesis; domain связывает provider `QA_REPORT`
с exact QARun/evidence/tree. Failed/error measurement идёт в существующий correction/HumanRequest flow без provider
переоценки. Полный механизм — ADR-0014 и планы 89–90.

Schema-valid `COMPLETED` от provider не является доказательством реализации. Для live IMPLEMENT domain требует
успешный audited `WRITE_FILE`, `EDIT_FILE` или `DELETE_FILE` той же ProviderSession/StageAttempt; чтение, recipe, отказ/ошибка или
чужая сессия не проходят gate. Отсутствие эффекта даёт typed `IMPLEMENT_EFFECT_NOT_OBSERVED` и hard pause, а не
synthetic success.

### PD-019 — Production использует только локальные авторизованные Codex/Claude CLI

**Дата:** 2026-09-07. Отменяет PD-017 и API-часть ADR-0013; расширяет AD-004 и PD-018.

Loomrail запускает официальный локально установленный `codex` или `claude` как supervised child process и использует
авторизацию, которую сам CLI сохранил после `codex login`/`claude auth login`. Loomrail не читает provider token и не
принимает `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` как provider configuration. Прямых OpenAI Responses/Anthropic Messages
requests, отдельного API billing и автоматического API fallback в production нет.

CLI работает в пустом temporary directory без доступа к repository path. Ambient settings/rules/hooks/plugins/MCP,
built-in shell/file/browser tools и session persistence отключаются fail-closed. Единственная workspace authority —
одноразовый session-scoped loopback MCP proxy к executor из PD-018. Codex делает прямыми только закрытые
`mcp__<session>` namespaces и автоматически подтверждает только их заранее allowlisted tools; Claude сочетает
`--restricted`, strict MCP, пустой built-in tool set и exact Loomrail allowlist, но не `--safe-mode`, который
отключает и явный custom MCP. Несовместимая версия, отсутствующий login либо невозможность доказать эту границу
означает `blocked`, а не ослабление sandbox.

Локальные adapters честно объявляют token enforcement `POST_SESSION`: фактический usage попадает в authoritative
ledger и останавливает следующую работу, но активный provider request может превысить оценочный token remainder.
Внутри сессии жёстко действуют timeout, cancel/process-tree kill, bounded output, tool/turn/attempt limits. Эта
осознанная продуктовая замена API token cap зафиксирована ADR-0015; UI не имеет права называть её hard token cap.

Stable-release index следует этой же границе по ADR-0016: schema v3 заменяет отменённый
`liveProviderHardTokenBudgetEnforcement` на `q20LocalSubscriptionWorkspaceExecution`. Compatibility evidence означает
только exact local CLI/runtime/executor contract; незакоммиченный результат остаётся `PENDING`.

### PD-020 — Provider не именует measured evidence и authoritative Acceptance facts

**Дата:** 2026-09-08. Уточняет PD-018 и Q3, не меняя final human gate.

Provider-authored QA artifact больше не определяет список checks, представленных как measured Browser QA. Для нового
artifact Loomrail детерминированно выводит bounded check vocabulary из exact QARun plan и matching PASSED
QAEvidenceBundle. Provider может объяснить результат, но не переименовать фактически выполненный login scenario в
проверку другого product surface.

Authoritative release note, owner verification instructions и known-risk status нового AcceptancePackage выводятся
domain из current Review, measured QA и Project verification evidence на одном tree. Provider сохраняет право
объяснить implementation и выбрать exact доступные Review/QA checks; его свободный пересказ не может превратить
`PASSED` verification в «не запускалась» или скрыть typed optional failure.

Semantic inference связи произвольного check с criterion по-прежнему не выполняется. Владелец видит exact выбранный
scenario/check и сохраняет единственное право `Accept | Return | Reject`. Механизм — ADR-0017 и планы 97–98.

### PD-021 — Readiness проверяет фактический session engine локального CLI

**Дата:** 2026-09-08. Уточняет PD-019 и stable-release compatibility gate.

Версия native launcher не считается достаточной runtime identity: launcher и движок, реально разбирающий session
argv, могут расходиться в зависимости от cwd и provider-owned engine selection state. Claude Code probe запускается
в новом temporary directory с тем же allowlisted environment, входит в parser через inert
`--setting-sources "" --version`, не запускает model session и только после этого применяет exact
version/platform/architecture admission. Старый, unreadable или unverified engine означает явный `blocked`, даже
если bare launcher из другого cwd печатает поддерживаемую версию.

Loomrail не удаляет обязательный `--restricted`, не повторяет запуск с ослабленными флагами, не обновляет CLI и не
переходит на API. `AUTO` вправе выбрать другой независимо готовый локальный CLI. Полный механизм — ADR-0018.

### PD-022 — Порядок WorkItem хранится как domain-owned `BLOCKS` DAG

**Дата:** 2026-09-09. Реализует ранее утверждённые WD-001 и WD-006; не меняет provider authority или final
Acceptance.

Hierarchy Epic/child через `parentId` означает состав результата, а dependency означает порядок исполнения и
хранится отдельно. В Beta исполняется один relation kind: направленное ребро `BLOCKS`; `blocked by` является его
обратной проекцией, а `relates to` остаётся non-executing future relation.

Владелец одной атомарной командой заменяет полный набор входящих blockers WorkItem с expected version. Loomrail
проверяет same-Project membership, отсутствие self/duplicate edges и cycle на bounded snapshot графа, затем в одной
SQLite transaction применяет edge diff, увеличивает version WorkItem, пишет Event и command receipt. Provider не
получает команду изменения графа и не определяет readiness.

Board state `READY` недостаточен для старта: все incoming blocker должны находиться в `DONE`, достигнутом через
human Acceptance. `CANCELLED` не считается выполнением и остаётся видимым блокером до отдельного решения владельца.
Первый срез не запускает следующий WorkItem автоматически и не разрешает cross-Project dependencies. Полный
контракт — ADR-0019 и планы 99–100.

### PD-023 — Acceptance provider wire ссылается на evidence по bounded ordinal

**Дата:** 2026-09-09. Уточняет PD-020 и ADR-0017; не меняет human-only acceptance.

Критерии и Review/QA checks остаются exact domain strings, но больше не встраиваются как dynamic string literals в
provider-native strict JSON Schema. Новый provider-neutral wire использует zero-based integer references с верхней
границей из immutable Acceptance input. Один bounded ordered reference table передаётся в prompt как недоверенный
контекст; после schema validation `provider-core` сам разрешает refs обратно в exact строки, а domain повторно
проверяет ordered total coverage и membership в current evidence.

Codex и Claude Code используют один wire contract. Provider-specific schema transport остаётся внутри adapters.
Ошибка provider schema или неверный ref остаются fail-closed operational failure; string fallback, synthetic package
и автоматическое принятие запрещены. Полный механизм — ADR-0021 и план 104.

### PD-024 — ProviderSession закрывается только после terminal workspace tool calls

**Дата:** 2026-09-09. Уточняет PD-019 и ADR-0014; не расширяет executor authority.

Закрытие native provider transport не означает, что принятый daemon-owned tool call завершён. Gateway lease при
закрытии сначала отказывает новым calls и разрывает provider socket, затем обязан дождаться terminal состояния всех
уже начатых direct calls. Только после этого ProviderSession, StageAttempt и workspace lease могут перейти дальше.

Незавершённый recipe не может выполняться одновременно со следующим Review/QA и не считается evidence. Owner cancel
сначала отзывает authority, чтобы executor остановил process tree, а затем проходит тот же drain. Crash/restart
остаётся на durable `UNKNOWN_OUTCOME` recovery path. Полный механизм — ADR-0023 и план 106.

### PD-025 — Local provider session переживает одну максимально долгую verification operation

**Дата:** 2026-09-09. Уточняет PD-019, PD-024 и QD-003; не расширяет provider или executor authority.

Потолок одной owner-approved E2E recipe равен 900 секундам. Общий wall-clock deadline локальной Codex/Claude
ProviderSession равен этому потолку плюс фиксированные 300 секунд на provider reasoning, MCP round trip и terminal
structured result. Один shared provider-core policy задаёт 1 200 000 мс для обоих adapters; provider-specific числа
запрещены.

Deadline остаётся preventive bounded control, а не обещанием закончить произвольное количество recipes за одну
сессию. Если provider тратит control-plane reserve до запуска долгой операции или исчерпывает общий лимит, transport
останавливается typed failure. Уже принятый tool call всё равно проходит drain из PD-024, но его потерянный ответ не
превращается в success и не replay-ится автоматически. Полный механизм — ADR-0024 и план 107.

### PD-026 — Handoff deadline не отделяет ProviderSession от её MCP lease

**Дата:** 2026-09-09. Закрывает пропущенную ветку PD-024; не расширяет длительность или authority tool call.

`Promise.race` между provider runtime и context-handoff deadline выбирает момент принудительной остановки, но не
отменяет ещё выполняющийся session task. После победы deadline Loomrail сначала вызывает и дожидается typed
`abortSession`, затем обязан дождаться того же session task вместе с его `finally`/MCP lease drain. Только после
этого разрешены durable `END_PROVIDER_SESSION` и следующая ProviderSession того же StageAttempt.

Context handoff не отзывает workspace authority уже принятой recipe: она может закончиться только внутри своего
owner-approved deadline или быть остановлена общим owner cancellation. Её результат после потери provider transport
не replay-ится и не считается stage success. Полный механизм — ADR-0025 и план 108.

### PD-027 — Provider видит только безопасную проекцию immutable Verification Plan

**Дата:** 2026-09-09. Уточняет PD-019 и PD-020; не передаёт provider право изменять Plan или workflow authority.

Каждая новая ProviderSession получает в обязательном `WORKFLOW_POSITION` exact identity активного Project
Verification Plan и bounded список разрешённых recipe: ID, kind, label, required, timeout и network policy. `argv`,
script body/provenance, cwd, output limit, repository path и publication payload в context не попадают. Snapshot
читается в одной транзакции с остальными context sources и записывается в recipe provenance по Plan revision.

Эта проекция только объясняет уже существующую authority. Исполняется по-прежнему только exact recipe ID через
daemon-owned executor, который сверяет captured Plan с текущим durable Plan. Ответ на `HumanRequest` никогда сам по
себе не расширяет permissions, recipe allowlist, budget или stage authority; provider обязан формулировать запрос как
вопрос о недостающей информации, а не как обещание выдать capability. Полный механизм — ADR-0026 и план 109.

## 14. Отложенные решения

Следующие решения намеренно принимаются отдельным spike/ADR после Phase 0, а не угадываются заранее:

- Electron или Tauri;
- cloud/team sync protocol;
- plugin distribution/catalog;
- bidirectional GitHub/Jira/YouTrack adapters;
- точная policy автоматического acceptance для trusted projects;
- mobile companion;
- hosted execution и remote workers.
