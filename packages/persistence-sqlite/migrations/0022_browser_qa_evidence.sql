-- Q1 deterministic Browser QA. The run owns verdict authority; evidence and attachment metadata
-- are append-only, while Defect disposition is versioned for the later Q2 retest lifecycle.

CREATE TABLE qa_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE RESTRICT,
  driver_id TEXT NOT NULL CHECK (driver_id = 'PLAYWRIGHT'),
  tested_tree TEXT NOT NULL CHECK (
    length(tested_tree) = 40 AND tested_tree NOT GLOB '*[^0-9a-f]*'
  ),
  target_origin TEXT NOT NULL CHECK (length(target_origin) BETWEEN 1 AND 2048),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PASSED', 'FAILED', 'ERROR')),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'TARGET_UNHEALTHY', 'DRIVER_CRASHED', 'ORIGIN_FORBIDDEN', 'TIMEOUT', 'EVIDENCE_INVALID'
    )
  ),
  error_summary TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  CHECK (
    (status = 'RUNNING' AND completed_at IS NULL)
    OR (status <> 'RUNNING' AND completed_at IS NOT NULL)
  ),
  CHECK (
    (status = 'ERROR' AND error_code IS NOT NULL AND error_summary IS NOT NULL)
    OR (status <> 'ERROR' AND error_code IS NULL AND error_summary IS NULL)
  )
) STRICT;

CREATE INDEX qa_runs_pipeline_started_idx
  ON qa_runs(pipeline_run_id, started_at, id);

CREATE TRIGGER qa_runs_one_way_completion
BEFORE UPDATE ON qa_runs
WHEN
  OLD.status <> 'RUNNING'
  OR NEW.status = 'RUNNING'
  OR NEW.version <> OLD.version + 1
  OR NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.pipeline_run_id <> OLD.pipeline_run_id
  OR NEW.stage_attempt_id <> OLD.stage_attempt_id
  OR NEW.agent_run_id <> OLD.agent_run_id
  OR NEW.driver_id <> OLD.driver_id
  OR NEW.tested_tree <> OLD.tested_tree
  OR NEW.target_origin <> OLD.target_origin
  OR NEW.plan_json <> OLD.plan_json
  OR NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'QA run may only complete once without changing its reservation');
END;

CREATE TRIGGER qa_runs_cannot_delete
BEFORE DELETE ON qa_runs BEGIN
  SELECT RAISE(ABORT, 'QA runs cannot be deleted');
END;

CREATE TABLE qa_attachment_refs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('SCREENSHOT', 'TRACE')),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 71 AND content_hash GLOB 'sha256:*'
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1073741824),
  target_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  retention_class TEXT NOT NULL CHECK (retention_class = 'STANDARD_30_DAYS'),
  storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 1024),
  UNIQUE (qa_run_id, storage_key)
) STRICT;

CREATE TRIGGER qa_attachment_refs_are_append_only_update
BEFORE UPDATE ON qa_attachment_refs BEGIN
  SELECT RAISE(ABORT, 'QA attachment refs are append-only');
END;

CREATE TRIGGER qa_attachment_refs_are_append_only_delete
BEFORE DELETE ON qa_attachment_refs BEGIN
  SELECT RAISE(ABORT, 'QA attachment refs are append-only');
END;

