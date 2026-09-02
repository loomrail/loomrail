-- Q2 deterministic QA correction lineage. A CorrectionRun owns one bounded fix -> review ->
-- retest cycle; its immutable QARetestPlan is the only sparse scope a retest may reserve.
--
-- StageAttempt.attempt and ReviewReport.round are local to the initial delivery or one correction
-- cycle, so both former pipeline-wide UNIQUE constraints are rebuilt without discarding history.
-- This migration is marked `rebuildsAReferencedTable`: stage_attempts and review_reports are both
-- referenced, and the migration runner keeps foreign keys off only for this transaction and runs
-- `foreign_key_check` before commit.

CREATE TABLE qa_correction_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  source_qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE RESTRICT,
  baseline_qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE RESTRICT,
  source_evidence_bundle_id TEXT NOT NULL REFERENCES qa_evidence_bundles(id) ON DELETE RESTRICT,
  source_tested_tree TEXT NOT NULL CHECK (
    length(source_tested_tree) = 40 AND source_tested_tree NOT GLOB '*[^0-9a-f]*'
  ),
  defect_ids_json TEXT NOT NULL CHECK (
    json_valid(defect_ids_json)
    AND json_type(defect_ids_json) = 'array'
    AND json_array_length(defect_ids_json) BETWEEN 1 AND 150
  ),
  status TEXT NOT NULL CHECK (
    status IN ('ACTIVE', 'PASSED', 'SUPERSEDED', 'EXHAUSTED', 'CANCELLED')
  ),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (pipeline_run_id, ordinal),
  CHECK (
    (status IN ('ACTIVE', 'EXHAUSTED') AND completed_at IS NULL)
    OR
    (status IN ('PASSED', 'SUPERSEDED', 'CANCELLED') AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX qa_correction_runs_pipeline_ordinal_idx
  ON qa_correction_runs(pipeline_run_id, ordinal, id);

-- EXHAUSTED is still the current correction while the owner gate is open. Treat it as current in
-- storage so a bad writer cannot create the next ACTIVE row before superseding the exhausted row
-- in the same transaction.
CREATE UNIQUE INDEX qa_correction_runs_one_current_idx
  ON qa_correction_runs(pipeline_run_id)
  WHERE status IN ('ACTIVE', 'EXHAUSTED');

CREATE TRIGGER qa_correction_runs_source_lineage_insert
BEFORE INSERT ON qa_correction_runs
WHEN
  NEW.status <> 'ACTIVE'
  OR NEW.completed_at IS NOT NULL
  OR NEW.version <> 1
  OR NOT EXISTS (
    SELECT 1
    FROM qa_runs AS source
    JOIN qa_runs AS baseline ON baseline.id = NEW.baseline_qa_run_id
    JOIN qa_evidence_bundles AS evidence ON evidence.id = NEW.source_evidence_bundle_id
    WHERE source.id = NEW.source_qa_run_id
      AND source.status = 'FAILED'
      AND source.project_id = NEW.project_id
      AND source.work_item_id = NEW.work_item_id
      AND source.pipeline_run_id = NEW.pipeline_run_id
      AND source.tested_tree = NEW.source_tested_tree
      AND baseline.status = 'FAILED'
      AND baseline.project_id = NEW.project_id
      AND baseline.work_item_id = NEW.work_item_id
      AND baseline.pipeline_run_id = NEW.pipeline_run_id
      AND evidence.qa_run_id = source.id
      AND evidence.project_id = NEW.project_id
      AND evidence.work_item_id = NEW.work_item_id
      AND evidence.pipeline_run_id = NEW.pipeline_run_id
      AND evidence.tested_tree = NEW.source_tested_tree
      AND evidence.verdict = 'FAILED'
  )
  OR EXISTS (
    SELECT defect_id.value
    FROM json_each(NEW.defect_ids_json) AS defect_id
    GROUP BY defect_id.value
    HAVING COUNT(*) > 1
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.defect_ids_json) AS defect_id
    LEFT JOIN qa_defects AS defect ON defect.id = defect_id.value
    WHERE defect.id IS NULL
      OR defect.status <> 'OPEN'
      OR defect.project_id <> NEW.project_id
      OR defect.work_item_id <> NEW.work_item_id
  )
BEGIN
  SELECT RAISE(ABORT, 'QA correction source lineage is invalid');
END;

CREATE TRIGGER qa_correction_runs_state_transition
BEFORE UPDATE ON qa_correction_runs
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.work_item_id <> OLD.work_item_id
  OR NEW.pipeline_run_id <> OLD.pipeline_run_id
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.source_qa_run_id <> OLD.source_qa_run_id
  OR NEW.baseline_qa_run_id <> OLD.baseline_qa_run_id
  OR NEW.source_evidence_bundle_id <> OLD.source_evidence_bundle_id
  OR NEW.source_tested_tree <> OLD.source_tested_tree
  OR NEW.defect_ids_json <> OLD.defect_ids_json
  OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1
  OR NOT (
    (OLD.status = 'ACTIVE' AND NEW.status IN ('PASSED', 'SUPERSEDED', 'EXHAUSTED', 'CANCELLED'))
    OR
    (OLD.status = 'EXHAUSTED' AND NEW.status IN ('SUPERSEDED', 'CANCELLED'))
  )
BEGIN
  SELECT RAISE(ABORT, 'QA correction may only make a valid one-way state transition');
END;

CREATE TRIGGER qa_correction_runs_cannot_delete
BEFORE DELETE ON qa_correction_runs BEGIN
  SELECT RAISE(ABORT, 'QA correction runs cannot be deleted');
END;

CREATE TABLE qa_retest_plans (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  correction_run_id TEXT NOT NULL UNIQUE REFERENCES qa_correction_runs(id) ON DELETE RESTRICT,
  baseline_qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE RESTRICT,
  source_qa_run_id TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE RESTRICT,
  source_evidence_bundle_id TEXT NOT NULL REFERENCES qa_evidence_bundles(id) ON DELETE RESTRICT,
  baseline_plan_revision INTEGER NOT NULL CHECK (baseline_plan_revision > 0),
  baseline_plan_content_hash TEXT NOT NULL CHECK (
    length(baseline_plan_content_hash) = 71
    AND baseline_plan_content_hash GLOB 'sha256:*'
  ),
  cells_json TEXT NOT NULL CHECK (
    json_valid(cells_json)
    AND json_type(cells_json) = 'array'
    AND json_array_length(cells_json) BETWEEN 1 AND 480
  ),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER qa_retest_plans_lineage_insert
BEFORE INSERT ON qa_retest_plans
WHEN NOT EXISTS (
  SELECT 1
  FROM qa_correction_runs AS correction
  JOIN qa_runs AS baseline ON baseline.id = NEW.baseline_qa_run_id
  WHERE correction.id = NEW.correction_run_id
    AND correction.project_id = NEW.project_id
    AND correction.work_item_id = NEW.work_item_id
    AND correction.pipeline_run_id = NEW.pipeline_run_id
    AND correction.baseline_qa_run_id = NEW.baseline_qa_run_id
    AND correction.source_qa_run_id = NEW.source_qa_run_id
    AND correction.source_evidence_bundle_id = NEW.source_evidence_bundle_id
    AND baseline.project_id = NEW.project_id
    AND baseline.work_item_id = NEW.work_item_id
    AND baseline.pipeline_run_id = NEW.pipeline_run_id
    AND json_extract(baseline.plan_json, '$.revision') = NEW.baseline_plan_revision
    AND json_extract(baseline.plan_json, '$.contentHash') = NEW.baseline_plan_content_hash
)
BEGIN
  SELECT RAISE(ABORT, 'QA retest plan lineage is invalid');
END;

CREATE TRIGGER qa_retest_plans_are_append_only_update
BEFORE UPDATE ON qa_retest_plans BEGIN
  SELECT RAISE(ABORT, 'QA retest plans are append-only');
END;

CREATE TRIGGER qa_retest_plans_are_append_only_delete
BEFORE DELETE ON qa_retest_plans BEGIN
  SELECT RAISE(ABORT, 'QA retest plans are append-only');
END;

-- Stage attempts written before Q2 belong to the initial delivery. Rebuild the pipeline-wide
-- uniqueness as two partial indexes so IMPLEMENT(1), REVIEW(1), and QA(1) can exist once per
-- correction without colliding with their initial-delivery namesakes.
CREATE TABLE stage_attempts_v25 (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  correction_run_id TEXT REFERENCES qa_correction_runs(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('DISCOVERY', 'PLAN', 'IMPLEMENT', 'REVIEW', 'QA', 'ACCEPTANCE')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING', 'QUEUED', 'RUNNING', 'WAITING_HUMAN', 'SOFT_PAUSED', 'HARD_PAUSED',
      'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'RECOVERING', 'STALE'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  started_at TEXT,
  finished_at TEXT,
  failure_code TEXT,
  unproductive_sessions INTEGER NOT NULL DEFAULT 0 CHECK (unproductive_sessions >= 0),
  pack_share_backoffs INTEGER NOT NULL DEFAULT 0 CHECK (pack_share_backoffs >= 0),
  result_tree TEXT CHECK (
    result_tree IS NULL OR (length(result_tree) = 40 AND result_tree NOT GLOB '*[^0-9a-f]*')
  )
) STRICT;

INSERT INTO stage_attempts_v25 (
  id, pipeline_run_id, project_id, work_item_id, correction_run_id, stage, attempt, status,
  version, started_at, finished_at, failure_code, unproductive_sessions, pack_share_backoffs,
  result_tree
)
SELECT
  id, pipeline_run_id, project_id, work_item_id, NULL, stage, attempt, status,
  version, started_at, finished_at, failure_code, unproductive_sessions, pack_share_backoffs,
  result_tree
FROM stage_attempts;

DROP INDEX stage_attempts_run_idx;
DROP TABLE stage_attempts;
ALTER TABLE stage_attempts_v25 RENAME TO stage_attempts;

CREATE INDEX stage_attempts_run_idx ON stage_attempts(pipeline_run_id, attempt, id);
CREATE UNIQUE INDEX stage_attempts_initial_cycle_unique_idx
  ON stage_attempts(pipeline_run_id, stage, attempt)
  WHERE correction_run_id IS NULL;
CREATE UNIQUE INDEX stage_attempts_correction_cycle_unique_idx
  ON stage_attempts(correction_run_id, stage, attempt)
  WHERE correction_run_id IS NOT NULL;

CREATE TRIGGER stage_attempts_correction_lineage_insert
BEFORE INSERT ON stage_attempts
WHEN NEW.correction_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM qa_correction_runs AS correction
  WHERE correction.id = NEW.correction_run_id
    AND correction.project_id = NEW.project_id
    AND correction.work_item_id = NEW.work_item_id
    AND correction.pipeline_run_id = NEW.pipeline_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'Stage attempt correction lineage is invalid');
END;

CREATE TRIGGER stage_attempts_correction_lineage_immutable
BEFORE UPDATE OF correction_run_id ON stage_attempts
WHEN NEW.correction_run_id IS NOT OLD.correction_run_id
BEGIN
  SELECT RAISE(ABORT, 'Stage attempt correction lineage is immutable');
END;

-- Review round numbers are equally local. All existing reports are initial-cycle reports.
DROP TRIGGER review_reports_are_append_only_update;
DROP TRIGGER review_reports_are_append_only_delete;
DROP INDEX review_reports_work_item_round_idx;

CREATE TABLE review_reports_v25 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL UNIQUE REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  correction_run_id TEXT REFERENCES qa_correction_runs(id) ON DELETE RESTRICT,
  author_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  reviewer_agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE RESTRICT,
  provider_relation TEXT NOT NULL CHECK (provider_relation IN ('CROSS_PROVIDER', 'SAME_PROVIDER')),
  reviewed_tree TEXT NOT NULL CHECK (
    length(reviewed_tree) = 40 AND reviewed_tree NOT GLOB '*[^0-9a-f]*'
  ),
  round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 3),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  verdict TEXT NOT NULL CHECK (verdict IN ('PASSED', 'CHANGES_REQUESTED')),
  finding_ids_json TEXT NOT NULL CHECK (
    json_valid(finding_ids_json)
    AND json_type(finding_ids_json) = 'array'
    AND json_array_length(finding_ids_json) <= 20
  ),
  created_at TEXT NOT NULL,
  CHECK (author_agent_run_id <> reviewer_agent_run_id),
  CHECK (
    (verdict = 'PASSED' AND json_array_length(finding_ids_json) = 0)
    OR (verdict = 'CHANGES_REQUESTED' AND json_array_length(finding_ids_json) BETWEEN 1 AND 20)
  )
) STRICT;

