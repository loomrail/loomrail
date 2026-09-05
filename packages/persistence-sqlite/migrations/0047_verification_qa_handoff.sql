-- A Project verification correction can interrupt Browser QA correction work. The evaluator
-- records stay separate, while this immutable parent edge lets a fresh passing verification Run
-- return execution to the exact locked QA retest instead of losing its open defects.

ALTER TABLE verification_correction_runs
  ADD COLUMN resumes_qa_correction_run_id TEXT
  REFERENCES qa_correction_runs(id) ON DELETE RESTRICT;

CREATE INDEX verification_correction_runs_qa_parent_idx
  ON verification_correction_runs(resumes_qa_correction_run_id, budget_position, id)
  WHERE resumes_qa_correction_run_id IS NOT NULL;

CREATE TRIGGER verification_correction_runs_qa_parent_insert
BEFORE INSERT ON verification_correction_runs
WHEN
  NEW.resumes_qa_correction_run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM qa_correction_runs AS parent
    WHERE parent.id = NEW.resumes_qa_correction_run_id
      AND parent.project_id = NEW.project_id
      AND parent.work_item_id = NEW.work_item_id
      AND parent.pipeline_run_id = NEW.pipeline_run_id
      AND parent.status = 'ACTIVE'
  )
BEGIN
  SELECT RAISE(ABORT, 'verification correction QA parent lineage mismatch');
END;

CREATE TRIGGER verification_correction_runs_qa_parent_immutable
BEFORE UPDATE OF resumes_qa_correction_run_id ON verification_correction_runs
WHEN NEW.resumes_qa_correction_run_id IS NOT OLD.resumes_qa_correction_run_id
BEGIN
  SELECT RAISE(ABORT, 'verification correction QA parent lineage is immutable');
END;

-- Nested stages carry both evaluator envelopes. This does not merge their failure identities: the
-- verification correction must name the exact QA parent through the immutable edge above. Keeping
-- both IDs on Review/QA evidence proves that the tree repaired for Project verification is also the
-- tree returned to the locked Browser QA retest.
CREATE UNIQUE INDEX stage_attempts_nested_correction_cycle_unique_idx
  ON stage_attempts(correction_run_id, verification_correction_run_id, stage, attempt)
  WHERE correction_run_id IS NOT NULL AND verification_correction_run_id IS NOT NULL;

CREATE UNIQUE INDEX review_reports_nested_correction_cycle_round_idx
  ON review_reports(correction_run_id, verification_correction_run_id, round)
  WHERE correction_run_id IS NOT NULL AND verification_correction_run_id IS NOT NULL;

DROP TRIGGER stage_attempts_correction_lineage_insert;

CREATE TRIGGER stage_attempts_correction_lineage_insert
BEFORE INSERT ON stage_attempts
WHEN
  (
    NEW.correction_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM qa_correction_runs AS correction
      WHERE correction.id = NEW.correction_run_id
        AND correction.project_id = NEW.project_id
        AND correction.work_item_id = NEW.work_item_id
        AND correction.pipeline_run_id = NEW.pipeline_run_id
    )
  )
  OR (
    NEW.verification_correction_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM verification_correction_runs AS correction
      WHERE correction.id = NEW.verification_correction_run_id
        AND correction.project_id = NEW.project_id
        AND correction.work_item_id = NEW.work_item_id
        AND correction.pipeline_run_id = NEW.pipeline_run_id
    )
  )
  OR (
    NEW.correction_run_id IS NOT NULL
    AND NEW.verification_correction_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM verification_correction_runs AS verification
      JOIN qa_correction_runs AS qa ON qa.id = NEW.correction_run_id
      WHERE verification.id = NEW.verification_correction_run_id
        AND verification.resumes_qa_correction_run_id = qa.id
        AND verification.project_id = NEW.project_id
        AND verification.work_item_id = NEW.work_item_id
        AND verification.pipeline_run_id = NEW.pipeline_run_id
        AND qa.project_id = NEW.project_id
        AND qa.work_item_id = NEW.work_item_id
        AND qa.pipeline_run_id = NEW.pipeline_run_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Stage attempt correction lineage is invalid');
END;

DROP TRIGGER qa_runs_correction_scope_insert;

CREATE TRIGGER qa_runs_correction_scope_insert
BEFORE INSERT ON qa_runs
WHEN
  (NEW.correction_run_id IS NULL) <> (NEW.retest_plan_id IS NULL)
  OR NOT EXISTS (
    SELECT 1 FROM stage_attempts AS attempt
    WHERE attempt.id = NEW.stage_attempt_id
      AND attempt.project_id = NEW.project_id
      AND attempt.work_item_id = NEW.work_item_id
      AND attempt.pipeline_run_id = NEW.pipeline_run_id
      AND attempt.stage = 'QA'
      AND attempt.correction_run_id IS NEW.correction_run_id
      AND attempt.verification_correction_run_id IS NEW.verification_correction_run_id
  )
  OR (
    NEW.correction_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM qa_retest_plans AS plan
      WHERE plan.id = NEW.retest_plan_id
        AND plan.correction_run_id = NEW.correction_run_id
        AND plan.project_id = NEW.project_id
        AND plan.work_item_id = NEW.work_item_id
        AND plan.pipeline_run_id = NEW.pipeline_run_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'QA run correction scope is invalid');
END;
