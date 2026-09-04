-- A StageAttempt may be interrupted by a daemon restart, explicitly resumed by its owner, and
-- interrupted again. The original UNIQUE(stage_attempt_id, reason) treated the second real
-- incident as a duplicate and rolled the entire startup reconciliation back, preventing Loomrail
-- from starting. Recovery reports are append-only incident facts, so each distinct reconciliation
-- needs its own row; command replay remains idempotent through the commands receipt table.

CREATE TABLE recovery_reports_v35 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  previous_status TEXT NOT NULL CHECK (previous_status = 'RUNNING'),
  recovered_status TEXT NOT NULL CHECK (recovered_status = 'INTERRUPTED'),
  reason TEXT NOT NULL CHECK (reason = 'DAEMON_RESTART'),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO recovery_reports_v35 (
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  previous_status, recovered_status, reason, created_at
)
SELECT
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  previous_status, recovered_status, reason, created_at
FROM recovery_reports;

DROP TRIGGER recovery_reports_are_append_only_update;
DROP TRIGGER recovery_reports_are_append_only_delete;
DROP INDEX recovery_reports_work_item_created_idx;
DROP TABLE recovery_reports;
ALTER TABLE recovery_reports_v35 RENAME TO recovery_reports;

CREATE INDEX recovery_reports_work_item_created_idx
  ON recovery_reports(work_item_id, created_at, id);

CREATE TRIGGER recovery_reports_are_append_only_update
BEFORE UPDATE ON recovery_reports
BEGIN
  SELECT RAISE(ABORT, 'recovery reports are append-only');
END;

CREATE TRIGGER recovery_reports_are_append_only_delete
BEFORE DELETE ON recovery_reports
BEGIN
  SELECT RAISE(ABORT, 'recovery reports are append-only');
END;
