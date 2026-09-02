-- SD-004 cleanup audit. Attachment metadata remains append-only; this table records only that the
-- corresponding raw file was removed or was already absent when bounded cleanup inspected it.

CREATE TABLE qa_attachment_retention_log (
  attachment_id TEXT PRIMARY KEY REFERENCES qa_attachment_refs(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('DELETED', 'ALREADY_ABSENT')),
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER qa_attachment_retention_log_is_append_only_update
BEFORE UPDATE ON qa_attachment_retention_log BEGIN
  SELECT RAISE(ABORT, 'QA attachment retention log is append-only');
END;

CREATE TRIGGER qa_attachment_retention_log_is_append_only_delete
BEFORE DELETE ON qa_attachment_retention_log BEGIN
  SELECT RAISE(ABORT, 'QA attachment retention log is append-only');
END;
