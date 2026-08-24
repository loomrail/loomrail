CREATE TABLE evidence_artifacts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('REVIEW', 'QA')),
  kind TEXT NOT NULL CHECK (kind IN ('REVIEW_REPORT', 'QA_REPORT')),
  status TEXT NOT NULL CHECK (status = 'PASSED'),
  provider TEXT NOT NULL CHECK (provider = 'MOCK'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_run_id, kind)
) STRICT;

CREATE TABLE acceptance_packages (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL UNIQUE REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  human_request_id TEXT NOT NULL UNIQUE REFERENCES human_requests(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'RETURNED', 'REJECTED')),
  criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
  artifact_ids_json TEXT NOT NULL CHECK (json_valid(artifact_ids_json)),
  release_note TEXT NOT NULL CHECK (length(release_note) BETWEEN 1 AND 4000),
  verify_instructions_json TEXT NOT NULL CHECK (json_valid(verify_instructions_json)),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_type TEXT CHECK (resolved_by_type IS NULL OR resolved_by_type IN ('HUMAN', 'SYSTEM')),
  resolved_by_id TEXT,
  resolution_reason TEXT,
  CHECK ((resolved_by_type IS NULL) = (resolved_by_id IS NULL))
) STRICT;

CREATE INDEX evidence_artifacts_run_created_idx
  ON evidence_artifacts(pipeline_run_id, created_at, id);
CREATE INDEX acceptance_packages_work_item_created_idx
  ON acceptance_packages(work_item_id, created_at DESC, id);

CREATE TRIGGER evidence_artifacts_are_append_only_update
BEFORE UPDATE ON evidence_artifacts
BEGIN
  SELECT RAISE(ABORT, 'evidence artifacts are append-only');
END;

CREATE TRIGGER evidence_artifacts_are_append_only_delete
BEFORE DELETE ON evidence_artifacts
BEGIN
  SELECT RAISE(ABORT, 'evidence artifacts are append-only');
END;

DROP TRIGGER commands_are_append_only_update;

UPDATE commands
SET result_json = json_set(
  result_json,
  '$.artifacts', json('[]'),
  '$.acceptancePackage', json('null')
)
WHERE command_type = 'APPLY_MOCK_PROVIDER_OUTCOME'
  AND json_type(result_json, '$.artifacts') IS NULL;

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands
BEGIN
  SELECT RAISE(ABORT, 'commands are append-only');
END;

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v4;

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
      'EVIDENCE_ARTIFACT_RECORDED', 'ACCEPTANCE_REQUESTED', 'ACCEPTANCE_RESOLVED'
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
FROM events_v4;

DROP TABLE events_v4;

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
