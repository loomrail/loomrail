-- The Git worktree a WorkItem is edited in (spec D1/D6, docs/plans/14-e1-workspace-execution-
-- implementation-plan.ru.md Задача 7). `work_item_id` is UNIQUE: the workspace belongs to the
-- WorkItem, not to any one StageAttempt, and a second row for the same WorkItem would mean two
-- writers past the lease. That invariant belongs to the schema, not to a convention callers are
-- trusted to follow.
--
-- `base_commit`/`snapshot_commit` are nullable, not optional-with-a-default: an empty repository
-- genuinely has no HEAD, and a workspace cut from a clean working copy genuinely carried nothing
-- forward, so there is no snapshot commit to name (spec §2.9/§2.12, see
-- packages/contracts/src/workspace.ts).
--
-- `lease_holder` names the StageAttempt currently allowed to write, or no one (spec D6): the
-- workspace outlives any single attempt, so this is a lease held for an attempt's duration, not an
-- owner. It is acquired by a single `UPDATE ... WHERE lease_holder IS NULL` -- see
-- ACQUIRE_WORKSPACE_LEASE in src/index.ts -- so the check and the claim are one atomic statement
-- rather than a read followed by a write.
CREATE TABLE work_item_workspaces (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_commit TEXT,
  snapshot_commit TEXT,
  status TEXT NOT NULL CHECK (status IN ('READY', 'ORPHANED', 'REMOVED')),
  lease_holder TEXT REFERENCES stage_attempts(id),
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
);

-- `events` bakes its allowed types into a CHECK, so widening it for WORK_ITEM_WORKSPACE_CREATED and
-- WORK_ITEM_WORKSPACE_ORPHANED requires a rebuild: drop the triggers and indexes, rename the table
-- aside, recreate it with the widened list, copy every row preserving `sequence`, drop the renamed
-- table, then recreate the indexes and the append-only triggers. This mirrors
-- 0006_session_handoff.sql's rebuild of the same table.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v10;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN (
      'PROJECT_REGISTERED', 'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_STATE_CHANGED',
      'PIPELINE_STARTED', 'STAGE_ATTEMPT_CHANGED', 'HUMAN_REQUEST_OPENED',
      'HUMAN_REQUEST_RESOLVED', 'USAGE_RECORDED', 'BUDGET_THRESHOLD_REACHED',
      'PIPELINE_PAUSED', 'PIPELINE_RESUMED', 'PIPELINE_CANCELLED',
      'BUDGET_OVERRIDE_APPROVED', 'RECOVERY_REPORT_CREATED', 'PIPELINE_COMPLETED',
      'EVIDENCE_ARTIFACT_RECORDED', 'ACCEPTANCE_REQUESTED', 'ACCEPTANCE_RESOLVED',
      'PROVIDER_SESSION_STARTED', 'CONTEXT_HANDOFF_REQUESTED', 'CHECKPOINT_PUBLISHED',
      'PROVIDER_SESSION_ENDED', 'CONTEXT_FLOOR_EXCEEDED',
      'WORK_ITEM_WORKSPACE_CREATED', 'WORK_ITEM_WORKSPACE_ORPHANED'
    )
  ),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('PROJECT', 'WORK_ITEM')),
  aggregate_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM')),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json))
) STRICT;

INSERT INTO events (
  sequence, id, schema_version, type, aggregate_type, aggregate_id, project_id,
  actor_type, actor_id, occurred_at, correlation_id, data_json
)
SELECT
  sequence, id, schema_version, type, aggregate_type, aggregate_id, project_id,
  actor_type, actor_id, occurred_at, correlation_id, data_json
FROM events_v10;

DROP TABLE events_v10;

CREATE INDEX events_project_sequence_idx ON events(project_id, sequence);
CREATE INDEX events_aggregate_sequence_idx ON events(aggregate_id, sequence);

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_are_append_only_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
