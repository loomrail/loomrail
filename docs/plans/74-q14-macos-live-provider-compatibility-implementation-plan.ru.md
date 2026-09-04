# Q14 — План macOS live-provider compatibility rows

**Дата:** 2026-09-04

**Статус:** active

**Спецификация:**
[73-q14-macos-live-provider-compatibility-spec.ru.md](73-q14-macos-live-provider-compatibility-spec.ru.md)

## 1. Порядок работы

### Q14.1 — Platform-scoped admission seam

- [x] Заменить version-only allowlist на exact version/platform/architecture rows.
- [x] Добавить deterministic tests для exact match и несовпадений OS/architecture/version.
- [x] Сохранить version-before-auth, bounded probe и no-raw result.

### Q14.2 — Quota-bearing capture

- [x] Зафиксировать exact local versions, architecture, install kind, models и invocation revision.
- [x] Снять и санитизировать success/failure/workspace/MCP recordings.
- [x] Replay recordings и независимо проверить terminal domain result schema.
- [x] Добавить только доказанные `darwin/arm64` rows.

### Q14.3 — Dogfood and review

- [x] Обновить public EN/RU matrix, T43 и sanitized evidence.
- [ ] Перезапустить isolated daemon и доказать provider readiness/recovery.
- [ ] Продолжить public target workflow с Codex implementation и независимым Claude review.
- [ ] Выполнить browser QA и correction loop; owner-only acceptance оставить владельцу.
- [ ] Провести Standards/Spec review и полный доступный verification gate.

## 2. Stop conditions

При несовместимом stream, schema drift, неожиданном permission boundary, quota exhaustion или утечке private data
row не добавляется. Windows остаётся открытым blocking gate и не заменяется Mock evidence.
