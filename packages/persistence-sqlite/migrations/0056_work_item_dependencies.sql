-- Q20.5 / ADR-0019: domain-owned same-Project WorkItem execution DAG.
CREATE TABLE work_item_dependencies (
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind = 'BLOCKS'),
  blocker_work_item_id TEXT NOT NULL,
  blocked_work_item_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_work_item_id, blocked_work_item_id),
  FOREIGN KEY (blocker_work_item_id, project_id)
    REFERENCES work_items(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (blocked_work_item_id, project_id)
    REFERENCES work_items(id, project_id) ON DELETE RESTRICT,
  CHECK (blocker_work_item_id <> blocked_work_item_id)
) STRICT;

CREATE INDEX work_item_dependencies_project_idx
ON work_item_dependencies(project_id, blocker_work_item_id, blocked_work_item_id);

CREATE INDEX work_item_dependencies_blocked_idx
ON work_item_dependencies(blocked_work_item_id, blocker_work_item_id);

-- `events.type` is closed. Rebuild it without rewriting or renumbering historical audit rows.
DROP TRIGGER events_are_append_only_update;
DROP TRIGGER events_are_append_only_delete;
DROP INDEX events_project_sequence_idx;
DROP INDEX events_aggregate_sequence_idx;
ALTER TABLE events RENAME TO events_v56;

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
      'PROJECT_WORKSPACE_STRATEGY_CHANGED',
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
      'WORK_ITEM_DEPENDENCIES_SET',
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
      'QA_CORRECTION_CANCELLED', 'WORKSPACE_TOOL_CALL_CHANGED'
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
FROM events_v56;

DROP TABLE events_v56;

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
