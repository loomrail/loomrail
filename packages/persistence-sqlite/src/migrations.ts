import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { StateStoreError, type StateStoreStartup } from "./types.js";

type Migration = {
  version: number;
  name: string;
  filename: string;
  /**
   * This migration rebuilds a table other tables hold foreign keys into, so it runs with
   * `PRAGMA foreign_keys` off -- SQLite's own documented procedure for the change, and the only one
   * available to it.
   *
   * Two SQLite behaviours force it, both of them about the *old* table rather than the new one.
   * With foreign keys enabled, `ALTER TABLE ... RENAME` rewrites every `REFERENCES` clause that
   * names the renamed table, so renaming the old one aside silently redirects the whole database at
   * a table the migration is about to drop. And `DROP TABLE` performs an implicit DELETE of every
   * row, which `ON DELETE RESTRICT` refuses immediately -- RESTRICT being the one action
   * `defer_foreign_keys` cannot defer. Neither can be worked around from inside the transaction,
   * because `PRAGMA foreign_keys` is a no-op there.
   *
   * The relaxation is bounded and verified, not taken on trust: the pragma is switched off for the
   * length of this one migration and restored whether it succeeds or fails, and before the
   * transaction commits `PRAGMA foreign_key_check` must come back empty. A rebuild that left a row
   * pointing at nothing therefore rolls back rather than committing a database whose foreign keys
   * were never checked.
   */
  rebuildsAReferencedTable?: true;
};

export type MigrationSource = Migration & {
  sql: string;
  checksum: string;
};

