-- Spec docs/plans/15-e1-5-change-visibility-spec.ru.md D3, §4, §6 step 5 and §12.3.
--
-- The tree a stage's worktree held when the stage succeeded. Nothing in E1.5 reads it: spec §11
-- puts the per-stage breakdown among the milestone's non-goals, so this is precomputed for the
-- milestone that closes the second half of GD-002 (checkpoint commits, squash and the Conventional
-- Commit message), which requires GD-001. `stageAttemptSchema.resultTree` in @loomrail/contracts
-- carries the full statement: which milestone, what will read it, that the milestone has no ID in
-- the approved order yet, and the measured limit on what a reader arriving later can do with the
-- value (`git write-tree` leaves the tree UNREACHABLE, so `git gc` prunes it after
-- `gc.pruneExpire`; equality between two labels survives that, diffing from one does not).
--
-- Nullable with no default, because `null` is a fact rather than a gap: no tree was measured for
-- this stage. Every StageAttempt recorded before this migration stays null forever (spec §12.3),
-- and so does one whose stage never ran in a worktree or whose worktree was gone when the label was
-- taken. A stage that ran and changed NOTHING is not null -- it records the tree it started on --
-- so the two can never be confused.
--
-- The CHECK is the same shape assertion `treeShaSchema` makes at the contract boundary, restated
-- here because the database is written by more than the one code path and a garbled sha is worth
-- refusing at the moment of the write rather than at the moment of the read.

ALTER TABLE stage_attempts
  ADD COLUMN result_tree TEXT
  CHECK (result_tree IS NULL OR (length(result_tree) = 40 AND result_tree NOT GLOB '*[^0-9a-f]*'));

-- The rest of this migration is the history half, and it is the same repair 0008 performed for
-- `unproductive_sessions` and `pack_share_backoffs`: the column above gives every stored ROW a
-- correct value, but `stageAttemptSchema` is `.strict()` and the entity is embedded verbatim in the
-- payloads of PIPELINE_STARTED, STAGE_ATTEMPT_CHANGED, PIPELINE_PAUSED, PIPELINE_RESUMED,
-- PIPELINE_CANCELLED, BUDGET_OVERRIDE_APPROVED, RECOVERY_REPORT_CREATED, ACCEPTANCE_REQUESTED,
-- ACCEPTANCE_RESOLVED and PIPELINE_COMPLETED. Left alone, every such payload written before this
-- milestone fails `domainEventSchema.parse` inside `eventFromRow`, which makes the whole activity
-- timeline and the events endpoint unreadable -- and `commands.result_json` is replayed through
-- `stateCommandResultSchema`, so a receipt written before this milestone fails its replay the same
-- way. No test starting from an empty database can see either, which is exactly why 0008 exists.
--
-- Structure follows 0008 statement for statement, including the reasons behind its less obvious
-- choices, which all still hold: the paths cannot be spelled out literally (a StageAttempt appears
-- at the top level of a command result AND inside `$.events[i].data`, and the events array's length
-- varies by command type), so occurrences are found with json_tree and folded over with a recursive
-- CTE, one json_insert each; adding an object key never shifts an array index, so the fold order
-- does not matter; `$.stage IS NOT NULL` narrows the match to actual StageAttempts rather than
-- anything that happens to reuse the key name; and the occurrence list is materialised into an
-- indexed TEMP TABLE because a non-materialised CTE is re-evaluated per fold step, which made the
-- pass quadratic in history size (measured in 0008 at 89s for 2000 events plus 2000 receipts).
--
-- One difference from 0008 worth naming: the value inserted is JSON null rather than 0, and
-- `json_insert` with an SQL NULL writes JSON null (probed). The guard `json_type(...) IS NULL`
-- therefore still means "the key is absent" after a pass -- `json_type` answers the string 'null'
-- for a key present and null -- so the pass stays idempotent, and a re-run finds nothing to do.

DROP TRIGGER events_are_append_only_update;

CREATE TEMP TABLE legacy_event_result_tree (
  sequence INTEGER NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL
);

