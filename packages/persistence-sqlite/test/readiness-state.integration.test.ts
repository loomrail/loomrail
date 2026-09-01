import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectReadinessSnapshotSchema,
  type ReadinessCheckDraft,
  type RegisterProjectCommand,
} from "@loomrail/contracts";
import { ReadinessDomainError } from "@loomrail/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

const now = "2026-08-31T00:10:00.000Z";
const digest = "b".repeat(64);

type CheckCatalogEntry = readonly [
  ReadinessCheckDraft["key"],
  ReadinessCheckDraft["category"],
  ReadinessCheckDraft["mode"],
];

const checkCatalog: readonly CheckCatalogEntry[] = [
  ["SECURITY_ACTIVE_CONSTITUTION", "SECURITY", "AUTOMATED"],
  ["SECURITY_SECRET_PATHS", "SECURITY", "AUTOMATED"],
  ["SECURITY_ENV_IGNORED", "SECURITY", "AUTOMATED"],
  ["SECURITY_CI_HARDENING", "SECURITY", "AUTOMATED"],
  ["LEGAL_LICENSE", "LEGAL", "AUTOMATED"],
  ["LEGAL_OWNER_REVIEW", "LEGAL", "OWNER"],
  ["PAYMENTS_OWNER_REVIEW", "PAYMENTS", "OWNER"],
  ["ANALYTICS_OWNER_REVIEW", "ANALYTICS", "OWNER"],
];

const checks: readonly ReadinessCheckDraft[] = checkCatalog.map(([key, category, mode]) => ({
  key,
  category,
  mode,
  status: mode === "OWNER" ? "ACTION_REQUIRED" : "PASSED",
  summary: `${key} summary`,
  findings: [],
}));

