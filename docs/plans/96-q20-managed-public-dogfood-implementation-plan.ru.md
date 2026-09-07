# Q20.3 — Managed public dogfood через local subscription CLI: implementation plan

**Статус:** implementation and rehearsal complete; repository promotion in progress

1. Зафиксировать public-only scope, production provider boundary, recovery point и evidence contract. **Done.**
2. Подготовить отдельный временный `LOOMRAIL_DATA_DIR`, проверить exact local CLI readiness и materialize встроенный
   web fixture без доступа к private repositories. **Done.**
3. Через production UI создать точный Recipe 1 Task, принять предложенный `npm test` verification plan и запустить
   workflow с `AUTO` selection. **Done.**
4. После durable provider boundary перезапустить daemon на том же state и проверить idempotent recovery. **Done.**
5. Довести Task до `PENDING` Acceptance Package, проверить cross-provider Review, current-tree verification, measured
   Browser QA, workspace audit и отсутствие QA mutation. **Done.**
6. Остановиться у human Acceptance gate; принять, вернуть или отклонить package только после отдельного явного выбора
   владельца. **Done: package оставлен `PENDING`.**
7. Сохранить только sanitized evidence, исправить устаревшую public guidance и обновить Master Plan/manifest reason без
   ложного `PASSED`. **Done.**
8. Выполнить полный `pnpm verify`, product E2E, landing E2E, release pack и clean-install verification. **Done.**
9. Не commit/push/stage/publish без отдельной команды владельца. **Разрешение на commit/push и интеграцию в `main`
   получено 2026-09-08; npm publish по-прежнему не разрешён.**

## Найденные rehearsal-дефекты

- provider-neutral MCP schema не показывала exact approved recipe IDs, из-за чего обе local CLI могли угадывать
  несуществующие ID и получать корректный, но плохо объяснённый отказ;
- после passing Browser QA и последующей budget pause Resume создавал новый QA AgentRun, а runner пытался заново
  войти в уже `PASSED` correction и оставлял dispatch pending с `StateStoreError`.
- после исправления Review provider-correction уже изменил workspace до HumanRequest, но continuation session не
  делала повторную запись; ошибочно session-scoped mutation proof отклонил честное завершение, хотя domain-owned
  StageAttempt уже содержал успешные `WRITE_FILE`.
- schema для `LIST_DIRECTORY` не объясняла, что portable workspace root обозначается `.`; корректный typed отказ
  породил лишний FREE_TEXT request.
- обновление Zod до `4.5.4` сделало видимым ещё один schema defect: при пустом approved recipe Plan MCP публиковал
  `RUN_RECIPE` с запрещённым пустым `enum` и закрывал proxy до IMPLEMENT. Tool теперь не публикуется, пока exact
  recipe IDs отсутствуют; restart integration и отдельный empty-plan regression это фиксируют.

Все дефекты входят в Q20.3 scope: exact recipe IDs публикуются только как enum из captured executor policy, а
passing Browser QA переиспользуется только при совпадении tree/plan/retest/correction lineage. Regression tests и
повторное продолжение того же durable rehearsal обязательны до evidence handoff. Mutation proof принадлежит
Project/WorkItem/StageAttempt и переживает provider-session continuation, а tool description явно задаёт `.` как
workspace root.
