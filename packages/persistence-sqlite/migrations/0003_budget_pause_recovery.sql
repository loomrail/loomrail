ALTER TABLE pipeline_runs ADD COLUMN orchestration_status TEXT CHECK (
  orchestration_status IS NULL OR orchestration_status IN (
    'RUNNING', 'WAITING_HUMAN', 'SOFT_PAUSED', 'HARD_PAUSED', 'INTERRUPTED',
    'SUCCEEDED', 'FAILED', 'CANCELLED'
  )
);

UPDATE pipeline_runs SET orchestration_status = status WHERE orchestration_status IS NULL;

CREATE TABLE budget_policies (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  max_estimated_tokens INTEGER NOT NULL CHECK (max_estimated_tokens > 0),
  warning_thresholds_json TEXT NOT NULL CHECK (json_valid(warning_thresholds_json)),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_run_id, revision)
) STRICT;

INSERT INTO budget_policies (
  id, schema_version, project_id, work_item_id, pipeline_run_id, revision,
  max_estimated_tokens, warning_thresholds_json, actor_type, actor_id, created_at
)
SELECT
  'budget-migrated-' || id, 1, project_id, work_item_id, id, 1,
  100, '[0.5,0.8,0.95]', 'SYSTEM', 'migration-0003', created_at
FROM pipeline_runs;

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  budget_policy_id TEXT NOT NULL REFERENCES budget_policies(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind = 'ESTIMATED_TOKENS'),
  amount INTEGER NOT NULL CHECK (amount > 0),
  quality TEXT NOT NULL CHECK (quality IN ('ACTUAL', 'PROVIDER_ESTIMATE', 'LOOMRAIL_ESTIMATE')),
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE recovery_reports (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  previous_status TEXT NOT NULL CHECK (previous_status = 'RUNNING'),
  recovered_status TEXT NOT NULL CHECK (recovered_status = 'INTERRUPTED'),
  reason TEXT NOT NULL CHECK (reason = 'DAEMON_RESTART'),
  created_at TEXT NOT NULL,
  UNIQUE (stage_attempt_id, reason)
) STRICT;

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v2;

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
      'BUDGET_OVERRIDE_APPROVED', 'RECOVERY_REPORT_CREATED', 'PIPELINE_COMPLETED'
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
FROM events_v2;

DROP TABLE events_v2;

CREATE INDEX budget_policies_run_revision_idx ON budget_policies(pipeline_run_id, revision DESC);
CREATE INDEX usage_records_run_recorded_idx ON usage_records(pipeline_run_id, recorded_at, id);
CREATE INDEX recovery_reports_work_item_created_idx ON recovery_reports(work_item_id, created_at, id);
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

CREATE TRIGGER budget_policies_are_append_only_update
BEFORE UPDATE ON budget_policies
BEGIN
  SELECT RAISE(ABORT, 'budget policies are append-only');
END;

CREATE TRIGGER budget_policies_are_append_only_delete
BEFORE DELETE ON budget_policies
BEGIN
  SELECT RAISE(ABORT, 'budget policies are append-only');
END;

CREATE TRIGGER usage_records_are_append_only_update
BEFORE UPDATE ON usage_records
BEGIN
  SELECT RAISE(ABORT, 'usage records are append-only');
END;

CREATE TRIGGER usage_records_are_append_only_delete
BEFORE DELETE ON usage_records
BEGIN
  SELECT RAISE(ABORT, 'usage records are append-only');
END;

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
