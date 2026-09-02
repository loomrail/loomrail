-- Link the compact QA_REPORT used by Acceptance to the daemon-measured QARun and evidence bundle.
-- Existing provider-authored reports remain readable with NULL provenance, but Acceptance rejects them.

ALTER TABLE evidence_artifacts
  ADD COLUMN qa_run_id TEXT REFERENCES qa_runs(id) ON DELETE RESTRICT;

ALTER TABLE evidence_artifacts
  ADD COLUMN qa_evidence_bundle_id TEXT REFERENCES qa_evidence_bundles(id) ON DELETE RESTRICT;

ALTER TABLE evidence_artifacts
  ADD COLUMN tested_tree TEXT;

CREATE UNIQUE INDEX evidence_artifacts_qa_run_unique_idx
  ON evidence_artifacts(qa_run_id)
  WHERE qa_run_id IS NOT NULL;

CREATE UNIQUE INDEX evidence_artifacts_qa_bundle_unique_idx
  ON evidence_artifacts(qa_evidence_bundle_id)
  WHERE qa_evidence_bundle_id IS NOT NULL;

CREATE TRIGGER evidence_artifacts_measured_qa_provenance_insert
BEFORE INSERT ON evidence_artifacts
WHEN
  (
    (NEW.qa_run_id IS NULL) +
    (NEW.qa_evidence_bundle_id IS NULL) +
    (NEW.tested_tree IS NULL)
  ) NOT IN (0, 3)
  OR (
    NEW.qa_run_id IS NOT NULL
    AND (NEW.kind <> 'QA_REPORT' OR NEW.stage <> 'QA')
  )
  OR (
    NEW.tested_tree IS NOT NULL
    AND (
      length(NEW.tested_tree) <> 40
      OR NEW.tested_tree GLOB '*[^0-9a-f]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Measured QA artifact provenance is invalid');
END;

CREATE TRIGGER evidence_artifacts_measured_qa_provenance_update
BEFORE UPDATE OF qa_run_id, qa_evidence_bundle_id, tested_tree ON evidence_artifacts
BEGIN
  SELECT RAISE(ABORT, 'Measured QA artifact provenance is immutable');
END;
