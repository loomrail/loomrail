import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { WorkflowTemplate } from "@loomrail/contracts";
import { canonicalMcpProfileSource } from "@loomrail/domain";
import { createMcpGateway, mcpProbeEnvironment } from "@loomrail/mcp-gateway";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpConnectionOpener } from "../src/mcp-sessions.js";

const fixturePath = fileURLToPath(
  new URL("../../../packages/mcp-gateway/test/fixtures/modern-server.mjs", import.meta.url),
);
const proxyEntrypoint = fileURLToPath(
  new URL("../../../packages/mcp-gateway/dist/proxy.js", import.meta.url),
);
const supervisorEntrypoint = fileURLToPath(
  new URL("../../../packages/mcp-gateway/dist/supervisor.js", import.meta.url),
);
const projectId = "project-mcp-session";
const timestamp = "2026-08-31T13:00:00.000Z";

const discoveryTemplate: WorkflowTemplate = {
  schemaVersion: 1,
  id: "mcp-session-integration-v1",
  version: 1,
  name: "MCP session integration",
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
};

describe("daemon MCP session orchestration", () => {
  let directory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let nextCommandId = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "loomrail MCP session "));
    databasePath = join(directory, "state.sqlite");
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const openState = (): LocalState => {
    if (state === undefined) throw new Error("The local state is not open");
    return state;
  };

  it("forwards a granted tool through the real proxy and persists only its redacted lifecycle", async () => {
    const localState = openState();
    localState.execute({
      schemaVersion: 1,
      commandId: "register-project",
      correlationId: "mcp-session-setup",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: projectId,
        fixtureId: null,
        name: "MCP session project",
        repositoryPath: join(directory, "repo"),
      },
    });
    const candidate = {
      profileId: null,
      name: "Synthetic MCP",
      executable: process.execPath,
      args: [fixturePath, "ready"],
      declaredTools: ["tool_00", "tool_01"],
    };
    const canonicalDigest = createHash("sha256").update(canonicalMcpProfileSource(candidate)).digest("hex");
    const consented = localState.execute({
      schemaVersion: 1,
      commandId: "confirm-profile",
      correlationId: "mcp-session-setup",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CONFIRM_MCP_PROFILE",
      payload: {
        projectId,
        expectedProjectVersion: 1,
        candidate,
        canonicalDigest,
      },
    });
    if (consented.type !== "MCP_PROFILE_CONSENTED") throw new Error("MCP profile was not consented");
    localState.execute({
      schemaVersion: 1,
      commandId: "record-capability",
      correlationId: "mcp-session-setup",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "RECORD_MCP_CAPABILITY_SNAPSHOT",
      payload: {
        projectId,
        profileRevisionId: consented.revision.id,
        state: "READY",
        protocolVersion: "2026-07-28",
        tools: ["tool_00", "tool_01"],
        resources: [],
        prompts: [],
      },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: "grant-profile",
      correlationId: "mcp-session-setup",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "SET_MCP_PROFILE_GRANT",
      payload: {
        projectId,
        expectedProjectVersion: 2,
        profileRevisionId: consented.revision.id,
        expectedGrantVersion: null,
        tools: ["tool_00"],
        ownerAttestsReadOnly: true,
      },
    });
    const workItem = localState.execute({
      schemaVersion: 1,
      commandId: "create-work-item",
      correlationId: "mcp-session-setup",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId,
        parentId: null,
        type: "TASK",
        title: "Use local docs",
        description: "",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: [],
      },
    });
    if (workItem.type !== "WORK_ITEM_CREATED") throw new Error("WorkItem was not created");
    localState.execute({
      schemaVersion: 1,
      commandId: "ready-work-item",
      correlationId: "mcp-session-setup",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: workItem.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const pipeline = localState.execute({
      schemaVersion: 1,
      commandId: "start-pipeline",
      correlationId: "mcp-session-setup",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: workItem.workItem.id,
        expectedVersion: 2,
        template: discoveryTemplate,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Pipeline was not started");
    const agent = localState.execute({
      schemaVersion: 1,
      commandId: "start-agent-run",
      correlationId: "mcp-session-setup",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: pipeline.dispatch.id,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    if (agent.type !== "AGENT_RUN_STARTED") throw new Error("AgentRun was not started");
    const session = localState.execute({
      schemaVersion: 1,
      commandId: "start-provider-session",
      correlationId: "mcp-session-setup",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId: pipeline.stageAttempt.id,
        recipe: {
          schemaVersion: 1,
          templateId: discoveryTemplate.id,
          templateVersion: discoveryTemplate.version,
          specSource: "ROLE_PLAYBOOK",
          roleProfile: { id: agent.run.profile.id, revision: agent.run.profile.revision },
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

    const gateway = createMcpGateway({ proxyEntrypoint, supervisorEntrypoint });
    const opener = createMcpConnectionOpener({
      state: localState,
      gateway,
      createCommandId: (kind) => `tool-call-${kind.toLowerCase()}-${(nextCommandId += 1).toString()}`,
    });
    const lease = await opener(session.mcpSnapshots);
    const connection = lease.connections[0];
    if (connection === undefined) throw new Error("The MCP connector was not opened");
    const client = new Client({ name: "daemon-mcp-test", version: "1.0.0" });
    const secretArgument = "raw-secret-never-persisted-7k4p";
    try {
      await client.connect(
        new StdioClientTransport({
          command: connection.proxyCommand,
          args: connection.proxyArgs,
          env: mcpProbeEnvironment(),
          stderr: "pipe",
        }),
        { timeout: 5_000, maxTotalTimeout: 5_000 },
      );
      await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: "tool_00" }] });
      await expect(
        client.callTool({ name: "tool_00", arguments: { query: secretArgument } }),
      ).resolves.toMatchObject({ content: [{ type: "text", text: secretArgument }] });

      const audit = localState.query({
        type: "LIST_MCP_TOOL_CALLS",
        providerSessionId: session.session.id,
      });
      expect(audit).toMatchObject({
        type: "MCP_TOOL_CALLS",
        calls: [
          {
            toolName: "tool_00",
            status: "SUCCEEDED",
          },
        ],
      });
      if (audit.type !== "MCP_TOOL_CALLS") throw new Error("Expected the MCP tool-call audit");
      expect(audit.calls[0]?.inputDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(audit)).not.toContain(secretArgument);
    } finally {
      await client.close().catch(() => undefined);
      await lease.close();
      await gateway.shutdown();
    }

    const databaseBytes = await readFile(databasePath);
    expect(databaseBytes.includes(Buffer.from(secretArgument, "utf8"))).toBe(false);
  });
});
