# Post-Stable operational dogfood — план реализации

**Дата:** 2026-09-12

**Статус:** complete; Stable `0.1.1` published and public-package dogfood accepted

**Спека:** [`122-post-stable-operational-dogfood-spec.ru.md`](122-post-stable-operational-dogfood-spec.ru.md)

## 1. Documentation truth

- [x] Сверить AGENTS, product decisions, master plan, active/historical plans, ADR и threat model.
- [x] Подтвердить, что capability/authority не меняются и новый ADR не требуется.
- [x] Закрыть устаревшие статусы исторических plan/spec после публичного Stable.
- [x] Синхронизировать operations copy с фактическим schema-neutral upgrade поведением.

## 2. Reproducible public-registry lifecycle gate

- [x] Red/green: exact-version validation и harness-root containment.
- [x] Установить public Beta и Stable с lifecycle scripts disabled в отдельные clean projects.
- [x] Проверить setup/doctor/data-path/start/health/stop без raw path/bootstrap/provider-output leakage.
- [x] Создать Beta state, сохранить stopped whole-directory backup, открыть ту же state Stable и доказать сохранность.
- [x] Восстановить backup в отдельный root и открыть его matching Beta binary; не выполнять down-migration.
- [x] Удалить Stable package и доказать, что data root не удалён.
- [x] Покрыть target/path containment, Unicode/space и symlink escape; live gate допускается только на supported
      macOS arm64, а другие targets fail closed.

## 3. Newcomer local-provider workflow

- [x] Запустить exact `loomrail@latest` на чистых install/data roots и пройти canonical `/try` onboarding.
- [x] Использовать только provider, который public Doctor классифицирует `VERIFIED + AUTHENTICATED`.
- [x] Пройти Discovery, Plan, bounded Implement, independent Review, Project verification, measured Browser QA и
      owner Acceptance именно из опубликованного patch Stable. Public `0.1.1` прошёл весь маршрут до
      `DONE / SUCCEEDED / ACCEPTED`; исчерпанная Claude allowance осталась typed blocking event, а продолжение через
      Codex потребовало явного выбора владельца и не было fallback.
- [x] Выполнить controlled restart до terminal workflow state и проверить отсутствие replay/overlap.
- [x] Проверить audit/evidence и отсутствие секретов/личных paths/raw provider payloads.

## 4. Provider drift

- [x] Зафиксировать текущую exact Codex version как `UNVERIFIED` до live evidence.
- [x] Если локальный target совместим, провести bounded read-only/workspace/MCP/failure capture и full workflow;
      добавить только exact `(version, darwin, arm64)` row и replay fixtures.
- [x] Не ослаблять gate во время qualification: до полного evidence target оставался blocked, invalid-model failure
      стал typed owner gate без fallback.
- [x] Не переносить execution row автоматически на allowance reporting или другую platform.

## 5. Final gates and evidence

- [x] Focused integration/security tests.
- [x] Полный `pnpm verify`, product E2E, protected landing E2E, fault-injection, release package и
      public-registry lifecycle gate.
- [x] Записать sanitized evidence и обновить master plan/compatibility/threat-model docs.
- [x] Провести patch release через existing Stable target/release gate, protected GitHub Environment, trusted npm
      staging и отдельный owner WebAuthn approval.
