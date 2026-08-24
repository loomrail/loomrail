CREATE TABLE workflow_templates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  template_json TEXT NOT NULL CHECK (json_valid(template_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
) STRICT;

CREATE TABLE pipeline_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  workflow_template_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'WAITING_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  current_stage_attempt_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (workflow_template_id, workflow_version)
    REFERENCES workflow_templates(id, version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE stage_attempts (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('DISCOVERY', 'PLAN', 'IMPLEMENT', 'REVIEW', 'QA', 'ACCEPTANCE')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING', 'QUEUED', 'RUNNING', 'WAITING_HUMAN', 'SOFT_PAUSED', 'HARD_PAUSED',
      'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'RECOVERING', 'STALE'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  started_at TEXT,
  finished_at TEXT,
  failure_code TEXT,
  UNIQUE (pipeline_run_id, stage, attempt)
) STRICT;

CREATE TABLE human_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'CONFIRMATION', 'FREE_TEXT')),
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  context TEXT NOT NULL CHECK (length(context) BETWEEN 1 AND 4000),
  recommendation TEXT,
  allow_other INTEGER NOT NULL CHECK (allow_other IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLAIMED', 'SNOOZED', 'RESOLVED', 'EXPIRED', 'CANCELLED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE human_request_options (
  human_request_id TEXT NOT NULL REFERENCES human_requests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  consequence TEXT NOT NULL CHECK (length(consequence) BETWEEN 1 AND 4000),
  recommended INTEGER NOT NULL CHECK (recommended IN (0, 1)),
  PRIMARY KEY (human_request_id, ordinal),
  UNIQUE (human_request_id, id)
) STRICT;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  human_request_id TEXT NOT NULL UNIQUE REFERENCES human_requests(id) ON DELETE RESTRICT,
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json)),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workflow_dispatches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('START', 'RESUME')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v1;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN (
      'PROJECT_REGISTERED', 'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_STATE_CHANGED',
      'PIPELINE_STARTED', 'STAGE_ATTEMPT_CHANGED', 'HUMAN_REQUEST_OPENED',
      'HUMAN_REQUEST_RESOLVED', 'PIPELINE_COMPLETED'
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
FROM events_v1;

DROP TABLE events_v1;

CREATE INDEX pipeline_runs_work_item_created_idx ON pipeline_runs(work_item_id, created_at DESC, id);
CREATE INDEX stage_attempts_run_idx ON stage_attempts(pipeline_run_id, attempt, id);
CREATE INDEX human_requests_project_status_idx ON human_requests(project_id, status, created_at, id);
CREATE INDEX human_requests_work_item_idx ON human_requests(work_item_id, created_at, id);
CREATE INDEX decisions_work_item_idx ON decisions(work_item_id, created_at, id);
CREATE INDEX workflow_dispatches_pending_idx ON workflow_dispatches(status, created_at, id);
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

CREATE TRIGGER decisions_are_append_only_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only');
END;

CREATE TRIGGER decisions_are_append_only_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only');
END;
