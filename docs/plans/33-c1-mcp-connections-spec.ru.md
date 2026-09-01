# C1 — MCP-подключения для provider sessions

**Дата:** 2026-08-31
**Статус:** active specification
**Предыдущий checkpoint:** B3+B2 и Project provider selection реализованы
**Следующий checkpoint:** C3, встроенный профиль Context7

## 1. Цель

Владелец Project может сохранить локальный MCP server, увидеть точную команду запуска, явно подтвердить её и
разрешить закрытый набор tools для новых ProviderSession. Loomrail, а не provider CLI, остаётся владельцем
конфигурации, запуска server process, разрешений, лимитов, аудита и recovery.

C1 не превращает MCP в новый источник workflow truth. WorkItem, StageAttempt, HumanRequest, Decision, budgets и
acceptance по-прежнему меняются только командами Loomrail.

## 2. Граница

### В C1

- project-scoped versioned MCP Connection Profiles;
- только local `stdio` servers;
- двухшаговое создание: Proposal → точный owner Consent;
- неизменяемая Profile Revision и её digest;
- отдельный MCP Grant с allowlist tool names и явным enable/disable;
- executable preflight без запуска server до Consent;
- bounded capability probe после Consent;
- snapshot конкретных revisions/grants при старте ProviderSession;
- daemon-owned stdio gateway и локальный одноразовый proxy connector;
- provider-native injection только proxy connector, без чтения ambient MCP config;
- bounded redacted audit tool calls и typed unknown outcome;
- немедленный fail-closed для отозванного grant на gateway;
- RU/EN, keyboard, light/dark и честные unavailable/error states.

### Не в C1

- Streamable HTTP, legacy HTTP+SSE, OAuth и browser redirect;
- MCP Registry, поиск и one-click install;
- `npx`, `npm exec`, `pnpm dlx` или другая implicit download/install;
- shell command strings, pipes, redirection, command substitution и privilege elevation;
- env values, secrets или credential material в profile/API/SQLite/Event;
- provider-wide/user-wide MCP config;
- Roots как filesystem ACL;
- prompts/resources как permission source;
- автоматическое расширение tool allowlist после capability change;
- автоматический retry потерянного tool call;
- произвольный side-effect tool, автоматически одобренный Loomrail;
- remote workers, plugins и Context7 preset — они используют этот контракт позднее.

## 3. Ubiquitous language

### MCP Profile Proposal

Невыполняемый candidate exact `stdio` launch: display name, абсолютный executable, argv и заявленные tool names.
Proposal короткоживущий и не даёт права spawn.

### MCP Connection Profile Revision

Неизменяемая project-scoped ревизия exact `stdio` launch с canonical digest. Изменение executable, argv или заявленной
surface создаёт новую revision.

### MCP Consent

Неизменяемое owner Decision, подтверждающее exact rendered launch и digest одной Profile Revision. Consent разрешает
bounded preflight и launch server, но не выдаёт tool grant сам по себе.

### MCP Capability Snapshot

Короткоживущее наблюдение bounded preflight: protocol era/version и имена prompts/resources/tools. Server content и
descriptions остаются untrusted; snapshot не расширяет права.

### MCP Grant

Versioned project permission, связывающий consented Profile Revision с закрытым allowlist tool names. Grant действует
для новых session snapshots; revoke блокирует новые calls через gateway и не переписывает audit.

### MCP Session Snapshot

Неизменяемая копия revision digest и grant, назначенная одной ProviderSession. Она доказывает, что именно было
доступно session, даже если Project Settings позже изменились.

### MCP Tool Call Record

Redacted audit одной попытки вызвать tool: session, profile revision, tool name, input digest, started/finished time и
typed outcome. Raw secret-like input/output в Event или SQLite не попадает.

## 4. Решения

### D1 — project-scoped, revisioned и двухшаговый Consent

HTTP proposal может принять candidate только для валидации и рендера. Он не сохраняет active profile и ничего не
запускает. Daemon возвращает one-time challenge, canonical digest и точный display всех argv elements. Отдельная
authenticated + Origin + CSRF команда подтверждает тот же challenge/digest и атомарно создаёт immutable revision,
Consent и Event.

Challenge живёт только в памяти, истекает через 5 минут и потребляется один раз. Повтор, несовпадающий digest или
изменённый Project version отклоняются.

### D2 — closed validation, no shell

