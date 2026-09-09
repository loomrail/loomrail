# Q20.14 — Safe Verification Plan context: private-dogfood fix

**Статус:** implemented; focused and full macOS candidate verification complete

**Основание:** PD-027, ADR-0026, Threat Model T75

## Outcome

Codex и Claude получают одну provider-neutral безопасную проекцию active Project Verification Plan внутри
обязательного durable context pack. Проекция объясняет существующую authority, но не создаёт новую.

## Реализация и проверки

1. Зафиксировать PD-027, ADR-0026, Q20.1 invariant и T75 до production-кода.
2. Добавить additive source kind `PROJECT_VERIFICATION_PLAN` и optional snapshot projection.
3. Читать Plan в той же SQLite snapshot transaction, что остальные context sources.
4. Рендерить в `WORKFLOW_POSITION` только ID/revision/status и bounded recipe ID/kind/label/required/timeout/network.
5. Явно сообщать, что HumanRequest answer не меняет permissions, allowlist, budget или workflow authority.
6. Повторить non-escalation notice в generic HumanRequest UI независимо от provider-authored текста.
7. RED/GREEN tests: active, disabled, absent, secret-bearing omitted fields, Unicode/space и snapshot isolation.
8. Выполнить focused contracts/context/persistence/daemon/web tests, затем полный `pnpm verify`. **Done:** полный
   `pnpm verify`, fault-injection, provider compatibility, activation, 62/62 product E2E и clean-install release
   package прошли.

## Non-goals

Изменение Plan provider-ом, передача argv/cwd/script/provenance/path, recipe discovery через filesystem, расширение
stage permissions, string fallback, synthetic success, live SMTP/deploy, commit/push Recurkit или Windows evidence.
