# C3 — встроенный Context7 preset

**Дата:** 2026-08-31
**Статус:** approved implementation boundary
**Зависимость:** C1 MCP Connections, PD-010, ADR-0005

## 1. Результат

В Project Settings владелец может начать настройку Context7 без терминала, глобального npm install, `npx`, PATH
discovery или ручного ввода команды. Loomrail строит Proposal из exact-pinned Context7 package, поставляемого вместе
с runtime, и проводит его через обычные C1 consent, probe и Grant.

## 2. Нормативная граница

### В C3

- `@upstash/context7-mcp` — exact production dependency Loomrail, не `latest` и не runtime download;
- executable — текущий абсолютный Node runtime; первый argv — разрешённый абсолютный bundled entrypoint;
- transport — только `stdio`;
- заявленные tools — только `resolve-library-id` и `query-docs`;
- отдельный authenticated + Origin/CSRF-protected endpoint принимает только Project version, не spawn payload;
- UI показывает preset до ручной формы и объясняет внешний network egress;
- существующие C1 Profile Revision, Consent, Snapshot, Grant, proxy, audit и recovery используются без нового state.

### Не в C3

- remote Streamable HTTP, Context7 OAuth/API key, env/secret fields;
- `npx`, global install, auto-update или package download после запуска Loomrail;
- автоматический Consent, probe или Grant;
- запись auto-invoke instruction в `AGENTS.md`, `CLAUDE.md` или provider user config;
- особый tool-call path в обход gateway и C1 budgets/audit.

## 3. UX

Settings показывает компактный Context7 preset:

1. «Проверить встроенный Context7» создаёт одноразовый Proposal на сервере.
2. Owner видит exact executable и каждый argv, включая абсолютный package entrypoint.
3. После Consent обычный probe должен обнаружить оба tool.
4. Owner выбирает tools и подтверждает read-only Grant.
5. Новые ProviderSession получают Context7 через Loomrail proxy; активные session не меняются.

Копирайт прямо говорит: запросы Context7 отправляются во внешний сервис; нельзя включать secrets, персональные данные
или закрытый код. Anonymous limits являются свойством внешнего сервиса, а не ошибкой локальной установки.

## 4. Версионирование и отказ

- Package version exact-pinned в workspace lockfile и release manifest.
- Loomrail не доверяет PATH и резолвит package entrypoint относительно собственного daemon module.
- Missing/malformed bundled package — typed unavailable result/ошибка, а не fallback на `npx`.
- Уже подтверждённый профиль остаётся immutable. Обновление preset создаёт новую revision и требует нового Consent.
- Capability drift не расширяет Grant: неизвестный tool остаётся скрыт.

## 5. Security acceptance

- preset endpoint отклоняет body с executable/args/tools;
- exact command проходит тот же canonical digest и one-shot challenge, что ручной C1 profile;
- package entrypoint является regular file; Node executable и script realpath повторно проверяются перед каждым spawn;
- Context7 получает no API key и no inherited secret env;
- provider видит только Loomrail proxy, не bundled launch recipe;
- outbound query content остаётся untrusted и не становится workflow truth.

## 6. Verification

- unit: deterministic preset candidate, exact tool list, no PATH/npx;
- daemon: CSRF/Origin, closed request schema, proposal uses server-owned candidate;
- gateway: real bundled Context7 capability probe discovers exact two tools without executing a tool call;
- browser: RU/EN, keyboard, light/dark, preset → consent flow;
- release: clean npm install contains Context7 dependency and packaged gateway entrypoints.