CREATE TABLE qa_defects (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  tested_tree TEXT NOT NULL CHECK (
    length(tested_tree) = 40 AND tested_tree NOT GLOB '*[^0-9a-f]*'
  ),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 50),
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'WAIVED')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  reproduction_json TEXT NOT NULL CHECK (
    json_valid(reproduction_json) AND json_type(reproduction_json) = 'array'
    AND json_array_length(reproduction_json) BETWEEN 1 AND 20
  ),
  target_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (qa_run_id, ordinal),
  CHECK (
    (status = 'OPEN' AND resolution_reason IS NULL AND resolved_at IS NULL)
    OR (status <> 'OPEN' AND resolution_reason IS NOT NULL AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX qa_defects_work_item_status_idx
  ON qa_defects(work_item_id, status, created_at, id);

CREATE TRIGGER qa_defects_immutable_identity
BEFORE UPDATE ON qa_defects
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.qa_run_id <> OLD.qa_run_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.tested_tree <> OLD.tested_tree
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.severity <> OLD.severity
  OR NEW.title <> OLD.title
  OR NEW.description <> OLD.description
  OR NEW.reproduction_json <> OLD.reproduction_json
  OR NEW.target_id <> OLD.target_id
  OR NEW.scenario_id <> OLD.scenario_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'QA defect identity is immutable');
END;

CREATE TRIGGER qa_defects_cannot_delete
BEFORE DELETE ON qa_defects BEGIN
  SELECT RAISE(ABORT, 'QA defects cannot be deleted');
END;

CREATE TABLE qa_evidence_bundles (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  qa_run_id TEXT NOT NULL UNIQUE REFERENCES qa_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  tested_tree TEXT NOT NULL CHECK (
    length(tested_tree) = 40 AND tested_tree NOT GLOB '*[^0-9a-f]*'
  ),
  verdict TEXT NOT NULL CHECK (verdict IN ('PASSED', 'FAILED')),
  environment_json TEXT NOT NULL CHECK (json_valid(environment_json) AND json_type(environment_json) = 'object'),
  executions_json TEXT NOT NULL CHECK (
    json_valid(executions_json) AND json_type(executions_json) = 'array'
    AND json_array_length(executions_json) BETWEEN 1 AND 480
  ),
  observations_json TEXT NOT NULL CHECK (
    json_valid(observations_json) AND json_type(observations_json) = 'array'
    AND json_array_length(observations_json) <= 100
  ),
  attachment_ids_json TEXT NOT NULL CHECK (
    json_valid(attachment_ids_json) AND json_type(attachment_ids_json) = 'array'
    AND json_array_length(attachment_ids_json) <= 50
  ),
  defect_ids_json TEXT NOT NULL CHECK (
    json_valid(defect_ids_json) AND json_type(defect_ids_json) = 'array'
    AND json_array_length(defect_ids_json) <= 50
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (verdict = 'PASSED' AND json_array_length(defect_ids_json) = 0)
    OR (verdict = 'FAILED' AND json_array_length(defect_ids_json) BETWEEN 1 AND 50)
  )
) STRICT;

CREATE TRIGGER qa_evidence_bundles_are_append_only_update
BEFORE UPDATE ON qa_evidence_bundles BEGIN
  SELECT RAISE(ABORT, 'QA evidence bundles are append-only');
END;

CREATE TRIGGER qa_evidence_bundles_are_append_only_delete
BEFORE DELETE ON qa_evidence_bundles BEGIN
  SELECT RAISE(ABORT, 'QA evidence bundles are append-only');
END;

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v21;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN (
      'PROJECT_REGISTERED', 'PROJECT_SCAFFOLD_REQUESTED', 'PROJECT_SCAFFOLD_COMPLETED',
      'PROJECT_SCAFFOLD_FAILED', 'PROJECT_CONSTITUTION_PROPOSED',
      'PROJECT_CONSTITUTION_PUBLICATION_REQUESTED', 'PROJECT_CONSTITUTION_ACTIVATED',
      'PROJECT_CONSTITUTION_PUBLICATION_FAILED', 'PROJECT_READINESS_ASSESSED',
      'PROJECT_READINESS_ATTESTED', 'PROJECT_PROVIDER_PREFERENCE_CHANGED',
      'MCP_PROFILE_CONSENTED', 'MCP_GRANT_CHANGED',
      'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_STATE_CHANGED',
      'PIPELINE_STARTED', 'STAGE_ATTEMPT_CHANGED', 'HUMAN_REQUEST_OPENED',
      'HUMAN_REQUEST_RESOLVED', 'USAGE_RECORDED', 'BUDGET_THRESHOLD_REACHED',
      'PIPELINE_PAUSED', 'PIPELINE_RESUMED', 'PIPELINE_CANCELLED',
      'BUDGET_OVERRIDE_APPROVED', 'RECOVERY_REPORT_CREATED', 'PIPELINE_COMPLETED',
      'EVIDENCE_ARTIFACT_RECORDED', 'ACCEPTANCE_REQUESTED', 'ACCEPTANCE_RESOLVED',
      'PROVIDER_SESSION_STARTED', 'CONTEXT_HANDOFF_REQUESTED', 'CHECKPOINT_PUBLISHED',
      'PROVIDER_SESSION_ENDED', 'CONTEXT_FLOOR_EXCEEDED',
      'WORK_ITEM_WORKSPACE_CREATED', 'WORK_ITEM_WORKSPACE_ORPHANED',
      'SQUAD_ASSIGNED', 'AGENT_RUN_STARTED', 'AGENT_RUN_FINISHED',
      'REVIEW_REPORT_RECORDED', 'REVIEW_FINDING_RECORDED', 'REVIEW_FINDING_RESOLVED',
      'REVIEW_LOOP_EXHAUSTED', 'QA_RUN_RESERVED', 'QA_RUN_COMPLETED'
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
FROM events_v21;

DROP TABLE events_v21;

CREATE INDEX events_project_sequence_idx ON events(project_id, sequence);
CREATE INDEX events_aggregate_sequence_idx ON events(aggregate_id, sequence);

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_are_append_only_delete
BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
