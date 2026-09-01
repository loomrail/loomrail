# C1 MCP connections: первичное исследование

Дата среза: 2026-08-31. Источники: только актуальная спецификация и документация MCP, официальный TypeScript SDK и официальные справочники OpenAI Codex CLI / Anthropic Claude Code.

## Вывод для Loomrail

Безопасный объём C1 — **локальные, явно сохранённые MCP-профили со `stdio`**, которые Loomrail передаёт конкретному provider adapter при запуске provider session. Daemon остаётся владельцем конфигурации, разрешений, approval, лимитов и аудита; MCP-сервер и provider session лишь сообщают возможности и выполняют разрешённые вызовы. Remote Streamable HTTP, OAuth, автоматическая установка серверов и произвольные команды из UI/API следует оставить будущей фазе.

Это особенно важно для архитектуры Loomrail: официальная [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) прямо рассматривает локальный proxy, который запускает `stdio` child process, как путь от компрометации web-клиента к выполнению произвольного кода. Поэтому API daemon не должен принимать `command`, `args` или `env` для запуска «на лету»: только ID ранее подтверждённого профиля и серверная загрузка его неизменяемой ревизии.

## Актуальный протокол и lifecycle

Текущая стабильная ревизия — [`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28); её статус виден в [официальных releases](https://github.com/modelcontextprotocol/modelcontextprotocol/releases). Она создаёт новую, stateless-эру протокола:

- `initialize` / `initialized` и protocol session удалены; каждый запрос несёт protocol version, client capabilities и, при наличии, client identity в `_meta` ([versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
- Современный сервер обязан реализовать [`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) и вернуть поддерживаемые версии и capabilities. `serverInfo` — самодекларация, не проверенная идентичность; её нельзя использовать для trust/permission decisions.
- Версии до и включая `2025-11-25` образуют legacy-эру с `initialize`. Совместимый клиент сначала ограниченно пробует `server/discover`, а при неподдерживаемом методе/таймауте переходит к legacy handshake. Unsupported modern version возвращается как `-32022` со списком поддерживаемых версий.
- Capabilities — согласованный контракт на wire, но не разрешения продукта. Host обязан изолировать соединения и управлять consent/authorization; каждый MCP client связан ровно с одним server ([architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)).

Следствие: Loomrail хранит отдельно `configuredRevision`, последний `discoveredProtocolEra/version/capabilities` и собственный `permissionPolicy`. Discovery — диагностический snapshot с TTL, а не источник истины; изменение списка/capabilities не расширяет права без новой команды и approval.

## Транспорт

| Транспорт                                                                                                    | Контракт спецификации                                                                                                                                                                                                                                              | Решение для Loomrail                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`stdio`](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)                   | Клиент запускает server child process; stdin/stdout содержат только newline-delimited JSON-RPC, stderr доступен для логов. При shutdown клиент закрывает stdin, ждёт, затем при необходимости завершает процесс.                                                   | Единственный транспорт C1. Spawn без shell, точные executable/argv, очищенный env, timeouts и output bounds; daemon владеет process tree. Нельзя автоматически повторять потерянный non-idempotent tool call после crash. |
| [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) | В современной ревизии каждый запрос — отдельный POST; ответ JSON или request-scoped SSE. Сервер обязан проверять `Origin`, а локальный endpoint следует bind только на localhost и защищать авторизацией. Protocol sessions, GET endpoint и resumable SSE удалены. | Не C1. Вводит сеть, SSRF/DNS-rebinding, bearer/OAuth, redirect и token-storage boundaries. Legacy HTTP+SSE не использовать для новой интеграции.                                                                          |

Спецификация говорит, что клиент _может_ повторить потерянные in-flight запросы после неожиданного завершения `stdio`. Для Loomrail безопаснее более строгая политика: повторять только явно idempotent read/list и лишь через детерминированную recovery-команду; mutation tool call переводить в `unknown_outcome` с ручным решением.

## Primitives и границы доверия

