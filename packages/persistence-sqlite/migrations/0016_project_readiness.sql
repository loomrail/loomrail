-- B3+B2 (`docs/plans/29-b3-b2-project-readiness-security-spec.ru.md`). One row is one
-- repository-bound assessment. The observed snapshot is immutable; only aggregate status/version
-- advances when the owner attests a manual check.
CREATE TABLE project_readiness_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  repository_head TEXT CHECK (
    repository_head IS NULL OR (length(repository_head) BETWEEN 40 AND 64 AND repository_head NOT GLOB '*[^0-9a-f]*')
  ),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
  working_tree_dirty INTEGER NOT NULL CHECK (working_tree_dirty IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ACTION_REQUIRED', 'READY')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX project_readiness_runs_project_created_idx
  ON project_readiness_runs(project_id, created_at DESC, id DESC);

CREATE TABLE project_readiness_checks (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  run_id TEXT NOT NULL REFERENCES project_readiness_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  check_key TEXT NOT NULL CHECK (check_key IN (
    'SECURITY_ACTIVE_CONSTITUTION', 'SECURITY_SECRET_PATHS', 'SECURITY_ENV_IGNORED',
    'SECURITY_CI_HARDENING', 'LEGAL_LICENSE', 'LEGAL_OWNER_REVIEW',
    'PAYMENTS_OWNER_REVIEW', 'ANALYTICS_OWNER_REVIEW'
  )),
  category TEXT NOT NULL CHECK (category IN ('SECURITY', 'LEGAL', 'PAYMENTS', 'ANALYTICS')),
  mode TEXT NOT NULL CHECK (mode IN ('AUTOMATED', 'OWNER')),
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'ACTION_REQUIRED', 'CONFIRMED', 'NOT_APPLICABLE')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (run_id, check_key),
  CHECK (
    (mode = 'AUTOMATED' AND status IN ('PASSED', 'ACTION_REQUIRED')) OR
    (mode = 'OWNER' AND status IN ('ACTION_REQUIRED', 'CONFIRMED', 'NOT_APPLICABLE'))
  )
) STRICT;

CREATE INDEX project_readiness_checks_run_idx ON project_readiness_checks(run_id, check_key);

CREATE TABLE project_readiness_findings (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  run_id TEXT NOT NULL REFERENCES project_readiness_runs(id) ON DELETE RESTRICT,
  check_id TEXT NOT NULL REFERENCES project_readiness_checks(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (code IN (
    'ACTIVE_CONSTITUTION_MISSING', 'TRACKED_SECRET_PATH', 'ENV_NOT_IGNORED',
    'CI_PULL_REQUEST_TARGET', 'CI_WRITE_ALL_PERMISSIONS', 'CI_ACTION_NOT_PINNED',
    'CI_INPUT_UNVERIFIABLE', 'LICENSE_MISSING'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  path TEXT CHECK (path IS NULL OR length(path) BETWEEN 1 AND 500),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500)
) STRICT;

CREATE INDEX project_readiness_findings_run_idx ON project_readiness_findings(run_id, check_id, id);

CREATE TABLE project_readiness_attestations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  run_id TEXT NOT NULL REFERENCES project_readiness_runs(id) ON DELETE RESTRICT,
  check_id TEXT NOT NULL REFERENCES project_readiness_checks(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('CONFIRMED', 'NOT_APPLICABLE')),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX project_readiness_attestations_run_idx
  ON project_readiness_attestations(run_id, check_id, created_at, id);

CREATE TRIGGER project_readiness_findings_are_append_only_update
BEFORE UPDATE ON project_readiness_findings BEGIN
  SELECT RAISE(ABORT, 'project readiness findings are append-only');
END;
CREATE TRIGGER project_readiness_findings_are_append_only_delete
BEFORE DELETE ON project_readiness_findings BEGIN
  SELECT RAISE(ABORT, 'project readiness findings are append-only');
END;
CREATE TRIGGER project_readiness_attestations_are_append_only_update
BEFORE UPDATE ON project_readiness_attestations BEGIN
  SELECT RAISE(ABORT, 'project readiness attestations are append-only');
END;
CREATE TRIGGER project_readiness_attestations_are_append_only_delete
BEFORE DELETE ON project_readiness_attestations BEGIN
  SELECT RAISE(ABORT, 'project readiness attestations are append-only');
END;

-- `events.type` is closed. Rebuild it with the two Project Readiness audit facts and preserve
-- sequences/cursors exactly; Events have no inbound foreign keys.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v15;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN (
      'PROJECT_REGISTERED', 'PROJECT_CONSTITUTION_PROPOSED',
      'PROJECT_CONSTITUTION_PUBLICATION_REQUESTED', 'PROJECT_CONSTITUTION_ACTIVATED',
      'PROJECT_CONSTITUTION_PUBLICATION_FAILED', 'PROJECT_READINESS_ASSESSED',
      'PROJECT_READINESS_ATTESTED',
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
FROM events_v15;

DROP TABLE events_v15;

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
