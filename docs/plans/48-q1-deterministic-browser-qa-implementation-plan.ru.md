# Q1 — План реализации deterministic Browser QA

**Дата:** 2026-09-02

**Статус:** in progress

**Спецификация:** [47-q1-deterministic-browser-qa-spec.ru.md](47-q1-deterministic-browser-qa-spec.ru.md)

## 1. Порядок работы

### Q1.1 — Контракты и чистый domain

- [x] Добавить bounded runtime-схемы `QARun`, scenario matrix, assertions, observations, attachments и Defects.
- [x] Разделить driver result и durable evidence: driver сообщает наблюдения, domain сам вычисляет verdict.
- [x] Fail closed при пустом mandatory matrix, stale tree, неизвестном driver и превышении bounds.
- [ ] Покрыть allowed/forbidden transitions, exact-version conflict и command idempotency.

### Q1.2 — BrowserDriver boundary

- [ ] Ввести небольшой provider-neutral `BrowserDriver` contract.
- [ ] Реализовать обязательный `PLAYWRIGHT` adapter с новым isolated context на каждый QARun.
- [ ] Разрешить только validated loopback origin; блокировать off-origin redirect, download и dialog.
- [ ] Нормализовать browser/runtime fingerprint без secrets, cookies, headers и абсолютных путей.
- [ ] Собирать deterministic viewport/locale/theme matrix, console/network observations, screenshots и trace.

### Q1.3 — Durable orchestration

- [ ] Добавить новую migration для QARun, evidence bundle, observations, attachment refs и Defects.
- [ ] Резервировать QARun до запуска browser process вместе с active BROWSER_QA AgentRun.
- [ ] Завершать QARun, AgentRun, evidence, HumanRequest/next dispatch, events и receipt одной транзакцией.
- [ ] Хранить тяжёлые файлы вне SQLite через quarantine/finalize/recovery protocol.
- [ ] Добавить restart/recovery и duplicate-completion coverage.

### Q1.4 — Workflow и Acceptance

- [ ] Запретить provider-owned `QA_REPORT` для scheduled BROWSER_QA run.
- [ ] На `PASSED` создавать daemon-owned QA evidence с exact tree и QARun id.
- [ ] На `FAILED|ERROR` не открывать Acceptance; создать понятный HumanRequest.
- [ ] Acceptance должен отклонять legacy/provider-only, stale и неполный QA evidence bundle.

### Q1.5 — Task Cockpit

- [ ] Показать measured status и tested environment без raw JSON.
- [ ] Показать scenario matrix, failed assertions, console/network observations и Defects.
- [ ] Дать безопасно открыть screenshot/trace через authenticated daemon route без absolute path.
- [ ] Проверить RU/EN, light/dark, keyboard, 320 px, reconnect и version-conflict recovery.

## 2. Security gate

- [ ] Обновить BrowserDriver-раздел threat model одновременно с первой capability.
- [ ] Проверить loopback allowlist, redirects, DNS/rebinding assumptions и response-size limits.
- [ ] Не передавать cookies, provider credentials, `.env`, Authorization headers и signed-in browser profile.
- [ ] Не разрешать shell/Git mutation, arbitrary launch recipe, external origin и destructive UI action.
- [ ] Проверить redaction, relative attachment keys, content hash/size и retention cleanup.

## 3. Verification gate

- [ ] Unit: schemas, verdict derivation, bounds, stale tree и forbidden transitions.
- [ ] Persistence: atomic success/failure, restart, idempotency, expected-version conflict и recovery marker.
- [ ] Daemon: green baseline, intentional assertion failure, driver error, off-origin redirect и timeout.
- [ ] Browser: real green route и real failed route; Acceptance никогда не стартует на неподтверждённом pass.
- [ ] Полные `pnpm verify`, production audit и clean npm tarball.
- [ ] Один и тот же baseline проходит на macOS и Windows.

## 4. Следующий срез

После Q1 идёт Q2: durable Defect lifecycle, отдельный correction-run counter, scoped retest и bounded automatic
defect -> fix -> re-test loop. Он не переиспользует R1 review rounds и не входит в Q1 migration задним числом.