describe("Project Readiness local state", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail readiness state "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(now),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    return state;
  };

  const register = (): RegisterProjectCommand => ({
    schemaVersion: 1,
    commandId: "register-project",
    correlationId: "correlation-register",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "REGISTER_PROJECT",
    payload: {
      id: "project-one",
      fixtureId: null,
      name: "Project one",
      repositoryPath: join(directory, "project-one"),
    },
  });

  const assess = (commandId = "assess-readiness") => ({
    schemaVersion: 1 as const,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN" as const, id: "local-owner" },
    type: "RECORD_PROJECT_READINESS_ASSESSMENT" as const,
    payload: {
      projectId: "project-one",
      expectedProjectVersion: 1,
      repositoryHead: "a".repeat(40),
      sourceDigest: digest,
      workingTreeDirty: false,
      checks: [...checks],
    },
  });

  it("persists a complete assessment atomically and replays the same command", async () => {
    const localState = await open();
    localState.execute(register());
    const assessed = localState.execute(assess());
    const replayed = localState.execute(assess());

    expect(assessed).toMatchObject({
      type: "PROJECT_READINESS_ASSESSED",
      run: { status: "ACTION_REQUIRED", version: 1 },
    });
    expect(assessed.type === "PROJECT_READINESS_ASSESSED" ? assessed.checks : []).toHaveLength(8);
    expect(replayed).toMatchObject({ type: "PROJECT_READINESS_ASSESSED", replayed: true });
    const snapshot = localState.query({ type: "GET_PROJECT_READINESS_SNAPSHOT", projectId: "project-one" });
    if (snapshot.type !== "PROJECT_READINESS_SNAPSHOT") {
      throw new Error("Readiness snapshot was not persisted");
    }
    const persistedSnapshot = projectReadinessSnapshotSchema.parse(snapshot.snapshot);
    expect(persistedSnapshot.run).toMatchObject({
      status: "ACTION_REQUIRED",
      repositoryHead: "a".repeat(40),
    });
    expect(
      persistedSnapshot.checks.some(
        (check) => check.key === "LEGAL_OWNER_REVIEW" && check.status === "ACTION_REQUIRED",
      ),
    ).toBe(true);
    expect(persistedSnapshot.attestations).toEqual([]);
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events.map((event) => event.type) : []).toEqual([
      "PROJECT_REGISTERED",
      "PROJECT_READINESS_ASSESSED",
    ]);
  });

  it("attests owner checks with optimistic versions and reaches READY after reopen", async () => {
    const localState = await open();
    localState.execute(register());
    const assessed = localState.execute(assess());
    if (assessed.type !== "PROJECT_READINESS_ASSESSED") throw new Error("Assessment was not recorded");

    let run = assessed.run;
    for (const key of ["LEGAL_OWNER_REVIEW", "PAYMENTS_OWNER_REVIEW", "ANALYTICS_OWNER_REVIEW"] as const) {
      const check = assessed.checks.find((candidate) => candidate.key === key);
      if (!check) throw new Error(`Missing ${key}`);
      const result = localState.execute({
        schemaVersion: 1,
        commandId: `attest-${key}`,
        correlationId: `correlation-${key}`,
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ATTEST_PROJECT_READINESS_CHECK",
        payload: {
          projectId: "project-one",
          runId: run.id,
          checkId: check.id,
          expectedRunVersion: run.version,
          outcome: key === "LEGAL_OWNER_REVIEW" ? "CONFIRMED" : "NOT_APPLICABLE",
          rationale: `Owner reviewed ${key}`,
        },
      });
      if (result.type !== "PROJECT_READINESS_ATTESTED") throw new Error("Attestation was not recorded");
      run = result.run;
    }
    expect(run).toMatchObject({ status: "READY", version: 4 });
    localState.close();
    state = undefined;

    const reopened = await open();
    const snapshot = reopened.query({ type: "GET_PROJECT_READINESS_SNAPSHOT", projectId: "project-one" });
    if (snapshot.type !== "PROJECT_READINESS_SNAPSHOT") {
      throw new Error("Readiness snapshot was not recovered");
    }
    const recoveredSnapshot = projectReadinessSnapshotSchema.parse(snapshot.snapshot);
    expect(recoveredSnapshot.run).toMatchObject({ status: "READY", version: 4 });
    expect(
      recoveredSnapshot.attestations.some(
        (attestation) =>
          attestation.outcome === "CONFIRMED" &&
          attestation.rationale === "Owner reviewed LEGAL_OWNER_REVIEW",
      ),
    ).toBe(true);
    expect(
      recoveredSnapshot.attestations.some(
        (attestation) =>
          attestation.outcome === "NOT_APPLICABLE" &&
          attestation.rationale === "Owner reviewed PAYMENTS_OWNER_REVIEW",
      ),
    ).toBe(true);
  });

  it("rejects automated, stale, and superseded-run attestations", async () => {
    const localState = await open();
    localState.execute(register());
    const first = localState.execute(assess());
    if (first.type !== "PROJECT_READINESS_ASSESSED") throw new Error("Assessment was not recorded");
    const automated = first.checks.find((check) => check.mode === "AUTOMATED");
    const owner = first.checks.find((check) => check.mode === "OWNER");
    if (!automated || !owner) throw new Error("Assessment catalog is incomplete");

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "attest-automated",
        correlationId: "correlation-automated",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ATTEST_PROJECT_READINESS_CHECK",
        payload: {
          projectId: "project-one",
          runId: first.run.id,
          checkId: automated.id,
          expectedRunVersion: first.run.version,
          outcome: "CONFIRMED",
          rationale: "Should be refused",
        },
      }),
    ).toThrow(ReadinessDomainError);

    localState.execute(assess("assess-again"));
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "attest-old-run",
        correlationId: "correlation-old-run",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "ATTEST_PROJECT_READINESS_CHECK",
        payload: {
          projectId: "project-one",
          runId: first.run.id,
          checkId: owner.id,
          expectedRunVersion: first.run.version,
          outcome: "CONFIRMED",
          rationale: "The old snapshot must remain historical",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "READINESS_RUN_NOT_LATEST" }));
  });

  // An owner check is the owner's own judgement about licences, payments and data handling, and
  // confirming the last one is what turns a Run READY. The rule that only the owner may make it
  // belongs to the deterministic decision, not to whichever caller reaches it.
  it("refuses an owner attestation that does not come from the owner", async () => {
    const localState = await open();
    localState.execute(register());
    const first = localState.execute(assess());
    if (first.type !== "PROJECT_READINESS_ASSESSED") throw new Error("Assessment was not recorded");
    const owner = first.checks.find((check) => check.mode === "OWNER");
    if (!owner) throw new Error("Assessment catalog is incomplete");

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "attest-as-system",
        correlationId: "correlation-system",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "ATTEST_PROJECT_READINESS_CHECK",
        payload: {
          projectId: "project-one",
          runId: first.run.id,
          checkId: owner.id,
          expectedRunVersion: first.run.version,
          outcome: "CONFIRMED",
          rationale: "A system actor must never confirm an owner review",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "OWNER_REQUIRED" }));
  });
});
