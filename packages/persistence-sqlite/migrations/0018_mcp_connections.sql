-- C1 (`docs/plans/33-c1-mcp-connections-spec.ru.md`). Exact local stdio launches are immutable
-- revisions. The browser never writes these tables directly; a consumed owner-consent challenge
-- becomes one durable command which writes revision + consent + event atomically.
CREATE TABLE mcp_profile_revisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  profile_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  executable TEXT NOT NULL CHECK (length(executable) BETWEEN 1 AND 4096),
  args_json TEXT NOT NULL CHECK (json_valid(args_json) AND json_type(args_json) = 'array'),
  declared_tools_json TEXT NOT NULL CHECK (
    json_valid(declared_tools_json) AND json_type(declared_tools_json) = 'array'
  ),
  canonical_digest TEXT NOT NULL CHECK (
    length(canonical_digest) = 64 AND canonical_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, revision),
  UNIQUE (profile_id, canonical_digest)
) STRICT;

CREATE INDEX mcp_profile_revisions_project_profile_idx
  ON mcp_profile_revisions(project_id, profile_id, revision DESC);

CREATE TABLE mcp_consents (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  profile_revision_id TEXT NOT NULL UNIQUE REFERENCES mcp_profile_revisions(id) ON DELETE RESTRICT,
  canonical_digest TEXT NOT NULL CHECK (
    length(canonical_digest) = 64 AND canonical_digest NOT GLOB '*[^0-9a-f]*'
  ),
  owner_id TEXT NOT NULL,
  consented_at TEXT NOT NULL
) STRICT;

CREATE TABLE mcp_capability_snapshots (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  profile_revision_id TEXT NOT NULL REFERENCES mcp_profile_revisions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'READY', 'SPAWN_FAILED', 'TIMED_OUT', 'INVALID_RESPONSE', 'OUTPUT_LIMIT_REACHED',
    'UNSUPPORTED_PROTOCOL', 'PROCESS_EXITED'
  )),
  protocol_version TEXT CHECK (protocol_version IS NULL OR length(protocol_version) BETWEEN 1 AND 80),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json) AND json_type(tools_json) = 'array'),
  resources_json TEXT NOT NULL CHECK (json_valid(resources_json) AND json_type(resources_json) = 'array'),
  prompts_json TEXT NOT NULL CHECK (json_valid(prompts_json) AND json_type(prompts_json) = 'array'),
  observed_at TEXT NOT NULL
) STRICT;

CREATE INDEX mcp_capability_snapshots_revision_observed_idx
  ON mcp_capability_snapshots(profile_revision_id, observed_at DESC, id DESC);

CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  profile_revision_id TEXT NOT NULL UNIQUE REFERENCES mcp_profile_revisions(id) ON DELETE RESTRICT,
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json) AND json_type(tools_json) = 'array'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version > 0),
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((enabled = 1 AND revoked_at IS NULL) OR (enabled = 0 AND revoked_at IS NOT NULL))
) STRICT;

CREATE INDEX mcp_grants_project_enabled_idx ON mcp_grants(project_id, enabled, profile_revision_id);

CREATE TABLE provider_session_mcp_snapshots (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  profile_revision_id TEXT NOT NULL REFERENCES mcp_profile_revisions(id) ON DELETE RESTRICT,
  profile_digest TEXT NOT NULL CHECK (
    length(profile_digest) = 64 AND profile_digest NOT GLOB '*[^0-9a-f]*'
  ),
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE RESTRICT,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json) AND json_type(tools_json) = 'array'),
  created_at TEXT NOT NULL,
  UNIQUE (provider_session_id, profile_revision_id)
) STRICT;

CREATE INDEX provider_session_mcp_snapshots_session_idx
  ON provider_session_mcp_snapshots(provider_session_id, id);