Candidate проходит runtime schema и policy:

- executable — абсолютный path к обычному executable file;
- на Windows canonical executable должен оканчиваться на `.exe` или `.com`; `.cmd`, `.bat` и произвольные обычные
  файлы не проходят closed preflight и не передаются в `spawn({ shell: false })`;
- максимум 32 args, каждый не пустой, не длиннее 2 KiB; общий rendered launch не длиннее 16 KiB;
- profile name и tool names имеют bounded Unicode/ASCII-safe формы;
- executable basename `npx`, `npm`, `pnpm`, `yarn`, `bunx`, shell, PowerShell, `cmd`, `sudo`, `doas` и известные
  download/install launchers запрещены в C1;
- API не принимает cwd, URL, headers, env, secret, shell mode или permission-bypass fields;
- argv передаётся массивом и никогда не соединяется в shell string.

Абсолютный `node`/`python` допустим только когда script/module path тоже абсолютный и является отдельным argv element;
Consent показывает оба path полностью. Это не доказывает безопасность кода — owner подтверждает локальный process с
правами своей учётной записи.

### D3 — Consent и Grant разделены

Consent разрешает запустить exact server для bounded probe. Grant разрешает provider session увидеть только выбранные
tool names. Capability Snapshot не может сам создать или расширить Grant. Tool исчез — session получает typed
unavailable. Появился новый tool — он остаётся скрытым до новой versioned Grant command.

C1 разрешает только tools, которые owner явно классифицировал как `READ_ONLY`. Это attestation, а не доказательство:
malicious executable может лгать о semantics и выполнять side effects уже при старте. UI говорит это прямо.

### D4 — daemon-owned gateway, не direct injection

Provider CLI получает конфигурацию одного или нескольких Loomrail proxy connectors. Каждый connector имеет
session/profile-scoped random token и loopback endpoint. Proxy передаёт JSON-RPC gateway внутри daemon; daemon запускает
реальный stdio server как свой child, валидирует и ограничивает wire, применяет Grant и пишет audit.

Direct injection exact server command в Codex/Claude отвергнута: provider тогда владеет process, вызовы обходят
Loomrail и revoke/audit/recovery становятся заявлениями без enforcement. Решение подробно в ADR-0005.

### D5 — provider isolation остаётся закрытой

- Codex продолжает `--ignore-user-config`; C1 добавляет только allowlisted `-c mcp_servers.loomrail_<id>.*` assignments
  для proxy command/args/enabled_tools.
- Claude Code получает generated temporary JSON только с proxy connectors, `--mcp-config <path>` и
  `--strict-mcp-config`; ambient `.mcp.json`/user MCP config не используется.
- Ни один adapter не получает raw real-server executable/argv.
- Permission-bypass flags, `--tools`, `--settings`, `--add-dir` и arbitrary Codex `-c` остаются запрещены.
- ProviderInvocation получает только typed `mcpConnections`; отсутствие поля не означает ambient/default connections.

Reconnaissance 2026-08-31: local Codex `0.151.0-alpha.7.2` не имеет `--mcp-config`, но принимает
`mcp_servers.<name>.command|args|enabled_tools` через `-c`; Claude Code `2.1.114` документирует `--mcp-config` и
`--strict-mcp-config`. Версии — evidence, не compatibility guarantee; adapter tests фиксируют argv interface.

### D6 — bounded wire и capability probe

Gateway использует official TypeScript SDK v2 через один internal seam и negotiation `auto`. Probe имеет отдельный
server process, deadline 5 s, максимум 1 MiB на line, 4 MiB aggregate output и закрытые counts: 64 tools, 64 resources,
64 prompts. Descriptions обрезаются и не входят в permission decisions.

Unsupported/legacy protocol, timeout, invalid JSON, flood и early exit дают typed state. Probe process всегда закрыт до
возврата результата. Никакой probe до Consent.

### D7 — вызов, audit и recovery

Gateway пропускает только granted tool names одной session/profile binding. Arguments runtime-валидируются по
объявленной schema с size/depth limits. Перед forward создаётся durable call record `STARTED`; после ответа —
`SUCCEEDED|FAILED`. Потеря server/daemon после forward оставляет `UNKNOWN_OUTCOME`.

`UNKNOWN_OUTCOME` никогда не ретраится автоматически, даже если tool заявлен read-only. Owner может запустить новую
StageAttempt после проверки внешнего состояния. Audit хранит digest и bounded metadata, не raw payload.

