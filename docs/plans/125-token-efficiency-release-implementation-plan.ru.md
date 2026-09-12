# Token-efficiency patch release — implementation plan

**Дата:** 2026-09-12

**Статус:** dogfood accepted; main CI and protected staging passed; npm WebAuthn pending

**Candidate:** `0.1.2`, `STABLE`, `MACOS_ARM64`

## Граница

Release не изменяет approved product boundary. Все шесть стадий и gates остаются. Первый bounded run из плана 124
остаётся в evidence как HARD_PAUSED, его расход не скрывается. Новый разрешённый run имеет отдельный первоначальный
budget: 900 000 pipeline tokens, 300 000 на AgentRun, 20 минут; повышение по ходу запуска не предусмотрено.
Транспорт — установленный authenticated local Codex CLI. Provider-token targets не подменяются byte benchmark.

## Проверки и публикация

- [x] Проверить исходную ветку, актуальный main, product/release authority и bounded budget regression.
- [x] Завершить дополнительный production dogfood через все шесть стадий и measured gates; показать итог владельцу.
- [x] Сохранить полный usage, restart/recovery и sanitized evidence, включая неуспешные попытки.
- [x] Согласовать версию в CLI, release index, notes и activation checks.
- [x] Выполнить локальные verify, 65 E2E и fault/recovery checks.
- [x] Выполнить clean-package и protected landing checks.
- [x] Commit/push, exact-source CI macOS/Windows, merge в main и push-triggered CI для exact main SHA.
- [ ] Protected stage-only npm workflow, отдельный npm approval, registry integrity/signatures/install verification.
- [ ] Git tag/GitHub Release и итоговая documentation truth после фактической публикации.

Protected stage `139548b4-19a0-46e9-bd8c-cc26eca6aa54` создан после зелёного main CI и всех release checks.
Workflow, npm stage и локальный tarball совпадают побайтно. Отдельный npm approval ожидает физического
WebAuthn-подтверждения владельца; public-registry verification и GitHub Release следуют только после него.
