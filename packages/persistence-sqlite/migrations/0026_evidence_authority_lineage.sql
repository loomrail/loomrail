-- Q2 compact evidence authority. Passing Review/QA artifacts are append-only projections of an
-- exact ReviewReport or QARun/EvidenceBundle. The former pipeline-wide kind uniqueness discarded
-- the history a correction cycle must retain, so uniqueness now belongs to the owning
-- StageAttempt and authority row.

DROP TRIGGER evidence_artifacts_are_append_only_update;
DROP TRIGGER evidence_artifacts_are_append_only_delete;
DROP TRIGGER evidence_artifacts_measured_qa_provenance_insert;
DROP TRIGGER evidence_artifacts_measured_qa_provenance_update;
DROP INDEX evidence_artifacts_run_created_idx;
DROP INDEX evidence_artifacts_qa_run_unique_idx;
DROP INDEX evidence_artifacts_qa_bundle_unique_idx;

ALTER TABLE evidence_artifacts RENAME TO evidence_artifacts_v25;

CREATE TABLE evidence_artifacts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  correction_run_id TEXT REFERENCES qa_correction_runs(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('REVIEW', 'QA')),
  kind TEXT NOT NULL CHECK (kind IN ('REVIEW_REPORT', 'QA_REPORT')),
  status TEXT NOT NULL CHECK (status = 'PASSED'),
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'CODEX', 'CLAUDE_CODE')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  review_report_id TEXT REFERENCES review_reports(id) ON DELETE RESTRICT,
  qa_run_id TEXT REFERENCES qa_runs(id) ON DELETE RESTRICT,
  qa_evidence_bundle_id TEXT REFERENCES qa_evidence_bundles(id) ON DELETE RESTRICT,
  tested_tree TEXT CHECK (
    tested_tree IS NULL
    OR (length(tested_tree) = 40 AND tested_tree NOT GLOB '*[^0-9a-f]*')
  ),
  created_at TEXT NOT NULL,
  UNIQUE (stage_attempt_id, kind),
  CHECK (
    (kind = 'REVIEW_REPORT' AND stage = 'REVIEW')
    OR (kind = 'QA_REPORT' AND stage = 'QA')
  ),
  CHECK (
    (
      kind = 'REVIEW_REPORT'
      AND qa_run_id IS NULL
      AND qa_evidence_bundle_id IS NULL
      AND (review_report_id IS NULL) = (tested_tree IS NULL)
    )
    OR
    (
      kind = 'QA_REPORT'
      AND review_report_id IS NULL
      AND (
        ((qa_run_id IS NULL) + (qa_evidence_bundle_id IS NULL) + (tested_tree IS NULL)) = 0
        OR ((qa_run_id IS NULL) + (qa_evidence_bundle_id IS NULL) + (tested_tree IS NULL)) = 3
      )
    )
  ),
  CHECK (
    correction_run_id IS NULL
    OR review_report_id IS NOT NULL
    OR qa_run_id IS NOT NULL
  )
) STRICT;

INSERT INTO evidence_artifacts (
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  correction_run_id, stage, kind, status, provider, title, summary, checks_json,
  review_report_id, qa_run_id, qa_evidence_bundle_id, tested_tree, created_at
)
SELECT
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  NULL, stage, kind, status, provider, title, summary, checks_json,
  NULL, qa_run_id, qa_evidence_bundle_id, tested_tree, created_at
FROM evidence_artifacts_v25;

DROP TABLE evidence_artifacts_v25;

CREATE INDEX evidence_artifacts_run_created_idx
  ON evidence_artifacts(pipeline_run_id, created_at, id);
CREATE UNIQUE INDEX evidence_artifacts_review_report_unique_idx
  ON evidence_artifacts(review_report_id) WHERE review_report_id IS NOT NULL;
CREATE UNIQUE INDEX evidence_artifacts_qa_run_unique_idx
  ON evidence_artifacts(qa_run_id) WHERE qa_run_id IS NOT NULL;
