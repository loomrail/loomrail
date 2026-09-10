# L2 — план реализации измеряемых launch-gates

**Дата:** 2026-09-10

**Статус:** Complete on macOS; Windows lifecycle evidence remains pending

**Спецификация:** [110-l2-measured-launch-gates-spec.ru.md](110-l2-measured-launch-gates-spec.ru.md)

## Порядок

1. Добавить closed contracts и domain tests для Plan, Run, gate evaluation и freshness.
2. Расширить Verification Plan kinds `SERVE`/`AUDIT`, запретить `SERVE` в finite Q17 Run.
3. Добавить bounded discovery `SERVE` из direct `apps/*/package.json` для monorepo dogfood.
4. Добавить supervised service lifecycle поверх существующего recipe resolver с STOPPED proof.
5. Добавить browser measurement deep operation с loopback/origin/size/secret limits.
6. Добавить migration, transactional commands/queries, idempotency и restart reconciliation.
7. Добавить authenticated daemon endpoints и Project Settings UI.
8. Покрыть разрешённые/запрещённые операции, Unicode/space/Windows abstractions и redaction.
9. Добавить один bundled local measurement fixture и browser E2E.
10. Выполнить focused suites, `pnpm verify`, fault-injection, release pack/install и CI.
11. Зафиксировать sanitized evidence и обновить master plan; commit/push только по действующей команде владельца.

## Exit gate

Owner-adopted plan запускает exact loopback service, получает все шесть typed gate results на одном tree, переживает
cancel/restart без replay и показывает их в UI. Ни одна ветка не выдаёт synthetic pass. External target, stale recipe,
tree mutation, secret output или unproved process stop fail closed.

## Результат реализации

- Добавлены closed contracts, domain transitions, migration `0058`, transactional plan/run/audit persistence,
  authenticated HTTP API и Project Settings UI для шести launch-gates.
- Production runner запускает только exact optional `SERVE` recipe, использует scrubbed environment и существующий
  process-tree supervisor, повторно сверяет plan/tree/manifest authority и освобождает execution authority только
  после доказанного `STOPPED`.
- Неопределённая остановка остаётся active `BLOCKED / SERVICE_TERMINATION_FAILED`; restart не replay-ит spawn, а
  owner может повторить только безопасную остановку.
- Playwright measurement boundary допускает только exact loopback origin и read-only traffic, использует свежие
  context, возвращает bounded numeric/presence/count evidence и не сохраняет bodies, header values, cookies,
  service output или найденные secret values.
- Verification proposal поддерживает root service scripts и bounded direct `apps/<portable-name>/package.json`
  service discovery. Publication/runtime повторно проверяют exact nested manifest и root package-manager authority;
  найденный Recurkit dogfood дефект этого round-trip закреплён интеграционным regression test.
- Покрыты allowed/forbidden origin, redirect, credentials, traversal/symlink, Unicode/space/Windows path abstraction,
  timeout, cancel, output limits, restart, blocked recovery, idempotency, stale evidence, HTTP security и UI states.
- Full production-shaped Recurkit run опубликовал Verification Plan revision 3 с 11 recipes, поднял dashboard через
  `apps/dashboard` `start`, измерил exact current tree и доказанно остановил process tree. Итог честно `FAILED`:
  bundle budget и client-bundle secret scan прошли; `Permissions-Policy` отсутствует, private-route и AUDIT evidence
  не настроены, а INP был доступен только в одном из трёх samples. Evidence зафиксирован в
  [`L2-LOCAL-LAUNCH-MEASUREMENT-EVIDENCE.md`](../evidence/phase-8/L2-LOCAL-LAUNCH-MEASUREMENT-EVIDENCE.md).
- После production fix прошли focused scanner/publisher suites, полный `pnpm verify` (37/37 node checks и
  1773/1773 Vitest tests в 23 пакетах), 63/63 Playwright E2E, fault-injection/crash recovery, production dependency
  audit без известных уязвимостей и release pack/receipt/clean-install. Stable manifest остаётся честно 9/11:
  pending только Codex/Claude Windows Q20 evidence.

L2 реализован как измерительный механизм; провал target Project не переименован в успех. L3–L5 и Windows runtime
остаются отдельными следующими milestones.
