-- Owner cancellation is a durable two-phase transition. CANCELLING keeps the workspace reserved
-- until the supervised process tree has stopped; the final SYSTEM command then records INTERRUPTED.

DROP TRIGGER verification_runs_correction_lineage_insert;
DROP TRIGGER verification_runs_correction_lineage_immutable;
DROP TRIGGER verification_failures_match_run_insert;
DROP TRIGGER verification_correction_runs_source_lineage_insert;
DROP INDEX verification_runs_active_workspace_idx;
DROP INDEX verification_runs_work_item_idx;

CREATE TABLE verification_runs_v51 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES work_item_workspaces(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE RESTRICT,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  plan_content_hash TEXT NOT NULL CHECK (length(plan_content_hash) = 64),
  implementation_tree TEXT NOT NULL CHECK (length(implementation_tree) = 40),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  retry_of_run_id TEXT REFERENCES verification_runs_v51(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'linux', 'win32')),
  status TEXT NOT NULL CHECK (
    status IN ('QUEUED', 'RUNNING', 'CANCELLING', 'PASSED', 'FAILED', 'ERROR', 'INTERRUPTED')
  ),
  current_check_id TEXT,
  terminal_reason TEXT CHECK (
    terminal_reason IS NULL OR terminal_reason IN (
      'ALL_REQUIRED_PASSED', 'REQUIRED_CHECK_FAILED', 'REQUIRED_CHECK_ERROR',
      'OWNER_CANCELLED', 'DAEMON_RESTART'
    )
  ),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  verification_correction_run_id TEXT
    REFERENCES verification_correction_runs(id) ON DELETE RESTRICT,
  UNIQUE (work_item_id, ordinal)
) STRICT;

INSERT INTO verification_runs_v51 (
  id, schema_version, project_id, work_item_id, pipeline_run_id, workspace_id, plan_id,
  plan_revision, plan_content_hash, implementation_tree, ordinal, retry_of_run_id, platform,
  status, current_check_id, terminal_reason, started_at, completed_at, created_at, version,
  verification_correction_run_id
)
SELECT
  id, schema_version, project_id, work_item_id, pipeline_run_id, workspace_id, plan_id,
  plan_revision, plan_content_hash, implementation_tree, ordinal, retry_of_run_id, platform,
  status, current_check_id, terminal_reason, started_at, completed_at, created_at, version,
  verification_correction_run_id
FROM verification_runs;

DROP TABLE verification_runs;
ALTER TABLE verification_runs_v51 RENAME TO verification_runs;

CREATE UNIQUE INDEX verification_runs_active_workspace_idx
ON verification_runs(workspace_id)
WHERE status IN ('QUEUED', 'RUNNING', 'CANCELLING');

CREATE INDEX verification_runs_work_item_idx
ON verification_runs(work_item_id, ordinal DESC);

CREATE TRIGGER verification_runs_correction_lineage_insert
BEFORE INSERT ON verification_runs
WHEN
  NEW.verification_correction_run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM verification_correction_runs AS correction
    WHERE correction.id = NEW.verification_correction_run_id
      AND correction.project_id = NEW.project_id
      AND correction.work_item_id = NEW.work_item_id
      AND correction.pipeline_run_id = NEW.pipeline_run_id
  )
BEGIN
  SELECT RAISE(ABORT, 'verification Run correction lineage mismatch');
END;

CREATE TRIGGER verification_runs_correction_lineage_immutable
BEFORE UPDATE OF verification_correction_run_id ON verification_runs
WHEN NEW.verification_correction_run_id IS NOT OLD.verification_correction_run_id
BEGIN
  SELECT RAISE(ABORT, 'verification Run correction lineage is immutable');
END;

CREATE TRIGGER verification_failures_match_run_insert
BEFORE INSERT ON verification_failures
WHEN NOT EXISTS (
  SELECT 1
  FROM verification_runs AS run
  WHERE run.id = NEW.verification_run_id
    AND run.project_id = NEW.project_id
    AND run.work_item_id = NEW.work_item_id
    AND run.pipeline_run_id = NEW.pipeline_run_id
    AND run.plan_id = NEW.plan_id
    AND run.plan_revision = NEW.plan_revision
    AND run.plan_content_hash = NEW.plan_content_hash
    AND run.implementation_tree = NEW.implementation_tree
    AND (
      (NEW.reason = 'REQUIRED_CHECK_FAILED' AND run.status = 'FAILED')
      OR (NEW.reason = 'REQUIRED_CHECK_ERROR' AND run.status = 'ERROR')
      OR (NEW.reason = 'RUN_INTERRUPTED' AND run.status = 'INTERRUPTED')
      OR (NEW.reason = 'STALE' AND run.status = 'PASSED')
    )
    AND (
      (NEW.verification_check_id IS NULL AND NEW.reason IN ('RUN_INTERRUPTED', 'STALE'))
      OR EXISTS (
        SELECT 1
        FROM verification_checks AS check_row
        WHERE check_row.id = NEW.verification_check_id
          AND check_row.run_id = run.id
          AND check_row.project_id = run.project_id
          AND check_row.work_item_id = run.work_item_id
          AND (
            (
              NEW.reason = 'REQUIRED_CHECK_FAILED'
              AND check_row.required = 1
              AND check_row.status = 'FAILED'
            )
            OR (
              NEW.reason = 'REQUIRED_CHECK_ERROR'
              AND check_row.required = 1
              AND check_row.status = 'ERROR'
            )
            OR (NEW.reason = 'RUN_INTERRUPTED' AND check_row.status = 'INTERRUPTED')
          )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'verification failure lineage mismatch');
END;

CREATE TRIGGER verification_correction_runs_source_lineage_insert
BEFORE INSERT ON verification_correction_runs
WHEN
  NEW.status <> 'ACTIVE'
  OR NEW.completed_at IS NOT NULL
  OR NEW.version <> 1
  OR NEW.budget_position <> (
    SELECT COUNT(*) + 1
    FROM (
      SELECT id FROM qa_correction_runs WHERE pipeline_run_id = NEW.pipeline_run_id
      UNION ALL
      SELECT id FROM verification_correction_runs WHERE pipeline_run_id = NEW.pipeline_run_id
    )
  )
  OR NOT EXISTS (
    SELECT 1
    FROM verification_failures AS failure
    JOIN verification_runs AS run ON run.id = NEW.source_verification_run_id
    WHERE failure.id = NEW.source_failure_id
      AND failure.verification_run_id = run.id
      AND failure.project_id = NEW.project_id
      AND failure.work_item_id = NEW.work_item_id
      AND failure.pipeline_run_id = NEW.pipeline_run_id
      AND failure.implementation_tree = NEW.source_implementation_tree
      AND run.project_id = NEW.project_id
      AND run.work_item_id = NEW.work_item_id
      AND run.pipeline_run_id = NEW.pipeline_run_id
      AND run.implementation_tree = NEW.source_implementation_tree
      AND (
        (failure.reason = 'REQUIRED_CHECK_FAILED' AND run.status = 'FAILED')
        OR (failure.reason = 'REQUIRED_CHECK_ERROR' AND run.status = 'ERROR')
        OR (failure.reason = 'STALE' AND run.status = 'PASSED')
        OR (
          failure.reason = 'RUN_INTERRUPTED'
          AND run.status = 'INTERRUPTED'
          AND run.terminal_reason = 'DAEMON_RESTART'
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'verification correction source lineage mismatch');
END;

-- The append-only Event vocabulary records the owner intent before any process side effect.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v51;

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
      'QA_CORRECTION_CANCELLED'
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
FROM events_v51;

DROP TABLE events_v51;

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
