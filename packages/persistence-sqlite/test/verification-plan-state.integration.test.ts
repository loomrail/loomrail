import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdoptVerificationPlanCommand, VerificationPlanProposal } from "@loomrail/contracts";
import { VerificationDomainError } from "@loomrail/domain";
import { verificationPlanProposalHash } from "@loomrail/project-readiness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

const now = "2026-09-05T09:00:00.000Z";
const proposalContent: Omit<VerificationPlanProposal, "proposalHash"> = {
  schemaVersion: 1,
  projectId: "project-one",
  target: { state: "ABSENT", digest: null },
  recipes: [
    {
      schemaVersion: 1,
      id: "package-test",
      kind: "UNIT",
      label: "Tests",
      required: true,
      executable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "a".repeat(64),
        scriptName: "test",
        scriptBodyPreview: "vitest run",
      },
    },
  ],
  warnings: [],
};
const proposal: VerificationPlanProposal = {
  ...proposalContent,
  proposalHash: verificationPlanProposalHash(proposalContent),
};

describe("Project verification plan local state", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail verification state "));
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

  const register = (localState: LocalState): void => {
    localState.execute({
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
  };

  const adopt = (expectedProjectVersion = 1): AdoptVerificationPlanCommand => ({
    schemaVersion: 1,
    commandId: "adopt-verification-plan",
    correlationId: "correlation-adopt-verification-plan",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "ADOPT_VERIFICATION_PLAN",
    payload: { projectId: "project-one", expectedProjectVersion, proposal },
  });

  it("atomically stores plan, Project version, Event, publication follow-up, and replay receipt", async () => {
    const localState = await open();
    register(localState);

    const adopted = localState.execute(adopt());
    const replayed = localState.execute(adopt());

    expect(adopted).toMatchObject({
      type: "VERIFICATION_PLAN_ADOPTED",
      plan: { projectId: "project-one", revision: 1, status: "ACTIVE" },
      publication: { status: "PENDING", attempts: 0, expectedTargetDigest: null },
    });
    expect(replayed).toMatchObject({ type: "VERIFICATION_PLAN_ADOPTED", replayed: true });
    const project = localState.query({ type: "GET_PROJECT", projectId: "project-one" });
    expect(project.type === "PROJECT" ? project.project : null).toMatchObject({ version: 2 });
    const snapshot = localState.query({ type: "GET_PROJECT_VERIFICATION_PLAN", projectId: "project-one" });
    expect(snapshot.type === "PROJECT_VERIFICATION_PLAN" ? snapshot : null).toMatchObject({
      plan: { revision: 1 },
      publication: { status: "PENDING" },
    });
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events.map((event) => event.type) : []).toEqual([
      "PROJECT_REGISTERED",
      "VERIFICATION_PLAN_ADOPTED",
    ]);
  });

  it("recovers the publication follow-up across restart without creating a second plan", async () => {
    const first = await open();
    register(first);
    first.execute(adopt());
    first.close();
    state = undefined;

    const reopened = await open();
    const pending = reopened.query({ type: "LIST_PENDING_VERIFICATION_PLAN_PUBLICATIONS" });
    const publications = pending.type === "VERIFICATION_PLAN_PUBLICATIONS" ? pending.publications : [];
    expect(publications).toHaveLength(1);
    expect(publications[0]?.plan.revision).toBe(1);
    const publication = publications[0]?.publication;
    if (publication === undefined) throw new Error("Pending publication was not recovered");
    const applied = reopened.execute({
      schemaVersion: 1,
      commandId: "complete-verification-publication",
      correlationId: "correlation-complete-verification-publication",
      actor: { type: "SYSTEM", id: "verification-publisher" },
      type: "COMPLETE_VERIFICATION_PLAN_PUBLICATION",
      payload: { publicationId: publication.id, expectedVersion: publication.version },
    });
    expect(applied).toMatchObject({
      type: "VERIFICATION_PLAN_PUBLICATION_APPLIED",
      publication: { status: "APPLIED", attempts: 1 },
    });
    expect(
      reopened.execute({
        schemaVersion: 1,
        commandId: "complete-verification-publication",
        correlationId: "correlation-complete-verification-publication",
        actor: { type: "SYSTEM", id: "verification-publisher" },
        type: "COMPLETE_VERIFICATION_PLAN_PUBLICATION",
        payload: { publicationId: publication.id, expectedVersion: publication.version },
      }),
    ).toMatchObject({ replayed: true, type: "VERIFICATION_PLAN_PUBLICATION_APPLIED" });
  });

  it("persists a typed failure and only an explicit owner retry returns it to pending", async () => {
    const localState = await open();
    register(localState);
    const adopted = localState.execute(adopt());
    if (adopted.type !== "VERIFICATION_PLAN_ADOPTED") throw new Error("Plan was not adopted");
    const failed = localState.execute({
      schemaVersion: 1,
      commandId: "fail-verification-publication",
      correlationId: "correlation-fail-verification-publication",
      actor: { type: "SYSTEM", id: "verification-publisher" },
      type: "FAIL_VERIFICATION_PLAN_PUBLICATION",
      payload: {
        publicationId: adopted.publication.id,
        expectedVersion: adopted.publication.version,
        errorCode: "TARGET_CHANGED",
      },
    });
    if (failed.type !== "VERIFICATION_PLAN_PUBLICATION_FAILED") {
      throw new Error("Publication failure was not stored");
    }
    expect(failed.publication).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "TARGET_CHANGED",
    });

    const retried = localState.execute({
      schemaVersion: 1,
      commandId: "retry-verification-publication",
      correlationId: "correlation-retry-verification-publication",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RETRY_VERIFICATION_PLAN_PUBLICATION",
      payload: {
        projectId: "project-one",
        publicationId: failed.publication.id,
        expectedVersion: failed.publication.version,
      },
    });
    expect(retried).toMatchObject({
      type: "VERIFICATION_PLAN_PUBLICATION_RETRIED",
      publication: { status: "PENDING", attempts: 1, lastErrorCode: null },
    });
  });

  it("rolls back a stale Project version without plan, publication, Event, or receipt", async () => {
    const localState = await open();
    register(localState);

    expect(() => localState.execute(adopt(9))).toThrow(VerificationDomainError);
    expect(
      localState.query({ type: "GET_PROJECT_VERIFICATION_PLAN", projectId: "project-one" }),
    ).toMatchObject({ type: "PROJECT_VERIFICATION_PLAN", plan: null, publication: null });
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events.map((event) => event.type) : []).toEqual([
      "PROJECT_REGISTERED",
    ]);
  });
});
