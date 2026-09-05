-- Q17 keeps repository-check correction separate from Browser QA correction. This migration only
-- establishes durable evaluator lineage; the workflow transition that creates these rows lands in
-- a later slice so an old daemon cannot accidentally enter a half-wired correction cycle.

CREATE TABLE verification_correction_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  budget_position INTEGER NOT NULL CHECK (budget_position BETWEEN 1 AND 3),
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  source_failure_id TEXT NOT NULL UNIQUE REFERENCES verification_failures(id) ON DELETE RESTRICT,
  source_verification_run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE RESTRICT,
  source_implementation_tree TEXT NOT NULL CHECK (
    length(source_implementation_tree) = 40
    AND source_implementation_tree NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('ACTIVE', 'PASSED', 'SUPERSEDED', 'EXHAUSTED', 'CANCELLED')
  ),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (pipeline_run_id, budget_position),
  CHECK (automatic = CASE WHEN budget_position <= 2 THEN 1 ELSE 0 END),
  CHECK (
    (status IN ('ACTIVE', 'EXHAUSTED') AND completed_at IS NULL)
    OR
    (status IN ('PASSED', 'SUPERSEDED', 'CANCELLED') AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX verification_correction_runs_work_item_idx
  ON verification_correction_runs(work_item_id, budget_position DESC, id);

CREATE UNIQUE INDEX verification_correction_runs_one_current_idx
  ON verification_correction_runs(pipeline_run_id)
  WHERE status IN ('ACTIVE', 'EXHAUSTED');

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
      AND failure.reason IN ('REQUIRED_CHECK_FAILED', 'REQUIRED_CHECK_ERROR')
      AND failure.verification_run_id = run.id
      AND failure.project_id = NEW.project_id
      AND failure.work_item_id = NEW.work_item_id
      AND failure.pipeline_run_id = NEW.pipeline_run_id
      AND failure.implementation_tree = NEW.source_implementation_tree
      AND run.project_id = NEW.project_id
      AND run.work_item_id = NEW.work_item_id
      AND run.pipeline_run_id = NEW.pipeline_run_id
      AND run.implementation_tree = NEW.source_implementation_tree
      AND run.status IN ('FAILED', 'ERROR')
  )
BEGIN
  SELECT RAISE(ABORT, 'verification correction source lineage mismatch');
END;

CREATE TRIGGER verification_correction_runs_state_transition
BEFORE UPDATE ON verification_correction_runs
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.pipeline_run_id <> OLD.pipeline_run_id
  OR NEW.budget_position <> OLD.budget_position
  OR NEW.automatic <> OLD.automatic
  OR NEW.source_failure_id <> OLD.source_failure_id
  OR NEW.source_verification_run_id <> OLD.source_verification_run_id
  OR NEW.source_implementation_tree <> OLD.source_implementation_tree
  OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1
  OR NOT (
    (OLD.status = 'ACTIVE' AND NEW.status IN ('PASSED', 'SUPERSEDED', 'EXHAUSTED', 'CANCELLED'))
    OR
    (OLD.status = 'EXHAUSTED' AND NEW.status IN ('SUPERSEDED', 'CANCELLED'))
  )
BEGIN
  SELECT RAISE(ABORT, 'verification correction may only make a valid one-way state transition');
END;

CREATE TRIGGER verification_correction_runs_cannot_delete
BEFORE DELETE ON verification_correction_runs BEGIN
  SELECT RAISE(ABORT, 'verification correction runs cannot be deleted');
END;

-- A StageAttempt is owned by the initial delivery or exactly one evaluator correction. Keeping
-- the two correction identities separate prevents a repository failure from becoming a QA defect.
ALTER TABLE stage_attempts
  ADD COLUMN verification_correction_run_id TEXT
  REFERENCES verification_correction_runs(id) ON DELETE RESTRICT;

DROP INDEX stage_attempts_initial_cycle_unique_idx;
DROP INDEX stage_attempts_correction_cycle_unique_idx;

CREATE UNIQUE INDEX stage_attempts_initial_cycle_unique_idx
  ON stage_attempts(pipeline_run_id, stage, attempt)
  WHERE correction_run_id IS NULL AND verification_correction_run_id IS NULL;
CREATE UNIQUE INDEX stage_attempts_correction_cycle_unique_idx
  ON stage_attempts(correction_run_id, stage, attempt)
  WHERE correction_run_id IS NOT NULL AND verification_correction_run_id IS NULL;
CREATE UNIQUE INDEX stage_attempts_verification_correction_cycle_unique_idx
  ON stage_attempts(verification_correction_run_id, stage, attempt)
  WHERE correction_run_id IS NULL AND verification_correction_run_id IS NOT NULL;

DROP TRIGGER stage_attempts_correction_lineage_insert;
DROP TRIGGER stage_attempts_correction_lineage_immutable;

CREATE TRIGGER stage_attempts_correction_lineage_insert
BEFORE INSERT ON stage_attempts
WHEN
  (NEW.correction_run_id IS NOT NULL AND NEW.verification_correction_run_id IS NOT NULL)
  OR (
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
BEGIN
  SELECT RAISE(ABORT, 'Stage attempt correction lineage is invalid');
END;

CREATE TRIGGER stage_attempts_correction_lineage_immutable
BEFORE UPDATE OF correction_run_id, verification_correction_run_id ON stage_attempts
WHEN
  NEW.correction_run_id IS NOT OLD.correction_run_id
  OR NEW.verification_correction_run_id IS NOT OLD.verification_correction_run_id
BEGIN
  SELECT RAISE(ABORT, 'Stage attempt correction lineage is immutable');
END;

ALTER TABLE review_reports
  ADD COLUMN verification_correction_run_id TEXT
  REFERENCES verification_correction_runs(id) ON DELETE RESTRICT;

DROP INDEX review_reports_work_item_round_idx;
DROP INDEX review_reports_initial_cycle_round_idx;
DROP INDEX review_reports_correction_cycle_round_idx;

CREATE INDEX review_reports_work_item_round_idx
  ON review_reports(
    work_item_id, pipeline_run_id, correction_run_id,
    verification_correction_run_id, round DESC, id
  );
CREATE UNIQUE INDEX review_reports_initial_cycle_round_idx
  ON review_reports(pipeline_run_id, round)
  WHERE correction_run_id IS NULL AND verification_correction_run_id IS NULL;
CREATE UNIQUE INDEX review_reports_correction_cycle_round_idx
  ON review_reports(correction_run_id, round)
  WHERE correction_run_id IS NOT NULL AND verification_correction_run_id IS NULL;
CREATE UNIQUE INDEX review_reports_verification_correction_cycle_round_idx
  ON review_reports(verification_correction_run_id, round)
  WHERE correction_run_id IS NULL AND verification_correction_run_id IS NOT NULL;

DROP TRIGGER review_reports_correction_lineage_insert;

CREATE TRIGGER review_reports_correction_lineage_insert
BEFORE INSERT ON review_reports
WHEN NOT EXISTS (
  SELECT 1 FROM stage_attempts AS attempt
  WHERE attempt.id = NEW.stage_attempt_id
    AND attempt.project_id = NEW.project_id
    AND attempt.work_item_id = NEW.work_item_id
    AND attempt.pipeline_run_id = NEW.pipeline_run_id
    AND attempt.stage = 'REVIEW'
    AND attempt.correction_run_id IS NEW.correction_run_id
    AND attempt.verification_correction_run_id IS NEW.verification_correction_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'Review report correction lineage is invalid');
END;

ALTER TABLE review_findings
  ADD COLUMN verification_correction_run_id TEXT
  REFERENCES verification_correction_runs(id) ON DELETE RESTRICT;

DROP TRIGGER review_findings_correction_lineage_insert;
DROP TRIGGER review_findings_immutable_identity;

CREATE TRIGGER review_findings_correction_lineage_insert
BEFORE INSERT ON review_findings
WHEN NOT EXISTS (
  SELECT 1
  FROM review_reports AS report
  JOIN stage_attempts AS attempt ON attempt.id = NEW.stage_attempt_id
  WHERE report.id = NEW.review_artifact_id
    AND report.stage_attempt_id = NEW.stage_attempt_id
    AND report.project_id = NEW.project_id
    AND report.work_item_id = NEW.work_item_id
    AND report.pipeline_run_id = NEW.pipeline_run_id
    AND report.correction_run_id IS NEW.correction_run_id
    AND report.verification_correction_run_id IS NEW.verification_correction_run_id
    AND attempt.correction_run_id IS NEW.correction_run_id
    AND attempt.verification_correction_run_id IS NEW.verification_correction_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'Review finding correction lineage is invalid');
END;

CREATE TRIGGER review_findings_immutable_identity
BEFORE UPDATE ON review_findings
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.pipeline_run_id <> OLD.pipeline_run_id
  OR NEW.stage_attempt_id <> OLD.stage_attempt_id
  OR NEW.correction_run_id IS NOT OLD.correction_run_id
  OR NEW.verification_correction_run_id IS NOT OLD.verification_correction_run_id
  OR NEW.review_artifact_id <> OLD.review_artifact_id
  OR NEW.reviewed_tree <> OLD.reviewed_tree
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.severity <> OLD.severity
  OR NEW.title <> OLD.title
  OR NEW.description <> OLD.description
  OR NEW.path IS NOT OLD.path
  OR NEW.start_line IS NOT OLD.start_line
  OR NEW.end_line IS NOT OLD.end_line
  OR NEW.reproduction <> OLD.reproduction
  OR NEW.criterion IS NOT OLD.criterion
  OR NEW.suggested_fix IS NOT OLD.suggested_fix
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'review finding identity is immutable');
END;

ALTER TABLE qa_runs
  ADD COLUMN verification_correction_run_id TEXT
  REFERENCES verification_correction_runs(id) ON DELETE RESTRICT;

DROP TRIGGER qa_runs_correction_scope_insert;
DROP TRIGGER qa_runs_one_way_completion;

CREATE TRIGGER qa_runs_correction_scope_insert
BEFORE INSERT ON qa_runs
WHEN
  (NEW.correction_run_id IS NULL) <> (NEW.retest_plan_id IS NULL)
  OR (NEW.correction_run_id IS NOT NULL AND NEW.verification_correction_run_id IS NOT NULL)
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

CREATE TRIGGER qa_runs_one_way_completion
BEFORE UPDATE ON qa_runs
WHEN
  OLD.status <> 'RUNNING'
  OR NEW.status = 'RUNNING'
  OR NEW.version <> OLD.version + 1
  OR NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.pipeline_run_id <> OLD.pipeline_run_id
  OR NEW.stage_attempt_id <> OLD.stage_attempt_id
  OR NEW.agent_run_id <> OLD.agent_run_id
  OR NEW.driver_id <> OLD.driver_id
  OR NEW.tested_tree <> OLD.tested_tree
  OR NEW.target_origin <> OLD.target_origin
  OR NEW.plan_json <> OLD.plan_json
  OR NEW.correction_run_id IS NOT OLD.correction_run_id
  OR NEW.retest_plan_id IS NOT OLD.retest_plan_id
  OR NEW.verification_correction_run_id IS NOT OLD.verification_correction_run_id
  OR NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'QA run may only complete once without changing its reservation');
