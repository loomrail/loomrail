# Q18 — Enforceable provider token budgets

**Статус:** implementation complete; live-provider capability unavailable; stable gate blocked

**Дата:** 2026-09-06

**Основание:** private RecurKit dogfood, ADR-0012, BD-001

## 1. Измеренный дефект

Codex PLAN session завершилась с 493 700 estimated tokens при immutable AgentRun ceiling 200 000 и pipeline
remainder 329 276. Usage был корректно записан, но terminal event пришёл после расхода. Следовательно, прежний
механизм был stop-after-session guard, а не hard budget.

## 2. Решение

- capability contract получает обязательное `tokenBudgetEnforcement: HARD | POST_SESSION`;
- `ProviderInvocation` получает immutable maximum, уже записанный расход и точный положительный остаток;
- daemon допускает provider start только при `HARD` и отказывает до ProviderSession/process spawn;
- AUTO не выбирает live provider с `POST_SESSION`;
- Settings показывает отдельный статус отсутствия hard token limit;
- Codex и Claude Code объявляют `POST_SESSION`, Mock — `HARD`;
- terminal usage, ledger и атомарная остановка следующей работы сохраняются.

## 3. Проверка

- [x] contract rejects missing/unknown enforcement capability;
- [x] domain returns an actionable owner-visible refusal;
- [x] daemon integration proves adapter `start` is not called and no ProviderSession exists;
- [x] daemon integration proves a HARD adapter receives the immutable AgentRun remainder;
- [x] provider adapters declare measured behavior;
- [x] AUTO excludes POST_SESSION while explicit diagnostics stay visible;
- [x] Settings and CLI startup state plainly that a POST_SESSION provider cannot start a live session;
- [x] stable manifest schema 2 adds a distinct mandatory PENDING hard-token-budget gate;
- [x] focused contracts/domain/provider/daemon/CLI tests pass;
- [x] full `pnpm verify` passes (35 release/system checks + 1 625 Vitest checks = 1 660);
- [x] full Mock browser matrix passes 60/60, including HARD and POST_SESSION provider-selection paths;
- [ ] live Codex/Claude row gains HARD only after exact runtime evidence;
- [ ] live Windows verification remains deferred.

## 4. Stable consequence

Stable publish remains closed. Passing tests cannot substitute for the missing live-provider primitive: the product
may be shared for Mock evaluation, but not represented as a safe live-agent stable release.
