-- Q17 owns one correction budget across Project verification and Browser QA without merging
-- their evaluator-specific failure or correction records. The ledger is the allocation authority:
-- evaluator-local ordinals remain lineage labels, while `position` is delivery-wide.

CREATE TABLE correction_budget_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  evaluator TEXT NOT NULL CHECK (evaluator IN ('BROWSER_QA', 'PROJECT_VERIFICATION')),
  correction_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_run_id, position),
  UNIQUE (evaluator, correction_run_id),
  CHECK (automatic = CASE WHEN position <= 2 THEN 1 ELSE 0 END)
) STRICT;

CREATE INDEX correction_budget_entries_work_item_idx
  ON correction_budget_entries(work_item_id, position, id);

-- Reconstruct allocations written before this ledger from their immutable creation order. A
-- database produced by the current code has at most three rows per delivery; keeping `position`
-- merely positive also preserves an already-overrun legacy database so the new policy can fail
-- closed instead of making startup destructive.
WITH combined AS (
  SELECT
    'qa:' || id AS ledger_id,
    project_id,
    work_item_id,
    pipeline_run_id,
    'BROWSER_QA' AS evaluator,
    id AS correction_run_id,
    CASE WHEN ordinal <= 2 THEN 1 ELSE 0 END AS source_automatic,
    created_at
  FROM qa_correction_runs
  UNION ALL
  SELECT
    'verification:' || id AS ledger_id,
    project_id,
    work_item_id,
    pipeline_run_id,
    'PROJECT_VERIFICATION' AS evaluator,
    id AS correction_run_id,
    automatic AS source_automatic,
    created_at
  FROM verification_correction_runs
), positioned AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY pipeline_run_id
      -- An owner-authorized row must remain after every automatic row even when an injected clock
      -- gave several historical allocations the same timestamp.
      ORDER BY source_automatic DESC, created_at, evaluator, correction_run_id
    ) AS budget_position
  FROM combined
)
INSERT INTO correction_budget_entries (
  id, project_id, work_item_id, pipeline_run_id, position, automatic, evaluator,
  correction_run_id, created_at
)
SELECT
  ledger_id,
  project_id,
  work_item_id,
  pipeline_run_id,
  budget_position,
  CASE WHEN budget_position <= 2 THEN 1 ELSE 0 END,
  evaluator,
  correction_run_id,
  created_at
FROM positioned;

CREATE TRIGGER correction_budget_entries_bounded_insert
BEFORE INSERT ON correction_budget_entries
WHEN
  NEW.position > 3
  OR NEW.position <> (
    SELECT COUNT(*) + 1
    FROM correction_budget_entries
    WHERE pipeline_run_id = NEW.pipeline_run_id
  )
BEGIN
  SELECT RAISE(ABORT, 'correction budget allocation is outside the delivery-wide bound');
END;

CREATE TRIGGER correction_budget_entries_append_only_update
BEFORE UPDATE ON correction_budget_entries BEGIN
  SELECT RAISE(ABORT, 'correction budget entries are append-only');
END;

CREATE TRIGGER correction_budget_entries_append_only_delete
BEFORE DELETE ON correction_budget_entries BEGIN
  SELECT RAISE(ABORT, 'correction budget entries are append-only');
END;

-- Persistence allocates the ledger row immediately before the evaluator-specific row in one
-- transaction. These reverse guards prevent a correction from bypassing the shared ceiling.
CREATE TRIGGER qa_correction_runs_budget_entry_insert
BEFORE INSERT ON qa_correction_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM correction_budget_entries AS entry
  WHERE entry.pipeline_run_id = NEW.pipeline_run_id
    AND entry.project_id = NEW.project_id
    AND entry.work_item_id = NEW.work_item_id
    AND entry.evaluator = 'BROWSER_QA'
    AND entry.correction_run_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'QA correction budget allocation is missing');
END;

CREATE TRIGGER verification_correction_runs_budget_entry_insert
BEFORE INSERT ON verification_correction_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM correction_budget_entries AS entry
  WHERE entry.pipeline_run_id = NEW.pipeline_run_id
    AND entry.project_id = NEW.project_id
    AND entry.work_item_id = NEW.work_item_id
    AND entry.evaluator = 'PROJECT_VERIFICATION'
    AND entry.correction_run_id = NEW.id
    AND entry.position = NEW.budget_position
    AND entry.automatic = NEW.automatic
)
BEGIN
  SELECT RAISE(ABORT, 'verification correction budget allocation is missing');
END;
