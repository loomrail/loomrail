# A3 — Parallel agents and dynamic squads

**Дата:** 2026-09-01
**Статус:** implemented locally; release verification in progress
**Основание:** AD-006–AD-008, WD-004, WD-006, TD-001–TD-003, BD-001, MASTER-PLAN §5.1–5.2, §7, §11–12

## 1. Проблема

Loomrail уже хранит durable `WorkflowDispatch`, выполняет `StageAttempt` через цепочку `ProviderSession`, выбирает
provider для каждой новой session и изолирует WorkItem отдельным worktree с lease. Но daemon по-прежнему имеет один
фоновый исполнитель: независимые задачи ждут друг друга, а постоянная роль, конкретный запуск и provider session не
разделены в runtime так, как требует AD-006.

A3 должен дать владельцу несколько одновременно идущих задач, не превращая параллельность в второй источник
workflow state и не позволяя двум писателям пересечься в одном workspace.

## 2. Граница эпика

### Входит

- versioned built-in `AgentProfile` для базовых ролей и project-local role playbook refinement;
- immutable `SquadAssignment`, привязанный к approved PipelineRun и содержащий только необходимые workflow roles;
- durable `AgentRun` между StageAttempt и ProviderSession;
- scheduler с default global concurrency 3 и отдельными global/project/provider limits;
- stable priority ordering готовых dispatches и явные machine-readable причины отсрочки;
- атомарное резервирование run slot и writer lease до запуска provider process;
- параллельный daemon worker pool, shutdown/abort всех live sessions и restart reconciliation;
- Agent Fleet/squad projection: роль, Task, stage, provider, status и причина ожидания;
- role-aware Context Pack без ослабления обязательных секций WorkflowTemplate;
- macOS/Windows, mock и live-provider verification.

### Не входит

- provider-native subagents, общий групповой чат и provider session как источник squad state;
- автоматическая декомпозиция Epic, создание WorkItem или изменение scope без approved plan;
- cross-Project Epic и новый dependency/DAG editor;
- shared main-directory mode, browser/server leases и merge/rebase automation;
- user-imported roles, plugin installation либо новые permissions без owner Consent;
- автоматический retry оборванного AgentRun;
- завершение budget hierarchy: A3 соблюдает доступные limits, но не выдаёт отсутствующий live-usage accounting за
  реализованный hard cost governor.

Q13 follow-up закрывает именно этот унаследованный разрыв через immutable AgentRun envelope и durable live usage;
это не меняет историческую границу исходного A3 scope.

## 3. Принятые решения

### D1 — AgentRun является единицей concurrency

`StageAttempt` остаётся попыткой workflow stage, `AgentRun` — одним непрерывным назначением immutable ревизии
AgentProfile на эту попытку, `ProviderSession` — короткой provider-native сессией внутри run. У StageAttempt может
быть несколько последовательных AgentRun с ordinal: blocking HumanRequest или hard pause завершает текущий run,
освобождает slot, а owner-approved resume создаёт следующий с новым policy snapshot. Одновременно активен не
более одного. Handoff создаёт следующую ProviderSession того же AgentRun и не занимает второй slot.

`AgentRun.policySnapshotHash` фиксирует назначение, точную ревизию профиля, effective provider и применённые
capability/budget/workspace policy. Он не притворяется hash всего provider input: при handoff Context Pack закономерно
меняется. Точный `contentHash` входа остаётся в append-only ContextPackRecipe каждой ProviderSession.

Оборванный AgentRun становится `INTERRUPTED`; startup reconciliation не запускает его снова. Возобновление
существующего StageAttempt или новый attempt остаётся owner-controlled путём AD-008.

### D2 — SquadAssignment фиксирует состав, а не запускает весь roster

Squad — immutable набор `profileId + revision + stages`, выбранный при старте approved PipelineRun. Встроенный
Standard workflow назначает только роли стадиям, которые реально исполняются агентом; ACCEPTANCE принадлежит
владельцу и AgentRun не создаёт. Маленькая задача не запускает Lead PM, Analyst и Architect одновременно только
потому, что такие профили существуют.

Изменение состава после старта создаёт новую revision назначения и действует только на ещё не начавшиеся
StageAttempt. Уже начатый AgentRun хранит собственный policy snapshot.

### D3 — Scheduler планирует, transaction резервирует

Pure module `planDispatchBatch` сортирует bounded candidates и объясняет, кого можно попробовать запустить сейчас.
Его ответ не является authority: команда `START_AGENT_RUN` в одной SQLite transaction повторно проверяет лимиты,
создаёт AgentRun, переводит dispatch/attempt, ставит exclusive active claim на WorkItem и, если workspace уже
существует, захватывает его lease. Два wake или browser action не могут превысить лимит через read-then-write race.

У первого agent stage workspace ещё может не существовать: его создание требует Git и не может происходить внутри
синхронной SQLite transaction. В этом случае durable active WorkItem claim не допускает второй run, daemon создаёт
worktree без provider process, затем одной transaction записывает workspace уже leased этому StageAttempt. Spawn
разрешён только после этого commit. Ошибка provisioning завершает AgentRun fail-closed и сохраняет workspace
evidence; она не оставляет in-memory reservation.

Provider process запускается только после commit. Ошибка spawn завершает зарезервированный run через существующую
fail-closed ветвь, а не удаляет его историю.

### D4 — Очередь приоритетна, стабильна и не гадает по тексту

Готовые candidates сортируются `URGENT → HIGH → MEDIUM → LOW`, затем `createdAt`, затем `dispatchId`. Scheduler
учитывает только machine-readable state: availability, budget permission, stable checkpoint, active counts и lease
claims. Title, prompt, checkpoint summary и provider prose не влияют на порядок или право запуска.

