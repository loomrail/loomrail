# L2 — измеряемые локальные launch-gates

**Дата:** 2026-09-10

**Статус:** Implemented on macOS; Windows lifecycle evidence remains pending

**Основание:** L track §5.3, PD-028, ADR-0027, Q17, Q1

## 1. Outcome

Владелец один раз принимает bounded план локального запуска и получает snapshot-bound evidence по шести launch-gates.
Loomrail сам поднимает exact owner-approved loopback target, измеряет его, останавливает весь process tree и честно
показывает `RUNNING | CANCELLING | BLOCKED | PASSED | FAILED | ERROR | INTERRUPTED`, gate-level
`ACTION_REQUIRED` и freshness `CURRENT | STALE`. Provider prose не участвует.

## 2. Граница модуля

```text
owner HTTP command
  -> deterministic domain decision
  -> SQLite plan/run/event/receipt transaction
  -> daemon runner
     -> approved SERVE recipe + supervised process tree
     -> typed browser measurement driver
     -> current Q17 AUDIT evidence lookup
  -> deterministic gate evaluation
  -> SQLite terminal run/event transaction
  -> Project Settings read model
```

- `contracts` владеет закрытыми схемами plan/run/result/error;
- `domain` владеет adoption, transitions, gate verdicts и freshness;
- `project-readiness` переиспользует executable/cwd/env/tree validation и добавляет service lifecycle;
- `browser-qa` измеряет только exact loopback target и возвращает bounded typed facts;
- `persistence-sqlite` хранит operational truth; WebSocket лишь инвалидирует read model;
- `daemon` оркестрирует процесс и recovery; `web` показывает owner actions;
- provider packages не импортируют и не получают L2 payload.

## 3. Launch Measurement Plan

Один `ACTIVE` plan на Project. Новая revision создаётся owner-командой с expected Project version и exact identity
активного Verification Plan.

Plan содержит:

- exact `verificationPlanId/revision/contentHash`;
- `startupRecipeId` с kind `SERVE`;
- optional `dependencyAuditRecipeId` с kind `AUDIT`;
- bare loopback `targetOrigin`;
- same-origin `healthPath`, `probePath`, 0–20 private routes;
- 3–5 samples;
- budgets: LCP, INP, CLS, total script bytes;
- closed required-header list;
- content hash, revision, timestamps и status.

Plan не содержит shell string, environment values, secrets, arbitrary header names, external origins или raw config.
`SERVE` никогда не входит в обычный Q17 run. `AUDIT` исполняется только как обычный явно required/optional Q17
recipe; L2 лишь связывает его terminal check.

Для monorepo scanner дополнительно рассматривает только прямые `apps/<portable-name>/package.json`: не более 32
entries, без symlink, recursion и workspace-glob evaluation. Из них предлагаются только `start | dev | preview`,
каждый с exact manifest hash и `cwd`; общий Plan по-прежнему ограничен 12 recipes. Finite checks из вложенных
manifest не добавляются, поэтому один root policy остаётся источником Q17 verification.

## 4. Run lifecycle

```text
RUNNING -> CANCELLING -> INTERRUPTED
RUNNING -> PASSED | FAILED | ERROR | INTERRUPTED
RUNNING | CANCELLING -> BLOCKED
BLOCKED -> CANCELLING -> INTERRUPTED | BLOCKED
```

На Project одновременно разрешён один active Run. Reservation фиксирует exact plan и current tree. Runner повторно
проверяет active plan/Verification Plan/recipe authority перед spawn. После health readiness выполняются измерения.
Service всегда останавливается в `finally`; terminal command разрешён только после process-tree proof и повторной
проверки tree. Если STOPPED-proof получить нельзя, Run остаётся active `BLOCKED / SERVICE_TERMINATION_FAILED`,
запрещает второй Run и предлагает владельцу повторить безопасную остановку. Отсутствующий process-record не является
proof для уже заблокированного Run. Restart никогда не replay-ит spawn: доказанная остановка даёт terminal
`ERROR / DAEMON_RESTART`, недоказанная остаётся `BLOCKED`.

## 5. Измерения

- Web Vitals: 3–5 fresh Chromium contexts; LCP/CLS наблюдаются через init-script до navigation, INP через bounded
  owner-declared safe interaction либо `ACTION_REQUIRED`, если interaction отсутствует/метрика недоступна; verdict
  использует median.
- Bundle budget: суммарные bytes JavaScript responses одного sample, максимум 32 MiB.
- Response headers: только presence закрытого списка; значения не сохраняются.
- Private routes: fresh credential-free requests, только 401/403 проходят.
- Client bundle secrets: bounded scan JavaScript bytes; сохраняется только count/category, raw match отсутствует.
- Dependency audit: exact current-tree Q17 check recipe kind `AUDIT`; отсутствие или stale даёт `ACTION_REQUIRED`.

Browser network остаётся exact-origin read-only. Redirect/off-origin, Cookie/Authorization, service worker,
download/dialog/permission, response/output limits и malformed input дают typed failure.

## 6. Security and privacy

- только loopback origin с DNS pinning;
- argv array из owner-approved Verification Plan, `shell:false`;
- scrubbed environment без provider/project secrets;
- cwd canonicalized под repository, symlink escape запрещён;
- monorepo service discovery ограничен regular direct `apps/*/package.json` и не исполняет workspace metadata;
- no install/deploy/push/merge authority;
- output redacted до persistence; browser bodies и header values не persist;
- cancellation и restart держат authority до STOPPED proof; uncertain stop сохраняется как durable `BLOCKED`;
- hostile config/provider/repository text остаётся plain untrusted input;
- export и logs не содержат raw service/browser payload.

Threat delta: T76 в `docs/security/THREAT-MODEL.md`.

## 7. UI

Project Settings показывает:

- exact выбранные SERVE/AUDIT recipes и Verification Plan identity;
- origin/paths/budgets/headers до adoption;
- `Adopt`, `Disable`, `Run`, `Cancel` с обычными HTTP/Origin/CSRF gates;
- running/cancelling/blocked/restart states и явное действие повторной безопасной остановки;
- шесть gate rows с числовым evidence, причиной action/error и freshness;
- предупреждение, что это local measurement, не deploy и не production-safety promise.

RU/EN, light/dark, keyboard/focus и narrow viewport обязательны.

## 8. Acceptance matrix

- allowed service + passing measurements + current AUDIT;
- missing/early-exit/timeout/output-cap/cancel/restart service;
- stale plan, stale tree, changed recipe, disabled plan;
- traversal/symlink cwd и Windows path with spaces/Unicode;
- off-origin/redirect/cookie/auth/private-route rejection;
- 3/5 sample median, unavailable INP, bundle cap, missing headers, secret canaries;
- audit pass/fail/missing/stale without parsing output strings;
- command idempotency and version conflict;
- Event/read model/export/log redaction;
- HTTP session/Origin/CSRF and UI states;
- full `pnpm verify`, Playwright E2E, release pack/install and macOS/Windows CI.

## 9. Non-goals

- external URL or deployed-site probes;
- Lighthouse score or SEO/accessibility replacement;
- provider-authored thresholds;
- install, deploy, rollback, auto-retry or scheduler dispatch;
- secret values, authenticated production routes or arbitrary custom headers;
- L3 Release/Environment/Launch Evidence Package.