END;

ALTER TABLE qa_evidence_bundles
  ADD COLUMN verification_correction_run_id TEXT
  REFERENCES verification_correction_runs(id) ON DELETE RESTRICT;

CREATE TRIGGER qa_evidence_bundles_correction_lineage_insert
BEFORE INSERT ON qa_evidence_bundles
WHEN NOT EXISTS (
  SELECT 1
  FROM qa_runs AS run
  JOIN stage_attempts AS attempt ON attempt.id = NEW.stage_attempt_id
  WHERE run.id = NEW.qa_run_id
    AND run.project_id = NEW.project_id
    AND run.work_item_id = NEW.work_item_id
    AND run.pipeline_run_id = NEW.pipeline_run_id
    AND run.stage_attempt_id = NEW.stage_attempt_id
    AND run.tested_tree = NEW.tested_tree
    AND run.verification_correction_run_id IS NEW.verification_correction_run_id
    AND attempt.verification_correction_run_id IS NEW.verification_correction_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'QA evidence correction lineage is invalid');
END;

ALTER TABLE evidence_artifacts
  ADD COLUMN verification_correction_run_id TEXT
  REFERENCES verification_correction_runs(id) ON DELETE RESTRICT;

DROP TRIGGER evidence_artifacts_authority_lineage_insert;