CREATE UNIQUE INDEX evidence_artifacts_qa_bundle_unique_idx
  ON evidence_artifacts(qa_evidence_bundle_id) WHERE qa_evidence_bundle_id IS NOT NULL;

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
      AND (
        attempt.stage = NEW.stage
        OR (
          NEW.correction_run_id IS NULL
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
        AND qa_run.tested_tree = NEW.tested_tree
        AND qa_run.status = 'PASSED'
        AND evidence.qa_run_id = qa_run.id
        AND evidence.project_id = NEW.project_id
        AND evidence.work_item_id = NEW.work_item_id
        AND evidence.pipeline_run_id = NEW.pipeline_run_id
        AND evidence.stage_attempt_id = NEW.stage_attempt_id
        AND evidence.tested_tree = NEW.tested_tree
        AND evidence.verdict = 'PASSED'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Evidence artifact authority lineage is invalid');
END;

CREATE TRIGGER evidence_artifacts_are_append_only_update
BEFORE UPDATE ON evidence_artifacts BEGIN
  SELECT RAISE(ABORT, 'evidence artifacts are append-only');
END;

CREATE TRIGGER evidence_artifacts_are_append_only_delete
BEFORE DELETE ON evidence_artifacts BEGIN
  SELECT RAISE(ABORT, 'evidence artifacts are append-only');
END;

-- EvidenceArtifact is embedded in Events, command receipts, and workflow snapshots. Its new
-- correctionRunId is required at the strict contract boundary, so pre-Q2 history gets truthful
-- JSON null just as the rebuilt rows above do.
DROP TRIGGER events_are_append_only_update;

CREATE TEMP TABLE legacy_event_evidence_correction (
  sequence INTEGER NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL
);

INSERT INTO legacy_event_evidence_correction (sequence, path, n)
SELECT events.sequence, tree.fullkey,
       ROW_NUMBER() OVER (PARTITION BY events.sequence ORDER BY tree.fullkey)
FROM events, json_tree(events.data_json) AS tree
WHERE tree.type = 'object'
  AND json_type(tree.value, '$.correctionRunId') IS NULL
  AND json_type(tree.value, '$.pipelineRunId') IS NOT NULL
  AND json_extract(tree.value, '$.stage') IN ('REVIEW', 'QA')
  AND json_extract(tree.value, '$.kind') IN ('REVIEW_REPORT', 'QA_REPORT')
  AND json_extract(tree.value, '$.status') = 'PASSED'
  AND json_type(tree.value, '$.provider') IS NOT NULL
  AND json_type(tree.value, '$.checks') = 'array';

CREATE INDEX legacy_event_evidence_correction_fold_idx
  ON legacy_event_evidence_correction(sequence, n);

CREATE TEMP TABLE backfilled_evidence_event (
  sequence INTEGER PRIMARY KEY,
  data_json TEXT NOT NULL
);

INSERT INTO backfilled_evidence_event (sequence, data_json)
WITH RECURSIVE
  backfilled(sequence, n, data_json) AS (
    SELECT events.sequence, 0, events.data_json
    FROM events
    WHERE events.sequence IN (SELECT sequence FROM legacy_event_evidence_correction)
    UNION ALL
    SELECT backfilled.sequence, occurrence.n,
           json_insert(backfilled.data_json, occurrence.path || '.correctionRunId', NULL)
    FROM backfilled
    JOIN legacy_event_evidence_correction AS occurrence
      ON occurrence.sequence = backfilled.sequence
     AND occurrence.n = backfilled.n + 1
  )
SELECT backfilled.sequence, backfilled.data_json
FROM backfilled
JOIN (
  SELECT sequence, MAX(n) AS n FROM legacy_event_evidence_correction GROUP BY sequence
) AS folded
  ON folded.sequence = backfilled.sequence
 AND folded.n = backfilled.n;

UPDATE events
SET data_json = (
  SELECT data_json FROM backfilled_evidence_event WHERE backfilled_evidence_event.sequence = events.sequence
)
WHERE events.sequence IN (SELECT sequence FROM backfilled_evidence_event);

DROP TABLE backfilled_evidence_event;
DROP TABLE legacy_event_evidence_correction;

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TRIGGER commands_are_append_only_update;

CREATE TEMP TABLE legacy_command_evidence_correction (
  command_id TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL
);

INSERT INTO legacy_command_evidence_correction (command_id, path, n)
SELECT commands.command_id, tree.fullkey,
       ROW_NUMBER() OVER (PARTITION BY commands.command_id ORDER BY tree.fullkey)
FROM commands, json_tree(commands.result_json) AS tree
WHERE tree.type = 'object'
  AND json_type(tree.value, '$.correctionRunId') IS NULL
  AND json_type(tree.value, '$.pipelineRunId') IS NOT NULL
  AND json_extract(tree.value, '$.stage') IN ('REVIEW', 'QA')
  AND json_extract(tree.value, '$.kind') IN ('REVIEW_REPORT', 'QA_REPORT')
  AND json_extract(tree.value, '$.status') = 'PASSED'
  AND json_type(tree.value, '$.provider') IS NOT NULL
  AND json_type(tree.value, '$.checks') = 'array';

CREATE INDEX legacy_command_evidence_correction_fold_idx
  ON legacy_command_evidence_correction(command_id, n);

CREATE TEMP TABLE backfilled_evidence_command (
  command_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);

INSERT INTO backfilled_evidence_command (command_id, result_json)
WITH RECURSIVE
  backfilled(command_id, n, result_json) AS (
    SELECT commands.command_id, 0, commands.result_json
    FROM commands
    WHERE commands.command_id IN (SELECT command_id FROM legacy_command_evidence_correction)
    UNION ALL
    SELECT backfilled.command_id, occurrence.n,
           json_insert(backfilled.result_json, occurrence.path || '.correctionRunId', NULL)
    FROM backfilled
    JOIN legacy_command_evidence_correction AS occurrence
      ON occurrence.command_id = backfilled.command_id
     AND occurrence.n = backfilled.n + 1
  )
SELECT backfilled.command_id, backfilled.result_json
FROM backfilled
JOIN (
  SELECT command_id, MAX(n) AS n FROM legacy_command_evidence_correction GROUP BY command_id
) AS folded
  ON folded.command_id = backfilled.command_id
 AND folded.n = backfilled.n;

UPDATE commands
SET result_json = (
  SELECT result_json FROM backfilled_evidence_command
  WHERE backfilled_evidence_command.command_id = commands.command_id
)
WHERE commands.command_id IN (SELECT command_id FROM backfilled_evidence_command);

DROP TABLE backfilled_evidence_command;
DROP TABLE legacy_command_evidence_correction;

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands BEGIN
  SELECT RAISE(ABORT, 'commands are append-only');
END;
