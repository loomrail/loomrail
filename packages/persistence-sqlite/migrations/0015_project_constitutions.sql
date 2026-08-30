-- B5+B1 (`docs/plans/23-b5-b1-existing-repository-onboarding-spec.ru.md`). A scan produces an
-- immutable proposal body whose status/version changes only as publication advances. Repository
-- text remains untrusted data inside `scan_json`/`sections_json`; only the owner command below may
-- create a publication.
CREATE TABLE constitution_proposals (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  project_version INTEGER NOT NULL CHECK (project_version > 0),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'ADOPTION_REQUESTED', 'ADOPTED')),
  preset_id TEXT NOT NULL CHECK (
    preset_id IN ('repository-baseline', 'typescript-node', 'typescript-pnpm-workspace')
  ),
  preset_version INTEGER NOT NULL CHECK (preset_version = 1),
  recommended_preset_id TEXT NOT NULL CHECK (
    recommended_preset_id IN ('repository-baseline', 'typescript-node', 'typescript-pnpm-workspace')
  ),
  scan_json TEXT NOT NULL CHECK (json_valid(scan_json)),
  sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
  rendered_markdown TEXT NOT NULL CHECK (length(rendered_markdown) BETWEEN 1 AND 100000),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  adopted_at TEXT
) STRICT;

CREATE INDEX constitution_proposals_project_created_idx
  ON constitution_proposals(project_id, created_at DESC, id DESC);

-- Version rows are immutable in content and mutable only in publication state. `ordinal` is the
-- stable project-local version number; the partial UNIQUE index enforces the product invariant
-- that one Project never has two active Constitutions.
CREATE TABLE project_constitution_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES constitution_proposals(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  preset_id TEXT NOT NULL CHECK (
    preset_id IN ('repository-baseline', 'typescript-node', 'typescript-pnpm-workspace')
  ),
  preset_version INTEGER NOT NULL CHECK (preset_version = 1),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  rendered_markdown TEXT NOT NULL CHECK (length(rendered_markdown) BETWEEN 1 AND 100000),
  status TEXT NOT NULL CHECK (status IN ('PUBLISHING', 'ACTIVE', 'SUPERSEDED', 'FAILED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (project_id, ordinal)
) STRICT;

CREATE UNIQUE INDEX project_constitution_one_active_idx
  ON project_constitution_versions(project_id) WHERE status = 'ACTIVE';

CREATE INDEX project_constitution_project_ordinal_idx
  ON project_constitution_versions(project_id, ordinal DESC);

-- The durable filesystem follow-up required by ADR-0002. The approved content stays on the
-- version row; this row records compare-and-set input and retry/recovery state, so a crash never
-- requires reconstructing intent from an Event.
CREATE TABLE constitution_publications (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  constitution_version_id TEXT NOT NULL UNIQUE REFERENCES project_constitution_versions(id) ON DELETE RESTRICT,
  target_path TEXT NOT NULL CHECK (target_path = '.loomrail/constitution.md'),
  expected_target_digest TEXT CHECK (expected_target_digest IS NULL OR length(expected_target_digest) = 64),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'FAILED')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'CONSTITUTION_TARGET_CHANGED', 'CONSTITUTION_TARGET_OUTSIDE_REPOSITORY',
      'CONSTITUTION_TARGET_UNREADABLE', 'CONSTITUTION_WRITE_FAILED', 'REPOSITORY_UNAVAILABLE'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT
) STRICT;

CREATE INDEX constitution_publications_pending_idx
  ON constitution_publications(status, created_at, id);

-- `events.type` is a closed CHECK. Rebuild it with the four Project Constitution audit facts while
-- preserving every sequence/cursor exactly; Events have no inbound foreign keys.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v14;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN (
      'PROJECT_REGISTERED', 'PROJECT_CONSTITUTION_PROPOSED',
      'PROJECT_CONSTITUTION_PUBLICATION_REQUESTED', 'PROJECT_CONSTITUTION_ACTIVATED',
      'PROJECT_CONSTITUTION_PUBLICATION_FAILED',
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
FROM events_v14;

DROP TABLE events_v14;

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
