# C2 — Plugin SDK v1

**Дата:** 2026-08-31
**Статус:** approved implementation boundary
**Зависимости:** C1 MCP Connections, C3 release bundle, PD-012, ADR-0005, ADR-0006

## 1. Результат

Автор локального расширения может собрать типизированный read-only tool plugin, объявить его точную surface в
versioned manifest и запустить отдельным MCP stdio process. Тот же process проходит C1 Consent, capability probe,
owner Grant, daemon proxy, audit, revoke и recovery. Плагин не получает workflow authority.

## 2. Нормативная граница

### В C2

- public npm subpath `loomrail/plugin-sdk` с TypeScript declarations;
- manifest schema v1: identity, version, description, license, relative bundled entrypoint, outbound network claim и
  exact tool metadata;
- helper с inferred Zod input для определения read-only tool;
- helper, который выводит manifest tool list из реальных definitions;
- один stdio host, который валидирует manifest/tool equality и выставляет закрытые MCP annotations;
- bounded text/structured result contract и redacted generic failure;
- synthetic plugin fixture, unit tests, real C1 probe conformance и clean-package test;
- author guide на EN/RU.

### Не в C2

- registry, marketplace, поиск, скачивание, установка, обновление или подписи packages;
- daemon/web installer и persistent catalog metadata;
- remote HTTP/OAuth transport;
- shell strings, arbitrary executable/argv/env/cwd/secrets;
- filesystem write, Git, browser, deployment или side-effect tools;
- resources, prompts, sampling, elicitation и roots;
- hooks для Project/WorkItem/StageAttempt/HumanRequest/Decision/budgets/acceptance;
- доверие к manifest как к OS sandbox или доказательству semantics.

## 3. Ubiquitous language

### Tool Plugin Manifest

Статический JSON-compatible документ schema v1. Manifest описывает compatibility и заявленное поведение, но сам по
себе не даёт право на spawn или tool call.

### Read-only Tool Definition

Типизированная Zod input schema, metadata и handler. SDK, а не author, задаёт MCP annotations
`readOnlyHint=true`, `destructiveHint=false` и запрещает их override.

### Plugin stdio host

Глубокий модуль SDK, который скрывает MCP server lifecycle, runtime validation, result bounds и redacted failure за
одним `serveReadonlyToolPlugin` interface.

### C1 conformance

Факт, что собранный plugin process обнаруживается обычным Loomrail capability probe с точным tool set и без
resources/prompts. Это protocol compatibility, не owner Consent и не Grant.

## 4. Manifest v1

Manifest содержит только:

```text
schemaVersion = 1
protocol = "loomrail.readonly-tools.v1"
id, name, version, description, license
entrypoint = relative .js/.mjs path without traversal
permissions.network = NONE | DECLARED_HOSTS(hostnames[])
tools[] = name, title?, description
```

`id`, tool names, hostname, lengths и counts bounded. Tools и hosts уникальны и canonical-sort. Поля command, args,
cwd, env, token, secret, hooks и arbitrary metadata закрытой schema не принимаются.

## 5. Runtime decisions

1. `defineReadonlyTool` принимает Zod object и сохраняет inferred handler input за opaque definition.
2. `defineReadonlyPluginManifest` получает definitions, поэтому author не может отдельно заявить другой tool list.
3. `serveReadonlyToolPlugin` повторно валидирует manifest и exact name/metadata equality до открытия stdin.
4. SDK регистрирует только tools. Annotations выставляются принудительно; `openWorldHint` отражает только declared
   outbound-host claim, но не считается enforcement.
5. Handler result допускает bounded text content и optional JSON object. Exception/invalid result возвращает generic
   error без stack/message. stdout принадлежит protocol; diagnostics разрешены только через stderr вне SDK.
6. C1 остаётся enforcement seam: даже корректный plugin невидим provider session без Consent + successful probe +
   owner read-only Grant.

## 6. Security acceptance

- plugin code никогда не import-ится daemon process;
- manifest не содержит credential material и не создаёт spawn recipe;
- SDK не запускает shell, downloader или package manager;
- tool definition не может выставить destructive annotations;
- network declaration показывается как claim, а не allowlist enforcement;
- invalid input не доходит до handler;
- thrown error не возвращает stack/raw message;
- synthetic plugin не может изменить Loomrail domain state через SDK interface.

## 7. Release acceptance

- `pnpm --filter @loomrail/plugin-sdk test` green;
- real `@loomrail/mcp-gateway` probe discovers exact fixture tools;
- declarations compile in strict mode;
- packed `loomrail` exposes `loomrail/plugin-sdk` from a clean install;
- macOS and Windows CI green before publication;
- no source change under `apps/landing`.
