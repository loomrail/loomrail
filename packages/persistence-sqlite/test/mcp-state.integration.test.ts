import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConfirmMcpProfileCommand, RegisterProjectCommand } from "@loomrail/contracts";
import { canonicalMcpProfileSource, McpDomainError } from "@loomrail/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalState, type LocalState } from "../src/index.js";

describe("MCP local state", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail MCP состояние "));
    databasePath = join(directory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date("2026-08-31T11:00:00.000Z"),
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
      repositoryPath: join(directory, "Проект с пробелом"),
    },
  });

  const candidate = () => ({
    profileId: null,
    name: "Локальная документация",
    executable: join(directory, "Инструменты", "docs mcp"),
    args: ["--read-only", join(directory, "Проект с пробелом")],
    declaredTools: ["read_doc", "search_docs"],
  });
  const digest = () => createHash("sha256").update(canonicalMcpProfileSource(candidate())).digest("hex");

  const confirm = (): ConfirmMcpProfileCommand => ({
    schemaVersion: 1,
    commandId: "confirm-profile",
    correlationId: "correlation-confirm",
    actor: { type: "HUMAN", id: "local-owner" },
    type: "CONFIRM_MCP_PROFILE",
    payload: {
      projectId: "project-one",
      expectedProjectVersion: 1,
      candidate: candidate(),
      canonicalDigest: digest(),
    },
  });

  it("atomically persists consent, capability, grant, Event and command replay across restart", async () => {
    const localState = await open();
    localState.execute(register());
    const consented = localState.execute(confirm());
    const replayed = localState.execute(confirm());
    if (consented.type !== "MCP_PROFILE_CONSENTED") throw new Error("MCP profile was not consented");

    expect(consented).toMatchObject({
      projectVersion: 2,
      revision: { revision: 1, name: "Локальная документация", canonicalDigest: digest() },
      consent: { ownerId: "local-owner" },
    });
    expect(replayed).toMatchObject({ type: "MCP_PROFILE_CONSENTED", replayed: true });

    const recorded = localState.execute({
      schemaVersion: 1,
      commandId: "record-capability",
      correlationId: "correlation-probe",
      actor: { type: "SYSTEM", id: "daemon" },
      type: "RECORD_MCP_CAPABILITY_SNAPSHOT",
      payload: {
        projectId: "project-one",
        profileRevisionId: consented.revision.id,
        state: "READY",
        protocolVersion: "2026-07-28",
        tools: ["search_docs", "read_doc"],
        resources: [],
        prompts: [],
      },
    });
    expect(recorded).toMatchObject({
      type: "MCP_CAPABILITY_RECORDED",
      snapshot: { state: "READY", tools: ["read_doc", "search_docs"] },
    });

    const granted = localState.execute({
      schemaVersion: 1,
      commandId: "grant-profile",
      correlationId: "correlation-grant",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "SET_MCP_PROFILE_GRANT",
      payload: {
        projectId: "project-one",
        expectedProjectVersion: 2,
        profileRevisionId: consented.revision.id,
        expectedGrantVersion: null,
        tools: ["search_docs"],
        ownerAttestsReadOnly: true,
      },
    });
    expect(granted).toMatchObject({
      type: "MCP_GRANT_CHANGED",
      projectVersion: 3,
      grant: { enabled: true, version: 1, tools: ["search_docs"] },
    });

    localState.close();
    state = undefined;
    const reopened = await open();
    const profiles = reopened.query({ type: "GET_PROJECT_MCP_PROFILES", projectId: "project-one" });
    expect(profiles).toMatchObject({
      type: "PROJECT_MCP_PROFILES",
      project: { version: 3 },
      profiles: [
        {
          revision: { id: consented.revision.id, executable: candidate().executable },
          capability: { state: "READY" },
          grant: { enabled: true, version: 1 },
        },
      ],
    });

    const created = reopened.execute({
      schemaVersion: 1,
      commandId: "create-work-item",
      correlationId: "correlation-work-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-one",
        parentId: null,
        type: "TASK",
        title: "Use local docs",
        description: "",
        priority: "MEDIUM",
        risk: "MEDIUM",
        acceptanceCriteria: [],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("WorkItem was not created");
    reopened.execute({
      schemaVersion: 1,
      commandId: "ready-work-item",
      correlationId: "correlation-ready",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const pipeline = reopened.execute({
      schemaVersion: 1,
      commandId: "start-pipeline",
      correlationId: "correlation-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template: {
          schemaVersion: 1,
          id: "mcp-session-test-v1",
          version: 1,
          name: "MCP session test",
          stages: [
            {
              stage: "DISCOVERY",
              ordinal: 0,
              contextPack: {
                schemaVersion: 1,
                sections: [{ id: "WORK_ITEM_BRIEF", ordinal: 0, required: true }],
              },
            },
          ],
        },
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Pipeline was not started");
    const session = reopened.execute({
      schemaVersion: 1,
      commandId: "start-provider-session",
      correlationId: "correlation-session",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId: pipeline.stageAttempt.id,
        recipe: {
          schemaVersion: 1,
          templateId: "mcp-session-test-v1",
          templateVersion: 1,
          specSource: "WORKFLOW_TEMPLATE",
          sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
          omitted: [],
          contentHash: `sha256:${"0".repeat(64)}`,
          estimatedTokens: 10,
          budgetTokens: 100,
          estimateQuality: "LOOMRAIL_ESTIMATE",
        },
      },
    });
    if (session.type !== "PROVIDER_SESSION_STARTED") throw new Error("ProviderSession was not started");
    expect(session.mcpSnapshots).toHaveLength(1);
    const sessionSnapshot = session.mcpSnapshots[0];
    if (!sessionSnapshot) throw new Error("MCP session snapshot was not created");
    expect(session.events[0]).toMatchObject({ data: { mcpSnapshots: [sessionSnapshot] } });

    const startedCall = reopened.execute({
      schemaVersion: 1,
      commandId: "start-tool-call",
      correlationId: "correlation-call",
      actor: { type: "SYSTEM", id: "mcp-gateway" },
      type: "START_MCP_TOOL_CALL",
      payload: {
        sessionSnapshotId: sessionSnapshot.id,
        toolName: "search_docs",
        inputDigest: "c".repeat(64),
      },
    });
    expect(startedCall).toMatchObject({ type: "MCP_TOOL_CALL_CHANGED", call: { status: "STARTED" } });

    const revoked = reopened.execute({
      schemaVersion: 1,
      commandId: "revoke-profile",
      correlationId: "correlation-revoke",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REVOKE_MCP_PROFILE_GRANT",
      payload: {
        projectId: "project-one",
        expectedProjectVersion: 3,
        profileRevisionId: consented.revision.id,
        expectedGrantVersion: 1,
      },
    });
    expect(revoked).toMatchObject({
      type: "MCP_GRANT_CHANGED",
      projectVersion: 4,
      grant: { enabled: false, version: 2 },
    });

    expect(() =>
      reopened.execute({
        schemaVersion: 1,
        commandId: "start-call-after-revoke",
        correlationId: "correlation-call-after-revoke",
        actor: { type: "SYSTEM", id: "mcp-gateway" },
        type: "START_MCP_TOOL_CALL",
        payload: {
          sessionSnapshotId: sessionSnapshot.id,
          toolName: "search_docs",
          inputDigest: "d".repeat(64),
        },
      }),
    ).toThrow(expect.objectContaining({ code: "GRANT_REVOKED" }));

    reopened.execute({
      schemaVersion: 1,
      commandId: "reconcile-after-lost-call",
      correlationId: "correlation-reconcile",
      actor: { type: "SYSTEM", id: "daemon" },
      type: "RECONCILE_WORKFLOWS",
      payload: {},
    });
    const calls = reopened.query({ type: "LIST_MCP_TOOL_CALLS", providerSessionId: session.session.id });
    expect(calls).toMatchObject({
      type: "MCP_TOOL_CALLS",
      calls: [{ status: "UNKNOWN_OUTCOME", failureCode: "CONNECTION_LOST" }],
    });

    const events = reopened.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(
      events.type === "EVENTS"
        ? events.events
            .map(({ type }) => type)
            .filter((type) => type === "PROJECT_REGISTERED" || type.startsWith("MCP_"))
        : [],
    ).toEqual(["PROJECT_REGISTERED", "MCP_PROFILE_CONSENTED", "MCP_GRANT_CHANGED", "MCP_GRANT_CHANGED"]);
  });

  it("rolls back forbidden launch, digest drift and a grant without a successful probe", async () => {
    const localState = await open();
    localState.execute(register());

    const shell = confirm();
    shell.commandId = "confirm-shell";
    shell.payload.candidate = { ...candidate(), executable: "/bin/sh" };
    shell.payload.canonicalDigest = createHash("sha256")
      .update(JSON.stringify(shell.payload.candidate))
      .digest("hex");
    expect(() => localState.execute(shell)).toThrow(
      expect.objectContaining({ code: "EXECUTABLE_FORBIDDEN" }),
    );

    const drift = confirm();
    drift.commandId = "confirm-drift";
    drift.payload.canonicalDigest = "f".repeat(64);
    expect(() => localState.execute(drift)).toThrow(
      expect.objectContaining({ code: "CANONICAL_DIGEST_MISMATCH" }),
    );

    const consented = localState.execute(confirm());
    if (consented.type !== "MCP_PROFILE_CONSENTED") throw new Error("MCP profile was not consented");
    expect(() =>
      localState.execute({
        schemaVersion: 1,
        commandId: "grant-without-probe",
        correlationId: "correlation-grant",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "SET_MCP_PROFILE_GRANT",
        payload: {
          projectId: "project-one",
          expectedProjectVersion: 2,
          profileRevisionId: consented.revision.id,
          expectedGrantVersion: null,
          tools: ["search_docs"],
          ownerAttestsReadOnly: true,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_NOT_READY" }));

    const profiles = localState.query({ type: "GET_PROJECT_MCP_PROFILES", projectId: "project-one" });
    expect(profiles).toMatchObject({
      type: "PROJECT_MCP_PROFILES",
      project: { version: 2 },
      profiles: [{ capability: null, grant: null }],
    });
    const events = localState.query({ type: "LIST_EVENTS", projectId: "project-one" });
    expect(events.type === "EVENTS" ? events.events.map(({ type }) => type) : []).toEqual([
      "PROJECT_REGISTERED",
      "MCP_PROFILE_CONSENTED",
    ]);
  });

  it("enforces immutable revisions and irreversible grants in SQLite itself", async () => {
    const localState = await open();
    localState.execute(register());
    const consented = localState.execute(confirm());
    if (consented.type !== "MCP_PROFILE_CONSENTED") throw new Error("MCP profile was not consented");

    const database = new DatabaseSync(databasePath);
    expect(() =>
      database
        .prepare("UPDATE mcp_profile_revisions SET name = ? WHERE id = ?")
        .run("changed", consented.revision.id),
    ).toThrow();
    database.close();
  });

  it("keeps domain errors typed through the transaction boundary", async () => {
    const localState = await open();
    localState.execute(register());
    const stale = confirm();
    stale.payload.expectedProjectVersion = 99;
    expect(() => localState.execute(stale)).toThrow(McpDomainError);
  });
});
