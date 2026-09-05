-- Q17 keeps repository-check failures separate from Browser QA defects. The row is immutable:
-- later correction attempts and passing reruns reference this identity instead of rewriting the
-- measured reason or its exact Plan/tree lineage.

CREATE TABLE verification_failures (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  verification_run_id TEXT NOT NULL UNIQUE REFERENCES verification_runs(id) ON DELETE RESTRICT,
  verification_check_id TEXT REFERENCES verification_checks(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE RESTRICT,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  plan_content_hash TEXT NOT NULL CHECK (length(plan_content_hash) = 64),
  implementation_tree TEXT NOT NULL CHECK (length(implementation_tree) = 40),
  reason TEXT NOT NULL CHECK (
    reason IN ('REQUIRED_CHECK_FAILED', 'REQUIRED_CHECK_ERROR', 'RUN_INTERRUPTED', 'STALE')
  ),
  stale_reasons_json TEXT NOT NULL CHECK (
    json_valid(stale_reasons_json)
    AND json_type(stale_reasons_json) = 'array'
    AND json_array_length(stale_reasons_json) <= 4
  ),
  created_at TEXT NOT NULL,
  CHECK ((reason = 'STALE') = (json_array_length(stale_reasons_json) > 0)),
  CHECK (reason NOT IN ('REQUIRED_CHECK_FAILED', 'REQUIRED_CHECK_ERROR') OR verification_check_id IS NOT NULL),
  CHECK (reason <> 'STALE' OR verification_check_id IS NULL)
) STRICT;

CREATE INDEX verification_failures_work_item_idx
ON verification_failures(work_item_id, created_at DESC, id DESC);

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

CREATE TRIGGER verification_failures_are_append_only_update
BEFORE UPDATE ON verification_failures BEGIN
  SELECT RAISE(ABORT, 'verification failures are append-only');
END;

CREATE TRIGGER verification_failures_are_append_only_delete
BEFORE DELETE ON verification_failures BEGIN
  SELECT RAISE(ABORT, 'verification failures are append-only');
END;

DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v40;

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
      'PROVIDER_ALLOWANCE_RECORDED', 'VERIFICATION_PLAN_ADOPTED',
      'VERIFICATION_PLAN_PUBLICATION_APPLIED', 'VERIFICATION_PLAN_PUBLICATION_FAILED',
      'VERIFICATION_PLAN_PUBLICATION_RETRIED',
      'VERIFICATION_RUN_RESERVED', 'VERIFICATION_CHECK_STARTED',
      'VERIFICATION_CHECK_COMPLETED', 'VERIFICATION_RUN_INTERRUPTED',
      'VERIFICATION_FAILURE_RECORDED',
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
FROM events_v40;

DROP TABLE events_v40;

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
