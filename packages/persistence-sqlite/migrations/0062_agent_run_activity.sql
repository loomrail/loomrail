-- Level 1 Agent Run Activity: prunable, non-authoritative diagnostic record of what a provider
-- reported doing. Unlike `events` and `workspace_tool_calls` this table is deliberately mutable and
-- prunable: a terminal report updates the row its start created, and the oldest rows are evicted
-- once a run passes its bound. Nothing here is evidence.
CREATE TABLE agent_run_activity (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq > 0),
  action_key TEXT NOT NULL CHECK (length(action_key) BETWEEN 1 AND 200),
  provider TEXT NOT NULL CHECK (provider IN ('CODEX', 'CLAUDE_CODE')),
  kind TEXT NOT NULL CHECK (kind IN ('TOOL_CALL', 'AGENT_TEXT', 'FILE_CHANGE', 'PROVIDER_ERROR')),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 500),
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 2000),
  status TEXT CHECK (status IS NULL OR length(status) BETWEEN 1 AND 120),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  observed_at TEXT NOT NULL,
  UNIQUE (provider_session_id, action_key),
  UNIQUE (agent_run_id, seq)
) STRICT;

CREATE INDEX agent_run_activity_run_idx
ON agent_run_activity(agent_run_id, observed_at, id);

-- Per-run counters the entries themselves cannot carry: how many were evicted, and whether the
-- recorder ever failed to write. Both are shown to the owner rather than hidden.
CREATE TABLE agent_run_activity_state (
  agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  next_seq INTEGER NOT NULL CHECK (next_seq > 0),
  omitted_count INTEGER NOT NULL CHECK (omitted_count >= 0),
  degraded INTEGER NOT NULL CHECK (degraded IN (0, 1))
) STRICT;
