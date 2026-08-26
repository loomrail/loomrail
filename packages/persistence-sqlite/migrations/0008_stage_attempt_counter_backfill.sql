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
-- backfill the missing fields with the value the column default already gave the row (0), guard on
-- `json_type(...) IS NULL` so the pass is idempotent and touches nothing already correct, and drop
-- and recreate the append-only triggers around the writes as 0004 and 0005 both do.
--
-- Unlike 0004 the paths cannot be spelled out literally: a StageAttempt appears at the top level of
-- a command result *and* inside `$.events[i].data`, and `events` is an array whose length varies by
-- command type (RECONCILE_WORKFLOWS emits one report per interrupted run). So the paths are found
-- with json_tree and folded over with a recursive CTE, one json_set per occurrence. Adding object
-- keys never shifts an array index, so the fold order does not matter.
--
-- `$.stage IS NOT NULL` narrows the match to actual StageAttempt objects: the key name alone is the
-- convention this backfill leans on, and requiring a field only a StageAttempt has keeps the pass
-- from stamping counters onto some future payload that reuses the name for something else.

DROP TRIGGER events_are_append_only_update;

WITH RECURSIVE
  legacy_attempt(sequence, path, n) AS (
    SELECT events.sequence, tree.fullkey,
           ROW_NUMBER() OVER (PARTITION BY events.sequence ORDER BY tree.fullkey)
    FROM events, json_tree(events.data_json) AS tree
    WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
      AND tree.type = 'object'
      AND json_type(tree.value, '$.stage') IS NOT NULL
      AND json_type(tree.value, '$.unproductiveSessions') IS NULL
  ),
  backfilled(sequence, n, data_json) AS (
    SELECT events.sequence, 0, events.data_json
    FROM events
    WHERE events.sequence IN (SELECT sequence FROM legacy_attempt)
    UNION ALL
    SELECT backfilled.sequence, legacy_attempt.n,
           json_set(backfilled.data_json,
                    legacy_attempt.path || '.unproductiveSessions', 0,
                    legacy_attempt.path || '.packShareBackoffs', 0)
    FROM backfilled
    JOIN legacy_attempt
      ON legacy_attempt.sequence = backfilled.sequence
     AND legacy_attempt.n = backfilled.n + 1
  )
UPDATE events
SET data_json = (
  SELECT data_json FROM backfilled
  WHERE backfilled.sequence = events.sequence
  ORDER BY backfilled.n DESC
  LIMIT 1
)
WHERE events.sequence IN (SELECT sequence FROM legacy_attempt);

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TRIGGER commands_are_append_only_update;

WITH RECURSIVE
  legacy_attempt(command_id, path, n) AS (
    SELECT commands.command_id, tree.fullkey,
           ROW_NUMBER() OVER (PARTITION BY commands.command_id ORDER BY tree.fullkey)
    FROM commands, json_tree(commands.result_json) AS tree
    WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
      AND tree.type = 'object'
      AND json_type(tree.value, '$.stage') IS NOT NULL
      AND json_type(tree.value, '$.unproductiveSessions') IS NULL
  ),
  backfilled(command_id, n, result_json) AS (
    SELECT commands.command_id, 0, commands.result_json
    FROM commands
    WHERE commands.command_id IN (SELECT command_id FROM legacy_attempt)
    UNION ALL
    SELECT backfilled.command_id, legacy_attempt.n,
           json_set(backfilled.result_json,
                    legacy_attempt.path || '.unproductiveSessions', 0,
                    legacy_attempt.path || '.packShareBackoffs', 0)
    FROM backfilled
    JOIN legacy_attempt
      ON legacy_attempt.command_id = backfilled.command_id
     AND legacy_attempt.n = backfilled.n + 1
  )
UPDATE commands
SET result_json = (
  SELECT result_json FROM backfilled
  WHERE backfilled.command_id = commands.command_id
  ORDER BY backfilled.n DESC
  LIMIT 1
)
WHERE commands.command_id IN (SELECT command_id FROM legacy_attempt);

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands
BEGIN
  SELECT RAISE(ABORT, 'commands are append-only');
END;
