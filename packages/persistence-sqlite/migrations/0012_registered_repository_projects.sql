-- Spec docs/plans/13-e1-workspace-execution-spec.ru.md §4: a Project is a local Git repository the
-- owner registered by path, and the two bundled fixtures are only the cheap ground the first run
-- starts from. Until now `projects.fixture_id` said the opposite -- `NOT NULL UNIQUE CHECK
-- (fixture_id IN ('web-app-a', 'api-service-b'))` -- so the table could hold nothing but the two
-- demos, and the owner could run a live agent only against Loomrail's own fixtures.
--
-- After this migration `fixture_id` is nullable and unrestricted: a Project registered by path
-- genuinely has no fixture, and NULL records that fact rather than omitting it. It stays UNIQUE,
-- which in SQLite constrains only non-NULL values -- every NULL is distinct in a UNIQUE index --
-- so the two demos still cannot each be registered twice while any number of path-registered
-- Projects coexist. `packages/contracts/src/work-management.ts` makes `projectSchema.fixtureId`
-- `.nullable()` for the same reason, and on the same grounds.
--
-- SQLite cannot alter a CHECK, so this is a table rebuild, the same shape 0006_session_handoff.sql
-- and 0011_work_item_workspaces.sql use for `events`. `projects` is harder than `events` was:
-- nothing references `events`, while thirteen tables reference `projects(id)`, twelve of them
-- ON DELETE RESTRICT. Two things follow, and both are why this migration is declared
-- `rebuildsAReferencedTable` in src/migrations.ts and therefore runs with `PRAGMA foreign_keys` off
-- -- SQLite's own documented procedure for this change, checked at the end of the same transaction
-- by `PRAGMA foreign_key_check`:
--
--   * With foreign keys ON, `ALTER TABLE projects RENAME TO ...` rewrites all thirteen
--     `REFERENCES projects(id)` clauses to name the renamed-aside table, and the database would end
--     up pointing at a table this migration just dropped. With them off, SQLite leaves those
--     clauses alone, so they still name `projects` -- which the last statement here restores.
--   * With foreign keys ON, `DROP TABLE projects` performs an implicit DELETE of every row, and
--     ON DELETE RESTRICT refuses it immediately. RESTRICT is the one action `defer_foreign_keys`
--     cannot defer, so deferring is not a way around this either (both were tried).
--
-- Every existing row is carried across column by column: the owner's real database has Projects in
-- it, and this migration preserves them exactly. test/local-state.integration.test.ts asserts both
-- halves -- the rows survive, and `PRAGMA foreign_key_check` is empty afterwards.
CREATE TABLE projects_v12 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  fixture_id TEXT UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  repository_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO projects_v12 (
  id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at
)
SELECT
  id, workspace_id, fixture_id, name, repository_path, status, version, created_at, updated_at
FROM projects;

DROP TABLE projects;

ALTER TABLE projects_v12 RENAME TO projects;
