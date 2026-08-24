import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

it("persists a transaction and reopens its backup from a portable path", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail sqlite "));
  const databasePath = join(temporaryDirectory, "состояние.sqlite");
  const backupPath = join(temporaryDirectory, "backup copy.sqlite");
  const database = new DatabaseSync(databasePath, {
    defensive: true,
    timeout: 5_000,
  });

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_id TEXT NOT NULL REFERENCES work_items(id)
      ) STRICT;
    `);

    const insertWorkItem = database.prepare("INSERT INTO work_items (id, version) VALUES (?, ?)");
    const insertEvent = database.prepare("INSERT INTO events (aggregate_id) VALUES (?)");

    database.exec("BEGIN IMMEDIATE");
    try {
      insertWorkItem.run("task-1", 1);
      insertEvent.run("task-1");
      database.exec("COMMIT");
    } catch (error: unknown) {
      database.exec("ROLLBACK");
      throw error;
    }

    await backup(database, backupPath);
  } finally {
    database.close();
  }

  const reopened = new DatabaseSync(backupPath, { readOnly: true });
  try {
    expect(reopened.prepare("SELECT id, version FROM work_items").get()).toEqual({
      id: "task-1",
      version: 1,
    });
    expect(reopened.prepare("SELECT sequence, aggregate_id FROM events").get()).toEqual({
      sequence: 1,
      aggregate_id: "task-1",
    });
  } finally {
    reopened.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