Default limits: global 3, project 3, provider 3. Более узкий configured limit побеждает default; значение 0 означает
явную паузу новых запусков на соответствующем scope. Limits не прерывают уже начатый run задним числом.

### D5 — Workspace использует read/write compatibility, но REVIEW требует stable checkpoint

На одном workspace одновременно допустимы несколько read-only run только по одному immutable checkpoint. Любой
writer конфликтует и с writer, и с reader этого workspace. WorkItem worktree остаётся отдельным по умолчанию; E1
lease — storage backstop, а не подсказка scheduler.

REVIEW и QA не запускаются против меняющегося дерева. Текущий линейный WorkflowTemplate уже создаёт их после
завершения предыдущей стадии; A3 сохраняет это условие отдельным `stableCheckpoint` input, чтобы будущий DAG не мог
случайно его обойти.

### D6 — Role playbook только уточняет Context Pack

WorkflowTemplate остаётся верхним из двух реализованных слоёв. Role playbook может добавить секцию либо поднять её
раньше среди optional sections, но не удалить required section, не сделать её optional и не поменять security or
permission policy. Recipe записывает `ROLE_PLAYBOOK` и точные profile id/revision; адаптер по-прежнему получает
только собранный pack.

## 4. Deep modules и seams

`packages/scheduler` имеет одну основную interface:

```text
planDispatchBatch({ candidates, activeRuns, limits })
  → { selectedDispatchIds, deferred }
```

Module владеет validation bounds, stable ordering, capacity accounting и workspace compatibility. Он не знает
SQLite, Fastify, adapter instances или process lifecycle.

`packages/domain` владеет AgentProfile/SquadAssignment/AgentRun invariants и role-playbook merge. Persistence
владеет атомарным claim. `apps/daemon` только наблюдает очередь, вызывает planner, запускает уже claimed runs и
будит новый проход при их завершении.

## 5. Модель

```text
PipelineRun
  └── SquadAssignment (immutable revision)
        └── AgentProfile ref per executable stage

StageAttempt
  └── AgentRun (one in A3 v1)
        └── ProviderSession (one or more through handoff)
```

`AgentRun.status`: `RUNNING | SUCCEEDED | FAILED | CANCELLED | INTERRUPTED | WAITING_HUMAN | SOFT_PAUSED |
HARD_PAUSED`.
Status не выводится из наличия процесса; он меняется только командами и validated transitions.

Scheduler deferral reasons: `NOT_READY`, `BUDGET_BLOCKED`, `CHECKPOINT_NOT_STABLE`, `ATTEMPT_ACTIVE`,
`GLOBAL_LIMIT`, `PROJECT_LIMIT`, `PROVIDER_LIMIT`, `WORKSPACE_CONFLICT`.

## 6. Жизненный цикл

1. Pipeline start сохраняет SquadAssignment и первый WorkflowDispatch вместе с workflow state.
2. Worker читает bounded pending candidates и durable active AgentRun.
3. Planner выдаёт упорядоченный batch и причины отсрочки.
4. Для каждого выбранного dispatch daemon вызывает атомарный `START_AGENT_RUN`.
5. Успешный claim при необходимости создаёт и durable-leases workspace до provider spawn; проигравший claim
   перечитывает очередь.
6. Provider handoff меняет только ProviderSession внутри того же AgentRun.
7. Terminal/pause/human outcome завершает AgentRun и освобождает capacity/lease одной durable transition; resume
   создаёт следующий ordinal, а не воскрешает старый run.
8. Completion будит scheduler; блокировка одного WorkItem не останавливает независимые runs.
9. Shutdown посылает abort каждой live ProviderSession и не начинает новые claims.
10. Startup reconciliation завершает orphan sessions/runs как interrupted до первого scheduling pass.

## 7. Security delta

- candidate read ограничен 200 rows, selected batch — global limit;
- profile, assignment, limits и scheduler inputs проходят closed runtime schemas;
- только daemon SYSTEM actor создаёт AgentRun; browser не передаёт provider argv, workspace path или slot claim;
- permission profile является пересечением верхних policy, а не union;
- provider/project limit проверяется повторно в claim transaction;
- exact AgentProfile revision и effective provider записываются до spawn;
- immutable AgentRun policy snapshot не заменяет per-ProviderSession ContextPackRecipe и его exact content hash;
- writer lease и stable checkpoint fail closed;
- shutdown/restart не создаёт automatic retry;
- logs не содержат prompts, raw provider stream, credentials или repository contents.

## 8. Acceptance

1. Три независимых fixture WorkItem одновременно достигают live ProviderSession; четвёртый остаётся deferred по
   `GLOBAL_LIMIT` и стартует после освобождения slot.
2. Project/provider override 1 не блокирует runnable task другого scope; причины ожидания стабильны и видимы.
3. Два writer run одного workspace не стартуют даже при concurrent wake; несколько read-only run допустимы только
   по одному stable checkpoint.
4. Handoff создаёт новую ProviderSession без второго AgentRun/slot.
5. Restart помечает orphan AgentRun interrupted и не перезапускает его автоматически.
6. Blocking HumanRequest останавливает только связанный run; независимые runs продолжаются.
7. Role playbook не может убрать required workflow context или расширить permissions.
8. Fleet projection совпадает с durable state после reconnect/restart и не является source of truth.
9. Focused tests, `pnpm verify`, E2E, production audit и clean release tarball проходят на macOS и Windows.
