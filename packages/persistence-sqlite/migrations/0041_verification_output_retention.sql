-- Verification output is diagnostic evidence, not permanent task truth. Keep the immutable
-- measured Check row while recording successful 30-day artifact cleanup separately.

CREATE TABLE verification_output_retention_log (
  artifact_id TEXT PRIMARY KEY REFERENCES verification_output_artifacts(artifact_id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('DELETED', 'ALREADY_ABSENT')),
  recorded_at TEXT NOT NULL
) STRICT;
