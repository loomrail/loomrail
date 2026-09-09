-- Q20.6 / ADR-0014: add bounded exact-fragment editing without rewriting audit history.
DROP TRIGGER workspace_tool_calls_terminal_once;
DROP TRIGGER workspace_tool_calls_cannot_delete;
DROP INDEX workspace_tool_calls_session_idx;
DROP INDEX workspace_tool_calls_started_idx;
ALTER TABLE workspace_tool_calls RENAME TO workspace_tool_calls_v57;

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
    operation IN ('LIST_DIRECTORY', 'READ_FILE', 'WRITE_FILE', 'EDIT_FILE', 'DELETE_FILE', 'RUN_RECIPE')
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

INSERT INTO workspace_tool_calls (
  id, schema_version, project_id, work_item_id, stage_attempt_id, agent_run_id,
  provider_session_id, provider_call_key, operation, target, policy_digest, input_digest,
  status, failure_code, output_digest, output_bytes, exit_code, started_at, finished_at
)
SELECT
  id, schema_version, project_id, work_item_id, stage_attempt_id, agent_run_id,
  provider_session_id, provider_call_key, operation, target, policy_digest, input_digest,
  status, failure_code, output_digest, output_bytes, exit_code, started_at, finished_at
FROM workspace_tool_calls_v57;

DROP TABLE workspace_tool_calls_v57;

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
