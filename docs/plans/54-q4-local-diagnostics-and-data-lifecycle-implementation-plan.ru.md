# Q4 — План реализации local diagnostics и data lifecycle

**Дата:** 2026-09-02

**Статус:** implementation complete; shared release gate pending

**Спецификация:**
[53-q4-local-diagnostics-and-data-lifecycle-spec.ru.md](53-q4-local-diagnostics-and-data-lifecycle-spec.ru.md)

## 1. Порядок работы

### Q4.1 — Closed CLI contract

- [x] Заменить flat options на discriminated command parser с legacy start compatibility.
- [x] Добавить bounded help, `doctor [--json]` и explicit `data-path` без startup side effects.
- [x] Разделить start/diagnostic failures и документировать exit semantics.

### Q4.2 — Read-only probes

- [x] Добавить typed read-only SQLite inspection только в `persistence-sqlite`.
- [x] Переиспользовать current migration catalog/checksums без запуска migrations.
- [x] Открыть bounded provider availability snapshot без Project/provider dispatch.
- [x] Реализовать Node/Git/data/provider/state report и human/JSON renderer без sensitive fields.

### Q4.3 — Operations contract

- [x] Добавить EN/RU operations guide: install check, backup, restore, upgrade, rollback, uninstall и retention.
- [x] Связать Getting Started, User Guide и release guide с одним operational source.
- [x] Обновить architecture/domain vocabulary, Master Plan и активный decomposition plan.

## 2. Security gate

- [x] Добавить threat T40 одновременно с executable diagnostics.
- [x] Проверить no path/env/account/raw output/error leakage canaries в human и JSON.
- [x] Проверить отсутствие mkdir/DB writes/migration/recovery/daemon/browser side effects.
- [x] Проверить argv/no-shell/deadline contract provider и Git probes.
- [x] Проверить, что uninstall/data cleanup остаются раздельными и product не удаляет path.

## 3. Verification gate

- [x] Unit: command matrix, help, status aggregation, redaction и deterministic render.
- [x] Persistence: missing/current/uninitialized/pending/drift/future/corrupt/unavailable DB и unchanged bytes.
- [x] CLI integration: exact data path, human/JSON exit codes, no-start commands.
- [x] Package smoke: installed doctor/data-path плюс прежний readiness launch.
- [x] Non-landing format/lint/typecheck/unit, production audit и clean-install tarball.
- [ ] Полный `pnpm verify` и macOS/Windows CI; protected landing failures остаются внешним blocker.

Локальный Q4 gate: formatting/public-tree/toolchain, full build/typecheck/unit, focused non-landing lint и production
audit зелёные. `0.1.0-alpha.5` tarball на чистой установке выполняет read-only doctor, exact data-path и прежний
daemon/Workbench readiness smoke. Repository-wide ESLint сообщает только три защищённые ошибки
`apps/landing/src/main.ts:630,631,634`; Q4 каталог landing не меняет. Новый macOS/Windows CI требуется после push.

## 4. Release boundary

Q4 закрывает первую часть Phase 8 operational readiness, но не setup wizard, full fault injection, dependency policy,
portable export/import или dogfood exit gate. npm publish остаётся запрещён.
