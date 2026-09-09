# Q20.7 — Specialized owner-gate routing: private-dogfood fix

**Статус:** implemented; accepted private Recurkit dogfood complete

**Архитектурная граница:** Attention — детерминированная read projection, а не универсальный command surface.
Доменная модель объявляет закрытое действие для каждого элемента; web-клиент только отображает его. Обычный
`HumanRequest` можно ответить из Attention, но исчерпанный QA/Project-verification correction gate разрешается только
специализированной командой в контексте WorkItem с полной optimistic и lineage-проверкой.

## Причина

Private Recurkit dogfood обнаружил, что общая форма ответа была показана для
`VERIFICATION_CORRECTION_EXHAUSTED`. Она закрыла `HumanRequest` обычной командой, не выделив финальную correction
position 3. Последующая ручная перепроверка унаследовала уже `PASSED` correction и при завершении попала в
`VerificationCorrectionError`. Ошибка не создала ложный pass, но оставила Run нетерминальным до явной отмены и
перезапуска daemon. Повторный запуск затем обнаружил второй recovery-дефект: elapsed wall time прерванного Check
превысил live-execution bound и schema validation откатила reconciliation уже после подтверждения остановки процесса.

## Контракт

- `AttentionItem.action` — закрытый enum: `ANSWER_REQUEST | OPEN_TASK_CONTEXT | REVIEW_ACCEPTANCE`.
- `QA_CORRECTION_EXHAUSTED` и `VERIFICATION_CORRECTION_EXHAUSTED` всегда проецируются как
  `OPEN_TASK_CONTEXT`; UI не монтирует для них общую форму ответа.
- Доменный `ANSWER_HUMAN_REQUEST` также fail-closed отклоняет оба exhausted-кода независимо от UI: прямой вызов
  общего HTTP endpoint не может закрыть специализированный gate или создать обычный resume dispatch.
- Выбор authorize-final-correction/cancel остаётся только у существующих специализированных HUMAN-команд. Они
  проверяют request, PipelineRun, StageAttempt, source failure и текущую correction authority в одной транзакции.
- После успешной специализированной команды daemon явно будит workflow worker. Durable queued dispatch не зависит
  от побочного refresh, перезапуска daemon или другого HTTP-запроса.
- Passing revalidation, которая ссылается на уже исторически `PASSED` verification correction, является безопасной
  идемпотентной перепроверкой: Run может завершиться `PASSED`, но correction не переоткрывается, не закрывается
  повторно и не создаёт второй handoff/event.
- Provider output, текст request и UI labels не участвуют в выборе команды.
- Generic answer блокируется для ACCEPTANCE только когда exact request уже принадлежит существующему
  AcceptancePackage. Operational provider failure или настоящий `NEEDS_HUMAN` до создания package сохраняет обычный
  audited answer/resume; проверка по одному имени stage запрещена.
- Live Check observation сохраняет прежний жёсткий duration bound. Persisted terminal Check отдельно допускает
  безопасный integer elapsed time после долгого простоя daemon; это не расширяет runtime timeout и не разрешает replay.
- Когда новая активная verification correction после IMPLEMENT+REVIEW достигает QA, gate отличает её от correction,
  которой принадлежит последний уже materialized failure, и резервирует один свежий Run на новом reviewed tree.
  Историческая stale failure не дублируется.

## Проверки

1. Domain projection: оба exhausted failure code дают только `OPEN_TASK_CONTEXT`.
2. Domain command boundary: generic answer для обоих exhausted failure code получает typed
   `WORKFLOW_CONTROL_NOT_ALLOWED` и не меняет состояние.
3. Web rendering/view model: inline-answer разрешён только для `ANSWER_REQUEST`.
4. Daemon boundary: успешный QA/verification correction-gate transition будит worker; отказ не создаёт runnable work.
5. Persistence: свежий passing retry после уже `PASSED` correction терминален и не меняет correction history.
6. Project-verification gate: новая активная correction после materialized stale Run получает свежий measurement;
   прежняя correction без новой authority остаётся заблокированной и не создаёт duplicate failure/retry.
7. Restart dogfood: отменённый/прерванный Run, включая downtime дольше live limit, восстанавливается без скрытого
   retry; новый Run проходит на текущем tree и продолжает workflow только из durable terminal state.
8. Acceptance retry: generic endpoint не может разрешить request существующего package, но operational request до
   package успешно возобновляет тот же StageAttempt и создаёт новый ProviderSession.
9. Полный `pnpm verify`, E2E, release package и повторный private Recurkit dogfood.

## Non-goals

Обход correction budget, автоматическое owner approval, анализ строк/текста запроса, provider-owned workflow
переходы, synthetic pass или восстановление через ручное редактирование SQLite.
