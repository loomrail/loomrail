# Windows CI: время на полную проверку перед 0.1.3

**Дата:** 2026-09-19

**Статус:** owner approved; implementation, remote verification pending.

## Подтверждённая причина

Main CI run `35442835671`, source `49d9dbd0f3bd92974e3329049b8d6752d9999073`:
пять jobs успешны; `Verify (windows-latest)` cancelled по GitHub annotation
`The job has exceeded the maximum execution time of 40m0s`.
Последние записи показывают успешно завершающиеся daemon integration tests вплоть до остановки.
Это подтверждает ограничение общего времени, но не доказывает успех оставшихся тестов.

Диагностика использует фактический удалённый run; локальный тест числа в YAML не воспроизводил бы
длительность Windows runner. Поэтому регрессионный критерий — полный успешный Windows CI на новом
source, а не формальный unit test timeout. Изменяется ровно один параметр.

## Изменение и границы

- Только Windows Verify: 40 → 60 минут. macOS Verify остаётся 40 минут.
- Ни один test/gate, матрица платформ, required context или individual timeout не убран и не ослаблен.
- Нет новых dependencies, product/runtime capabilities или расширения live-provider support.
- Нет bypass защиты main или npm environment.
- Старый ожидающий stage run `35442899024` отменяется как superseded.
- Новый release source выбирается из merged main после всех шести успешных jobs.
  npm staging выполняется заново для точного source, затем проверяются receipt и registry bytes.

## Verification

- До CI fix полный `pnpm verify` лендинга прошёл; landing unit 12/12, browser 9/9.
- После изменения: форматирование и release workflow contract tests.
- Перед merge: все required PR checks. Перед stage: все required main push CI checks.
- Success самого увеличения лимита не заявляется до зелёного Windows Verify.