INSERT INTO review_reports_v25 (
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  correction_run_id, author_agent_run_id, reviewer_agent_run_id, provider_relation,
  reviewed_tree, round, title, summary, checks_json, verdict, finding_ids_json, created_at
)
SELECT
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  NULL, author_agent_run_id, reviewer_agent_run_id, provider_relation,
  reviewed_tree, round, title, summary, checks_json, verdict, finding_ids_json, created_at
FROM review_reports;

DROP TABLE review_reports;
ALTER TABLE review_reports_v25 RENAME TO review_reports;

CREATE INDEX review_reports_work_item_round_idx
  ON review_reports(work_item_id, pipeline_run_id, correction_run_id, round DESC, id);
CREATE UNIQUE INDEX review_reports_initial_cycle_round_idx
  ON review_reports(pipeline_run_id, round)
  WHERE correction_run_id IS NULL;
CREATE UNIQUE INDEX review_reports_correction_cycle_round_idx
  ON review_reports(correction_run_id, round)
  WHERE correction_run_id IS NOT NULL;

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
)
BEGIN
  SELECT RAISE(ABORT, 'Review report correction lineage is invalid');
END;

CREATE TRIGGER review_reports_are_append_only_update
BEFORE UPDATE ON review_reports BEGIN
  SELECT RAISE(ABORT, 'review reports are append-only');
