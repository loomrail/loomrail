CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  fixture_id TEXT NOT NULL UNIQUE CHECK (fixture_id IN ('web-app-a', 'api-service-b')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  repository_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  parent_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('EPIC', 'FEATURE', 'TASK', 'BUG', 'SPIKE', 'SUBTASK')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) <= 20000),
  state TEXT NOT NULL CHECK (state IN ('BACKLOG', 'READY', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED')),
  current_stage TEXT CHECK (
    current_stage IS NULL OR current_stage IN ('DISCOVERY', 'PLAN', 'IMPLEMENT', 'REVIEW', 'QA', 'ACCEPTANCE')
  ),
  priority TEXT NOT NULL CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  risk TEXT NOT NULL CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, project_id),
  FOREIGN KEY (parent_id, project_id) REFERENCES work_items(id, project_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE work_item_acceptance_criteria (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  criterion TEXT NOT NULL CHECK (length(criterion) BETWEEN 1 AND 500),
  PRIMARY KEY (work_item_id, ordinal)
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN ('PROJECT_REGISTERED', 'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_STATE_CHANGED')
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

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX work_items_project_state_idx ON work_items(project_id, state, created_at, id);
CREATE INDEX work_items_parent_idx ON work_items(parent_id, created_at, id);
CREATE INDEX events_project_sequence_idx ON events(project_id, sequence);
CREATE INDEX events_aggregate_sequence_idx ON events(aggregate_id, sequence);

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_are_append_only_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands
BEGIN
  SELECT RAISE(ABORT, 'command receipts are append-only');
END;

CREATE TRIGGER commands_are_append_only_delete
BEFORE DELETE ON commands
BEGIN
  SELECT RAISE(ABORT, 'command receipts are append-only');
END;
