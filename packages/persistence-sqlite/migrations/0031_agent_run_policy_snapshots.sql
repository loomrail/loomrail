-- A3 effective policy snapshots. Historical AgentRuns keep NULL because their hash covered an
-- earlier metadata bundle that cannot be truthfully reconstructed as an applied policy. Every new
-- AgentRun writes the validated snapshot and matching hash in its start transaction.

ALTER TABLE agent_runs
  ADD COLUMN policy_snapshot_json TEXT CHECK (
    policy_snapshot_json IS NULL
    OR CASE WHEN json_valid(policy_snapshot_json) THEN json_type(policy_snapshot_json) = 'object' ELSE 0 END
  );

DROP TRIGGER agent_runs_immutable_identity;

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
  OR NEW.policy_snapshot_json IS NOT OLD.policy_snapshot_json
  OR NEW.policy_snapshot_hash <> OLD.policy_snapshot_hash
  OR NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'agent run identity is immutable');
END;