END;

CREATE TRIGGER review_reports_are_append_only_delete
BEFORE DELETE ON review_reports BEGIN
  SELECT RAISE(ABORT, 'review reports are append-only');
END;

DROP TRIGGER review_findings_immutable_identity;

ALTER TABLE review_findings
  ADD COLUMN correction_run_id TEXT REFERENCES qa_correction_runs(id) ON DELETE RESTRICT;

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
    AND attempt.correction_run_id IS NEW.correction_run_id
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

-- A QARun is FULL when both columns are NULL and RETEST when both are present. The retest plan is
-- created before reservation and storage proves it belongs to the same correction and delivery.
DROP TRIGGER qa_runs_one_way_completion;

ALTER TABLE qa_runs
  ADD COLUMN correction_run_id TEXT REFERENCES qa_correction_runs(id) ON DELETE RESTRICT;

ALTER TABLE qa_runs
  ADD COLUMN retest_plan_id TEXT REFERENCES qa_retest_plans(id) ON DELETE RESTRICT;

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
  OR NEW.started_at <> OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'QA run may only complete once without changing its reservation');
END;

-- Required fields were added to strict JSON contracts before this durable schema existed. Rows get
-- NULL/FULL from the columns above, but old Events and command receipts embed the entities verbatim
-- and must be repaired too. Find each nested entity by its discriminating fields, materialise the
-- occurrence list, and fold json_insert over each document. Object-key insertion never shifts an
-- array path, and guards make the pass idempotent.
DROP TRIGGER events_are_append_only_update;