CREATE TRIGGER evidence_artifacts_authority_lineage_insert
BEFORE INSERT ON evidence_artifacts
WHEN
  NOT EXISTS (
    SELECT 1 FROM stage_attempts AS attempt
    WHERE attempt.id = NEW.stage_attempt_id
      AND attempt.project_id = NEW.project_id
      AND attempt.work_item_id = NEW.work_item_id
      AND attempt.pipeline_run_id = NEW.pipeline_run_id
      AND attempt.correction_run_id IS NEW.correction_run_id
      AND attempt.verification_correction_run_id IS NEW.verification_correction_run_id
      AND (
        attempt.stage = NEW.stage
        OR (
          NEW.correction_run_id IS NULL
          AND NEW.verification_correction_run_id IS NULL
          AND NEW.review_report_id IS NULL
          AND NEW.qa_run_id IS NULL
          AND NEW.qa_evidence_bundle_id IS NULL
          AND NEW.tested_tree IS NULL
        )
      )
  )
  OR (
    NEW.review_report_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM review_reports AS report
      WHERE report.id = NEW.review_report_id
        AND report.project_id = NEW.project_id
        AND report.work_item_id = NEW.work_item_id
        AND report.pipeline_run_id = NEW.pipeline_run_id
        AND report.stage_attempt_id = NEW.stage_attempt_id
        AND report.correction_run_id IS NEW.correction_run_id
        AND report.verification_correction_run_id IS NEW.verification_correction_run_id
        AND report.reviewed_tree = NEW.tested_tree
        AND report.verdict = 'PASSED'
    )
  )
  OR (
    NEW.qa_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM qa_runs AS qa_run
      JOIN qa_evidence_bundles AS evidence ON evidence.id = NEW.qa_evidence_bundle_id
      WHERE qa_run.id = NEW.qa_run_id
        AND qa_run.project_id = NEW.project_id
        AND qa_run.work_item_id = NEW.work_item_id
        AND qa_run.pipeline_run_id = NEW.pipeline_run_id
        AND qa_run.stage_attempt_id = NEW.stage_attempt_id
        AND qa_run.correction_run_id IS NEW.correction_run_id
        AND qa_run.verification_correction_run_id IS NEW.verification_correction_run_id
        AND qa_run.tested_tree = NEW.tested_tree
        AND qa_run.status = 'PASSED'
        AND evidence.qa_run_id = qa_run.id
        AND evidence.project_id = NEW.project_id
        AND evidence.work_item_id = NEW.work_item_id
        AND evidence.pipeline_run_id = NEW.pipeline_run_id
        AND evidence.stage_attempt_id = NEW.stage_attempt_id
        AND evidence.verification_correction_run_id IS NEW.verification_correction_run_id
        AND evidence.tested_tree = NEW.tested_tree
        AND evidence.verdict = 'PASSED'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Evidence artifact authority lineage is invalid');
END;

ALTER TABLE verification_runs
  ADD COLUMN verification_correction_run_id TEXT
  REFERENCES verification_correction_runs(id) ON DELETE RESTRICT;

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
