-- L4b1 / ADR-0030: bind each new STANDARD deployment to one Environment kind and allow
-- Production only after an exact successful Preview evidence digest. Existing v1 history is
-- preserved byte-for-byte and remains readable, but its nullable promotion columns cannot qualify.

DROP TRIGGER deployment_plans_are_immutable_update;
DROP TRIGGER deployment_plans_cannot_delete;
DROP INDEX deployment_plans_project_idx;

CREATE TABLE deployment_plans_v61 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  release_id TEXT NOT NULL REFERENCES launch_releases(id) ON DELETE RESTRICT,
  environment_id TEXT NOT NULL REFERENCES launch_environments(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision IN (1, 2)),
  release_evidence_digest TEXT NULL CHECK (
    release_evidence_digest IS NULL OR (
      length(release_evidence_digest) = 64
      AND release_evidence_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  environment_kind TEXT NULL CHECK (environment_kind IS NULL OR environment_kind IN ('PREVIEW', 'PRODUCTION')),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  created_at TEXT NOT NULL,
  CHECK (
    (revision = 1 AND release_evidence_digest IS NULL AND environment_kind IS NULL)
    OR
    (revision = 2 AND release_evidence_digest IS NOT NULL AND environment_kind IS NOT NULL)
  )
) STRICT;

INSERT INTO deployment_plans_v61 (
  id, schema_version, project_id, release_id, environment_id, revision,
  release_evidence_digest, environment_kind, content_hash, plan_json, created_at
)
SELECT
  id, schema_version, project_id, release_id, environment_id, revision,
  NULL, NULL, content_hash, plan_json, created_at
FROM deployment_plans;

DROP TABLE deployment_plans;
ALTER TABLE deployment_plans_v61 RENAME TO deployment_plans;

CREATE INDEX deployment_plans_project_idx
ON deployment_plans(project_id, created_at DESC, id DESC);

CREATE TRIGGER deployment_plans_are_immutable_update
BEFORE UPDATE ON deployment_plans BEGIN
  SELECT RAISE(ABORT, 'deployment plans are immutable');
END;

CREATE TRIGGER deployment_plans_cannot_delete
BEFORE DELETE ON deployment_plans BEGIN
  SELECT RAISE(ABORT, 'deployment plans cannot be deleted');
END;

DROP TRIGGER deployments_guard_update;

ALTER TABLE deployments
ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 1 CHECK (plan_revision IN (1, 2));

ALTER TABLE deployments
ADD COLUMN environment_kind TEXT NULL CHECK (
  environment_kind IS NULL OR environment_kind IN ('PREVIEW', 'PRODUCTION')
);

ALTER TABLE deployments
ADD COLUMN release_evidence_digest TEXT NULL CHECK (
  (plan_revision = 1 AND release_evidence_digest IS NULL AND environment_kind IS NULL)
  OR
  (
    plan_revision = 2
    AND environment_kind IS NOT NULL
    AND release_evidence_digest IS NOT NULL
    AND length(release_evidence_digest) = 64
    AND release_evidence_digest NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX deployments_promotion_idx
ON deployments(project_id, release_evidence_digest, environment_kind, status, created_at DESC, id DESC);

CREATE TRIGGER deployments_guard_update
BEFORE UPDATE ON deployments
WHEN
  NEW.id <> OLD.id
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.project_id <> OLD.project_id
  OR NEW.plan_id <> OLD.plan_id
  OR NEW.plan_revision <> OLD.plan_revision
  OR NEW.release_id <> OLD.release_id
  OR NEW.environment_id <> OLD.environment_id
  OR NEW.environment_kind IS NOT OLD.environment_kind
  OR NEW.release_evidence_digest IS NOT OLD.release_evidence_digest
  OR NEW.approval_digest <> OLD.approval_digest
  OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid deployment transition');
END;