CREATE TABLE mcp_tool_calls (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  session_snapshot_id TEXT NOT NULL REFERENCES provider_session_mcp_snapshots(id) ON DELETE RESTRICT,
  profile_revision_id TEXT NOT NULL REFERENCES mcp_profile_revisions(id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  input_digest TEXT NOT NULL CHECK (
    length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN_OUTCOME')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'TOOL_NOT_GRANTED', 'GRANT_REVOKED', 'ARGUMENTS_INVALID', 'SERVER_UNAVAILABLE',
    'SERVER_ERROR', 'PROTOCOL_ERROR', 'DEADLINE_EXCEEDED', 'OUTPUT_LIMIT_REACHED', 'CONNECTION_LOST'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (
    (status = 'STARTED' AND failure_code IS NULL AND finished_at IS NULL) OR
    (status = 'SUCCEEDED' AND failure_code IS NULL AND finished_at IS NOT NULL) OR
    (status IN ('FAILED', 'UNKNOWN_OUTCOME') AND failure_code IS NOT NULL AND finished_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX mcp_tool_calls_session_started_idx
  ON mcp_tool_calls(provider_session_id, started_at, id);
CREATE INDEX mcp_tool_calls_unfinished_idx
  ON mcp_tool_calls(status, started_at) WHERE status = 'STARTED';

-- Facts are append-only. A grant is the one mutable projection; once revoked, its trigger below
-- prevents it from becoming enabled again. A tool call may make exactly one STARTED -> terminal
-- transition while every identifying field stays fixed.
CREATE TRIGGER mcp_profile_revisions_are_append_only_update
BEFORE UPDATE ON mcp_profile_revisions BEGIN
  SELECT RAISE(ABORT, 'MCP profile revisions are append-only');
END;
CREATE TRIGGER mcp_profile_revisions_are_append_only_delete
BEFORE DELETE ON mcp_profile_revisions BEGIN
  SELECT RAISE(ABORT, 'MCP profile revisions are append-only');
END;
CREATE TRIGGER mcp_consents_are_append_only_update
BEFORE UPDATE ON mcp_consents BEGIN
  SELECT RAISE(ABORT, 'MCP consents are append-only');
END;
CREATE TRIGGER mcp_consents_are_append_only_delete
BEFORE DELETE ON mcp_consents BEGIN
  SELECT RAISE(ABORT, 'MCP consents are append-only');
END;
CREATE TRIGGER mcp_capability_snapshots_are_append_only_update
BEFORE UPDATE ON mcp_capability_snapshots BEGIN
  SELECT RAISE(ABORT, 'MCP capability snapshots are append-only');
END;
CREATE TRIGGER mcp_capability_snapshots_are_append_only_delete
BEFORE DELETE ON mcp_capability_snapshots BEGIN
  SELECT RAISE(ABORT, 'MCP capability snapshots are append-only');
END;
CREATE TRIGGER provider_session_mcp_snapshots_are_append_only_update
BEFORE UPDATE ON provider_session_mcp_snapshots BEGIN
  SELECT RAISE(ABORT, 'MCP session snapshots are append-only');
END;
CREATE TRIGGER provider_session_mcp_snapshots_are_append_only_delete
BEFORE DELETE ON provider_session_mcp_snapshots BEGIN
  SELECT RAISE(ABORT, 'MCP session snapshots are append-only');
END;
CREATE TRIGGER mcp_grants_cannot_reenable
BEFORE UPDATE ON mcp_grants WHEN OLD.enabled = 0 AND NEW.enabled <> 0 BEGIN
  SELECT RAISE(ABORT, 'a revoked MCP grant cannot be enabled');
END;
CREATE TRIGGER mcp_grants_update_shape
BEFORE UPDATE ON mcp_grants WHEN
  NEW.id <> OLD.id OR
  NEW.schema_version <> OLD.schema_version OR
  NEW.project_id <> OLD.project_id OR
  NEW.profile_revision_id <> OLD.profile_revision_id OR
  NEW.created_at <> OLD.created_at OR
  NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'an MCP grant update may only advance its permission projection');
END;
CREATE TRIGGER mcp_grants_cannot_delete
BEFORE DELETE ON mcp_grants BEGIN
  SELECT RAISE(ABORT, 'MCP grants cannot be deleted');
END;
CREATE TRIGGER mcp_tool_calls_terminal_once
BEFORE UPDATE ON mcp_tool_calls WHEN
  OLD.status <> 'STARTED' OR
  NEW.id <> OLD.id OR
  NEW.schema_version <> OLD.schema_version OR
  NEW.project_id <> OLD.project_id OR
  NEW.provider_session_id <> OLD.provider_session_id OR
  NEW.session_snapshot_id <> OLD.session_snapshot_id OR
  NEW.profile_revision_id <> OLD.profile_revision_id OR
  NEW.tool_name <> OLD.tool_name OR
  NEW.input_digest <> OLD.input_digest OR
  NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'an MCP tool call may only move once from STARTED to terminal');
END;
CREATE TRIGGER mcp_tool_calls_cannot_delete
BEFORE DELETE ON mcp_tool_calls BEGIN
  SELECT RAISE(ABORT, 'MCP tool calls cannot be deleted');
END;

-- `events.type` is closed. Rebuild it with the two MCP Project audit facts and preserve every
-- sequence/cursor exactly; Events have no inbound foreign keys.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v17;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN (
      'PROJECT_REGISTERED', 'PROJECT_CONSTITUTION_PROPOSED',
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
      'WORK_ITEM_WORKSPACE_CREATED', 'WORK_ITEM_WORKSPACE_ORPHANED'
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
FROM events_v17;

DROP TABLE events_v17;

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
