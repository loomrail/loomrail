# Q7 — План реализации local log lifecycle

**Дата:** 2026-09-02

**Статус:** local implementation complete; cross-platform release evidence pending

**Спецификация:** [59-q7-local-log-lifecycle-spec.ru.md](59-q7-local-log-lifecycle-spec.ru.md)

## 1. Порядок работы

### Q7.1 — Deep local-log module

- [x] Добавить safe text/structured-line redaction с closed fields и byte/depth/count bounds.
- [x] Добавить exact owned-file scanner, exclusive writer/management lease и stale-lock recovery.
- [x] Добавить bounded segment writer, daily/size rotation, 30-day retention и total-capacity eviction.
- [x] Покрыть disk bytes, malformed/oversized line, symlink/unknown sibling, rotation/retention/capacity и lock races.

### Q7.2 — Owner CLI

- [x] Подключить writer к production launcher и закрывать после daemon shutdown/start failure.
- [x] Добавить `logs export` complete-or-error и `logs delete` exact-owned-only.
- [x] Добавить parsing/help/unit/integration tests, включая active/stale/invalid lock.
- [x] Redact top-level CLI error before stderr.

### Q7.3 — Policy and evidence

- [x] Добавить T10 Q7 threat delta и architecture/data-layout boundary.
- [x] Обновить EN/RU operations/user docs и domain vocabulary.
- [x] Обновить Master Plan/decomposition/release notes и Phase 8 evidence.

## 2. Verification gate

- [x] Focused CLI tests/typecheck/lint зелёные.
- [x] Daemon logging/auth redaction tests зелёные.
- [x] Full `pnpm test`, non-landing lint, typecheck, public-tree и production audit зелёные.
- [x] `pnpm test:fault-injection` и clean release verification не регрессируют.
- [ ] macOS/Windows CI доказывает Q7 unit + clean-install gates; общий Verify может оставаться blocked только landing.

## 3. Authority boundary

Q7 управляет только operational files. Он не добавляет domain command, HTTP route, provider raw-output persistence,
telemetry consent или filesystem authority над любым другим data-directory subtree. Unknown files сохраняются, а
publish и `apps/landing/**` остаются вне scope.

Локальное evidence: [Q7-LOCAL-LOG-LIFECYCLE-EVIDENCE.md](../evidence/phase-8/Q7-LOCAL-LOG-LIFECYCLE-EVIDENCE.md).
