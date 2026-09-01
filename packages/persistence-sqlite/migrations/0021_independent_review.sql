-- R1 independent review loop. Review reports are append-only observations of one immutable tree;
-- findings keep a versioned current disposition while their identity and source never change.

CREATE TABLE review_reports (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL UNIQUE REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  author_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  reviewer_agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE RESTRICT,
  provider_relation TEXT NOT NULL CHECK (provider_relation IN ('CROSS_PROVIDER', 'SAME_PROVIDER')),
  reviewed_tree TEXT NOT NULL CHECK (
    length(reviewed_tree) = 40 AND reviewed_tree NOT GLOB '*[^0-9a-f]*'
  ),
  round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 3),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  verdict TEXT NOT NULL CHECK (verdict IN ('PASSED', 'CHANGES_REQUESTED')),
  finding_ids_json TEXT NOT NULL CHECK (
    json_valid(finding_ids_json)
    AND json_type(finding_ids_json) = 'array'
    AND json_array_length(finding_ids_json) <= 20
  ),
  created_at TEXT NOT NULL,
  CHECK (author_agent_run_id <> reviewer_agent_run_id),
  CHECK (
    (verdict = 'PASSED' AND json_array_length(finding_ids_json) = 0)
    OR (verdict = 'CHANGES_REQUESTED' AND json_array_length(finding_ids_json) BETWEEN 1 AND 20)
  ),
  UNIQUE (pipeline_run_id, round)
) STRICT;

CREATE INDEX review_reports_work_item_round_idx
  ON review_reports(work_item_id, pipeline_run_id, round DESC, id);

CREATE TRIGGER review_reports_are_append_only_update
BEFORE UPDATE ON review_reports BEGIN
  SELECT RAISE(ABORT, 'review reports are append-only');
END;

CREATE TRIGGER review_reports_are_append_only_delete
BEFORE DELETE ON review_reports BEGIN
  SELECT RAISE(ABORT, 'review reports are append-only');
END;

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  review_artifact_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE RESTRICT,
  reviewed_tree TEXT NOT NULL CHECK (
    length(reviewed_tree) = 40 AND reviewed_tree NOT GLOB '*[^0-9a-f]*'
  ),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 20),
  severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'WAIVED', 'FALSE_POSITIVE')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  path TEXT,
  start_line INTEGER CHECK (start_line IS NULL OR start_line > 0),
  end_line INTEGER CHECK (end_line IS NULL OR end_line > 0),
  reproduction TEXT NOT NULL CHECK (length(reproduction) BETWEEN 1 AND 4000),
  criterion TEXT,
  suggested_fix TEXT,
  resolution_reason TEXT,
  resolved_by_type TEXT CHECK (resolved_by_type IS NULL OR resolved_by_type IN ('HUMAN', 'SYSTEM')),
  resolved_by_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (review_artifact_id, ordinal),
  CHECK (path IS NOT NULL OR (start_line IS NULL AND end_line IS NULL)),
  CHECK ((start_line IS NULL) = (end_line IS NULL)),
  CHECK (start_line IS NULL OR end_line >= start_line),
  CHECK (
    (status = 'OPEN' AND resolution_reason IS NULL AND resolved_by_type IS NULL
      AND resolved_by_id IS NULL AND resolved_at IS NULL)
    OR
    (status <> 'OPEN' AND resolution_reason IS NOT NULL AND resolved_by_type IS NOT NULL
      AND resolved_by_id IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CHECK ((resolved_by_type IS NULL) = (resolved_by_id IS NULL))
) STRICT;

CREATE INDEX review_findings_pipeline_status_idx
  ON review_findings(pipeline_run_id, status, created_at, id);

CREATE TRIGGER review_findings_immutable_identity
BEFORE UPDATE ON review_findings
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.pipeline_run_id <> OLD.pipeline_run_id
  OR NEW.stage_attempt_id <> OLD.stage_attempt_id
  OR NEW.review_artifact_id <> OLD.review_artifact_id
  OR NEW.reviewed_tree <> OLD.reviewed_tree
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.severity <> OLD.severity
  OR NEW.title <> OLD.title
  OR NEW.description <> OLD.description
  OR NEW.path IS NOT OLD.path
  OR NEW.start_line IS NOT OLD.start_line
  OR NEW.end_line IS NOT OLD.end_line
  OR NEW.reproduction <> OLD.reproduction
  OR NEW.criterion IS NOT OLD.criterion
  OR NEW.suggested_fix IS NOT OLD.suggested_fix
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'review finding identity is immutable');
END;

CREATE TRIGGER review_findings_cannot_delete
BEFORE DELETE ON review_findings BEGIN
  SELECT RAISE(ABORT, 'review findings cannot be deleted');
END;

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v20;

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
      'REVIEW_LOOP_EXHAUSTED'
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
FROM events_v20;

DROP TABLE events_v20;

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
