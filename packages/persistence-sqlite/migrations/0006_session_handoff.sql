-- Spec docs/plans/07-a1-session-handoff-spec.ru.md §4.2, §4.4, §6.5.
--
-- Adds durable storage for the session-handoff loop: the recipe used to assemble each provider
-- session's context pack, the sessions themselves, and the checkpoints an agent publishes mid-
-- session. Also widens the `events` CHECK to admit the five new session-handoff event types, and
-- adds the unproductive-session counter to `stage_attempts` (§6.5: it must survive a daemon
-- restart, so it lives in the database rather than in daemon memory).

CREATE TABLE context_pack_recipes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  spec_source TEXT NOT NULL CHECK (spec_source = 'WORKFLOW_TEMPLATE'),
  -- [{ id, sources: [{ kind, id, version }], bytes }] -- see contextPackRecipeSectionSchema.
  sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
  -- [{ id, reason }] -- see contextPackRecipeOmittedSectionSchema.
  omitted_json TEXT NOT NULL CHECK (json_valid(omitted_json)),
  content_hash TEXT NOT NULL CHECK (content_hash LIKE 'sha256:%'),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  budget_tokens INTEGER NOT NULL CHECK (budget_tokens > 0),
  estimate_quality TEXT NOT NULL
    CHECK (estimate_quality IN ('ACTUAL', 'PROVIDER_ESTIMATE', 'LOOMRAIL_ESTIMATE')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE provider_sessions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'ENDED')),
  end_reason TEXT CHECK (
    end_reason IS NULL OR
    end_reason IN ('COMPLETED', 'HANDOFF', 'CONTEXT_EXHAUSTED', 'INTERRUPTED', 'CANCELLED')
  ),
  context_pack_recipe_id TEXT NOT NULL REFERENCES context_pack_recipes(id) ON DELETE RESTRICT,
  handoff_requested_at TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (stage_attempt_id, ordinal),
  -- Mirrors providerSessionSchema's two refines: an ENDED session carries both an end reason and
  -- an end timestamp, and a RUNNING one carries neither.
  CHECK ((status = 'ENDED') = (end_reason IS NOT NULL)),
  CHECK ((status = 'ENDED') = (ended_at IS NOT NULL))
) STRICT;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  completed_json TEXT NOT NULL CHECK (json_valid(completed_json)),
  remaining_json TEXT NOT NULL CHECK (json_valid(remaining_json)),
  dead_ends_json TEXT NOT NULL CHECK (json_valid(dead_ends_json)),
  open_questions_json TEXT NOT NULL CHECK (json_valid(open_questions_json)),
  created_at TEXT NOT NULL,
  UNIQUE (provider_session_id, ordinal)
) STRICT;

-- §6.5: the counter lives in state, not in daemon memory, because a daemon restart is itself a
-- normal end of a session -- a counter held in memory would be reset by the very event it exists
-- to guard against.
ALTER TABLE stage_attempts
  ADD COLUMN unproductive_sessions INTEGER NOT NULL DEFAULT 0
  CHECK (unproductive_sessions >= 0);

CREATE INDEX provider_sessions_attempt_ordinal_idx
  ON provider_sessions(stage_attempt_id, ordinal);
CREATE INDEX checkpoints_attempt_created_idx
  ON checkpoints(stage_attempt_id, created_at DESC, id);

CREATE TRIGGER checkpoints_are_append_only_update
BEFORE UPDATE ON checkpoints
BEGIN
  SELECT RAISE(ABORT, 'checkpoints are append-only');
END;

CREATE TRIGGER checkpoints_are_append_only_delete
BEFORE DELETE ON checkpoints
BEGIN
  SELECT RAISE(ABORT, 'checkpoints are append-only');
END;

CREATE TRIGGER context_pack_recipes_are_append_only_update
BEFORE UPDATE ON context_pack_recipes
BEGIN
  SELECT RAISE(ABORT, 'context pack recipes are append-only');
END;

CREATE TRIGGER context_pack_recipes_are_append_only_delete
BEFORE DELETE ON context_pack_recipes
BEGIN
  SELECT RAISE(ABORT, 'context pack recipes are append-only');
END;

-- `events` bakes its allowed types into a CHECK, so widening it requires a rebuild: drop the
-- triggers and indexes, rename the table aside, recreate it with the widened list, copy every row
-- preserving `sequence`, drop the renamed table, then recreate the indexes and the append-only
-- triggers. This mirrors 0005_acceptance_evidence.sql's rebuild of the same table.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v5;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (
    type IN (
      'PROJECT_REGISTERED', 'WORK_ITEM_CREATED', 'WORK_ITEM_UPDATED', 'WORK_ITEM_STATE_CHANGED',
      'PIPELINE_STARTED', 'STAGE_ATTEMPT_CHANGED', 'HUMAN_REQUEST_OPENED',
      'HUMAN_REQUEST_RESOLVED', 'USAGE_RECORDED', 'BUDGET_THRESHOLD_REACHED',
      'PIPELINE_PAUSED', 'PIPELINE_RESUMED', 'PIPELINE_CANCELLED',
      'BUDGET_OVERRIDE_APPROVED', 'RECOVERY_REPORT_CREATED', 'PIPELINE_COMPLETED',
      'EVIDENCE_ARTIFACT_RECORDED', 'ACCEPTANCE_REQUESTED', 'ACCEPTANCE_RESOLVED',
      'PROVIDER_SESSION_STARTED', 'CONTEXT_HANDOFF_REQUESTED', 'CHECKPOINT_PUBLISHED',
      'PROVIDER_SESSION_ENDED', 'CONTEXT_FLOOR_EXCEEDED'
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
FROM events_v5;

DROP TABLE events_v5;

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
