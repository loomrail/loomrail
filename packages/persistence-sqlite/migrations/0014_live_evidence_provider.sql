DROP TRIGGER evidence_artifacts_are_append_only_update;
DROP TRIGGER evidence_artifacts_are_append_only_delete;
DROP INDEX evidence_artifacts_run_created_idx;

ALTER TABLE evidence_artifacts RENAME TO evidence_artifacts_v13;

CREATE TABLE evidence_artifacts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('REVIEW', 'QA')),
  kind TEXT NOT NULL CHECK (kind IN ('REVIEW_REPORT', 'QA_REPORT')),
  status TEXT NOT NULL CHECK (status = 'PASSED'),
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'CODEX', 'CLAUDE_CODE')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_run_id, kind)
) STRICT;

INSERT INTO evidence_artifacts (
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  stage, kind, status, provider, title, summary, checks_json, created_at
)
SELECT
  id, schema_version, project_id, work_item_id, pipeline_run_id, stage_attempt_id,
  stage, kind, status, provider, title, summary, checks_json, created_at
FROM evidence_artifacts_v13;

DROP TABLE evidence_artifacts_v13;

CREATE INDEX evidence_artifacts_run_created_idx
  ON evidence_artifacts(pipeline_run_id, created_at, id);

CREATE TRIGGER evidence_artifacts_are_append_only_update
BEFORE UPDATE ON evidence_artifacts
BEGIN
  SELECT RAISE(ABORT, 'evidence artifacts are append-only');
END;

CREATE TRIGGER evidence_artifacts_are_append_only_delete
BEFORE DELETE ON evidence_artifacts
BEGIN
  SELECT RAISE(ABORT, 'evidence artifacts are append-only');
END;
