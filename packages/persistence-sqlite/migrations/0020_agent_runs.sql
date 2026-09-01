-- A3 (`docs/plans/43-a3-parallel-squads-spec.ru.md`): durable squad composition and AgentRun
-- reservations. Historical ProviderSessions predate this model and remain valid with a NULL
-- agent_run_id; inventing a profile/provider/policy snapshot for them would make the audit trail
-- less truthful, not more complete.

CREATE TABLE squad_assignments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  stages_json TEXT NOT NULL CHECK (json_valid(stages_json)),
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_run_id, revision)
) STRICT;

CREATE INDEX squad_assignments_scope_idx
  ON squad_assignments(project_id, work_item_id, pipeline_run_id, revision DESC);

CREATE TRIGGER squad_assignments_are_immutable_update
BEFORE UPDATE ON squad_assignments BEGIN
  SELECT RAISE(ABORT, 'squad assignments are immutable');
END;

CREATE TRIGGER squad_assignments_are_immutable_delete
BEFORE DELETE ON squad_assignments BEGIN
  SELECT RAISE(ABORT, 'squad assignments are immutable');
END;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  squad_assignment_id TEXT NOT NULL REFERENCES squad_assignments(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  profile_role TEXT NOT NULL CHECK (
    profile_role IN (
      'LEAD_PM', 'PRODUCT_ANALYST', 'SOFTWARE_ARCHITECT', 'DEVELOPER',
      'CODE_REVIEWER', 'BROWSER_QA', 'ACCEPTANCE_MANAGER'
    )
  ),
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'CODEX', 'CLAUDE_CODE')),
  status TEXT NOT NULL CHECK (
    status IN (
      'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED',
      'WAITING_HUMAN', 'SOFT_PAUSED', 'HARD_PAUSED'
    )
  ),
  policy_snapshot_hash TEXT NOT NULL CHECK (
    length(policy_snapshot_hash) = 71
    AND substr(policy_snapshot_hash, 1, 7) = 'sha256:'
    AND substr(policy_snapshot_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (stage_attempt_id, ordinal),
  CHECK ((status = 'RUNNING') = (finished_at IS NULL))
) STRICT;

-- These partial unique indexes are the durable ownership backstops. The transaction also performs
-- named pre-checks so callers receive a useful refusal, but a missed or racing caller still cannot
-- create two live owners for one StageAttempt or WorkItem.
CREATE UNIQUE INDEX agent_runs_one_active_attempt_idx
  ON agent_runs(stage_attempt_id) WHERE status = 'RUNNING';
CREATE UNIQUE INDEX agent_runs_one_active_work_item_idx
  ON agent_runs(work_item_id) WHERE status = 'RUNNING';
CREATE INDEX agent_runs_active_capacity_idx
  ON agent_runs(status, project_id, provider, started_at, id);

CREATE TRIGGER agent_runs_immutable_identity
BEFORE UPDATE ON agent_runs
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.pipeline_run_id <> OLD.pipeline_run_id
  OR NEW.stage_attempt_id <> OLD.stage_attempt_id
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.squad_assignment_id <> OLD.squad_assignment_id
  OR NEW.profile_id <> OLD.profile_id
  OR NEW.profile_revision <> OLD.profile_revision
  OR NEW.profile_role <> OLD.profile_role
  OR NEW.provider <> OLD.provider
  OR NEW.policy_snapshot_hash <> OLD.policy_snapshot_hash
  OR NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'agent run identity is immutable');
END;

CREATE TRIGGER agent_runs_cannot_delete
BEFORE DELETE ON agent_runs BEGIN
  SELECT RAISE(ABORT, 'agent runs cannot be deleted');
END;

ALTER TABLE provider_sessions
  ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE RESTRICT;

CREATE INDEX provider_sessions_agent_run_ordinal_idx
  ON provider_sessions(agent_run_id, ordinal) WHERE agent_run_id IS NOT NULL;

-- `events.type` is closed. Add the assignment/run lifecycle facts while preserving every existing
-- sequence and cursor. No table references events, so this rebuild does not require the broader
-- foreign-key relaxation used when migration 0019 rebuilt `projects`.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v19;

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
      'WORK_ITEM_WORKSPACE_CREATED', 'WORK_ITEM_WORKSPACE_ORPHANED',
      'SQUAD_ASSIGNED', 'AGENT_RUN_STARTED', 'AGENT_RUN_FINISHED'
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
FROM events_v19;

DROP TABLE events_v19;

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