const migrations: readonly Migration[] = [
  { version: 1, name: "initial", filename: "0001_initial.sql" },
  { version: 2, name: "mock_workflow", filename: "0002_mock_workflow.sql" },
  { version: 3, name: "budget_pause_recovery", filename: "0003_budget_pause_recovery.sql" },
  {
    version: 4,
    name: "pipeline_started_budget_backfill",
    filename: "0004_pipeline_started_budget_backfill.sql",
  },
  { version: 5, name: "acceptance_evidence", filename: "0005_acceptance_evidence.sql" },
  { version: 6, name: "session_handoff", filename: "0006_session_handoff.sql" },
  { version: 7, name: "pack_share_backoff", filename: "0007_pack_share_backoff.sql" },
  {
    version: 8,
    name: "stage_attempt_counter_backfill",
    filename: "0008_stage_attempt_counter_backfill.sql",
  },
  { version: 9, name: "session_window_occupancy", filename: "0009_session_window_occupancy.sql" },
  { version: 10, name: "provider_session_pid", filename: "0010_provider_session_pid.sql" },
  {
    version: 11,
    name: "work_item_workspaces",
    filename: "0011_work_item_workspaces.sql",
  },
  {
    version: 12,
    name: "registered_repository_projects",
    filename: "0012_registered_repository_projects.sql",
    rebuildsAReferencedTable: true,
  },
  {
    version: 13,
    name: "stage_attempt_result_tree",
    filename: "0013_stage_attempt_result_tree.sql",
  },
  {
    version: 14,
    name: "live_evidence_provider",
    filename: "0014_live_evidence_provider.sql",
  },
  {
    version: 15,
    name: "project_constitutions",
    filename: "0015_project_constitutions.sql",
  },
  {
    version: 16,
    name: "project_readiness",
    filename: "0016_project_readiness.sql",
  },
  {
    version: 17,
    name: "project_provider_preference",
    filename: "0017_project_provider_preference.sql",
  },
  {
    version: 18,
    name: "mcp_connections",
    filename: "0018_mcp_connections.sql",
  },
  {
    version: 19,
    name: "project_scaffolding",
    filename: "0019_project_scaffolding.sql",
    rebuildsAReferencedTable: true,
  },
  { version: 20, name: "agent_runs", filename: "0020_agent_runs.sql" },
  { version: 21, name: "independent_review", filename: "0021_independent_review.sql" },
  { version: 22, name: "browser_qa_evidence", filename: "0022_browser_qa_evidence.sql" },
  {
    version: 23,
    name: "measured_qa_artifact_provenance",
    filename: "0023_measured_qa_artifact_provenance.sql",
  },
  {
    version: 24,
    name: "qa_attachment_retention",
    filename: "0024_qa_attachment_retention.sql",
  },
  {
    version: 25,
    name: "qa_correction_lineage",
    filename: "0025_qa_correction_lineage.sql",
    rebuildsAReferencedTable: true,
  },
  {
    version: 26,
    name: "evidence_authority_lineage",
    filename: "0026_evidence_authority_lineage.sql",
  },
  {
    version: 27,
    name: "qa_defect_waiver_event",
    filename: "0027_qa_defect_waiver_event.sql",
  },
  {
    version: 28,
    name: "qa_correction_events",
    filename: "0028_qa_correction_events.sql",
  },
  {
    version: 29,
    name: "qa_defect_resolution_provenance",
    filename: "0029_qa_defect_resolution_provenance.sql",
  },
  {
    version: 30,
    name: "role_playbook_recipes",
    filename: "0030_role_playbook_recipes.sql",
  },
  {
    version: 31,
    name: "agent_run_policy_snapshots",
    filename: "0031_agent_run_policy_snapshots.sql",
  },
  {
    version: 32,
    name: "provider_usage_reports",
    filename: "0032_provider_usage_reports.sql",
  },
  {
    version: 33,
    name: "budget_model_tier_override",
    filename: "0033_budget_model_tier_override.sql",
  },
  {
    version: 34,
    name: "budget_agent_run_override",
    filename: "0034_budget_agent_run_override.sql",
  },
  {
    version: 35,
    name: "repeatable_recovery_reports",
    filename: "0035_repeatable_recovery_reports.sql",
  },
  {
    version: 36,
    name: "provider_allowance_snapshots",
    filename: "0036_provider_allowance_snapshots.sql",
  },
  {
    version: 37,
    name: "project_verification_plans",
    filename: "0037_project_verification_plans.sql",
  },
  {
    version: 38,
    name: "verification_runs",
    filename: "0038_verification_runs.sql",
  },
  {
    version: 39,
    name: "acceptance_verification_evidence",
    filename: "0039_acceptance_verification_evidence.sql",
  },
  {
    version: 40,
    name: "verification_failures",
    filename: "0040_verification_failures.sql",
  },
  {
    version: 41,
    name: "verification_output_retention",
    filename: "0041_verification_output_retention.sql",
  },
  {
    version: 42,
    name: "verification_correction_lineage",
    filename: "0042_verification_correction_lineage.sql",
  },
  {
    version: 43,
    name: "verification_correction_started_event",
    filename: "0043_verification_correction_started_event.sql",
  },
  {
    version: 44,
    name: "verification_correction_passed_event",
    filename: "0044_verification_correction_passed_event.sql",
  },
  {
    version: 45,
    name: "verification_correction_loop_events",
    filename: "0045_verification_correction_loop_events.sql",
  },
  {
    version: 46,
    name: "correction_budget_ledger",
    filename: "0046_correction_budget_ledger.sql",
  },
  {
    version: 47,
    name: "verification_qa_handoff",
    filename: "0047_verification_qa_handoff.sql",
  },
  {
    version: 48,
    name: "stale_verification_correction",
    filename: "0048_stale_verification_correction.sql",
  },
];

// `PRAGMA foreign_key_check` names the child table of each violation in its first column.
const foreignKeyViolationSchema = z.object({ table: z.string() });

const migrationRowSchema = z.object({
  version: z.number().int().positive(),
  name: z.string(),
  checksum: z.string().length(64),
});

const schemaMigrationsSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL
  ) STRICT;
