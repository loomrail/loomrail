-- L1 (`docs/plans/82-l-production-launch-track-spec.ru.md` §5.1). Catalog v2 widens the closed check,
-- category and finding vocabularies. Existing Runs keep their eight rows unchanged; only future Runs
-- record fourteen. `CHECK` constraints cannot be altered in place, so both tables are rebuilt.
DROP TRIGGER project_readiness_findings_are_append_only_update;
DROP TRIGGER project_readiness_findings_are_append_only_delete;
DROP INDEX project_readiness_findings_run_idx;
DROP INDEX project_readiness_checks_run_idx;

CREATE TABLE project_readiness_checks_v52 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  run_id TEXT NOT NULL REFERENCES project_readiness_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  check_key TEXT NOT NULL CHECK (check_key IN (
    'SECURITY_ACTIVE_CONSTITUTION', 'SECURITY_SECRET_PATHS', 'SECURITY_ENV_IGNORED',
    'SECURITY_CI_HARDENING', 'LEGAL_LICENSE', 'LEGAL_OWNER_REVIEW',
    'PAYMENTS_OWNER_REVIEW', 'ANALYTICS_OWNER_REVIEW',
    'DEPS_LOCKFILE_PRESENT', 'ENV_PROD_SEPARATION', 'SECURITY_HEADERS_OWNER_REVIEW',
    'OPS_HEALTH_ENDPOINT_DECLARED', 'OPS_ROLLBACK_PLAN', 'OPS_BACKUP'
  )),
  category TEXT NOT NULL CHECK (category IN (
    'SECURITY', 'LEGAL', 'PAYMENTS', 'ANALYTICS', 'DEPENDENCIES', 'ENVIRONMENT', 'OPERATIONS'
  )),
  mode TEXT NOT NULL CHECK (mode IN ('AUTOMATED', 'OWNER')),
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'ACTION_REQUIRED', 'CONFIRMED', 'NOT_APPLICABLE')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (run_id, check_key),
  CHECK (
    (mode = 'AUTOMATED' AND status IN ('PASSED', 'ACTION_REQUIRED')) OR
    (mode = 'OWNER' AND status IN ('ACTION_REQUIRED', 'CONFIRMED', 'NOT_APPLICABLE'))
  )
) STRICT;

INSERT INTO project_readiness_checks_v52 (
  id, schema_version, run_id, project_id, check_key, category, mode, status, summary, version
)
SELECT id, schema_version, run_id, project_id, check_key, category, mode, status, summary, version
FROM project_readiness_checks;

DROP TABLE project_readiness_checks;
ALTER TABLE project_readiness_checks_v52 RENAME TO project_readiness_checks;

CREATE INDEX project_readiness_checks_run_idx ON project_readiness_checks(run_id, check_key);

CREATE TABLE project_readiness_findings_v52 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  run_id TEXT NOT NULL REFERENCES project_readiness_runs(id) ON DELETE RESTRICT,
  check_id TEXT NOT NULL REFERENCES project_readiness_checks(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (code IN (
    'ACTIVE_CONSTITUTION_MISSING', 'TRACKED_SECRET_PATH', 'ENV_NOT_IGNORED',
    'CI_PULL_REQUEST_TARGET', 'CI_WRITE_ALL_PERMISSIONS', 'CI_ACTION_NOT_PINNED',
    'CI_INPUT_UNVERIFIABLE', 'LICENSE_MISSING',
    'LOCKFILE_MISSING', 'LOCKFILE_AMBIGUOUS', 'DEPENDENCY_INPUT_UNVERIFIABLE',
    'PROD_ENV_NOT_IGNORED', 'INLINE_SECRET_IN_CI'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  path TEXT CHECK (path IS NULL OR length(path) BETWEEN 1 AND 500),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500)
) STRICT;

INSERT INTO project_readiness_findings_v52 (
  id, schema_version, run_id, check_id, project_id, code, severity, path, message
)
SELECT id, schema_version, run_id, check_id, project_id, code, severity, path, message
FROM project_readiness_findings;

DROP TABLE project_readiness_findings;
ALTER TABLE project_readiness_findings_v52 RENAME TO project_readiness_findings;

CREATE INDEX project_readiness_findings_run_idx ON project_readiness_findings(run_id, check_id, id);

CREATE TRIGGER project_readiness_findings_are_append_only_update
BEFORE UPDATE ON project_readiness_findings BEGIN
  SELECT RAISE(ABORT, 'project readiness findings are append-only');
END;
CREATE TRIGGER project_readiness_findings_are_append_only_delete
BEFORE DELETE ON project_readiness_findings BEGIN
  SELECT RAISE(ABORT, 'project readiness findings are append-only');
END;
