# Loomrail Phase 0 / M2 — contracts, domain and persistence

**Дата:** 2026-08-22
**Статус:** locally complete; Windows CI evidence pending
**Outcome:** локальное состояние Project и WorkItem переживает restart, каждая принятая mutation атомарно оставляет
versioned Event, а повтор command не дублирует результат

## 1. Scope

M2 реализует минимальный deterministic work-management kernel:

- versioned runtime contracts для Project, WorkItem, commands, results и Events;
- pure WorkItem decision module с явной transition matrix;
- SQLite migrations, current-state tables, append-only events и command receipts;
- optimistic concurrency по `expectedVersion`;
- command idempotency по `commandId` и canonical input hash;
- регистрация только bundled fixture projects через allowlisted fixture ID;
- authenticated HTTP queries и mutations;
- exact Origin, JSON content type и session-bound CSRF для mutations;
- restart/reopen, backup-ready migration и cross-platform path tests.

## 2. Non-goals

- PipelineRun, StageAttempt, scheduler и workflow execution;
- HumanRequest, budgets, provider sessions или agents;
- WebSocket/realtime projection;
- repository scanning или чтение пользовательского project;
- shell, Git, worktree или browser automation;
- user-created Project paths;
- Kanban/Task Cockpit UI — это M3.

## 3. Deep module interfaces

### Domain module

`packages/domain` предоставляет одну основную interface:

```text
decideWorkItemCommand(command, context) -> decision
```

Она скрывает transition matrix, version increments, readiness/leaf rules и event intent. Module не знает о SQLite,
HTTP, filesystem, clock или ID generation. Clock/IDs уже разрешены persistence/application layer до вызова.

### Local-state module

`packages/persistence-sqlite` предоставляет:

```text
openLocalState(options) -> LocalState

LocalState.execute(command) -> command result
LocalState.query(query) -> query result
LocalState.close()
```

Module скрывает `node:sqlite`, migrations, prepared statements, row mapping, transaction, idempotency receipts,
optimistic concurrency и append-only Event. Daemon не получает raw database handle или repository-per-table methods.

## 4. Canonical records

### Project

```text
schemaVersion, id, workspaceId, fixtureId, name, repositoryPath
status: ACTIVE | ARCHIVED
version, createdAt, updatedAt
```

### WorkItem

```text
schemaVersion, id, projectId, parentId?
type: EPIC | FEATURE | TASK | BUG | SPIKE | SUBTASK
title, description
state: BACKLOG | READY | IN_PROGRESS | BLOCKED | DONE | CANCELLED
currentStage?
priority: LOW | MEDIUM | HIGH | URGENT
risk: LOW | MEDIUM | HIGH | CRITICAL
acceptanceCriteria[]
version, createdAt, updatedAt
```

M2 создаёт WorkItem только в `BACKLOG`. `DONE` остаётся недоступен до final acceptance command будущего milestone.
Новый executable state `IN_PROGRESS` запрещён для WorkItem с children.

## 5. Transition matrix

```text
BACKLOG      -> READY | CANCELLED
READY        -> BACKLOG | IN_PROGRESS | BLOCKED | CANCELLED
IN_PROGRESS  -> READY | BLOCKED | CANCELLED
BLOCKED      -> READY | IN_PROGRESS | CANCELLED
DONE         -> (none in M2)
CANCELLED    -> (none in M2)
```

Отдельные errors различают invalid transition, acceptance-required, terminal state, child execution и version
conflict. UI позднее сможет объяснить причину без разбора error string.

## 6. Transaction contract

Для accepted command одна `BEGIN IMMEDIATE` transaction:

1. ищет `commandId`;
2. для duplicate с тем же canonical hash возвращает сохранённый result;
3. reuse того же ID с другим input отклоняет;
4. загружает current aggregate и children metadata;
5. проверяет `expectedVersion` и domain transition;
6. сохраняет current state и normalized criteria;
7. добавляет append-only Event;
8. сохраняет serialized validated command result;
9. делает commit.

Любая ошибка делает rollback. Event публикуется наружу только как committed query result; realtime появится в M3.

## 7. Migration and recovery

- migrations — ordered immutable `.sql` files с SHA-256 checksum в `schema_migrations`;
- `foreign_keys`, WAL, defensive mode и bounded timeout включаются явно;
- перед pending migration существующей non-empty DB создаётся timestamped online backup;
- checksum drift закрывает startup, а не переписывает историю;
- daemon открывает DB до listener и не принимает requests при migration failure;
- tests используют temporary directories, paths with spaces/non-ASCII и никогда не удаляют внешний путь.

## 8. HTTP slice

```text
GET   /api/v1/projects
POST  /api/v1/projects/fixtures/register
GET   /api/v1/projects/:projectId/work-items
GET   /api/v1/work-items/:workItemId
POST  /api/v1/work-items
PATCH /api/v1/work-items/:workItemId
POST  /api/v1/work-items/:workItemId/move
GET   /api/v1/events
```

Queries требуют local session. Mutations дополнительно требуют exact Origin, `application/json` и
`x-loomrail-csrf`, совпадающий с session. HTTP requests не принимают arbitrary repository path: fixture registration
разрешает только catalog ID, а daemon сам canonicalizes bundled directory и запрещает escape/symlink.

## 9. Test matrix

- every allowed/forbidden state transition;
- `DONE` без acceptance rejected;
- parent with child cannot start;
- create/update/move increment expected versions correctly;
- stale expected version rejected without state/event mutation;
- same command ID/input returns same result and one Event;
- same command ID/different input rejected;
- accepted state and Event survive close/reopen;
- event sequence monotonic and Event UPDATE/DELETE denied;
- migration checksum and backup behavior;
- fixture ID validation, traversal and symlink escape rejection;
- anonymous, cross-origin, missing-CSRF and wrong-CSRF mutations rejected;
- two fixture Projects stay query-isolated;
- existing M1 bootstrap and browser smoke remain green.

## 10. Exit gate

M2 считается locally complete, когда:

- `pnpm verify`, production audit и Playwright smoke проходят;
- integration scenario регистрирует fixture Project, создаёт WorkItem, обновляет/двигает его, закрывает daemon,
  открывает ту же DB и видит state + ordered Events;
- duplicate command не создаёт второй WorkItem/Event;
- Windows matrix остаётся blocking и не помечается пройденной до реального GitHub Actions run;
- никакой provider, repository или command execution capability не появился.
