-- Spec docs/plans/07-a1-session-handoff-spec.ru.md §6.5, §7.
--
-- Migrations 0006 and 0007 added `unproductive_sessions` and `pack_share_backoffs` as columns with
-- a DEFAULT, so every stored StageAttempt *row* came through the upgrade correct. The matching
-- fields on `stageAttemptSchema` are required and the schema is `.strict()`, and that entity is
-- embedded verbatim in the payloads of PIPELINE_STARTED, STAGE_ATTEMPT_CHANGED, PIPELINE_PAUSED,
-- PIPELINE_RESUMED, PIPELINE_CANCELLED, BUDGET_OVERRIDE_APPROVED, RECOVERY_REPORT_CREATED,
-- ACCEPTANCE_REQUESTED, ACCEPTANCE_RESOLVED and PIPELINE_COMPLETED -- none of which 0006 rewrote:
-- its rebuild of `events` copied `data_json` verbatim. Every payload written before this milestone
-- therefore fails `domainEventSchema.parse` inside `eventFromRow`, which makes the whole activity
-- timeline and the events endpoint unreadable on a database that predates A1. The board keeps
-- loading because snapshots are read from rows, which is exactly why no test caught it: every test
-- starts from an empty database, so every stored payload already has the post-A1 shape.
--
-- The same applies to `commands.result_json`, which is replayed through `stateCommandResultSchema`
-- when a command id is reused, so a pre-A1 receipt would fail its replay in the same way.
--
-- This is the same class of repair as 0004_pipeline_started_budget_backfill.sql, and follows it:
-- backfill the missing fields with the value the column default already gave the row (0), guard so
-- the pass is idempotent and touches nothing already correct, and drop and recreate the
-- append-only triggers around the writes as 0004 and 0005 both do.
--
-- Unlike 0004 the paths cannot be spelled out literally: a StageAttempt appears at the top level of
-- a command result *and* inside `$.events[i].data`, and `events` is an array whose length varies by
-- command type (RECONCILE_WORKFLOWS emits one report per interrupted run). So the paths are found
-- with json_tree and folded over with a recursive CTE, one json_insert per occurrence. Adding
-- object keys never shifts an array index, so the fold order does not matter.
--
-- `$.stage IS NOT NULL` narrows the match to actual StageAttempt objects: the key name alone is the
-- convention this backfill leans on, and requiring a field only a StageAttempt has keeps the pass
-- from stamping counters onto some future payload that reuses the name for something else.
--
-- The guard is "either counter absent", not "unproductiveSessions absent". A database written by a
-- build between 0006 (which added `unproductive_sessions`) and 0007 (which added
-- `pack_share_backoffs`) holds payloads carrying the first field and not the second; keying the
-- guard on the first alone would skip exactly those, and 0008 is recorded as applied afterwards, so
-- there is no second pass -- that history would stay unreadable for good. `json_insert` rather than
-- `json_set` for the same reason: on a half-legacy payload the counter that is already there is a
-- real count, and json_set would flatten it back to 0.
--
-- The occurrence list is materialised into a TEMP TABLE indexed on (sequence, n) rather than left
-- as a CTE. A non-materialised CTE is re-evaluated per fold step -- json_tree over every row again,
-- once per occurrence -- which made the pass quadratic in history size: measured on synthetic
-- legacy histories, 2000 events took 9.3s and 2000 events plus 2000 four-occurrence command
-- receipts took 89s, with no progress output, inside the BEGIN IMMEDIATE of a startup path the
-- owner cannot skip. The temp table is the same set of rows; only the number of times it is
-- computed changes.

DROP TRIGGER events_are_append_only_update;

CREATE TEMP TABLE legacy_event_attempt (
  sequence INTEGER NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL
);

INSERT INTO legacy_event_attempt (sequence, path, n)
SELECT events.sequence, tree.fullkey,
       ROW_NUMBER() OVER (PARTITION BY events.sequence ORDER BY tree.fullkey)
