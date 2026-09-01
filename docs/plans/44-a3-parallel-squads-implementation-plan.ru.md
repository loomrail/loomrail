# A3 Parallel agents and dynamic squads — implementation plan

**Дата:** 2026-09-01
**Статус:** implementation complete; release verification in progress
**Спецификация:** [`43-a3-parallel-squads-spec.ru.md`](43-a3-parallel-squads-spec.ru.md)

## 1. Scheduler kernel

- [x] Добавить bounded pure `@loomrail/scheduler` и closed deferral vocabulary.
- [x] Покрыть priority/order, global/project/provider capacity, zero limit, workspace read/write compatibility,
      stable checkpoint, duplicate/invalid input и deterministic repeat.
- [x] Зафиксировать domain terms и A3 threat delta.

## 2. Roles and durable runs

- [x] Добавить versioned built-in AgentProfile и immutable SquadAssignment contracts.
- [x] Добавить AgentRun state machine и role-playbook refinement без ослабления WorkflowTemplate.
- [x] Добавить additive migration, сохранив historical ProviderSession без выдуманного AgentRun backfill.
- [x] Реализовать transactional `START_AGENT_RUN`/terminal transitions с повторной проверкой limits и lease.
- [x] Добавить restart/recovery, idempotency, storage uniqueness и 3+1 capacity coverage.

## 3. Parallel daemon execution

- [x] Заменить single worker bounded pool с default 3, без timer polling.
- [x] Считать adapter/provider для candidate до claim и захватывать exact instance для live ProviderSession.
- [x] Поддержать global/project/provider configuration с безопасными bounds.
- [x] Abort всех live sessions на shutdown; completion всегда будит следующий scheduling pass.
- [x] Интеграционные проверки: 3+1, разные Project/provider, blocked head, lease race, handoff, failure и restart.

## 4. Fleet and squad UI

- [x] Добавить bounded authenticated projection активных/ожидающих AgentRun.
- [x] Показать Task, role, stage, provider, status и machine-readable wait reason без raw logs.
- [x] Добавить RU/EN, light/dark, keyboard, 320 px и reconnect/restart states.
- [x] Не добавлять управление permissions, budget override или acceptance через Fleet.

## 5. Verification and release

- [x] Focused contracts/domain/scheduler/persistence/daemon/web tests.
- [x] Threat model, architecture, product checkpoint и user docs синхронизированы.
- [x] Full E2E, `pnpm audit --prod` и clean `0.1.0-alpha.5` release tarball.
- [ ] `pnpm verify`: A3 проходит ESLint отдельно; общий gate ждёт три lint-исправления в отдельно разрабатываемом
      `apps/landing/src/main.ts`.
- [ ] macOS/Windows CI gate.
- [x] Исходники release candidate `0.1.0-alpha.5` готовы к commit/push без изменений `apps/landing/**`.
- [ ] Tag и npm-публикация `0.1.0-alpha.5` только после всех gates.
