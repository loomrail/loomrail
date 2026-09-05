import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LocalState, StateQuery, StateQueryResult } from "@loomrail/persistence-sqlite";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupExpiredVerificationOutputs } from "../src/verification-output-retention.js";

describe("daemon Project verification output retention", () => {
  let rootDirectory = "";
  let artifactsDirectory = "";

  beforeEach(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), "loomrail verification retention "));
    artifactsDirectory = join(rootDirectory, "artifacts");
    await mkdir(artifactsDirectory);
  });

  afterEach(async () => {
    await rm(rootDirectory, { recursive: true, force: true });
  });

  it("deletes an expired flat artifact, records the outcome, and does not select it again", async () => {
    const storageKey = "verification-output-expired.txt";
    const artifactPath = join(artifactsDirectory, storageKey);
    await writeFile(artifactPath, "expired output", { mode: 0o600 });

    let recorded = false;
    let selectedCutoff = "";
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      execute: (command) => {
        if (command.type !== "RECORD_VERIFICATION_OUTPUT_RETENTION") {
          throw new Error(`Unexpected command ${command.type}`);
        }
        expect(command.payload).toEqual({ artifactId: "verification-output-expired", outcome: "DELETED" });
        recorded = true;
        return {
          schemaVersion: 1,
          type: "VERIFICATION_OUTPUT_RETENTION_RECORDED",
          replayed: false,
          artifactId: command.payload.artifactId,
          outcome: command.payload.outcome,
          recordedAt: "2026-09-05T12:00:00.000Z",
        };
      },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type !== "LIST_EXPIRED_VERIFICATION_OUTPUTS") {
          throw new Error(`Unexpected query ${query.type}`);
        }
        selectedCutoff = query.closedBefore;
        return {
          type: "VERIFICATION_OUTPUTS",
          artifacts: recorded ? [] : [{ artifactId: "verification-output-expired", storageKey }],
        };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    await expect(
      cleanupExpiredVerificationOutputs({
        state,
        artifactsDirectory,
        now: new Date("2026-09-05T12:00:00.000Z"),
        logger: app.log,
      }),
    ).resolves.toEqual({ selected: 1, recorded: 1, skipped: 0 });
    expect(selectedCutoff).toBe("2026-08-06T12:00:00.000Z");
    await expect(access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      cleanupExpiredVerificationOutputs({
        state,
        artifactsDirectory,
        now: new Date("2026-09-05T12:00:00.000Z"),
        logger: app.log,
      }),
    ).resolves.toEqual({ selected: 0, recorded: 0, skipped: 0 });
    await app.close();
  });

  it("does not follow a forged storage key or symlink", async () => {
    const outsideDirectory = join(rootDirectory, "outside");
    const outsidePath = join(outsideDirectory, "must-survive-verification-retention.txt");
    await mkdir(outsideDirectory);
    await writeFile(outsidePath, "owner data");
    await symlink(
      outsideDirectory,
      join(artifactsDirectory, "verification-output-link.txt"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const candidates = [
      { artifactId: "verification-output-escape", storageKey: "../must-survive.txt" },
      { artifactId: "verification-output-link", storageKey: "verification-output-link.txt" },
    ];
    const state: LocalState = {
      startup: { appliedMigrations: [] },
      execute: () => {
        throw new Error("Unsafe output must not be recorded as deleted");
      },
      query: (query: StateQuery): StateQueryResult => {
        if (query.type !== "LIST_EXPIRED_VERIFICATION_OUTPUTS") {
          throw new Error(`Unexpected query ${query.type}`);
        }
        return { type: "VERIFICATION_OUTPUTS", artifacts: candidates };
      },
      close: () => undefined,
    };
    const app = Fastify({ logger: false });

    await expect(
      cleanupExpiredVerificationOutputs({
        state,
        artifactsDirectory,
        now: new Date("2026-09-05T12:00:00.000Z"),
        logger: app.log,
      }),
    ).resolves.toEqual({ selected: 2, recorded: 0, skipped: 2 });
    await expect(access(outsidePath)).resolves.toBeUndefined();
    await app.close();
  });
});
