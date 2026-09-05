-- Durable owner-approved verification execution. A Run owns the workspace's read reservation
-- while queued/running; StageAttempt writers and verification readers exclude each other in the
-- same workspace row rather than coordinating through daemon memory.

CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES work_item_workspaces(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE RESTRICT,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  plan_content_hash TEXT NOT NULL CHECK (length(plan_content_hash) = 64),
  implementation_tree TEXT NOT NULL CHECK (length(implementation_tree) = 40),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  retry_of_run_id TEXT REFERENCES verification_runs(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'linux', 'win32')),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'INTERRUPTED')),
  current_check_id TEXT,
  terminal_reason TEXT CHECK (
    terminal_reason IS NULL OR terminal_reason IN (
      'ALL_REQUIRED_PASSED', 'REQUIRED_CHECK_FAILED', 'REQUIRED_CHECK_ERROR',
      'OWNER_CANCELLED', 'DAEMON_RESTART'
    )
  ),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (work_item_id, ordinal)
) STRICT;

CREATE UNIQUE INDEX verification_runs_active_workspace_idx
ON verification_runs(workspace_id)
WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX verification_runs_work_item_idx
ON verification_runs(work_item_id, ordinal DESC);

CREATE TABLE verification_checks (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE RESTRICT,
  recipe_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 12),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'INTERRUPTED')),
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  exit_code INTEGER,
  signal TEXT,
  error_code TEXT,
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, recipe_id)
) STRICT;

CREATE INDEX verification_checks_run_idx ON verification_checks(run_id, ordinal);

CREATE TABLE verification_output_artifacts (
  artifact_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE RESTRICT,
  check_id TEXT NOT NULL UNIQUE REFERENCES verification_checks(id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

ALTER TABLE work_item_workspaces
ADD COLUMN verification_holder TEXT REFERENCES verification_runs(id) ON DELETE RESTRICT;

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v37;

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
      'PROVIDER_ALLOWANCE_RECORDED', 'VERIFICATION_PLAN_ADOPTED',
      'VERIFICATION_PLAN_PUBLICATION_APPLIED', 'VERIFICATION_PLAN_PUBLICATION_FAILED',
      'VERIFICATION_PLAN_PUBLICATION_RETRIED',
      'VERIFICATION_RUN_RESERVED', 'VERIFICATION_CHECK_STARTED',
      'VERIFICATION_CHECK_COMPLETED', 'VERIFICATION_RUN_INTERRUPTED',
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
      'REVIEW_LOOP_EXHAUSTED', 'QA_RUN_RESERVED', 'QA_RUN_COMPLETED', 'QA_DEFECT_WAIVED',
      'QA_CORRECTION_STARTED', 'QA_CORRECTION_EXHAUSTED', 'QA_CORRECTION_PASSED',
      'QA_CORRECTION_CANCELLED'
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
FROM events_v37;

DROP TABLE events_v37;

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