CREATE TEMP TABLE legacy_event_q2_lineage (
  sequence INTEGER NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CORRECTION_LINEAGE', 'QA_SCOPE')),
  n INTEGER NOT NULL
);

INSERT INTO legacy_event_q2_lineage (sequence, path, kind, n)
SELECT sequence, path, kind,
       ROW_NUMBER() OVER (PARTITION BY sequence ORDER BY path, kind)
FROM (
  SELECT events.sequence AS sequence, tree.fullkey AS path, 'CORRECTION_LINEAGE' AS kind
  FROM events, json_tree(events.data_json) AS tree
  WHERE tree.type = 'object'
    AND json_type(tree.value, '$.correctionRunId') IS NULL
    AND (
      (json_type(tree.value, '$.stage') IS NOT NULL
        AND json_type(tree.value, '$.attempt') IS NOT NULL
        AND json_type(tree.value, '$.pipelineRunId') IS NOT NULL)
      OR
      (json_type(tree.value, '$.providerRelation') IS NOT NULL
        AND json_type(tree.value, '$.reviewerAgentRunId') IS NOT NULL
        AND json_type(tree.value, '$.reviewedTree') IS NOT NULL)
      OR
      (json_type(tree.value, '$.reviewArtifactId') IS NOT NULL
        AND json_type(tree.value, '$.severity') IS NOT NULL
        AND json_type(tree.value, '$.reviewedTree') IS NOT NULL)
    )
  UNION ALL
  SELECT events.sequence AS sequence, tree.fullkey AS path, 'QA_SCOPE' AS kind
  FROM events, json_tree(events.data_json) AS tree
  WHERE tree.type = 'object'
    AND json_type(tree.value, '$.scope') IS NULL
    AND json_type(tree.value, '$.driverId') IS NOT NULL
    AND json_type(tree.value, '$.targetOrigin') IS NOT NULL
    AND json_type(tree.value, '$.plan') = 'object'
);

