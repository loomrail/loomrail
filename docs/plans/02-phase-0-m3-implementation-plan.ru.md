# Loomrail Phase 0 / M3 — real task cockpit

**Дата:** 2026-08-24
**Статус:** locally complete; Windows CI evidence pending
**Outcome:** browser Workbench управляет настоящими Project/WorkItem из локального SQLite через authenticated daemon,
а не отображает отдельный UI mock

## 1. Scope

M3 соединяет готовое M2-ядро с task-centric интерфейсом:

- authenticated web API client с runtime validation;
- регистрация и переключение двух allowlisted fixture Projects;
- чтение, создание, редактирование и разрешённые state transitions WorkItem;
- optimistic version для update/move и invalidation query cache после mutation;
- audit timeline из append-only Events;
- EN/RU и равноправные light/dark themes;
- Linear-density Workbench, shared controls, keyboard/focus и mobile fallback;
- явный UX для недоступного daemon и завершившейся browser session.

## 2. Security and recovery boundary

Browser не может самостоятельно выпускать новый bootstrap token. При потере in-memory daemon session UI отличает:

- временно недоступный daemon — безопасная повторная попытка без изменения local state;
- `SESSION_REQUIRED`/`CSRF_REJECTED` — инструкция перезапустить Loomrail из terminal, после чего CLI открывает новую
  вкладку с одноразовым bootstrap URL.

Cookie, CSRF и bootstrap token не выводятся в UI, logs или committed artifacts. Reconnect не ослабляет loopback,
Origin, `HttpOnly`, `SameSite=Strict` и CSRF boundaries.

## 3. Persisted editing

Task inspector редактирует только поля, уже разрешённые M2 command contract:

```text
title, description, priority, risk, acceptanceCriteria[]
```

UI отправляет только реально изменённые поля. Daemon проверяет `expectedVersion`, domain отклоняет no-op/stale update,
а SQLite сохраняет новый current state и `WORK_ITEM_UPDATED` Event в одной transaction.

## 4. Verification

- unit tests классифицируют missing/expired session и недоступный daemon;
- browser E2E создаёт, редактирует, перемещает и после reload повторно читает WorkItem;
- E2E проверяет audit event, persisted preferences, EN/RU, light/dark, overlays, mobile filters и recovery state;
- `pnpm verify` и `pnpm test:e2e` являются release-gate.

## 5. Exit gate

M3 locally complete, когда:

- новая задача создаётся из UI и переживает reload;
- brief, priority, risk и acceptance criteria редактируются через `PATCH`, а timeline показывает changed fields;
- допустимый state transition обновляет board и Event history;
- после потери daemon/session пользователь получает конкретный безопасный recovery path вместо вечного loading/error;
- desktop/mobile, keyboard, light/dark и EN/RU scenarios проходят browser E2E;
- daemon status сообщает `phase-0 / M3`.

Windows evidence остаётся отдельным blocking CI gate и не считается пройденным по локальному macOS результату.
