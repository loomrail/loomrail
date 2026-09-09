# Q20.5 — План реализации WorkItem dependency DAG

**Статус:** implemented; accepted private Recurkit Epic and full macOS candidate verification complete

**Спецификация:** [99-work-item-dependency-dag-spec.ru.md](99-work-item-dependency-dag-spec.ru.md)

1. Зафиксировать PD-022, ADR-0019, domain glossary, T65 и bounded deep contract. **Done.**
2. RED: покрыть domain allowed/forbidden graph decisions и dependency start gate. **Done.**
3. GREEN: добавить contracts/domain decision без infrastructure/provider imports. **Done.**
4. Добавить additive SQLite migration, atomic edge diff/Event/receipt, restart/idempotency/concurrency tests. **Done.**
5. Добавить authenticated read/mutation API и integration tests для allowed/forbidden operations. **Done.**
6. Добавить Epic/parent creation, dependency inspector, blocked/start UI и light/dark/keyboard E2E. **Done.**
7. Прогнать private Recurkit Epic через 2–3 durable dependent WorkItem обоими локальными providers. **Done:** три
   дочерних WorkItem приняты; первые две связаны durable `BLOCKS`; cancelled precursor не считается pass.
8. Выполнить `pnpm verify`, product E2E, release pack/status, обновить evidence и затем commit/push по уже полученному
   разрешению. npm publish запрещён; Windows live evidence отложен владельцем. **Done:** полный `pnpm verify`,
   fault-injection, provider compatibility, activation, 62/62 product E2E, release pack и clean-install прошли;
   stable status до immutable evidence commit честно остаётся 8/11.
