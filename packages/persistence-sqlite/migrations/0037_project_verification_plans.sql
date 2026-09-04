-- Q17 keeps the owner-approved verification Plan and its marker-file publication follow-up in
-- durable state. The Event is audit only; neither the repository file nor WebSocket delivery is
-- the source of truth.

CREATE TABLE verification_plans (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  source_proposal_hash TEXT NOT NULL CHECK (length(source_proposal_hash) = 64),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, revision)
) STRICT;

CREATE INDEX verification_plans_project_revision_idx
ON verification_plans(project_id, revision DESC);

CREATE TABLE verification_plan_publications (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL UNIQUE REFERENCES verification_plans(id) ON DELETE RESTRICT,
  target_path TEXT NOT NULL CHECK (target_path = '.loomrail/verification-plan.json'),
  expected_target_digest TEXT CHECK (expected_target_digest IS NULL OR length(expected_target_digest) = 64),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'FAILED')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  last_error_code TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT
) STRICT;

CREATE INDEX verification_plan_publications_pending_idx
ON verification_plan_publications(status, created_at, id);

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v36;

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
FROM events_v36;

DROP TABLE events_v36;

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