CREATE INDEX legacy_event_q2_lineage_fold_idx ON legacy_event_q2_lineage(sequence, n);

CREATE TEMP TABLE backfilled_q2_event (
  sequence INTEGER PRIMARY KEY,
  data_json TEXT NOT NULL
);

INSERT INTO backfilled_q2_event (sequence, data_json)
WITH RECURSIVE
  backfilled(sequence, n, data_json) AS (
    SELECT events.sequence, 0, events.data_json
    FROM events
    WHERE events.sequence IN (SELECT sequence FROM legacy_event_q2_lineage)
    UNION ALL
    SELECT backfilled.sequence, occurrence.n,
           CASE occurrence.kind
             WHEN 'QA_SCOPE' THEN
               json_insert(backfilled.data_json, occurrence.path || '.scope', json('{"type":"FULL"}'))
             ELSE
               json_insert(backfilled.data_json, occurrence.path || '.correctionRunId', NULL)
           END
    FROM backfilled
    JOIN legacy_event_q2_lineage AS occurrence
      ON occurrence.sequence = backfilled.sequence
     AND occurrence.n = backfilled.n + 1
  )
SELECT backfilled.sequence, backfilled.data_json
FROM backfilled
JOIN (
  SELECT sequence, MAX(n) AS n FROM legacy_event_q2_lineage GROUP BY sequence
) AS folded
  ON folded.sequence = backfilled.sequence
 AND folded.n = backfilled.n;

UPDATE events
SET data_json = (
  SELECT data_json FROM backfilled_q2_event WHERE backfilled_q2_event.sequence = events.sequence
)
WHERE events.sequence IN (SELECT sequence FROM backfilled_q2_event);

DROP TABLE backfilled_q2_event;
DROP TABLE legacy_event_q2_lineage;

