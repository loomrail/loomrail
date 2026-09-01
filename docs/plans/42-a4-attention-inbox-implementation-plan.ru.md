# A4 Global Attention Inbox — implementation plan

**Дата:** 2026-09-01
**Статус:** complete
**Спецификация:** [`41-a4-attention-inbox-spec.ru.md`](41-a4-attention-inbox-spec.ru.md)

## 1. Contracts и deep module

- [x] Добавить closed Attention schemas/types и bounded response contract.
- [x] Реализовать pure `buildAttentionInbox` в domain с одной public interface.
- [x] Покрыть classification, precedence, stable ordering, referential mismatch и bounds.

## 2. Persistence и daemon

- [x] Добавить consistent `GET_ATTENTION_INBOX` query без новой таблицы/миграции.
- [x] Связать open HumanRequest с Project, WorkItem, StageAttempt и optional AcceptancePackage.
- [x] Добавить authenticated `GET /api/v1/attention` и runtime validation.
- [x] Покрыть multi-project, restart, overflow, missing relation и auth.

## 3. Web

- [x] Добавить global query/cache invalidation и sidebar badge всех Project.
- [x] Добавить `/attention` master/detail route с grouped list и keyboard selection.
- [x] Переиспользовать один answer form в Inbox и Task Cockpit.
- [x] Добавить acceptance deep-link к exact Project/WorkItem без generic answer.
- [x] Добавить RU/EN, responsive, loading/empty/error/stale states и semantic tokens.

## 4. Verification

- [x] Focused contracts/domain/persistence/daemon/web tests.
- [x] Browser E2E: two projects, answer/resume, acceptance deep-link, restart and keyboard.
- [x] Light/dark and 320/375/768/1280 px review.
- [x] Threat model, domain context, product decision and user docs updated.
- [x] `pnpm verify`, full E2E, production audit and clean release tarball.
- [x] Commit and push only after gates pass.

## 5. Local evidence

- `pnpm verify` — passed;
- `pnpm test:e2e` — 43/43 passed;
- `pnpm audit --prod` — no known vulnerabilities;
- `pnpm pack:release && pnpm test:release` — `0.1.0-alpha.3` tarball runs from a clean temporary install.
