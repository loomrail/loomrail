# Q2 — План реализации QA Defect correction loop

**Дата:** 2026-09-02

**Статус:** in progress

**Спецификация:** [49-q2-qa-defect-correction-loop-spec.ru.md](49-q2-qa-defect-correction-loop-spec.ru.md)

## 1. Порядок работы

### Q2.1 — Contracts и чистый domain

- [x] Добавить bounded `CorrectionRun`, `QARetestPlan` и canonical cell reason schemas.
- [x] Добавить full/retest QARun lineage schemas и проверку scope на reservation boundary.
- [x] Добавить nullable correction lineage StageAttempt и ReviewReport/Finding.
- [x] Добавить correction/authority lineage evidence artifacts.
- [x] Реализовать pure derivation affected cells + deterministic regression subset.
- [x] Реализовать pure correction-loop transition: start, supersede, pass, exhaust, owner final/cancel.
- [ ] Добавить owner-only optimistic QADefect waiver; SYSTEM resolution остаётся только outcome passing retest.
- [ ] Проверить два независимых bounds: R1 rounds локально на correction и 2 automatic + 1 owner Q2 runs.

### Q2.2 — Durable state и migration

- [x] Добавить additive migration `correction_runs` и append-only `qa_retest_plans`.
- [x] Backfill existing StageAttempt/QARun/Review rows и strict Event/receipt payloads как initial cycle без
      correction identity.
- [x] Перестроить StageAttempt/ReviewReport uniqueness на per-cycle без потери append-only истории.
- [x] Перестроить evidence uniqueness на per-authority и сохранить старые compact artifacts.
- [ ] Атомарно писать FAILED evidence/defects + next CorrectionRun/retest plan/IMPLEMENT dispatch или HumanRequest.
- [ ] Атомарно писать passing retest + SYSTEM defect resolutions + correction pass + ACCEPTANCE dispatch.
- [ ] Покрыть command receipt, optimistic version, duplicate completion, restart и parallel-active rejection.

### Q2.3 — Orchestration и locked context

- [ ] Передать correction Developer bounded source/Open Defects, source tree/evidence и locked plan hash.
- [ ] Запускать fresh correction REVIEW с локальным round и actual correction diff.
- [ ] Резервировать retest QARun только по active CorrectionRun/QARetestPlan, не по provider payload.
- [ ] На ERROR возобновлять QA StageAttempt без расходования correction ordinal.
- [ ] Исполнять sparse cells в baseline order с полными шагами/assertions и тем же BrowserDriver isolation.

### Q2.4 — Acceptance и Task Cockpit

- [ ] Валидировать full-baseline → sequential corrections → current passing retest lineage.
- [ ] Выбирать current-tree Review/QA artifacts, а не первый/произвольный PASSED artifact.
- [ ] Показать correction ordinal/status, source failure, affected/regression scope и evidence chain.
- [ ] Показать OPEN/RESOLVED/WAIVED defects и owner waiver/final-cycle/cancel actions без raw JSON.
- [ ] Добавить RU/EN, light/dark, keyboard, 320 px и reconnect/version-conflict recovery.

## 2. Security gate

- [ ] Обновить threat model одновременно с первой executable correction capability.
- [ ] Проверить locked plan/hash/origin и запрет provider-selected/changed retest scope.
- [ ] Проверить SYSTEM-only resolution, HUMAN-only waiver/final authorization и CSRF/Origin/session controls.
- [ ] Проверить stale tree/review/evidence lineage и отсутствие acceptance через старый full pass.
- [ ] Проверить bounds context/defects/cells/events и отсутствие secrets/absolute paths.

## 3. Verification gate

- [ ] Unit: scope derivation, independent counters, transitions, invalid/stale/waiver-only paths.
- [ ] Persistence: atomic first/next/pass/exhaust/cancel, idempotency, restart и migrations from Q1 DB.
- [ ] Daemon: fail → correction → review → scoped pass; repeated failure; ERROR retry.
- [ ] Browser: happy correction route, exhausted owner route, defect waiver, responsive/localized UI.
- [ ] Full non-landing lint/typecheck/unit/E2E, production audit и clean tarball.
- [ ] Полный `pnpm verify` и macOS/Windows CI; publish остаётся запрещён до общего release gate.

## 4. Первый implementation slice

Contracts + pure `deriveQARetestPlan`/`decideQACorrectionLoop`, lineage contracts и migrations 0025–0026 завершены с
focused tests. Они хранят bounded CorrectionRun/immutable QARetestPlan, различают FULL/RETEST QARun, делают
StageAttempt attempt и ReviewReport round локальными для initial/correction cycle, привязывают compact evidence к
exact ReviewReport либо QARun/EvidenceBundle и ремонтируют старые strict JSON Events/receipts. Следующий slice —
атомарные correction commands; daemon и UI до этой transaction boundary не должны самостоятельно интерпретировать
correction transitions.
