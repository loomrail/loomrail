-- A3 role-aware context packs. Historical recipes came only from WorkflowTemplate and keep a
-- null role profile. New ROLE_PLAYBOOK recipes name the exact immutable AgentProfile revision
-- whose refinement was applied before the ProviderSession started.

DROP TRIGGER context_pack_recipes_are_append_only_update;
DROP TRIGGER context_pack_recipes_are_append_only_delete;
ALTER TABLE context_pack_recipes RENAME TO context_pack_recipes_v29;

CREATE TABLE context_pack_recipes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  provider_session_id TEXT NOT NULL UNIQUE REFERENCES provider_sessions(id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  spec_source TEXT NOT NULL CHECK (spec_source IN ('WORKFLOW_TEMPLATE', 'ROLE_PLAYBOOK')),
  role_profile_id TEXT,
  role_profile_revision INTEGER CHECK (role_profile_revision IS NULL OR role_profile_revision > 0),
  sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
  omitted_json TEXT NOT NULL CHECK (json_valid(omitted_json)),
  content_hash TEXT NOT NULL CHECK (content_hash LIKE 'sha256:%'),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  budget_tokens INTEGER NOT NULL CHECK (budget_tokens > 0),
  estimate_quality TEXT NOT NULL
    CHECK (estimate_quality IN ('ACTUAL', 'PROVIDER_ESTIMATE', 'LOOMRAIL_ESTIMATE')),
  created_at TEXT NOT NULL,
  CHECK (
    (spec_source = 'ROLE_PLAYBOOK' AND role_profile_id IS NOT NULL AND role_profile_revision IS NOT NULL)
    OR
    (spec_source = 'WORKFLOW_TEMPLATE' AND role_profile_id IS NULL AND role_profile_revision IS NULL)
  )
) STRICT;

INSERT INTO context_pack_recipes (
  id, schema_version, provider_session_id, template_id, template_version, spec_source,
  role_profile_id, role_profile_revision, sections_json, omitted_json, content_hash,
  estimated_tokens, budget_tokens, estimate_quality, created_at
)
SELECT
  id, schema_version, provider_session_id, template_id, template_version, spec_source,
  NULL, NULL, sections_json, omitted_json, content_hash,
  estimated_tokens, budget_tokens, estimate_quality, created_at
FROM context_pack_recipes_v29;

DROP TABLE context_pack_recipes_v29;

CREATE TRIGGER context_pack_recipes_are_append_only_update
BEFORE UPDATE ON context_pack_recipes
BEGIN
  SELECT RAISE(ABORT, 'context pack recipes are append-only');
END;

CREATE TRIGGER context_pack_recipes_are_append_only_delete
BEFORE DELETE ON context_pack_recipes
BEGIN
  SELECT RAISE(ABORT, 'context pack recipes are append-only');
END;