### D8 — lifecycle и revoke

- Profile Revision immutable; edit создаёт новый Proposal/Revision/Consent.
- Grant enable/disable optimistic-versioned и durable.
- ProviderSession atomically stores MCP Session Snapshots вместе с session start state/event.
- Revoke запрещает новые gateway calls сразу; active in-flight call получает recorded outcome, но не повторяется.
- Session end/abort закрывает connectors, stdin real servers, затем TERM/grace/KILL process tree.
- Startup reconciliation помечает unfinished calls `UNKNOWN_OUTCOME` и убивает известные orphan server processes до
  восстановления workflow.

### D9 — UI

Project Settings показывает:

- Profiles и их revision/consent/grant state;
- exact executable и каждый argv element отдельной строкой;
- предупреждение «это запустит локальный process с вашими правами»;
- declared/discovered/granted tool names как разные списки;
- provider support, last probe state и session applicability;
- действия Propose, Confirm exact command, Probe, Grant/revoke;
- никакого secret/env input в C1.

Danger action требует explicit checkbox, keyboard reachable focus и server-issued challenge. Color не является
единственным state signal. Light/dark и RU/EN равноправны.

## 5. Domain transitions

Allowed:

```text
candidate → Proposal challenge
Proposal challenge + exact digest + owner → consented Revision
consented Revision → Capability Snapshot
consented Revision + owner tool allowlist → enabled Grant
enabled Grant → disabled/revoked Grant
enabled Grant + ProviderSession start → MCP Session Snapshot
```

Forbidden:

- spawn/probe from Proposal;
- consent stale/used/expired/mismatched challenge;
- grant without Consent or for tools absent from declared/discovered intersection;
- in-place edit of Revision;
- enable a revoked Revision;
- session using latest revision by lookup after its snapshot was created;
- ungranted tool call;
- automatic mutation retry after disconnect;
- browser payload containing URL/env/secret/cwd/shell/provider flags;
- provider ambient MCP config contributing a connection.

## 6. Persistence

Новые таблицы должны разделять неизменяемые facts и current projection:

- `mcp_profile_revisions` — immutable launch recipe + digest;
- `mcp_consents` — immutable owner consent;
- `mcp_capability_snapshots` — immutable bounded observations;
- `mcp_grants` — versioned current permission rows;
- `provider_session_mcp_snapshots` — immutable session binding;
- `mcp_tool_calls` — append/update only through typed lifecycle with terminal-state guard.

Dynamic values идут только в prepared statements. Proposal challenges и raw tool payload не хранятся. Profile/Grant
command writes state, Event, durable follow-up и receipt в одной short transaction.

## 7. HTTP surface

Project-scoped authenticated routes:

- `GET /api/v1/projects/:projectId/mcp-profiles`;
- `POST /api/v1/projects/:projectId/mcp-profile-proposals`;
- `POST /api/v1/projects/:projectId/mcp-profile-proposals/:challengeId/confirm`;
- `POST /api/v1/projects/:projectId/mcp-profiles/:revisionId/probe`;
- `PUT /api/v1/projects/:projectId/mcp-profiles/:revisionId/grant`;
- `DELETE /api/v1/projects/:projectId/mcp-profiles/:revisionId/grant`.

Mutation routes требуют session, exact Origin, CSRF и JSON. Confirm/Grant используют expected Project version.
Ни один launch route не принимает executable/argv: probe и session resolve revision server-side by id.

## 8. Acceptance

- Proposal никогда не spawn-ит process и истекает/потребляется one-shot.
- Consent создаёт immutable revision и Event с digest, без secret/raw output.
- Ambient provider MCP config не подключается ни на одном path.
- Codex/Claude получают только proxy connectors и закрытые tool allowlists.
- Real server process принадлежит daemon и завершается при session end/restart recovery.
- Ungranted tool call физически не достигает server.
- Call audit переживает restart; uncertain call становится `UNKNOWN_OUTCOME`, не retry.
- Profile edit/revoke не меняет historical session snapshot.
- Windows paths with spaces/non-ASCII, macOS, RU/EN, keyboard, light/dark покрыты tests.
- `pnpm verify` и full E2E зелёные, кроме отдельно принадлежащей landing-сессии, если её текущий lint gate ещё не слит.
