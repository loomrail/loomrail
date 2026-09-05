-- A daemon restart cannot certify the outcome of a queued/running Project verification Run. The
-- immutable interrupted failure may start a bounded correction, but an owner's explicit cancel
-- may not. Widen the append-only source guard without changing any existing correction row.

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
