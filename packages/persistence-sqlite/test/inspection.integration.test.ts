import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectStateDatabase, openLocalState } from "../src/index.js";

describe("read-only state database inspection", () => {
  let directory = "";
  let databasePath = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail state inspection "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const createCurrentDatabase = async (): Promise<void> => {
    const state = await openLocalState({ databasePath });
    state.close();
  };

  it("does not create missing or uninitialized state", async () => {
    await expect(inspectStateDatabase(databasePath)).resolves.toEqual({
      status: "MISSING",
      appliedMigrations: 0,
      expectedMigrations: 0,
    });
    const empty = new DatabaseSync(databasePath);
    empty.close();
    const before = await readFile(databasePath);

    const inspection = await inspectStateDatabase(databasePath);

    expect(inspection.status).toBe("UNINITIALIZED");
    expect(inspection.expectedMigrations).toBeGreaterThan(0);
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("accepts the current migration ledger without changing database bytes", async () => {
    await createCurrentDatabase();
    const before = await readFile(databasePath);

    const inspection = await inspectStateDatabase(databasePath);

    expect(inspection).toEqual({
      status: "READY",
      appliedMigrations: inspection.expectedMigrations,
      expectedMigrations: inspection.expectedMigrations,
    });
    expect(inspection.expectedMigrations).toBeGreaterThan(0);
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("distinguishes pending, drifted, and future migration ledgers", async () => {
    await createCurrentDatabase();
    const database = new DatabaseSync(databasePath);
    const latest = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latest.version);
    database.close();
    await expect(inspectStateDatabase(databasePath)).resolves.toMatchObject({
      status: "UPGRADE_REQUIRED",
    });

    const drifted = new DatabaseSync(databasePath);
    drifted.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("a".repeat(64));
    drifted.close();
    await expect(inspectStateDatabase(databasePath)).resolves.toMatchObject({
      status: "MIGRATION_DRIFT",
    });

    const future = new DatabaseSync(databasePath);
    future
      .prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
      .run(999, "future", "b".repeat(64), "2026-09-02T00:00:00.000Z");
    future.close();
    await expect(inspectStateDatabase(databasePath)).resolves.toMatchObject({
      status: "INCOMPATIBLE",
    });
  });

  it("fails closed for corrupt and non-file paths", async () => {
    await writeFile(databasePath, "not a sqlite database", "utf8");
    await expect(inspectStateDatabase(databasePath)).resolves.toMatchObject({ status: "CORRUPT" });
    await expect(inspectStateDatabase(directory)).resolves.toEqual({
      status: "UNAVAILABLE",
      appliedMigrations: 0,
      expectedMigrations: 0,
    });
  });

  it("does not mistake an unrelated valid SQLite database for empty Loomrail state", async () => {
    const unrelated = new DatabaseSync(databasePath);
    unrelated.exec("CREATE TABLE unrelated_data (value TEXT NOT NULL) STRICT");
    unrelated.close();

    await expect(inspectStateDatabase(databasePath)).resolves.toMatchObject({
      status: "INCOMPATIBLE",
    });
  });
});