FROM events, json_tree(events.data_json) AS tree
WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
  AND tree.type = 'object'
  AND json_type(tree.value, '$.stage') IS NOT NULL
  AND (json_type(tree.value, '$.unproductiveSessions') IS NULL
       OR json_type(tree.value, '$.packShareBackoffs') IS NULL);

CREATE INDEX legacy_event_attempt_fold_idx ON legacy_event_attempt (sequence, n);

CREATE TEMP TABLE backfilled_event (
  sequence INTEGER PRIMARY KEY,
  data_json TEXT NOT NULL
);

INSERT INTO backfilled_event (sequence, data_json)
WITH RECURSIVE
  backfilled(sequence, n, data_json) AS (
    SELECT events.sequence, 0, events.data_json
    FROM events
    WHERE events.sequence IN (SELECT sequence FROM legacy_event_attempt)
    UNION ALL
    SELECT backfilled.sequence, legacy_event_attempt.n,
           json_insert(backfilled.data_json,
                       legacy_event_attempt.path || '.unproductiveSessions', 0,
                       legacy_event_attempt.path || '.packShareBackoffs', 0)
    FROM backfilled
    JOIN legacy_event_attempt
      ON legacy_event_attempt.sequence = backfilled.sequence
     AND legacy_event_attempt.n = backfilled.n + 1
  )
SELECT backfilled.sequence, backfilled.data_json
FROM backfilled
JOIN (SELECT sequence, MAX(n) AS n FROM legacy_event_attempt GROUP BY sequence) AS folded
  ON folded.sequence = backfilled.sequence
 AND folded.n = backfilled.n;

UPDATE events
SET data_json = (SELECT data_json FROM backfilled_event WHERE backfilled_event.sequence = events.sequence)
WHERE events.sequence IN (SELECT sequence FROM backfilled_event);

DROP TABLE backfilled_event;
DROP TABLE legacy_event_attempt;

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TRIGGER commands_are_append_only_update;

CREATE TEMP TABLE legacy_command_attempt (
  command_id TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL
);

INSERT INTO legacy_command_attempt (command_id, path, n)
SELECT commands.command_id, tree.fullkey,
       ROW_NUMBER() OVER (PARTITION BY commands.command_id ORDER BY tree.fullkey)
FROM commands, json_tree(commands.result_json) AS tree
WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
  AND tree.type = 'object'
  AND json_type(tree.value, '$.stage') IS NOT NULL
  AND (json_type(tree.value, '$.unproductiveSessions') IS NULL
       OR json_type(tree.value, '$.packShareBackoffs') IS NULL);

CREATE INDEX legacy_command_attempt_fold_idx ON legacy_command_attempt (command_id, n);

CREATE TEMP TABLE backfilled_command (
  command_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);

INSERT INTO backfilled_command (command_id, result_json)
WITH RECURSIVE
  backfilled(command_id, n, result_json) AS (
    SELECT commands.command_id, 0, commands.result_json
    FROM commands
    WHERE commands.command_id IN (SELECT command_id FROM legacy_command_attempt)
    UNION ALL
    SELECT backfilled.command_id, legacy_command_attempt.n,
           json_insert(backfilled.result_json,
                       legacy_command_attempt.path || '.unproductiveSessions', 0,
                       legacy_command_attempt.path || '.packShareBackoffs', 0)
    FROM backfilled
    JOIN legacy_command_attempt
      ON legacy_command_attempt.command_id = backfilled.command_id
     AND legacy_command_attempt.n = backfilled.n + 1
  )
SELECT backfilled.command_id, backfilled.result_json
FROM backfilled
JOIN (SELECT command_id, MAX(n) AS n FROM legacy_command_attempt GROUP BY command_id) AS folded
  ON folded.command_id = backfilled.command_id
 AND folded.n = backfilled.n;

UPDATE commands
SET result_json = (
  SELECT result_json FROM backfilled_command WHERE backfilled_command.command_id = commands.command_id
)
WHERE commands.command_id IN (SELECT command_id FROM backfilled_command);

DROP TABLE backfilled_command;
DROP TABLE legacy_command_attempt;

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands
BEGIN
  SELECT RAISE(ABORT, 'commands are append-only');
END;
