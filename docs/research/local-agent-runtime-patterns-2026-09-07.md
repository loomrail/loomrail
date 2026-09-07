# Локальные агентные runtime без API-ключей приложения

Дата исследования: 2026-09-07.

## Краткий ответ

Да: Loomrail может запускать уже установленный и авторизованный Codex CLI или Claude Code CLI и пользоваться подпиской пользователя без `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` в самом Loomrail. Это не неофициальный обход:

- Codex CLI официально поддерживает вход через ChatGPT и повторно использует сохранённую авторизацию в `codex exec` и App Server ([Codex authentication](https://developers.openai.com/codex/auth), [non-interactive mode](https://developers.openai.com/codex/noninteractive), [App Server](https://developers.openai.com/codex/app-server)).
- Claude Code официально поддерживает браузерный вход через Claude.ai Pro, Max, Teams и Enterprise и программный запуск через `claude -p` ([authentication](https://code.claude.com/docs/en/iam), [headless mode](https://code.claude.com/docs/en/headless)).

Но «CLI установлен и авторизован» недостаточно для безопасного IMPLEMENT/QA. Loomrail должен проверять версию и возможности CLI, запускать процесс с ограниченной средой, не читать файлы авторизации, не передавать API-ключи, оставлять provider-specific протокол внутри адаптера и пропускать разрешённые операции через собственный executor и доменные approval/gate/budget правила.

Рекомендуемая граница:

- Codex: `codex app-server --stdio` как основной интеграционный протокол.
- Claude Code: `claude -p` с `stream-json`, `--restricted`, отключёнными встроенными инструментами и только явно переданным Loomrail MCP server.
- Loomrail: один небольшой provider-neutral контракт с нормализованными событиями; workflow, разрешения, бюджеты, acceptance, idempotency и recovery остаются доменными.
- Никакого автоматического fallback на Responses/Messages API и никакого запроса API-ключа в onboarding.

## Что именно переиспользуется

Loomrail запускает локальный дочерний процесс. Сам CLI общается со своим провайдером и использует собственное сохранённое состояние входа. Loomrail не должен:

- читать или копировать `~/.codex/auth.json`, системный keychain или Claude credential store;
- сохранять access/refresh token;
- подменять вход API-ключом;
- выводить email, account id или содержимое auth/status ответа в audit/log;
- обещать, что подписка CLI эквивалентна API-биллингу или имеет те же квоты.

Для проверки достаточно узких команд самого CLI: `codex login status` и `claude auth status`. Для Codex App Server лучше использовать его `account/read`: сервер сам владеет OAuth и обновлением токена ([App Server authentication API](https://developers.openai.com/codex/app-server#authentication-api)).

## Codex CLI

### Доступные режимы

`codex exec` — официальный неинтерактивный вход для scripts/CI. Он:

- по умолчанию работает в read-only sandbox;
- принимает `--sandbox workspace-write` для изменений;
- отдаёт машинно-читаемый JSONL через `--json`;
- поддерживает JSON Schema результата, resume и interrupt на уровне процесса;
- повторно использует сохранённую авторизацию CLI;
- отдаёт usage по завершённому turn.

См. [non-interactive mode](https://developers.openai.com/codex/noninteractive) и [CLI developer commands](https://developers.openai.com/codex/cli/reference).

Для Loomrail `codex exec` годится как простой batch fallback только если продукт явно принимает более бедный протокол. Для полноценного Task Cockpit предпочтительнее App Server.

Для воспроизводимого `exec` официальный CLI также предлагает `--ignore-user-config` и `--ignore-rules`: первый не загружает пользовательский `config.toml`, второй пропускает пользовательские и проектные execpolicy `.rules`. Это полезно против неявного расширения полномочий, но не является общей кнопкой «не доверять всему содержимому репозитория» и не отменяет Loomrail policy/executor.

`codex app-server` — официальный JSON-RPC-подобный двунаправленный протокол поверх JSONL/stdio. Он предоставляет:

- `thread/start`, `thread/resume`, `thread/fork`;
- `turn/start`, `turn/steer`, `turn/interrupt`;
- typed lifecycle событий и итог `completed | interrupted | failed`;
- server-initiated approvals на команды и изменения файлов;
- typed error data вместо анализа stderr;
- auth/account, rate-limit и token-usage события;
- sandbox/approval policy и ограниченные readable/writable roots;
- dynamic tools, где host исполняет вызов и возвращает результат.

См. [официальное описание App Server](https://developers.openai.com/codex/app-server) и [протокол в репозитории Codex](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

`codex mcp-server` не стоит брать как основу нового клиента: в текущем CLI он помечен deprecated в пользу App Server ([developer commands](https://developers.openai.com/codex/cli/reference)). MCP остаётся полезным транспортом для host-owned инструментов, но не заменяет lifecycle/auth/session API App Server.

### Auth и onboarding

Codex поддерживает два режима: вход через ChatGPT и API key. Для этого продукта нужен только первый. UX:

1. Найти поддерживаемый `codex` без выполнения model turn.
2. Показать версию и результат безопасной проверки статуса.
3. Если входа нет: «Откройте терминал и выполните `codex login`», затем кнопка «Проверить снова».
4. Если авторизация есть: показать только «Вход через ChatGPT выполнен»; не показывать идентификаторы и не читать auth-файл.
5. Если CLI слишком стар или handshake несовместим: состояние `version_unsupported`, ссылка на обновление, выполнение заблокировано.

Официальная документация прямо говорит, что CLI кэширует авторизацию и автоматически обновляет ChatGPT token. Файл/credential store содержит секреты и не является интеграционным API ([Codex authentication](https://developers.openai.com/codex/auth)).

### Sandbox, tools и approvals

App Server позволяет задавать `cwd`, sandbox и approval policy при старте thread и получать структурированные запросы разрешения на command/file change. Это полезный внешний слой защиты, но он не отменяет Loomrail executor:

- provider sandbox может меняться между версиями и платформами;
- provider-owned shell/file tools не должны считаться источником продуктовых разрешений;
- `danger-full-access` и флаги bypass нельзя включать автоматически;
- дополнительные writable/readable roots должны быть пустыми, если их явно не выдал пользователь;
- любое approval от App Server нормализуется в доменную команду; UI не отвечает провайдеру раньше durable audit/decision.

Dynamic tools в App Server позволяют сделать операции host-owned, но в официальной документации они пока обозначены как experimental. Нельзя строить единственную security boundary на предположении, что ими можно навсегда отключить все встроенные provider tools. Нужны version/capability negotiation и негативные conformance-тесты при каждом поддерживаемом обновлении CLI.

### Output, cancellation, recovery

Каждая строка stdout — недоверенный JSON frame. Адаптер должен ограничить длину frame и общий объём, валидировать схему и protocol version, а неизвестные варианты превращать в typed `protocol_unsupported`, не в success. Raw provider payload не попадает в БД или обычный audit.

На durable boundary сохраняются только:

- provider kind и проверенная версия;
- opaque thread/session id;
- последний принятый sequence/cursor, если он есть в версии протокола;
- нормализованное событие и доменная версия workflow;
- idempotency key каждого tool operation;
- агрегированное usage без transcript/raw arguments.

После рестарта Loomrail сначала восстанавливает доменную запись, затем делает явный `thread/resume`. История provider thread не может восстанавливать или переписывать workflow-состояние.

Отмена — `turn/interrupt`, затем ограниченное ожидание и завершение дерева процесса. `interrupted` нельзя отображать как failure или success.

### Token/quota budgets

App Server отдаёт token usage, rate-limit windows и reset time. В актуальном протоколе durable goals также имеют `tokenBudget`; сервер выставляет `budgetLimited`, когда учёт пересёк заданный предел ([App Server goal API в официальном репозитории](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-set-and-update-a-thread-goal), [типизированная schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadGoalUpdatedNotification.json)). Это полезный второй guardrail, но Loomrail всё равно владеет бюджетом: provider accounting и semantics могут меняться, а уже начатый запрос невозможно «открутить».

У `codex exec` не документирован общий hard `--max-tokens` для всего запуска. Поэтому минимальные кросс-провайдерные гарантии должны включать hard limits на turns, tool calls, wall-clock и output bytes; token limit — доменный учёт плюс provider-native guardrail, где он есть.

## Claude Code CLI

### Программный протокол

Официальный headless entry point — `claude -p`. Для долгого двунаправленного сеанса доступны:

- `--input-format stream-json`;
- `--output-format stream-json`;
- `--verbose` для полного event stream;
- `--json-schema` для финального структурированного результата;
- `--session-id`, `--resume`;
- `--max-turns` и `--max-budget-usd`;
- `--mcp-config` и `--strict-mcp-config`;
- `--allowedTools`, `--disallowedTools`, `--tools`;
- `--permission-prompt-tool` для отправки permission prompt в MCP tool.

См. [CLI reference](https://code.claude.com/docs/en/cli-reference) и [headless mode](https://code.claude.com/docs/en/headless).

Важно различать флаги:

- `--allowedTools` автоодобряет совпавшие tools, но не сужает весь доступный tool surface;
- именно `--tools` задаёт набор встроенных tools; `--tools ""` отключает их;
- `--strict-mcp-config` не даёт подмешать MCP servers из других config locations;
- `--disallowedTools` полезен как deny-in-depth, но не заменяет allowlist.

### Почему нужен `--restricted`

Claude Code 2.1.248 добавил `--restricted`. По официальному CLI reference этот режим:

- убирает встроенные command/code и WebFetch tools, если они не названы явно;
- ограничивает file tools working directories;
- загружает только managed и явно переданные settings;
- запрещает bypass permissions.

Это критично для запуска внутри недоверенного репозитория. Обычный `claude -p` без `--bare` может загрузить проектные `.claude/settings.json` hooks и `.mcp.json`; в headless mode диалог workspace trust/per-server prompt не защищает запуск. В то же время `--bare` не подходит subscription-only продукту: он отключает OAuth/keychain и требует `ANTHROPIC_API_KEY` ([headless mode](https://code.claude.com/docs/en/headless)).

Следствие: безопасный subscription-only адаптер должен требовать Claude Code версии не ниже той, где документирован `--restricted` (сейчас 2.1.248), а не молча откатываться к обычному `-p` или `--bare`.

Рекомендуемый профиль запуска по текущей документации:

```text
claude -p \
  --restricted \
  --tools "" \
  --strict-mcp-config \
  --mcp-config <ephemeral Loomrail-only config> \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --max-turns <domain-derived limit>
```

Точный allowlist Loomrail MCP tool names и permission mode должен формироваться argv-массивом после capability handshake. В командной строке выше нет shell interpolation и provider credentials.

Для версии 2.1.259+ `--permission-prompts none` даёт fail-closed поведение для любого неожиданного permission prompt. На более ранней поддерживаемой версии можно использовать точный `--allowedTools` только для Loomrail MCP tools: это разрешает сам вызов транспорта, но решение о файловой/командной операции всё равно принимает Loomrail. `--dangerously-skip-permissions` / `bypassPermissions` недопустимы. Если нужен provider-native диалог, `--permission-prompt-tool` направляет его в MCP host, где решение сначала фиксируется доменной транзакцией.

### Auth и окружение

`claude auth login` открывает браузерный вход, а `claude auth status` даёт машинно-читаемый status и exit code. Claude Code поддерживает вход через Claude.ai subscription ([authentication](https://code.claude.com/docs/en/iam)).

Официальная документация также говорит, что `ANTHROPIC_API_KEY` в environment меняет выбор авторизации. Поэтому дочерний процесс в subscription-only режиме должен получать минимальную allowlisted environment, из которой удалены:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`;
- другие provider tokens/credentials;
- значения, импортированные из `.env`;
- переменные, способные переопределить config/auth/backend, если они не прошли отдельную allowlist.

При этом HOME/keychain context, нужный самому CLI для его штатного credential store, должен сохраняться платформенно корректным способом. Loomrail не получает содержимое credential store.

Первый системный `claude` оказался версией 2.1.114 и честно не прошёл version gate. После активации сохранённого
Node 24 runtime обычный `PATH` выбрал уже установленный Claude Code 2.1.260 с документированным `--restricted`;
Loomrail ничего не устанавливал и не обновлял. Локальный probe подтвердил Codex CLI 0.153.4 и Claude Code 2.1.260,
оба с существующей subscription-authentication и без API-ключа приложения. Личные пути и account fields не
фиксировались.

Focused owner-approved dogfood выявил две важные несовместимости предполагаемых «самых строгих» флагов с реальными
tool calls. У Codex GPT-5.6 MCP metadata оказалось доступно через code mode: общий code-mode host остался выключен,
но точные `mcp__<session>` namespaces пришлось объявить direct-only; non-interactive `codex exec` также потребовал
автоматического acknowledgement только для уже закрытого `enabled_tools` списка. У Claude `--safe-mode` отключил и
явный custom MCP, поэтому безопасный профиль использует `--restricted` + empty settings + strict MCP + empty
built-ins + exact allowed tools без safe mode. После этих уточнений оба CLI реально выполнили IMPLEMENT read/write и
QA read-only через Loomrail proxy/executor в temporary workspace с пробелами и Unicode.

### Cancellation и errors

Официальный headless guide описывает:

- SIGINT завершает текущий turn;
- SIGTERM даёт exit 143, оставляет незавершённый turn resumable и завершает process tree запущенных Bash-команд;
- stream содержит typed `system/api_retry` с категориями auth/rate-limit/overloaded и т. п.

Loomrail должен сначала посылать graceful interrupt, затем SIGTERM/платформенный эквивалент с deadline и только потом hard kill. Exit code и structured events маппятся в typed errors; stderr string parsing остаётся последним diagnostic detail, не branching API.

### Budget semantics

Claude даёт hard `--max-turns` и `--max-budget-usd`, но не документирует hard token cap для subscription-запуска. Более того, документация называет cost в JSON оценкой клиента, которая может отличаться от фактической. Поэтому `--max-budget-usd` нельзя выдавать пользователю за точный token cap или API spend control подписки.

Честная кросс-провайдерная модель:

- hard: wall-clock, turns, tool calls, command duration, output bytes, workspace mutation count;
- observed: input/output/cache tokens из provider events;
- interrupt: при достижении доменного token budget, с явно документированным риском overshoot уже выполняющегося model call;
- provider-native budget: дополнительная защита, не источник правды.

Если продукт требует математически точный token cap без overshoot, Claude Code subscription runtime не удовлетворяет этому требованию и должен оставаться blocked. Это продуктово-архитектурное решение, а не повод скрыто переключаться на API.

## Похожие open-source оркестраторы

### Vibe Kanban

[Vibe Kanban](https://github.com/BloopAI/vibe-kanban) просит пользователя сначала авторизовать предпочитаемый coding agent, затем создаёт рабочие пространства/ветки и запускает Codex или Claude. Это подтверждает subscription-first UX.

Codex executor запускает App Server, передаёт `cwd`, sandbox/approval policy, читает account status, сохраняет/resume thread и обрабатывает typed command/file approvals ([Codex executor](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executors/codex.rs)). Claude executor запускает `claude -p` со stream-json и permission prompt tool через stdio/MCP ([Claude executor](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executors/claude.rs)).

Полезный паттерн: structured provider adapters и persisted opaque session ids. Ограничение: проект закрепляет версии через `npx -y`; это даёт воспроизводимость, но добавляет автоматическую загрузку executable и supply-chain/network поверхность. Для Loomrail лучше использовать обнаруженный локальный бинарник с явной проверкой совместимости и отдельным, видимым пользователю обновлением.

### Warpforge

[Warpforge](https://github.com/warpforgehq/warpforge) прямо заявляет, что не создаёт отдельный account/API-key слой: он находит локальные agents, а авторизация остаётся у CLI. Для унификации Claude/Codex он использует ACP adapters, worktrees и durable daemon.

[Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview) — первичный открытый JSON-RPC протокол с capability negotiation, session new/load/resume/cancel, MCP config, client-owned file/terminal methods и permission requests. [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup) требует absolute paths и передаёт `cwd`; [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) имеют typed lifecycle и permission options.

ACP — перспективный provider-neutral transport, но не security boundary: спецификация говорит, что root должен служить границей, а фактические возможности зависят от adapter/agent. Raw input/output в tool calls также нельзя автоматически сохранять. Для текущего Loomrail нативные протоколы дают меньше промежуточных зависимостей; ACP можно добавить позднее как третий adapter, не меняя доменный контракт.

### AWO

[AWO](https://github.com/ystepanoff/awo) использует тонкие CLI adapters: Claude запускается как локальный CLI, Codex — через `codex exec`; prompt идёт через stdin, применяются таймауты ([agents implementation](https://github.com/ystepanoff/awo/blob/main/internal/agents/agents.go)). Writer Codex получает `workspace-write`, reviewer — `read-only`; dangerous bypass не включается автоматически.

Его [safety model](https://github.com/ystepanoff/awo/blob/main/docs/safety.md) полезно отделяет worktree confinement, deterministic verification, artifacts и human review, но честно признаёт, что worktree не sandbox, а verification commands имеют shell authority. Для Loomrail отсюда стоит взять раздельные роли writer/reviewer и детерминированные exit codes, но не считать worktree достаточной изоляцией.

### Claude Squad

[Claude Squad](https://github.com/smtg-ai/claude-squad) оркестрирует несколько терминальных agents через tmux и git worktrees. Это простой жизнеспособный паттерн параллелизма и наблюдаемости, но не глубокий API: provider output/approvals остаются терминальными, а безопасность зависит от переданной CLI command line. README всё ещё описывает API-key onboarding для Codex, поэтому его нельзя копировать как актуальный product contract.

Общий вывод по репозиториям: большинство существующих решений доверяют provider CLI и worktree сильнее, чем позволяет threat model Loomrail. Их полезные идеи — reuse local auth, explicit session ids, structured protocols, worktree concurrency, visible terminal/diff. Их ограничения — shallow string adapters, terminal heuristics, auto-download pinned CLIs, provider-owned mutation path и отсутствие единой durable idempotency boundary.

## Предлагаемый минимальный глубокий контракт Loomrail

Provider adapter должен быть узким и не раскрывать Codex JSON-RPC или Claude stream-json:

```ts
type LocalAgentRuntime = {
  probe(): Promise<Result<RuntimeCapability, RuntimeError>>;
  start(input: StartRun): AsyncIterable<RuntimeEvent>;
  resume(input: ResumeRun): AsyncIterable<RuntimeEvent>;
  cancel(input: CancelRun): Promise<Result<void, RuntimeError>>;
  respondToApproval(input: ApprovalDecision): Promise<Result<void, RuntimeError>>;
};
```

Нормализованные `RuntimeEvent`:

- `message_delta` / `message_completed`;
- `tool_requested` с provider-opaque call id и уже runtime-validated Loomrail operation;
- `approval_required`;
- `usage_updated`;
- `quota_limited`;
- `completed`;
- `interrupted`;
- `failed` с typed category.

Контракт не должен включать raw provider payload, provider-specific tool schema, shell command string как универсальную абстракцию или mutation result, которому домен обязан поверить.

Executor принимает только собственный discriminated union Loomrail (например read/write/patch/run с явной permission class), canonical workspace handle, deadline, byte limit и idempotency key. Поток решения:

1. Adapter валидирует provider frame и преобразует provider tool call в Loomrail operation.
2. Domain проверяет phase, gate, budget, permission и expected workflow version.
3. Durable transaction фиксирует approval/intent/audit/idempotency record.
4. Executor повторно проверяет canonical path/argv и выполняет операцию.
5. Durable transaction фиксирует ограниченный/redacted result и domain transition.
6. Adapter возвращает provider-specific tool result только в живой process stream.

## Обязательные меры запуска процесса

- Разрешать executable только из обнаруженного и подтверждённого пути; показывать версию/источник пользователю.
- Передавать argv массивом, никогда не собирать shell command line.
- Задавать `cwd` canonical workspace root.
- На Windows корректно обнаруживать `.exe`/`.cmd` и управлять Job/process tree; на macOS учитывать app-bundled binary и symlink resolution.
- Работать с пробелами и Unicode в пути как с нативными path values, не с quoting convention.
- Давать child process минимальную allowlisted environment; удалять API keys, токены и `.env` values.
- Ограничивать размер одного frame, stdout/stderr и суммарный сохранённый diagnostic tail.
- Иметь startup/idle/turn/tool/total deadlines.
- Проверять canonical root и target до и после открытия; запрещать traversal, symlink/junction/reparse-point escape и TOCTOU насколько позволяет платформа.
- Не давать network/shell/file authority через provider config, который Loomrail не создал для этого запуска.
- Не логировать prompt, raw response, MCP arguments/result или command environment по умолчанию.

## UX onboarding и состояния

Нормальный пользовательский путь не содержит API key:

1. «Использовать локальный Codex» / «Использовать локальный Claude Code».
2. Автоматическая проверка: найден ли CLI, поддерживается ли версия, есть ли вход, доступен ли безопасный профиль.
3. Если не найден: официальная инструкция установки.
4. Если не выполнен вход: конкретная команда `codex login` или `claude auth login`, затем «Проверить снова».
5. Если версия старая: «Обновите Claude Code: текущая версия не умеет безопасный ограниченный запуск»; IMPLEMENT/QA остаётся blocked.
6. Перед первой mutation: понятный approval с workspace, классом операции и сроком действия (`once`, `for this turn`, если разрешено политикой).

Состояния интерфейса должны быть различимы без raw JSON:

- `runtime_not_installed`;
- `authentication_required`;
- `runtime_version_unsupported`;
- `runtime_capability_missing`;
- `ready`;
- `waiting_for_approval`;
- `permission_denied`;
- `quota_limited` с reset time, если provider его дал;
- `budget_limited`;
- `interrupted`;
- `protocol_failed` / `provider_failed` / `executor_failed`;
- `recovery_required`.

Ни одно из этих состояний не должно автоматически переключать provider на платный API или превращаться в synthetic success.

## Решения, которые нужно зафиксировать в ADR/spec

1. Продукт работает local-subscription-first; API-key providers удаляются из обязательного onboarding и не являются fallback.
2. Нативные provider протоколы остаются внутри адаптеров: текущий slice использует Codex `exec` JSONL/MCP и Claude
   stream-json/MCP; переход Codex на App Server не меняет executor/domain contract.
3. Claude IMPLEMENT/QA требует `--restricted`; неподдерживаемая версия блокируется.
4. Provider sandbox и worktree — defense-in-depth, Loomrail executor/domain остаются источником разрешений.
5. Token budget имеет честную семантику: hard там, где runtime гарантирует; иначе observed + interrupt с возможным overshoot. Hard cross-provider limits задаются также в turns/time/tools/output.
6. Auth storage никогда не читается Loomrail; используются только CLI status/account methods.
7. Raw provider payload не сохраняется; recovery основан на domain/audit/idempotency state и opaque provider session id.
8. Auto-download/auto-update CLI не выполняется: пользователь явно устанавливает/обновляет доверенный runtime.

## Минимальная матрица проверок

- Codex: installed/not installed, ChatGPT login/no login, compatible/incompatible handshake, approval accept/decline/cancel, sandbox denial, typed usage/quota/error, interrupt, restart/resume.
- Claude: installed/not installed, `claude.ai` login/no login, version before/after `--restricted`, project hooks/MCP не загружаются, built-ins недоступны, только Loomrail MCP tools доступны, max turns, interrupt/process tree, restart/resume.
- Оба: whitespace/Unicode workspace, macOS symlink и Windows junction/reparse escape, traversal, absolute path outside root, stdout/frame overflow, malformed/unknown JSON, secret-like output redaction, duplicate tool call/idempotency replay, crash between intent and result, no API-key environment, no raw payload in DB/log/audit.
- E2E: понятные `authentication_required`, `version_unsupported`, `waiting_for_approval`, `permission_denied`, `budget_limited`, `interrupted`, `failed`, `recovery_required`; ни один blocked/error path не становится passed.

## Итог

Целевой пользовательский контракт достижим без API-ключей Loomrail: пользователь один раз устанавливает и
авторизует Codex CLI/Claude Code CLI, а Loomrail подключается к локальному runtime. Focused macOS dogfood подтвердил
реальный IMPLEMENT/QA у обоих providers через bounded executor. Для Claude путь требует жёсткого version gate на
`--restricted`; для Codex — exact direct-only MCP namespace и closed tool acknowledgement. Полный private workflow и
Windows evidence всё ещё нужны до release claim.
