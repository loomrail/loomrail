-- A passed VerificationRun keeps its measured terminal status forever. When its Plan or tree no
-- longer matches the current gate, an append-only STALE VerificationFailure becomes the source of
-- a new correction instead. Widen only the source trigger: evaluator identity, shared budget and
-- every delivery coordinate remain unchanged.

DROP TRIGGER verification_correction_runs_source_lineage_insert;

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
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'verification correction source lineage mismatch');
END;