CREATE TRIGGER events_are_append_only_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

DROP TRIGGER commands_are_append_only_update;

CREATE TEMP TABLE legacy_command_q2_lineage (
  command_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CORRECTION_LINEAGE', 'QA_SCOPE')),
  n INTEGER NOT NULL
);

INSERT INTO legacy_command_q2_lineage (command_id, path, kind, n)
SELECT command_id, path, kind,
       ROW_NUMBER() OVER (PARTITION BY command_id ORDER BY path, kind)
FROM (
  SELECT commands.command_id AS command_id, tree.fullkey AS path, 'CORRECTION_LINEAGE' AS kind
  FROM commands, json_tree(commands.result_json) AS tree
  WHERE tree.type = 'object'
    AND json_type(tree.value, '$.correctionRunId') IS NULL
    AND (
      (json_type(tree.value, '$.stage') IS NOT NULL
        AND json_type(tree.value, '$.attempt') IS NOT NULL
        AND json_type(tree.value, '$.pipelineRunId') IS NOT NULL)
      OR
      (json_type(tree.value, '$.providerRelation') IS NOT NULL
        AND json_type(tree.value, '$.reviewerAgentRunId') IS NOT NULL
        AND json_type(tree.value, '$.reviewedTree') IS NOT NULL)
      OR
      (json_type(tree.value, '$.reviewArtifactId') IS NOT NULL
        AND json_type(tree.value, '$.severity') IS NOT NULL
        AND json_type(tree.value, '$.reviewedTree') IS NOT NULL)
    )
  UNION ALL
  SELECT commands.command_id AS command_id, tree.fullkey AS path, 'QA_SCOPE' AS kind
  FROM commands, json_tree(commands.result_json) AS tree
  WHERE tree.type = 'object'
    AND json_type(tree.value, '$.scope') IS NULL
    AND json_type(tree.value, '$.driverId') IS NOT NULL
    AND json_type(tree.value, '$.targetOrigin') IS NOT NULL
    AND json_type(tree.value, '$.plan') = 'object'
);

CREATE INDEX legacy_command_q2_lineage_fold_idx ON legacy_command_q2_lineage(command_id, n);

CREATE TEMP TABLE backfilled_q2_command (
  command_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);

INSERT INTO backfilled_q2_command (command_id, result_json)
WITH RECURSIVE
  backfilled(command_id, n, result_json) AS (
    SELECT commands.command_id, 0, commands.result_json
    FROM commands
    WHERE commands.command_id IN (SELECT command_id FROM legacy_command_q2_lineage)
    UNION ALL
    SELECT backfilled.command_id, occurrence.n,
           CASE occurrence.kind
             WHEN 'QA_SCOPE' THEN
               json_insert(backfilled.result_json, occurrence.path || '.scope', json('{"type":"FULL"}'))
             ELSE
               json_insert(backfilled.result_json, occurrence.path || '.correctionRunId', NULL)
           END
    FROM backfilled
    JOIN legacy_command_q2_lineage AS occurrence
      ON occurrence.command_id = backfilled.command_id
     AND occurrence.n = backfilled.n + 1
  )
SELECT backfilled.command_id, backfilled.result_json
FROM backfilled
JOIN (
  SELECT command_id, MAX(n) AS n FROM legacy_command_q2_lineage GROUP BY command_id
) AS folded
  ON folded.command_id = backfilled.command_id
 AND folded.n = backfilled.n;

UPDATE commands
SET result_json = (
  SELECT result_json FROM backfilled_q2_command WHERE backfilled_q2_command.command_id = commands.command_id
)
WHERE commands.command_id IN (SELECT command_id FROM backfilled_q2_command);

DROP TABLE backfilled_q2_command;
DROP TABLE legacy_command_q2_lineage;

CREATE TRIGGER commands_are_append_only_update
BEFORE UPDATE ON commands BEGIN
  SELECT RAISE(ABORT, 'commands are append-only');
END;
