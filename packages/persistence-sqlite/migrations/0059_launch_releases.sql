-- L3 / ADR-0028: owner-declared Environments and immutable Release evidence snapshots.
CREATE TABLE launch_environments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('PREVIEW', 'PRODUCTION')),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, kind)
) STRICT;

CREATE INDEX launch_environments_project_idx
ON launch_environments(project_id, kind, id);

CREATE TRIGGER launch_environments_guard_update
BEFORE UPDATE ON launch_environments
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.kind <> OLD.kind
  OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid launch environment transition');
END;

CREATE TRIGGER launch_environments_cannot_delete
BEFORE DELETE ON launch_environments BEGIN
  SELECT RAISE(ABORT, 'launch environments cannot be deleted');
END;

CREATE TABLE launch_releases (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  environment_id TEXT NOT NULL REFERENCES launch_environments(id) ON DELETE RESTRICT,
  source_tree TEXT NOT NULL CHECK (
    length(source_tree) = 40 AND source_tree NOT GLOB '*[^0-9a-f]*'
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  release_json TEXT NOT NULL CHECK (json_valid(release_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX launch_releases_project_idx
ON launch_releases(project_id, created_at DESC, id DESC);

CREATE TRIGGER launch_releases_are_immutable_update
BEFORE UPDATE ON launch_releases BEGIN
  SELECT RAISE(ABORT, 'launch releases are immutable');
END;

CREATE TRIGGER launch_releases_cannot_delete
BEFORE DELETE ON launch_releases BEGIN
  SELECT RAISE(ABORT, 'launch releases cannot be deleted');
END;

-- The append-only Event vocabulary records Environment/Release snapshots without rewriting history.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v59;

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
      'LAUNCH_MEASUREMENT_PLAN_CHANGED', 'LAUNCH_MEASUREMENT_RUN_CHANGED',
      'LAUNCH_ENVIRONMENT_CHANGED', 'LAUNCH_RELEASE_CREATED'
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
FROM events_v59;

DROP TABLE events_v59;

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
