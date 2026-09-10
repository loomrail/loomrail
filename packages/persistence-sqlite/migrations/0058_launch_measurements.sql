-- L2 / ADR-0027: owner-approved local launch measurement Plans and durable Runs.
CREATE TABLE launch_measurement_plans (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, revision)
) STRICT;

CREATE INDEX launch_measurement_plans_project_idx
ON launch_measurement_plans(project_id, revision DESC);

CREATE TRIGGER launch_measurement_plans_are_immutable_update
BEFORE UPDATE ON launch_measurement_plans BEGIN
  SELECT RAISE(ABORT, 'launch measurement plans are immutable');
END;

CREATE TRIGGER launch_measurement_plans_are_immutable_delete
BEFORE DELETE ON launch_measurement_plans BEGIN
  SELECT RAISE(ABORT, 'launch measurement plans cannot be deleted');
END;

CREATE TABLE launch_measurement_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES launch_measurement_plans(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('RUNNING', 'CANCELLING', 'BLOCKED', 'PASSED', 'FAILED', 'ERROR', 'INTERRUPTED')
  ),
  tested_tree TEXT NOT NULL CHECK (
    length(tested_tree) = 40 AND tested_tree NOT GLOB '*[^0-9a-f]*'
  ),
  run_json TEXT NOT NULL CHECK (json_valid(run_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  CHECK ((status IN ('RUNNING', 'CANCELLING', 'BLOCKED')) = (completed_at IS NULL))
) STRICT;

CREATE UNIQUE INDEX launch_measurement_runs_one_active_project
ON launch_measurement_runs(project_id)
WHERE status IN ('RUNNING', 'CANCELLING', 'BLOCKED');

CREATE INDEX launch_measurement_runs_project_idx
ON launch_measurement_runs(project_id, started_at DESC, id DESC);

CREATE INDEX launch_measurement_runs_active_idx
ON launch_measurement_runs(started_at, id)
WHERE status IN ('RUNNING', 'CANCELLING', 'BLOCKED');

CREATE TRIGGER launch_measurement_runs_guard_update
BEFORE UPDATE ON launch_measurement_runs
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.plan_id <> OLD.plan_id
  OR NEW.tested_tree <> OLD.tested_tree
  OR NEW.started_at <> OLD.started_at
  OR NEW.version <> OLD.version + 1
  OR OLD.status NOT IN ('RUNNING', 'CANCELLING', 'BLOCKED')
  OR NEW.status = 'RUNNING'
BEGIN
  SELECT RAISE(ABORT, 'invalid launch measurement run transition');
END;

CREATE TRIGGER launch_measurement_runs_cannot_delete
BEFORE DELETE ON launch_measurement_runs BEGIN
  SELECT RAISE(ABORT, 'launch measurement runs cannot be deleted');
END;

-- The append-only Event vocabulary records Plan and Run snapshots without rewriting history.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v58;

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
      'PROJECT_WORKSPACE_STRATEGY_CHANGED',
      'PROVIDER_ALLOWANCE_RECORDED', 'VERIFICATION_PLAN_ADOPTED', 'VERIFICATION_PLAN_DISABLED',
      'VERIFICATION_PLAN_PUBLICATION_APPLIED', 'VERIFICATION_PLAN_PUBLICATION_FAILED',
      'VERIFICATION_PLAN_PUBLICATION_RETRIED',
      'VERIFICATION_RUN_RESERVED', 'VERIFICATION_CHECK_STARTED',
      'VERIFICATION_CHECK_COMPLETED', 'VERIFICATION_RUN_CANCELLATION_REQUESTED',
      'VERIFICATION_RUN_INTERRUPTED', 'VERIFICATION_FAILURE_RECORDED',
      'VERIFICATION_CORRECTION_STARTED', 'VERIFICATION_CORRECTION_PASSED',
      'VERIFICATION_CORRECTION_SUPERSEDED', 'VERIFICATION_CORRECTION_EXHAUSTED',
      'VERIFICATION_CORRECTION_CANCELLED', 'MCP_PROFILE_CONSENTED', 'MCP_GRANT_CHANGED',
      'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_STATE_CHANGED',
      'WORK_ITEM_DEPENDENCIES_SET',
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
      'QA_CORRECTION_CANCELLED', 'WORKSPACE_TOOL_CALL_CHANGED',
      'LAUNCH_MEASUREMENT_PLAN_CHANGED', 'LAUNCH_MEASUREMENT_RUN_CHANGED'
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
FROM events_v58;

DROP TABLE events_v58;

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
