-- A system-resolved QA defect names the exact passing retest that proved the fix. Owner waivers
-- remain reasoned dispositions and deliberately carry no passing-run provenance.

ALTER TABLE qa_defects
ADD COLUMN resolved_by_qa_run_id TEXT REFERENCES qa_runs(id) ON DELETE RESTRICT;

CREATE TRIGGER qa_defects_resolution_provenance_insert
BEFORE INSERT ON qa_defects
WHEN NEW.status <> 'OPEN' OR NEW.resolved_by_qa_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'QA defects must begin open without resolution provenance');
END;

CREATE TRIGGER qa_defects_resolution_provenance_update
BEFORE UPDATE ON qa_defects
WHEN
  (NEW.status = 'RESOLVED' AND (
    NEW.resolved_by_qa_run_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM qa_runs AS run
      WHERE run.id = NEW.resolved_by_qa_run_id
        AND run.status = 'PASSED'
        AND run.work_item_id = NEW.work_item_id
        AND run.correction_run_id IS NOT NULL
    )
  ))
  OR (NEW.status <> 'RESOLVED' AND NEW.resolved_by_qa_run_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'QA defect resolution provenance is invalid');
END;
