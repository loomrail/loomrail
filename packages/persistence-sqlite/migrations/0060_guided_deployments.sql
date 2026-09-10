-- L4a / ADR-0029: owner-approved, one-shot GitHub Actions deployment attempts.
CREATE TABLE deployment_plans (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  release_id TEXT NOT NULL REFERENCES launch_releases(id) ON DELETE RESTRICT,
  environment_id TEXT NOT NULL REFERENCES launch_environments(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision = 1),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX deployment_plans_project_idx
ON deployment_plans(project_id, created_at DESC, id DESC);

CREATE TRIGGER deployment_plans_are_immutable_update
BEFORE UPDATE ON deployment_plans BEGIN
  SELECT RAISE(ABORT, 'deployment plans are immutable');
END;

CREATE TRIGGER deployment_plans_cannot_delete
BEFORE DELETE ON deployment_plans BEGIN
  SELECT RAISE(ABORT, 'deployment plans cannot be deleted');
END;

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL UNIQUE REFERENCES deployment_plans(id) ON DELETE RESTRICT,
  release_id TEXT NOT NULL REFERENCES launch_releases(id) ON DELETE RESTRICT,
  environment_id TEXT NOT NULL REFERENCES launch_environments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')
  ),
  approval_digest TEXT NOT NULL CHECK (
    length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9a-f]*'
  ),
  remote_run_id INTEGER NULL CHECK (remote_run_id IS NULL OR remote_run_id > 0),
  deployment_json TEXT NOT NULL CHECK (json_valid(deployment_json)),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX deployments_project_idx
ON deployments(project_id, created_at DESC, id DESC);

CREATE INDEX deployments_active_idx
ON deployments(status, id)
WHERE status IN ('APPROVED', 'RUNNING');

CREATE TRIGGER deployments_guard_update
BEFORE UPDATE ON deployments
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.plan_id <> OLD.plan_id
  OR NEW.release_id <> OLD.release_id
  OR NEW.environment_id <> OLD.environment_id
  OR NEW.approval_digest <> OLD.approval_digest
  OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid deployment transition');
END;

CREATE TRIGGER deployments_cannot_delete
BEFORE DELETE ON deployments BEGIN
  SELECT RAISE(ABORT, 'deployments cannot be deleted');
END;

CREATE TABLE deployment_approvals (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  deployment_id TEXT NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE RESTRICT,
  approval_digest TEXT NOT NULL CHECK (
    length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9a-f]*'
  ),
  approval_json TEXT NOT NULL CHECK (json_valid(approval_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER deployment_approvals_are_immutable_update
BEFORE UPDATE ON deployment_approvals BEGIN
  SELECT RAISE(ABORT, 'deployment approvals are immutable');
END;

CREATE TRIGGER deployment_approvals_cannot_delete
BEFORE DELETE ON deployment_approvals BEGIN
  SELECT RAISE(ABORT, 'deployment approvals cannot be deleted');
END;

-- Extend append-only Event vocabulary without rewriting any event payload.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v60;

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
      'LAUNCH_ENVIRONMENT_CHANGED', 'LAUNCH_RELEASE_CREATED',
      'DEPLOYMENT_PLAN_ADOPTED', 'DEPLOYMENT_CHANGED'
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
FROM events_v60;

DROP TABLE events_v60;

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
