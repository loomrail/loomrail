# Q17 — План реализации Project verification gate

**Дата:** 2026-09-05

**Статус:** in progress — Q17.1/Q17.2 complete, Q17.3 Acceptance gate in progress

**Спецификация:**
[79-q17-project-verification-gate-spec.ru.md](79-q17-project-verification-gate-spec.ru.md)

## Confirmed TDD seams

Product decision QD-003 и owner instruction подтверждают шесть public seams: contracts/domain,
scanner/publisher, persistence, runner, authenticated HTTP и Task Cockpit. Каждый vertical slice начинается с одного
failing behavior test на соответствующем seam и заканчивается narrow green run; bulk horizontal test scaffolding
запрещён.

## Q17.1 — Inert preview и owner adoption

- [x] Добавить strict proposal/plan/recipe contracts, canonical hash и deterministic adoption decisions.
- [x] Расширить read-only scanner только bounded `package.json` scripts без запуска package manager/lifecycle hooks.
- [x] Добавить marker-bound `.loomrail/verification-plan.json` publisher с symlink/path/hash conflict checks.
- [x] Добавить migration, Project plan commands/query, optimistic versioning, receipts и Events.
- [x] Добавить authenticated preview/adopt Settings UI с exact executable/argv/cwd/policy disclosure.

**Tracer:** malicious `package.json` остаётся inert; owner видит exact `pnpm run test`, принимает preview hash, reload
показывает ту же revision; без adoption ни один child не появляется.

## Q17.2 — Manual measured run

- [x] Добавить Run/check/evidence contracts и pure terminal/freshness projection.
- [x] Реализовать один daemon-owned runner: argv/no-shell, canonical cwd, scrubbed environment, output/deadline bounds,
      cross-platform process-tree termination и exact-tree before/after check.
- [x] Добавить transactional reservation/check completion/terminal Run commands и restart reconciliation без replay.
- [x] Добавить manual start/cancel/retry/read-output HTTP seams и Task Cockpit states.
- [ ] Проверить output privacy, path/control-sequence redaction и artifact retention/recovery.

**Tracer:** owner запускает adopted required fixture test, видит real non-zero `FAILED`, duration/platform и bounded
output; restart сохраняет failure, а crash во время process даёт `INTERRUPTED`, не второй spawn.

## Q17.3 — Workflow и Acceptance gate

- [x] Запускать active required Plan после fresh independent Review и до Browser QA: внутренний
      `verification-workflow` может зарезервировать только первый Run на стадии QA; Browser QA не получает AgentRun
      или browser authority до свежего current-tree pass, а terminal non-pass не ретраится скрыто.
- [ ] Добавить отдельный `VerificationFailure` и связать его с correction IMPLEMENT/re-review/rerun lineage.
      Immutable failure identity и атомарная запись `FAILED | ERROR | INTERRUPTED` уже готовы; correction transition,
      re-review/rerun links и `STALE` materialization остаются в работе.
- [ ] Применить общий bounded correction ceiling, не смешивая VerificationFailure и QADefect identities.
- [x] Сделать required failed/error/interrupted/stale детерминированным Acceptance blocker; optional failure оставить
      advisory.
- [x] Показать criterion-to-verification evidence в Acceptance Package/export без raw output/path leakage.

**Tracer:** intentional failure блокирует Acceptance, fix меняет tree и делает старый Run stale, independent re-review
запускает exact rerun, только current-tree pass открывает Browser QA и затем owner Acceptance.

## Q17.4 — Security, restart и cross-platform exit

- [ ] Закрыть T48 matrix: argv/path/env/network-policy/output/timeout/tree mutation/child orphan/duplicate completion.
- [ ] Проверить every allowed/forbidden transition, rollback, idempotency, expected-version conflict и restart.
- [ ] Выполнить RU/EN, keyboard/focus, light/dark, 320 px и daemon-restart Browser QA.
- [ ] Выполнить focused lint/typecheck/unit/integration, full non-landing gates, fault injection и clean release.
- [ ] Выполнить independent Standards/Spec review и исправить все P0–P2.
- [ ] Зафиксировать macOS/Windows fixed-commit fixture CI evidence; не заявлять live Windows provider evidence.
- [ ] Обновить threat model, architecture, master plan и sanitized Q17 evidence.

## Implementation order

1. contracts + pure domain red/green;
2. scanner preview + publisher red/green;
3. persistence adoption/restart red/green;
4. runner + manual API red/green;
5. Task Cockpit manual evidence red/green;
6. workflow/correction/Acceptance red/green;
7. security/fault/browser/cross-platform gates;
8. independent review, evidence, atomic commits and push.

Новый internal package допустим только если runner/process-tree logic нельзя разместить одним глубоким daemon module
без импорта `apps/*` в `packages/*` или дублирования существующей portable boundary. Запрещено переиспользовать
provider output, Browser QADefect или shell string как shortcut.
