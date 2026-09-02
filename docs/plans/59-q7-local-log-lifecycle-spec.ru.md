# Q7 — Local log lifecycle

**Дата:** 2026-09-02

**Статус:** approved implementation scope

**Предшественники:** Q4, Q5, Q6

**Нормативные решения:** AD-003, SD-003, SD-004, T04, T10

## 1. Outcome

Production launcher пишет bounded structured operational logs в локальный data directory, редактируя их до disk
write. Владелец может экспортировать уже отредактированный NDJSON или удалить только принадлежащие Loomrail log
segments явными CLI-командами. Retention работает автоматически и не может затронуть SQLite, Git, workspaces,
Browser QA evidence или неизвестные соседние файлы.

## 2. Термины и authority

**Operational Log Segment** — локальный append-only NDJSON-файл одной ограниченной части daemon operational log.
Он помогает расследованию, но не является Event, domain truth, workflow evidence или provider transcript.

**Log Writer Lease** — process-owned exclusive marker в `logs/`, не позволяющий второму launcher или management
command читать/удалять сегменты во время записи. Lease не является session/auth credential и не даёт product
authority.

**Redacted Log Export** — complete-or-error snapshot retained segments после повторной schema/redaction обработки.
Он не содержит source filenames, data-directory path или неотредактированные bytes.

SQLite Event/Decision/receipt остаются durable audit authority. Raw Codex/Claude stdout/stderr не начинает
сохраняться: adapters по-прежнему принимают только typed bounded события и отбрасывают owner hook/process output до
logger boundary.

## 3. Storage contract

Production `loomrail start` создаёт `<data>/logs/` с owner-only POSIX mode, проверяет, что это настоящий directory, и
берёт exclusive `.writer.lock`. Stale valid lock может быть reclaimed только если его PID больше не существует;
invalid/non-regular lock fail closed и не удаляется.

Owned segment имеет closed filename, создаётся `wx` с POSIX mode `0600` и никогда не переоткрывается по
произвольному path. Один segment ограничен 2 MiB, весь retained set — 16 MiB, одна sanitized line — 16 KiB. Segment
также меняется не реже раза в сутки при активной записи. Exact constants экспортируются для тестов и docs; локальные
пути/имена не попадают в stdout или safe error message.

Symlink, directory или другой non-regular node под owned filename/lock отвергается. Неизвестный соседний файл не
считается owned и сохраняется.

## 4. Redaction-before-write contract

Поток Pino/Fastify проходит через один standard-library sanitizer до `FileHandle.write`:

- принимается только JSON object; malformed/oversized raw line заменяется bounded diagnostic без исходных bytes;
- output получает schema version и component, а top-level поля проходят closed allowlist;
- request сохраняет только method, redacted URL и request ID; response — status code;
- error сохраняет safe type/code/message без stack;
- headers, body, environment, argv, prompt/output/content, repository/worktree/storage paths и неизвестные поля
  исключаются;
- string sanitizer скрывает bearer/assignment/query secrets, bootstrap-like long tokens, POSIX/Windows/UNC paths,
  control characters и режет длину;
- arrays/object depth/field count bounded; non-finite numbers и unsupported values не сериализуются.

Fastify header redaction остаётся defense in depth. CLI top-level failure также проходит тот же text sanitizer до
stderr. Bootstrap URL остаётся intentional one-time owner output startup report, но никогда не попадает в log stream.

## 5. Retention and capacity

Operational logs имеют privacy maximum `STANDARD_30_DAYS`, измеренный от последней модификации closed segment.
Cleanup выполняется до нового writer, при rotation и периодически во время долгого daemon process. Сначала удаляются
expired exact owned files, затем oldest files до reserved capacity следующего segment. Active segment не удаляется.

Deletion работает только по exact scanned names и после повторного `lstat`; traversal, glob и recursive removal не
используются. Ошибка cleanup/write/rotation закрывает writer и становится safe typed failure вместо бесконтрольного
роста или молчаливой потери privacy policy.

## 6. Owner commands

`loomrail logs export`:

- берёт management lease и поэтому требует остановленный daemon;
- читает exact regular owned segments в стабильном порядке с total bound;
- повторно парсит/redacts каждую строку до того, как что-либо пишет в stdout;
- выдаёт только NDJSON entries; empty retained set даёт empty stdout;
- corrupted/oversized/symlink input возвращает safe error и не выдаёт partial export.

`loomrail logs delete`:

- также требует management lease;
- удаляет только exact owned segments, не directory и не неизвестных siblings;
- печатает bounded count/bytes без filesystem path;
- не трогает Event log, state database, backups, artifacts, demo repositories, workspaces или Git.

Commands не доступны через unauthenticated HTTP и не добавляют remote export/delete boundary.

## 7. Acceptance criteria

1. Production launcher пишет sanitized local NDJSON и закрывает writer после daemon shutdown/failure.
2. Bootstrap/session/header/token/path/prompt canaries отсутствуют в bytes на диске и в export.
3. Malformed и oversized input заменяется safe bounded diagnostic до write.
4. Rotation, 30-day cleanup и 16-MiB capacity удаляют только exact regular owned segments.
5. Active writer блокирует export/delete; dead valid lock reclaimable, invalid lock сохраняется и fail closed.
6. Export complete-or-error, повторно redacted, без filenames/paths; delete explicit и scoped.
7. CLI parsing/help, macOS/Windows path behavior, crash restart и release clean install остаются зелёными.
8. EN/RU operations/security docs и T10 delta описывают retention/export/delete и residual local-owner risk.

## 8. Non-goals

- raw provider transcript/stdout/stderr capture;
- telemetry, crash upload, network export или support bundle;
- Workbench live-log UI/retention settings;
- удаление durable Events/Decisions/usage/handoffs;
- изменение Browser QA `STANDARD_30_DAYS` lifecycle;
- encryption-at-rest или собственный key store;
- изменение `apps/landing/**`.
