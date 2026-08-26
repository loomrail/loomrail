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
];

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
  const migrationsDirectory =
    options.migrationsDirectory ?? fileURLToPath(new URL("../migrations", import.meta.url));
  const hasMigrationTable = databaseHasMigrationTable(database);
  const appliedRows = hasMigrationTable
    ? migrationRowSchema
        .array()
        .parse(
          database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
        )
    : [];
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const migrationSources = await Promise.all(
    migrations.map(async (migration) => {
      const sql = await readFile(join(migrationsDirectory, migration.filename), "utf8");
      return { ...migration, sql, checksum: checksum(sql) };
    }),
  );

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
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, migration.checksum, options.now().toISOString());
      database.exec("COMMIT");
    } catch (error: unknown) {
      database.exec("ROLLBACK");
      throw new StateStoreError(
        "MIGRATION_FAILED",
        `Migration ${migration.version.toString()} failed`,
        {},
        { cause: error },
      );
    }
  }

  return {
    appliedMigrations: pending.map((migration) => migration.version),
    ...(backupPath === undefined ? {} : { backupPath }),
  };
};

export const databaseWasNonEmpty = existingDatabaseIsNonEmpty;