`;

const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex");

export const loadMigrationSources = async (
  migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url)),
): Promise<readonly MigrationSource[]> =>
  Promise.all(
    migrations.map(async (migration) => {
      const sql = await readFile(join(migrationsDirectory, migration.filename), "utf8");
      return { ...migration, sql, checksum: checksum(sql) };
    }),
  );

const databaseHasMigrationTable = (database: DatabaseSync): boolean =>
  database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get() !== undefined;

const existingDatabaseIsNonEmpty = async (databasePath: string): Promise<boolean> => {
  if (databasePath === ":memory:") return false;
  try {
    return (await stat(databasePath)).size > 0;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const backupFilename = (now: Date): string =>
  `state-before-migration-${now.toISOString().replaceAll(":", "-")}.sqlite`;

/**
 * SQLite's step 12: after a table rebuild performed with foreign keys off, prove that no row is
 * left pointing at nothing -- while the transaction can still be rolled back.
 *
 * `PRAGMA foreign_key_check` answers with one row per violation and nothing at all when the
 * database is sound, so the assertion is on emptiness. The first violation is named in the message
 * because a rebuild that dropped rows names exactly which table stopped resolving.
 */
// `PRAGMA foreign_keys` answers as a one-row result whose single column is named after the pragma.
const foreignKeysRowSchema = z.object({ foreign_keys: z.number().int() });

/**
 * Whether this connection currently enforces foreign keys.
 *
 * Read rather than assumed. `openLocalState` turns the check on before any migration runs, so the
 * value here is on today -- but a rebuilding migration is the one place in the codebase that turns
 * it *off*, and restoring an assumption instead of the value found is exactly how such a place
 * silently starts lying when the assumption changes. A connection whose pragma cannot be read is
 * treated as enforcing, because that is the safe direction: the cost of turning it on when it was
 * off is a check that was not asked for, and the cost of the reverse is a database that stops
 * enforcing its own references with nothing saying so.
 */
const foreignKeysAreOn = (database: DatabaseSync): boolean => {
  try {
    return foreignKeysRowSchema.parse(database.prepare("PRAGMA foreign_keys").get()).foreign_keys !== 0;
  } catch {
    return true;
  }
};

const assertForeignKeysIntact = (database: DatabaseSync, version: number): void => {
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length === 0) return;
  const first = foreignKeyViolationSchema.parse(violations[0]);
  throw new StateStoreError(
    "MIGRATION_FAILED",
    `Migration ${version.toString()} left ${violations.length.toString()} foreign key violation(s), the first in ${first.table}`,
  );
};

export const applyMigrations = async (
  database: DatabaseSync,
  options: {
    databasePath: string;
    migrationsDirectory?: string;
    backupsDirectory?: string;
    now: () => Date;
    databaseWasNonEmpty: boolean;
  },
): Promise<StateStoreStartup> => {
  const hasMigrationTable = databaseHasMigrationTable(database);
  const appliedRows = hasMigrationTable
    ? migrationRowSchema
        .array()
        .parse(
          database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
        )
    : [];
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const migrationSources = await loadMigrationSources(options.migrationsDirectory);

  for (const migration of migrationSources) {
    const applied = appliedByVersion.get(migration.version);
    if (applied && (applied.name !== migration.name || applied.checksum !== migration.checksum)) {
      throw new StateStoreError(
        "MIGRATION_DRIFT",
        `Migration ${migration.version.toString()} no longer matches the applied checksum`,
      );
    }
  }

  const pending = migrationSources.filter((migration) => !appliedByVersion.has(migration.version));
  let backupPath: string | undefined;
  if (pending.length > 0 && options.databaseWasNonEmpty && options.databasePath !== ":memory:") {
    const backupsDirectory = options.backupsDirectory ?? join(dirname(options.databasePath), "backups");
    await mkdir(backupsDirectory, { recursive: true });
    backupPath = join(backupsDirectory, backupFilename(options.now()));
    await backup(database, backupPath);
  }

  if (!hasMigrationTable) database.exec(schemaMigrationsSql);
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );

  for (const migration of pending) {
    const rebuild = migration.rebuildsAReferencedTable === true;
    // Outside the transaction on purpose: `PRAGMA foreign_keys` is a no-op inside one.
    const foreignKeysWereOn = rebuild && foreignKeysAreOn(database);
    if (rebuild) database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        if (rebuild) assertForeignKeysIntact(database, migration.version);
        insertMigration.run(
          migration.version,
          migration.name,
          migration.checksum,
          options.now().toISOString(),
        );
        database.exec("COMMIT");
      } catch (error: unknown) {
        database.exec("ROLLBACK");
        throw error instanceof StateStoreError
          ? error
          : new StateStoreError(
              "MIGRATION_FAILED",
              `Migration ${migration.version.toString()} failed`,
              {},
              { cause: error },
            );
      }
    } finally {
      // Restored to the value this connection had, on both paths. A migration that threw still
      // leaves this connection to whoever catches, and a connection with foreign keys quietly off
      // is worse than the failure -- but "restored" has to mean the value found, not a hardcoded
      // ON: this is the one place that turns the check off, so it is the one place an unstated
      // assumption about the caller's setting would go unnoticed.
      if (rebuild) database.exec(`PRAGMA foreign_keys = ${foreignKeysWereOn ? "ON" : "OFF"}`);
    }
  }

  return {
    appliedMigrations: pending.map((migration) => migration.version),
    ...(backupPath === undefined ? {} : { backupPath }),
  };
};

export const databaseWasNonEmpty = existingDatabaseIsNonEmpty;
