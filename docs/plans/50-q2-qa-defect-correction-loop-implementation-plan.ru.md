# Q2 — План реализации QA Defect correction loop

**Дата:** 2026-09-02

**Статус:** implementation complete; release gate pending on parallel landing lint and cross-platform CI

**Спецификация:** [49-q2-qa-defect-correction-loop-spec.ru.md](49-q2-qa-defect-correction-loop-spec.ru.md)

## 1. Порядок работы

### Q2.1 — Contracts и чистый domain

- [x] Добавить bounded `CorrectionRun`, `QARetestPlan` и canonical cell reason schemas.
- [x] Добавить full/retest QARun lineage schemas и проверку scope на reservation boundary.
- [x] Добавить nullable correction lineage StageAttempt и ReviewReport/Finding.
- [x] Добавить correction/authority lineage evidence artifacts.
- [x] Реализовать pure derivation affected cells + deterministic regression subset.
- [x] Реализовать pure correction-loop transition: start, supersede, pass, exhaust, owner final/cancel.
- [x] Добавить owner-only optimistic QADefect waiver; SYSTEM resolution остаётся только outcome passing retest.
- [x] Проверить два независимых bounds: R1 rounds локально на correction и 2 automatic + 1 owner Q2 runs.

### Q2.2 — Durable state и migration

- [x] Добавить additive migration `correction_runs` и append-only `qa_retest_plans`.
- [x] Backfill existing StageAttempt/QARun/Review rows и strict Event/receipt payloads как initial cycle без
      correction identity.
- [x] Перестроить StageAttempt/ReviewReport uniqueness на per-cycle без потери append-only истории.
- [x] Перестроить evidence uniqueness на per-authority и сохранить старые compact artifacts.
- [x] Атомарно писать FAILED evidence/defects + next CorrectionRun/retest plan/IMPLEMENT dispatch или HumanRequest.
- [x] Атомарно писать passing retest + SYSTEM defect resolutions + correction pass + ACCEPTANCE dispatch.
- [x] Покрыть command receipt, optimistic version, duplicate completion, restart и parallel-active rejection.

### Q2.3 — Orchestration и locked context

- [x] Передать correction Developer bounded source/Open Defects, source tree/evidence и locked plan hash.
- [x] Запускать fresh correction REVIEW с локальным round и actual correction diff.
- [x] Резервировать retest QARun только по active CorrectionRun/QARetestPlan, не по provider payload.
- [x] На ERROR возобновлять QA StageAttempt без расходования correction ordinal.
- [x] Исполнять sparse cells в baseline order с полными шагами/assertions и тем же BrowserDriver isolation.

### Q2.4 — Acceptance и Task Cockpit

- [x] Валидировать full-baseline → sequential corrections → current passing retest lineage.
- [x] Выбирать current-tree Review/QA artifacts, а не первый/произвольный PASSED artifact.
- [x] Показать correction ordinal/status, source failure, affected/regression scope и evidence chain.
- [x] Показать OPEN/RESOLVED/WAIVED defects и owner waiver/final-cycle/cancel actions без raw JSON.
- [x] Добавить RU/EN, light/dark, keyboard, 320 px и reconnect/version-conflict recovery.

## 2. Security gate

- [x] Обновить threat model одновременно с первой executable correction capability.
- [x] Проверить locked plan/hash/origin и запрет provider-selected/changed retest scope.
- [x] Проверить SYSTEM-only resolution, HUMAN-only waiver/final authorization и CSRF/Origin/session controls.
- [x] Проверить stale tree/review/evidence lineage и отсутствие acceptance через старый full pass.
- [x] Проверить bounds context/defects/cells/events и отсутствие secrets/absolute paths.

## 3. Verification gate

- [x] Unit: scope derivation, independent counters, transitions, invalid/stale/waiver-only paths.
- [x] Persistence: atomic first/next/pass/exhaust/cancel, idempotency, restart и migrations from Q1 DB.
- [x] Daemon: fail → correction → review → scoped pass; repeated failure; ERROR retry.
- [x] Browser: happy correction route, exhausted owner route, defect waiver, responsive/localized UI.
- [x] Full non-landing lint/typecheck/unit/E2E, production audit и clean tarball.
- [ ] Полный `pnpm verify` и macOS/Windows CI; publish остаётся запрещён до общего release gate.

## 4. Implementation checkpoint

Q2 реализован до полного локального gate. Чистый domain выводит immutable retest scope, владеет двумя automatic и
одним owner-authorized correction cycle независимо от локальных R1 rounds, проверяет полную
FULL-baseline → sequential corrections → current passing RETEST lineage и не принимает stale, incomplete,
waiver-only или unrelated pass. SQLite migrations 0025–0029 сохраняют per-cycle StageAttempt/Review/QARun lineage,
authority-bound evidence, correction audit events и exact `resolvedByQARunId`; FAILED/pass/exhaust/final/cancel и
retry после ERROR меняют current state, Event, durable follow-up и receipt одной транзакцией.

Daemon передаёт Developer bounded correction context, запускает fresh independent review и резервирует sparse retest
только из locked daemon-derived plan. Task Cockpit показывает correction timeline, source evidence, affected/regression
cells и OPEN/RESOLVED/WAIVED defects, а owner gate предлагает только final Correction 3 либо cancel. Локально прошли
full non-landing lint/typecheck/unit, 52/52 Playwright E2E, production audit и clean-install tarball
`0.1.0-alpha.5`; пакет не опубликован. Полный `pnpm verify` по-прежнему останавливают только три lint-ошибки
параллельного `apps/landing/src/main.ts`, а текущий Q2 commit ещё должен пройти macOS/Windows CI.
