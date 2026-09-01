-- B4 (`docs/plans/39-b4-new-project-scaffolding-spec.ru.md`): a durable Project row owns the
-- scaffold operation before its repository exists. `PROVISIONING` is deliberately not ACTIVE:
-- list/query callers must not dispatch work against a path the publisher has not verified yet.
-- SQLite cannot widen this CHECK in place, and many tables reference projects, so this migration
-- uses the same foreign-key-off + foreign_key_check procedure as migration 0012.
CREATE TABLE projects_v19 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  fixture_id TEXT UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  repository_path TEXT NOT NULL UNIQUE,
  provider_preference TEXT NOT NULL DEFAULT 'AUTO'
    CHECK (provider_preference IN ('AUTO', 'CODEX', 'CLAUDE_CODE', 'MOCK')),
  status TEXT NOT NULL CHECK (status IN ('PROVISIONING', 'ACTIVE', 'ARCHIVED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO projects_v19 (
  id, workspace_id, fixture_id, name, repository_path, provider_preference,
  status, version, created_at, updated_at
)
SELECT
  id, workspace_id, fixture_id, name, repository_path, provider_preference,
  status, version, created_at, updated_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_v19 RENAME TO projects;

CREATE TABLE scaffold_operations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'TARGET_CONFLICT', 'TARGET_PARENT_UNAVAILABLE', 'RECIPE_CHANGED',
      'SCAFFOLD_FILE_CONFLICT', 'GIT_UNAVAILABLE', 'GIT_INIT_FAILED',
      'REPOSITORY_INVALID', 'SCAFFOLD_WRITE_FAILED'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX scaffold_operations_status_idx
  ON scaffold_operations(status, created_at, id);

CREATE TRIGGER scaffold_operations_cannot_delete
BEFORE DELETE ON scaffold_operations BEGIN
  SELECT RAISE(ABORT, 'scaffold operations cannot be deleted');
END;

-- `events.type` is closed. Add the three Project-scoped scaffold facts while preserving every
-- existing sequence and cursor. The provisioning Project already exists when the first event is
-- appended, so the ordinary project_id foreign key remains honest and unchanged.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v18;

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
FROM events_v18;

DROP TABLE events_v18;

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
