import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ConstitutionSection,
  ProposeProjectConstitutionCommand,
  RegisterProjectCommand,
} from "@loomrail/contracts";
import { ConstitutionDomainError } from "@loomrail/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

const now = "2026-08-30T10:00:00.000Z";
const digest = "a".repeat(64);
const sectionKeys: readonly ConstitutionSection["key"][] = [
  "PRODUCT_CONTEXT",
  "ARCHITECTURE",
  "CODE_STANDARDS",
  "AGENT_POLICIES",
  "DEFINITION_OF_DONE",
  "ROLE_PLAYBOOKS",
  "LEARNED_CONVENTIONS",
];

const sections: ConstitutionSection[] = sectionKeys.map((key) => ({
  key,
  title: key,
  body: `Rules for ${key}`,
  sources: [{ kind: "PRESET", reference: "repository-baseline@1", label: "Trusted preset" }],
}));

describe("Project Constitution local state", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail constitution state "));
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

  const propose = (
    commandId = "propose-constitution",
    target: ProposeProjectConstitutionCommand["payload"]["scan"]["targetConstitution"] = {
      state: "ABSENT",
      digest: null,
    },
  ): ProposeProjectConstitutionCommand => ({
    schemaVersion: 1,
    commandId,
    correlationId: `correlation-${commandId}`,
    actor: { type: "HUMAN", id: "local-owner" },
    type: "PROPOSE_PROJECT_CONSTITUTION",
    payload: {
      projectId: "project-one",
      expectedProjectVersion: 1,
      presetId: "repository-baseline",
      recommendedPresetId: "repository-baseline",
      scan: {
        schemaVersion: 1,
        sourceDigest: digest,
        targetConstitution: target,
        files: [],
        warnings: [],
        packageManager: "UNKNOWN",
        languages: [],
        workspace: false,
        verificationCommands: [],
        instructionPaths: [],
        architecturePaths: [],
        ciPaths: [],
        configPaths: [],
      },
      sections,
      renderedMarkdown: "# Project Constitution\n",
      contentDigest: digest,
    },
  });

  it("persists proposal, Event, publication follow-up and command replay atomically", async () => {
    const localState = await open();
    localState.execute(register());
    const proposed = localState.execute(propose());
    const replayed = localState.execute(propose());
    if (proposed.type !== "PROJECT_CONSTITUTION_PROPOSED") throw new Error("Proposal was not created");

    expect(replayed).toMatchObject({ type: "PROJECT_CONSTITUTION_PROPOSED", replayed: true });
    const requested = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-constitution",
      correlationId: "correlation-adopt",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REQUEST_PROJECT_CONSTITUTION_ADOPTION",
      payload: {
        projectId: "project-one",
        proposalId: proposed.proposal.id,
        expectedProjectVersion: 1,
        expectedProposalVersion: proposed.proposal.version,
      },
    });

    expect(requested).toMatchObject({
      type: "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED",
      publication: { status: "PENDING", attempts: 0 },
      constitution: { status: "PUBLISHING", ordinal: 1 },
    });
    const pending = localState.query({ type: "LIST_PENDING_CONSTITUTION_PUBLICATIONS" });
    expect(pending.type === "CONSTITUTION_PUBLICATIONS" ? pending.publications : []).toHaveLength(1);
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events.map((event) => event.type) : []).toEqual([
      "PROJECT_REGISTERED",
      "PROJECT_CONSTITUTION_PROPOSED",
      "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED",
    ]);
  });

  it("recovers a pending publication after reopen and activates it exactly once", async () => {
    const localState = await open();
    localState.execute(register());
    const proposed = localState.execute(propose());
    if (proposed.type !== "PROJECT_CONSTITUTION_PROPOSED") throw new Error("Proposal was not created");
    const requested = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-constitution",
      correlationId: "correlation-adopt",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REQUEST_PROJECT_CONSTITUTION_ADOPTION",
      payload: {
        projectId: "project-one",
        proposalId: proposed.proposal.id,
        expectedProjectVersion: 1,
        expectedProposalVersion: 1,
      },
    });
    if (requested.type !== "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED") {
      throw new Error("Publication was not requested");
    }
    localState.close();
    state = undefined;

    const reopened = await open();
    const pending = reopened.query({ type: "LIST_PENDING_CONSTITUTION_PUBLICATIONS" });
    expect(pending.type === "CONSTITUTION_PUBLICATIONS" ? pending.publications : []).toHaveLength(1);
    const completed = reopened.execute({
      schemaVersion: 1,
      commandId: "complete-publication",
      correlationId: "correlation-complete",
      actor: { type: "SYSTEM", id: "constitution-publisher" },
      type: "COMPLETE_PROJECT_CONSTITUTION_PUBLICATION",
      payload: { publicationId: requested.publication.id, expectedVersion: requested.publication.version },
    });

    expect(completed).toMatchObject({
      type: "PROJECT_CONSTITUTION_ACTIVATED",
      proposal: { status: "ADOPTED" },
      constitution: { status: "ACTIVE" },
      publication: { status: "APPLIED", attempts: 1 },
    });
    const snapshot = reopened.query({
      type: "GET_PROJECT_CONSTITUTION_SNAPSHOT",
      projectId: "project-one",
    });
    expect(snapshot.type === "PROJECT_CONSTITUTION_SNAPSHOT" ? snapshot.snapshot : null).toMatchObject({
      activeConstitution: { status: "ACTIVE", ordinal: 1 },
      pendingConstitution: null,
      publication: { status: "APPLIED" },
    });
    expect(
      reopened.execute({
        schemaVersion: 1,
        commandId: "complete-publication",
        correlationId: "correlation-complete",
        actor: { type: "SYSTEM", id: "constitution-publisher" },
        type: "COMPLETE_PROJECT_CONSTITUTION_PUBLICATION",
        payload: { publicationId: requested.publication.id, expectedVersion: requested.publication.version },
      }),
    ).toMatchObject({ replayed: true, type: "PROJECT_CONSTITUTION_ACTIVATED" });
  });

  it("records a failed publication, rejects stale transitions, and permits an explicit retry", async () => {
    const localState = await open();
    localState.execute(register());
    const proposed = localState.execute(propose());
    if (proposed.type !== "PROJECT_CONSTITUTION_PROPOSED") throw new Error("Proposal was not created");
    const requested = localState.execute({
      schemaVersion: 1,
      commandId: "adopt-constitution",
      correlationId: "correlation-adopt",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REQUEST_PROJECT_CONSTITUTION_ADOPTION",
      payload: {
        projectId: "project-one",
        proposalId: proposed.proposal.id,
        expectedProjectVersion: 1,
        expectedProposalVersion: 1,
      },
    });
    if (requested.type !== "PROJECT_CONSTITUTION_PUBLICATION_REQUESTED") {
      throw new Error("Publication was not requested");
    }
    const failed = localState.execute({
      schemaVersion: 1,
      commandId: "fail-publication",
      correlationId: "correlation-fail",
      actor: { type: "SYSTEM", id: "constitution-publisher" },
      type: "FAIL_PROJECT_CONSTITUTION_PUBLICATION",
      payload: {
        publicationId: requested.publication.id,
        expectedVersion: requested.publication.version,
        errorCode: "CONSTITUTION_TARGET_CHANGED",
      },
    });
    if (failed.type !== "PROJECT_CONSTITUTION_PUBLICATION_FAILED") {
      throw new Error("Publication failure was not recorded");
    }
    expect(failed).toMatchObject({
      publication: { status: "FAILED", attempts: 1 },
      constitution: { status: "FAILED" },
    });

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "stale-retry",
        correlationId: "correlation-stale-retry",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "RETRY_PROJECT_CONSTITUTION_PUBLICATION",
        payload: {
          projectId: "project-one",
          publicationId: failed.publication.id,
          expectedVersion: 1,
        },
      }),
    ).toThrow(ConstitutionDomainError);

    const retried = localState.execute({
      schemaVersion: 1,
      commandId: "retry-publication",
      correlationId: "correlation-retry",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "RETRY_PROJECT_CONSTITUTION_PUBLICATION",
      payload: {
        projectId: "project-one",
        publicationId: failed.publication.id,
        expectedVersion: failed.publication.version,
      },
    });
    expect(retried).toMatchObject({
      type: "PROJECT_CONSTITUTION_PUBLICATION_RETRIED",
      publication: { status: "PENDING", attempts: 1 },
      constitution: { status: "PUBLISHING" },
    });
  });

  it("refuses adoption when the target was not safely reviewable", async () => {
    const localState = await open();
    localState.execute(register());
    const proposed = localState.execute(propose("blocked-proposal", { state: "BLOCKED", digest: null }));
    if (proposed.type !== "PROJECT_CONSTITUTION_PROPOSED") throw new Error("Proposal was not created");

    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "blocked-adoption",
        correlationId: "correlation-blocked",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REQUEST_PROJECT_CONSTITUTION_ADOPTION",
        payload: {
          projectId: "project-one",
          proposalId: proposed.proposal.id,
          expectedProjectVersion: 1,
          expectedProposalVersion: 1,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "CONSTITUTION_TARGET_BLOCKED" }));
    const snapshot = localState.query({
      type: "GET_PROJECT_CONSTITUTION_SNAPSHOT",
      projectId: "project-one",
    });
    expect(snapshot.type === "PROJECT_CONSTITUTION_SNAPSHOT" ? snapshot.snapshot : null).toMatchObject({
      activeConstitution: null,
      pendingConstitution: null,
      latestProposal: { status: "PROPOSED" },
    });
  });
});