INSERT INTO legacy_event_result_tree (sequence, path, n)
SELECT events.sequence, tree.fullkey,
       ROW_NUMBER() OVER (PARTITION BY events.sequence ORDER BY tree.fullkey)
FROM events, json_tree(events.data_json) AS tree
WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
  AND tree.type = 'object'
  AND json_type(tree.value, '$.stage') IS NOT NULL
  AND json_type(tree.value, '$.resultTree') IS NULL;

CREATE INDEX legacy_event_result_tree_fold_idx ON legacy_event_result_tree (sequence, n);

CREATE TEMP TABLE backfilled_event (
  sequence INTEGER PRIMARY KEY,
  data_json TEXT NOT NULL
);

INSERT INTO backfilled_event (sequence, data_json)
WITH RECURSIVE
  backfilled(sequence, n, data_json) AS (
    SELECT events.sequence, 0, events.data_json
    FROM events
    WHERE events.sequence IN (SELECT sequence FROM legacy_event_result_tree)
    UNION ALL
    SELECT backfilled.sequence, legacy_event_result_tree.n,
           json_insert(backfilled.data_json, legacy_event_result_tree.path || '.resultTree', NULL)
    FROM backfilled
    JOIN legacy_event_result_tree
      ON legacy_event_result_tree.sequence = backfilled.sequence
     AND legacy_event_result_tree.n = backfilled.n + 1
  )
SELECT backfilled.sequence, backfilled.data_json
FROM backfilled
JOIN (SELECT sequence, MAX(n) AS n FROM legacy_event_result_tree GROUP BY sequence) AS folded
  ON folded.sequence = backfilled.sequence
 AND folded.n = backfilled.n;

UPDATE events
SET data_json = (SELECT data_json FROM backfilled_event WHERE backfilled_event.sequence = events.sequence)
WHERE events.sequence IN (SELECT sequence FROM backfilled_event);

DROP TABLE backfilled_event;
DROP TABLE legacy_event_result_tree;

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TRIGGER commands_are_append_only_update;

CREATE TEMP TABLE legacy_command_result_tree (
  command_id TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL
);

INSERT INTO legacy_command_result_tree (command_id, path, n)
SELECT commands.command_id, tree.fullkey,
       ROW_NUMBER() OVER (PARTITION BY commands.command_id ORDER BY tree.fullkey)
FROM commands, json_tree(commands.result_json) AS tree
WHERE tree.key IN ('stageAttempt', 'previousStageAttempt')
  AND tree.type = 'object'
  AND json_type(tree.value, '$.stage') IS NOT NULL
  AND json_type(tree.value, '$.resultTree') IS NULL;

CREATE INDEX legacy_command_result_tree_fold_idx ON legacy_command_result_tree (command_id, n);

CREATE TEMP TABLE backfilled_command (
  command_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);

INSERT INTO backfilled_command (command_id, result_json)
WITH RECURSIVE
  backfilled(command_id, n, result_json) AS (
    SELECT commands.command_id, 0, commands.result_json
    FROM commands
    WHERE commands.command_id IN (SELECT command_id FROM legacy_command_result_tree)
    UNION ALL
    SELECT backfilled.command_id, legacy_command_result_tree.n,
           json_insert(backfilled.result_json, legacy_command_result_tree.path || '.resultTree', NULL)
    FROM backfilled
    JOIN legacy_command_result_tree
      ON legacy_command_result_tree.command_id = backfilled.command_id
     AND legacy_command_result_tree.n = backfilled.n + 1
  )
SELECT backfilled.command_id, backfilled.result_json
FROM backfilled
JOIN (SELECT command_id, MAX(n) AS n FROM legacy_command_result_tree GROUP BY command_id) AS folded
  ON folded.command_id = backfilled.command_id
 AND folded.n = backfilled.n;

UPDATE commands
SET result_json = (
  SELECT result_json FROM backfilled_command WHERE backfilled_command.command_id = commands.command_id
)
WHERE commands.command_id IN (SELECT command_id FROM backfilled_command);

DROP TABLE backfilled_command;
DROP TABLE legacy_command_result_tree;

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands
BEGIN
  SELECT RAISE(ABORT, 'commands are append-only');
END;
