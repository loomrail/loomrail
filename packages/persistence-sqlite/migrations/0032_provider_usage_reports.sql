-- Q13 live-provider spend. Exactly one final cumulative report belongs to a ProviderSession.
-- The linked UsageRecord is the budget-ledger projection of input + output tokens; provider-only
-- subdivisions remain here and are not charged a second time.

CREATE TABLE provider_usage_reports (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  stage_attempt_id TEXT NOT NULL REFERENCES stage_attempts(id) ON DELETE RESTRICT,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL UNIQUE REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  usage_record_id TEXT UNIQUE REFERENCES usage_records(id) ON DELETE RESTRICT,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  reasoning_output_tokens INTEGER CHECK (
    reasoning_output_tokens IS NULL OR reasoning_output_tokens >= 0
  ),
  total_tokens INTEGER NOT NULL CHECK (
    total_tokens >= 0 AND total_tokens = input_tokens + output_tokens
  ),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  quality TEXT NOT NULL CHECK (quality IN ('ACTUAL', 'PROVIDER_ESTIMATE', 'LOOMRAIL_ESTIMATE')),
  usage_digest TEXT NOT NULL CHECK (
    length(usage_digest) = 71 AND usage_digest GLOB 'sha256:[0-9a-f]*'
  ),
  recorded_at TEXT NOT NULL,
  CHECK (
    (total_tokens = 0 AND usage_record_id IS NULL)
    OR (total_tokens > 0 AND usage_record_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX provider_usage_reports_agent_run_idx
  ON provider_usage_reports(agent_run_id, recorded_at, id);
CREATE INDEX provider_usage_reports_stage_attempt_idx
  ON provider_usage_reports(stage_attempt_id, recorded_at, id);

CREATE TRIGGER provider_usage_reports_are_append_only_update
BEFORE UPDATE ON provider_usage_reports
BEGIN
  SELECT RAISE(ABORT, 'provider usage reports are append-only');
END;

CREATE TRIGGER provider_usage_reports_are_append_only_delete
BEFORE DELETE ON provider_usage_reports
BEGIN
  SELECT RAISE(ABORT, 'provider usage reports are append-only');
END;