| Primitive                                                                              | Кто управляет                                                  | Что требуется в C1                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)     | User-controlled selection; сервер возвращает шаблон/сообщения. | Считать текст и embedded content недоверенными, валидировать arguments/result, показывать источник; prompt не может менять workflow, permissions или approval.                                                                                                            |
| [Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) | Application-driven context по URI.                             | Allowlist schemes/servers, валидировать URI и размер/MIME; для `file://` нормализовать path и проверять реальную проектную границу. Подписки/listChanged не являются состоянием продукта.                                                                                 |
| [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)         | Model-controlled action.                                       | Allowlist на уровне connection + tool, runtime-валидация `inputSchema` и `outputSchema`, timeout/rate/output limits, видимый exact input для чувствительных операций, approval перед side effect и полный redacted audit. Returned `structuredContent` тоже недоверенный. |
| [Roots](https://modelcontextprotocol.io/specification/2026-07-28/client/roots)         | Клиент сообщает серверу предполагаемые filesystem roots.       | Не внедрять: feature deprecated с `2026-07-28`, новые реализации SHOULD NOT adopt. Roots информационны и никогда не были ACL; проектную границу обеспечивает Loomrail/sandbox, а не MCP.                                                                                  |

Современный MCP stateless. Если tool возвращает handle для продолжения операции, владение handle должно проверяться при каждом вызове; знание handle не является аутентификацией. Это же правило применимо к привязке MCP state к `projectId/runId/principal` Loomrail.

## Security и authorization

Для локального `stdio` official guidance требует показывать **точную** запускаемую команду без сокращений и получать явное согласие; server работает с правами клиента и должен быть ограничен filesystem/network sandbox там, где это возможно ([local server compromise](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#local-mcp-server-compromise)). Практический baseline C1:

1. Профиль создаётся отдельной authenticated + CSRF-protected командой, содержит абсолютный/однозначно разрешённый executable и массив argv; shell, command substitution, `npx`/другая implicit download/install и privilege-elevation запрещены.
2. Environment формируется allowlist-ом. Секрет — только ссылка на credential profile/OS secret storage; значения не попадают в DB, events, logs или provider transcript.
3. UI показывает executable, все args, рабочий каталог, filesystem/network grants и заявленные tools. Изменение ревизии профиля требует нового consent.
4. Daemon разрешает spawn только из внутреннего command handler по сохранённому profile revision, с project/run binding, concurrency/budget limits и redacted structured audit. Browser/WebSocket никогда не передают spawn payload напрямую.
5. Server descriptions, prompt/resource/tool content, errors, links и capabilities считаются untrusted input. URL нельзя открывать через shell.

[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) относится к HTTP и необязательна; для `stdio` спецификация говорит не применять этот OAuth flow, а получать credentials из environment. Значит OAuth не нужен C1.

Для будущего remote HTTP нужны отдельные threat-model/ADR и реализация полного resource-server flow: Protected Resource Metadata и authorization-server discovery, PKCE S256, exact redirect/state validation, минимальные scopes, secure/rotating token storage, `resource` indicator и проверка audience при каждом запросе. Token passthrough запрещён; downstream API должен получать отдельный token. Обязательны HTTPS (кроме настоящего loopback), SSRF-защита discovery/redirect на каждом hop, защита от DNS rebinding/mix-up/confused-deputy и безопасное открытие auth URL без shell ([authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations), [security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)).

## Official TypeScript SDK: совместимость на 2026-08-31

Официальный Tier 1 [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) имеет стабильную v2 line `2.0.0`, выпущенную 2026-07-27, и legacy `@modelcontextprotocol/sdk` `1.30.0` ([releases](https://github.com/modelcontextprotocol/typescript-sdk/releases), [roadmap](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md)). v2 требует Node `>=20`, публикует ESM и CJS, реализует `2026-07-28` и legacy wire до `2025-11-25`; conformance CI проверяет обе ревизии. Experimental tasks SEP-1686 из v2 исключены. Пакеты `core/client/server/server-legacy/codemod` версионируются одной группой; `/internal` не имеет compatibility guarantee ([versioning policy](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/VERSIONING.md), [client package](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/package.json)).

Важные интеграционные детали:

- `Client` v2 по умолчанию всё ещё делает legacy handshake. Для modern+legacy нужен явный `versionNegotiation: { mode: "auto" }`, либо pin на `2026-07-28`. На `stdio` auto-probe запускается в disposable sibling process — его надо учитывать в consent, process accounting и tests; не выполнять скрыто на каждый provider run ([protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)).
- Для запуска собственного modern `stdio` server v2 использует `serveStdio(factory)`; прямое `new StdioServerTransport()` + `connect()` — legacy wiring ([stdio serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md)).
- HTTP helper создаёт свежий server на каждый request, но security middleware/host/origin/token policy остаются обязанностью приложения ([HTTP serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)). Это ещё одна причина не включать remote transport в C1.

SDK полезен daemon для bounded preflight/discovery и, позднее, прямого MCP host. Он сам по себе не подключает MCP к Codex/Claude: точная передача профиля provider session остаётся обязанностью provider adapter и должна использовать только документированный provider-specific mechanism.

## Non-interactive preflight provider CLI

| Provider              | Без запуска agent session                                                                                 | Официальные exit/output guarantees                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Политика Loomrail                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI Codex CLI      | `codex login status`; для ручной расширенной диагностики — стабильный `codex doctor --json`.              | [`login status`](https://developers.openai.com/codex/cli/reference#codex-login-status) печатает активный auth mode и гарантирует exit `0`, когда credentials присутствуют. Для отсутствия credentials отдельные nonzero-коды и machine-readable schema не документированы. [`doctor --json`](https://developers.openai.com/codex/cli/reference#codex-doctor) выдаёт redacted report, но справочник не обещает стабильную JSON schema/exit taxonomy. В официальном reference нет контракта для `codex --version`. | Spawn-error означает «binary unavailable»; exit `0` login status — только `credentials_present`. Любой другой результат — typed `auth_unknown/not_ready` с redacted diagnostic, без парсинга human text. `doctor` не hot-path probe. |
| Anthropic Claude Code | `claude auth status` (JSON по умолчанию, `--text`); `claude --version` / `-v`; read-only `claude doctor`. | [CLI reference](https://code.claude.com/docs/en/cli-reference) гарантирует для `auth status`: exit `0` logged in, `1` not logged in. `--version` выводит номер версии; отдельная exit taxonomy/JSON schema не заявлена.                                                                                                                                                                                                                                                                                          | Использовать `auth status` как typed local auth preflight и отдельно сохранить raw version string с length/charset bounds. `doctor` — только пользовательская диагностика.                                                           |

Обе проверки сообщают локальный login/credential status, но официальные страницы не обещают live-проверку entitlement, quota или доступности API. Они не заменяют запуск сессии и её typed startup failure. Также current references не задают минимальную историческую версию CLI, в которой команды появились: нельзя объявить совместимость только по semver. Adapter должен capability-probe команду с коротким timeout, различать `binary_missing`, `subcommand_unsupported`, `logged_out`, `timeout` и `probe_failed`, а неизвестный output не трактовать как успех.

## Рекомендуемая граница C1

**В C1:** project-scoped versioned connection profiles; только local `stdio`; ручное подтверждение exact spawn; deterministic enable/disable/attach commands; provider-specific injection без чтения пользовательского MCP config; preflight и capability snapshot; allowlist tool/resource/prompt surface; per-call approvals, budgets, audit и recovery; light/dark/keyboard доступный UI состояния.

**Не в C1:** Streamable HTTP/legacy HTTP+SSE, OAuth и browser redirect, Registry discovery/one-click install, arbitrary executable/URL from request, automatic `npx` download, inherited user-wide provider MCP config, Roots как sandbox, silent capability expansion, automatic retry mutation calls, MCP state как workflow truth.

Перед реализацией C1 эти границы нужно закрепить в active spec и обновить threat model минимум для: daemon-as-stdio-proxy/RCE, malicious local server, prompt/tool/resource injection, secret leakage, path escape, process escape/orphaning, stdout flooding, unknown mutation outcome и provider-config isolation.

## Context7 preset: primary-source snapshot на 2026-08-31

Официальный package manifest фиксирует `@upstash/context7-mcp` `3.2.5`, MIT, Node `>=20.18.1` и бинарник
`context7-mcp -> dist/index.js` ([package.json](https://github.com/upstash/context7/blob/master/packages/mcp/package.json)).
Официальный developer guide подтверждает, что локальный default transport — `stdio`, а API key необязателен; типичная
сторонняя установка через `npx` для Loomrail неприемлема, потому что C1 запрещает runtime download
([developer guide](https://github.com/upstash/context7/blob/master/docs/resources/developer.mdx)).

Текущий server source регистрирует ровно `resolve-library-id` и `query-docs`. Оба помечены `readOnlyHint: true`,
`destructiveHint: false`, `openWorldHint: true`, `idempotentHint: true`; описания отдельно запрещают secrets,
credentials, personal data и proprietary code в query
([server source](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts)). Это обосновывает closed
C3 allowlist из двух tools, но не отменяет owner attestation: annotations принадлежат внешнему server и являются
заявлением, а не доказательством.

Вывод для C3: exact package входит в Loomrail release dependencies; daemon резолвит его entrypoint относительно себя
и строит обычный local-stdio C1 Proposal. Никакого `npx`, PATH discovery, remote MCP URL, API key или auto-invoke rule.
