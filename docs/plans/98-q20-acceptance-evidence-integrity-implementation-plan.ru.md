# Q20.4 — План реализации целостности Acceptance evidence

**Статус:** implemented; accepted private Recurkit Epic complete on macOS

**Спецификация:**
[97-q20-acceptance-evidence-integrity-spec.ru.md](97-q20-acceptance-evidence-integrity-spec.ru.md)

1. Зафиксировать PD-020, ADR-0017, T63 и неизменный non-goal semantic inference. **Done.**
2. RED: через public domain transition доказать, что invented QA checks и contradictory acceptance prose сейчас
   попадают в package. **Done.**
3. GREEN: вывести bounded measured QA vocabulary и domain-owned acceptance narrative в одном acceptance module.
   **Done.**
4. Расширить coherent ContextSources snapshot для QA/Acceptance actual measured plan и Project verification.
   **Done.**
5. Добавить persistence/daemon restart, idempotency, hostile text/redaction и browser/API regression coverage.
   **Done.**
6. Повторить private Recurkit dogfood на релевантном Browser QA scope; прежний returned run не считать pass.
   **Done:** новый WorkItem прошёл authoritative Review, Project verification, measured Browser QA и owner Acceptance;
   прежние returned/cancelled runs не переименованы в pass. Более поздний formal 3-WorkItem private Epic также
   завершён и записан отдельным stable evidence.
7. Выполнить полный `pnpm verify`, обновить evidence/status и только затем commit/push по отдельному уже полученному
   разрешению. npm publish остаётся запрещён. **Done:** `pnpm verify`, последовательный полный product E2E 61/61,
   release pack и clean-install release verification прошли.

## Dogfood findings: Claude runtime identity и post-session budget

Private Recurkit dogfood выявил два независимых факта. Во-первых, Claude launcher выбирал разные engine version в
зависимости от cwd; по PD-021/ADR-0018 readiness теперь повторяет production temporary-directory shape через inert
session-parser probe. Текущий production-shaped probe подтверждает admitted `2.1.260`; ослабление argv и automatic
update запрещены.

Во-вторых, два FAST Discovery session завершились с exit 1 без terminal result или usable provider diagnostic;
provider-side cause не выдумывается. Один STANDARD
Discovery session дал валидный результат, но authoritative terminal usage составил 703351 токен и честно
hard-paused PLAN при run limit 700000. Run отменён вместо расширения subscription spend. Это не full private pass:
этот historical run не засчитан. Более поздний owner-approved run уложился в явно утверждённый бюджет и закрыл шаг 6.
Санитизированный отчёт:
`docs/evidence/phase-8/Q20-PRIVATE-RECURKIT-DOGFOOD-2026-09-08.md`.
