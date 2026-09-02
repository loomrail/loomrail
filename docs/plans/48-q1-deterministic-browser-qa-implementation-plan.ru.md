# Q1 — План реализации deterministic Browser QA

**Дата:** 2026-09-02

**Статус:** implementation complete; release gate pending on parallel landing lint

**Спецификация:** [47-q1-deterministic-browser-qa-spec.ru.md](47-q1-deterministic-browser-qa-spec.ru.md)

## 1. Порядок работы

### Q1.1 — Контракты и чистый domain

- [x] Добавить bounded runtime-схемы `QARun`, scenario matrix, assertions, observations, attachments и Defects.
- [x] Разделить driver result и durable evidence: driver сообщает наблюдения, domain сам вычисляет verdict.
- [x] Fail closed при пустом mandatory matrix, stale tree, неизвестном driver и превышении bounds.
- [x] Покрыть allowed/forbidden transitions, exact-version conflict и command idempotency.

### Q1.2 — BrowserDriver boundary

- [x] Ввести небольшой provider-neutral `BrowserDriver` contract.
- [x] Реализовать обязательный `PLAYWRIGHT` adapter с новым isolated context на каждый QARun.
- [x] Разрешить только validated loopback origin; блокировать off-origin redirect, download и dialog.
- [x] Нормализовать browser/runtime fingerprint без secrets, cookies, headers и абсолютных путей.
- [x] Собирать deterministic viewport/locale/theme matrix, console/network observations, screenshots и trace.

### Q1.3 — Durable orchestration

- [x] Добавить новую migration для QARun, evidence bundle, observations, attachment refs и Defects.
- [x] Резервировать QARun до запуска browser process вместе с active BROWSER_QA AgentRun.
- [x] Завершать QARun, AgentRun, evidence, HumanRequest/next dispatch, events и receipt одной транзакцией.
- [x] Хранить тяжёлые файлы вне SQLite через quarantine/finalize/recovery protocol.
- [x] Добавить restart/recovery marker coverage.
- [x] Добавить duplicate-completion и completed-state restart coverage.

### Q1.4 — Workflow и Acceptance

- [x] Запретить provider-owned `QA_REPORT` для scheduled BROWSER_QA run.
- [x] На `PASSED` создавать daemon-owned QA evidence с exact tree и QARun id.
- [x] На `FAILED|ERROR` не открывать Acceptance; создать понятный HumanRequest.
- [x] Acceptance должен отклонять legacy/provider-only, stale и неполный QA evidence bundle.

### Q1.5 — Task Cockpit

- [x] Показать measured status и tested environment без raw JSON.
- [x] Показать scenario matrix, failed assertions, console/network observations и Defects.
- [x] Дать безопасно открыть screenshot/trace через authenticated daemon route без absolute path.
- [x] Проверить RU/EN, light/dark, keyboard, 320 px, reconnect и version-conflict recovery.

## 2. Security gate

- [x] Обновить BrowserDriver-раздел threat model одновременно с первой capability.
- [x] Проверить loopback allowlist, redirects, DNS/rebinding assumptions и response-size limits.
- [x] Не передавать cookies, provider credentials, `.env`, Authorization headers и signed-in browser profile.
- [x] Не разрешать shell/Git mutation, arbitrary launch recipe, external origin и destructive UI action.
- [x] Проверить redaction, relative attachment keys, content hash/size и retention cleanup.

## 3. Verification gate

- [x] Unit: schemas, verdict derivation, bounds, stale tree и forbidden transitions.
- [x] Persistence: atomic success/failure, restart, idempotency и expected-version conflict.
- [x] Artifact recovery: committed marker, orphan quarantine и hash/size mismatch.
- [x] Daemon: green baseline, intentional assertion failure, driver error, off-origin redirect и timeout.
- [x] Browser: real green route и real failed route; Acceptance никогда не стартует на неподтверждённом pass.
- [ ] Полный `pnpm verify` (локально остаются три lint-ошибки параллельного `apps/landing/src/main.ts`).
- [x] Production audit без high-severity уязвимостей.
- [x] Clean npm tarball устанавливается и запускается только из опубликованного layout.
- [x] Один и тот же baseline проходит на macOS и Windows: independent browser jobs дали 50/50 green в
      [GitHub Actions run 33617720338](https://github.com/loomrail/loomrail/actions/runs/33617720338).

## 4. Следующий срез

После Q1 идёт Q2: durable Defect lifecycle, отдельный correction-run counter, scoped retest и bounded automatic
defect -> fix -> re-test loop. Он не переиспользует R1 review rounds и не входит в Q1 migration задним числом.
