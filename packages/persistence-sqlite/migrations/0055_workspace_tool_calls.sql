-- Q20 / ADR-0014: privacy-safe, idempotent audit for local provider workspace tools.
CREATE TABLE workspace_tool_calls (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  provider_call_key TEXT NOT NULL CHECK (
    length(provider_call_key) = 64 AND provider_call_key NOT GLOB '*[^0-9a-f]*'
  ),
  operation TEXT NOT NULL CHECK (
    operation IN ('LIST_DIRECTORY', 'READ_FILE', 'WRITE_FILE', 'DELETE_FILE', 'RUN_RECIPE')
  ),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 240),
  policy_digest TEXT NOT NULL CHECK (
    length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'
  ),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('STARTED', 'SUCCEEDED', 'DENIED', 'FAILED', 'UNKNOWN_OUTCOME')
  ),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'WORKSPACE_ACCESS_DENIED', 'PATH_INVALID', 'PATH_FORBIDDEN', 'PATH_OUTSIDE_WORKSPACE',
      'SYMLINK_FORBIDDEN', 'TARGET_NOT_FOUND', 'TARGET_TYPE_FORBIDDEN', 'CONTENT_CONFLICT',
      'CONTENT_INVALID', 'SIZE_LIMIT_REACHED', 'RECIPE_NOT_APPROVED',
      'RECIPE_AUTHORITY_CHANGED', 'NETWORK_POLICY_UNAVAILABLE', 'RECIPE_EXITED_NONZERO',
      'DEADLINE_EXCEEDED', 'OUTPUT_LIMIT_REACHED', 'CANCELLED',
      'PROCESS_TERMINATION_FAILED', 'PROCESS_FAILED', 'REPLAYED_WITHOUT_OUTPUT',
      'DAEMON_RESTART', 'INTERNAL_ERROR'
    )
  ),
  output_digest TEXT CHECK (
    output_digest IS NULL OR (
      length(output_digest) = 64 AND output_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  output_bytes INTEGER CHECK (output_bytes IS NULL OR output_bytes BETWEEN 0 AND 262144),
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (provider_session_id, provider_call_key),
  CHECK ((status = 'STARTED') = (finished_at IS NULL)),
  CHECK ((status IN ('STARTED', 'SUCCEEDED')) = (failure_code IS NULL))
) STRICT;

CREATE INDEX workspace_tool_calls_session_idx
ON workspace_tool_calls(provider_session_id, started_at, id);

CREATE INDEX workspace_tool_calls_started_idx
ON workspace_tool_calls(status, operation, started_at, id)
WHERE status = 'STARTED';

CREATE TRIGGER workspace_tool_calls_terminal_once
BEFORE UPDATE ON workspace_tool_calls
WHEN
  OLD.status <> 'STARTED'
  OR NEW.status = 'STARTED'
  OR NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.stage_attempt_id <> OLD.stage_attempt_id
  OR NEW.agent_run_id <> OLD.agent_run_id
  OR NEW.provider_session_id <> OLD.provider_session_id
  OR NEW.provider_call_key <> OLD.provider_call_key
  OR NEW.operation <> OLD.operation
  OR NEW.target <> OLD.target
  OR NEW.policy_digest <> OLD.policy_digest
  OR NEW.input_digest <> OLD.input_digest
  OR NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'a workspace tool call may only move once from STARTED to terminal');
END;

CREATE TRIGGER workspace_tool_calls_cannot_delete
BEFORE DELETE ON workspace_tool_calls BEGIN
  SELECT RAISE(ABORT, 'workspace tool calls cannot be deleted');
END;

-- The append-only Event vocabulary records both reservation and terminal outcome.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v55;

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
      'QA_CORRECTION_CANCELLED', 'WORKSPACE_TOOL_CALL_CHANGED'
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
FROM events_v55;

DROP TABLE events_v55;

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
