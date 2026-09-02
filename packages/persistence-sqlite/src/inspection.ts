import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { loadMigrationSources } from "./migrations.js";

export type StateDatabaseInspectionStatus =
  | "MISSING"
  | "UNINITIALIZED"
  | "READY"
  | "UPGRADE_REQUIRED"
  | "CORRUPT"
  | "MIGRATION_DRIFT"
  | "INCOMPATIBLE"
  | "UNAVAILABLE";

export type StateDatabaseInspection = {
  status: StateDatabaseInspectionStatus;
  appliedMigrations: number;
  expectedMigrations: number;
};

const quickCheckRowSchema = z.object({ quick_check: z.string() });
const countRowSchema = z.object({ count: z.number().int().nonnegative() });
const migrationRowSchema = z.object({
  version: z.number().int().positive(),
  name: z.string(),
  checksum: z.string(),
});

const missingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Inspects the durable state without creating a database, applying migrations or running recovery.
 * Raw filesystem and SQLite failures deliberately collapse into a closed result so diagnostics do
 * not become a path or exception-message export surface.
 */
export const inspectStateDatabase = async (
  databasePath: string,
  options: { migrationsDirectory?: string } = {},
): Promise<StateDatabaseInspection> => {
  let expectedMigrations = 0;
  try {
    const metadata = await stat(databasePath);
    if (!metadata.isFile()) {
      return { status: "UNAVAILABLE", appliedMigrations: 0, expectedMigrations };
    }
  } catch (error: unknown) {
    return {
      status: missingFile(error) ? "MISSING" : "UNAVAILABLE",
      appliedMigrations: 0,
      expectedMigrations,
    };
  }

  let database: DatabaseSync | undefined;
  try {
    const expected = await loadMigrationSources(options.migrationsDirectory);
    expectedMigrations = expected.length;
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1_000 });

    const quickCheck = quickCheckRowSchema.array().parse(database.prepare("PRAGMA quick_check").all());
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      return { status: "CORRUPT", appliedMigrations: 0, expectedMigrations };
    }

    const hasMigrationTable =
      database
        .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
        .get() !== undefined;
    if (!hasMigrationTable) {
      const userTables = countRowSchema.parse(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get(),
      ).count;
      return {
        status: userTables === 0 ? "UNINITIALIZED" : "INCOMPATIBLE",
        appliedMigrations: 0,
        expectedMigrations,
      };
    }

    const applied = migrationRowSchema
      .array()
      .parse(
        database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
      );
    const expectedByVersion = new Map(expected.map((migration) => [migration.version, migration]));
    if (applied.some((migration) => !expectedByVersion.has(migration.version))) {
      return {
        status: "INCOMPATIBLE",
        appliedMigrations: applied.length,
        expectedMigrations,
      };
    }
    if (
      applied.some((migration) => {
        const current = expectedByVersion.get(migration.version);
        if (current === undefined) return true;
        return current.name !== migration.name || current.checksum !== migration.checksum;
      })
    ) {
      return {
        status: "MIGRATION_DRIFT",
        appliedMigrations: applied.length,
        expectedMigrations,
      };
    }

    const appliedVersions = new Set(applied.map((migration) => migration.version));
    const missing = expected.filter((migration) => !appliedVersions.has(migration.version));
    const firstMissing = missing[0]?.version;
    if (firstMissing !== undefined && applied.some((migration) => migration.version > firstMissing)) {
      return {
        status: "MIGRATION_DRIFT",
        appliedMigrations: applied.length,
        expectedMigrations,
      };
    }
    return {
      status: missing.length === 0 ? "READY" : "UPGRADE_REQUIRED",
      appliedMigrations: applied.length,
      expectedMigrations,
    };
  } catch {
    return {
      status: database === undefined ? "UNAVAILABLE" : "CORRUPT",
      appliedMigrations: 0,
      expectedMigrations,
    };
  } finally {
    database?.close();
  }
};
