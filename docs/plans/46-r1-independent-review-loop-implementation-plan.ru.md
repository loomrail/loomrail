# R1 Independent review loop — implementation plan

**Дата:** 2026-09-02

**Статус:** implementation complete; release gate pending
**Спецификация:** [`45-r1-independent-review-loop-spec.ru.md`](45-r1-independent-review-loop-spec.ru.md)

## 1. Contracts and pure decisions

- [x] Добавить closed ReviewReport/Finding schemas, verdict/status/severity/disposition и bounded drafts.
- [x] Расширить provider REVIEW result; IDs, provider attribution и disposition остаются daemon-owned.
- [x] Добавить pure review-loop decision: PASS, next fix round, exhausted owner gate, stale rejection.
- [x] Проверить allowed/forbidden transitions, max findings, attempt numbering и deterministic repeat.

## 2. Durable review state

- [x] Добавить additive migration для multi-round reports и Findings, не меняя shared migrations.
- [x] Записывать report/findings/AgentRun finish/next dispatch или HumanRequest в одной transaction.
- [x] Добавить owner-only optimistic commands для WAIVED/FALSE_POSITIVE и append-only events.
- [x] Покрыть idempotency, expected-version conflict, restart и stale-tree race.

## 3. Independent routing and fresh context

- [x] Зафиксировать latest IMPLEMENT author AgentRun и reviewer relation.
- [x] Для AUTO предпочитать готовый alternate live provider; explicit preference/env остаются lock.
- [x] Добавить review-first-session context без author checkpoint/transcript, со stable tree/handoff/open findings.
- [x] Проверить exact adapter capture, same-provider fallback и provider disappearance before claim.

## 4. Task Cockpit

- [x] Добавить review rounds/verdict/findings/provider relation без raw JSON.
- [x] Добавить owner disposition actions с обязательной причиной и visible focus.
- [x] Добавить RU/EN, light/dark, 320 px и reload/reconnect browser QA.
- [x] Добавить явный browser QA для stale/conflict feedback.
- [x] Browser route: defect -> fix -> re-review -> QA.
- [x] Browser route: exhausted loop -> HumanRequest -> owner-authorized final round / cancel.

## 5. Security, verification and release

- [x] Обновить threat model, domain vocabulary, architecture и user guide.
- [x] Focused tests, dependency audit и full browser E2E.
- [ ] Full `pnpm verify` и clean tarball после зелёного landing lint gate.
- [ ] macOS/Windows CI; tag/npm publish только на зелёном gate.
