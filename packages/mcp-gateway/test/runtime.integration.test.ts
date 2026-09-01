import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpProfileRevision, McpSessionSnapshot } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { createMcpGateway, mcpProbeEnvironment, type McpToolCallTerminalOutcome } from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/modern-server.mjs", import.meta.url));
const proxyEntrypoint = fileURLToPath(new URL("../dist/proxy.js", import.meta.url));
const supervisorEntrypoint = fileURLToPath(new URL("../dist/supervisor.js", import.meta.url));
const canonicalDigest = "0".repeat(64);

const revision: McpProfileRevision = {
  schemaVersion: 1,
  id: "revision-one",
  profileId: "profile-one",
  projectId: "project-one",
  revision: 1,
  name: "Test MCP",
  executable: process.execPath,
  args: [fixturePath, "ready"],
  declaredTools: ["tool_00", "tool_01"],
  canonicalDigest,
  createdAt: "2026-08-31T12:00:00.000Z",
};

const snapshot: McpSessionSnapshot = {
  schemaVersion: 1,
  id: "snapshot-one",
  projectId: "project-one",
  providerSessionId: "provider-session-one",
  profileRevisionId: revision.id,
  profileDigest: canonicalDigest,
  grantId: "grant-one",
  grantVersion: 1,
  tools: ["tool_00"],
  createdAt: "2026-08-31T12:00:01.000Z",
};

describe("MCP session gateway runtime", () => {
  it("exposes only granted tools through a one-time Loomrail proxy and audits calls", async () => {
    const starts: { toolName: string; inputDigest: string }[] = [];
    const finishes: { callId: string; outcome: McpToolCallTerminalOutcome }[] = [];
    const gateway = createMcpGateway({ proxyEntrypoint, supervisorEntrypoint });
    const lease = await gateway.open([
      {
        revision,
        snapshot,
        startToolCall: (input) => {
          starts.push(input);
          return `call-${String(starts.length)}`;
        },
        finishToolCall: (callId, outcome) => {
          finishes.push({ callId, outcome });
        },
      },
    ]);
    const connection = lease.connections[0];
    if (connection === undefined) throw new Error("Expected one MCP proxy connection");
    expect(connection.enabledTools).toEqual(["tool_00"]);
    expect(connection.proxyArgs).not.toContain(fixturePath);
    expect(connection.proxyArgs).not.toContain("ready");

    const client = new Client({ name: "gateway-test-client", version: "1.0.0" });
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
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: "tool_00" }],
      });
      await expect(
        client.callTool({ name: "tool_00", arguments: { query: "through Loomrail" } }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "through Loomrail" }],
      });
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ toolName: "tool_00" });
      expect(starts[0]?.inputDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(finishes).toEqual([{ callId: "call-1", outcome: { status: "SUCCEEDED" } }]);

      gateway.revoke(snapshot.grantId);
      await expect(
        client.callTool({ name: "tool_00", arguments: { query: "must not run" } }),
      ).resolves.toMatchObject({ isError: true });
      expect(starts).toHaveLength(1);
    } finally {
      await client.close().catch(() => undefined);
      await lease.close();
      await gateway.shutdown();
    }
  }, 20_000);

  it("records a lost response as UNKNOWN_OUTCOME and never retries the call", async () => {
    const disconnectedRevision: McpProfileRevision = {
      ...revision,
      id: "revision-disconnect",
      args: [fixturePath, "exit-on-call"],
      canonicalDigest: "1".repeat(64),
    };
    const disconnectedSnapshot: McpSessionSnapshot = {
      ...snapshot,
      id: "snapshot-disconnect",
      profileRevisionId: disconnectedRevision.id,
      profileDigest: disconnectedRevision.canonicalDigest,
      grantId: "grant-disconnect",
    };
    const starts: { toolName: string; inputDigest: string }[] = [];
    const finishes: { callId: string; outcome: McpToolCallTerminalOutcome }[] = [];
    const gateway = createMcpGateway({ proxyEntrypoint, supervisorEntrypoint });
    const lease = await gateway.open([
      {
        revision: disconnectedRevision,
        snapshot: disconnectedSnapshot,
        startToolCall: (input) => {
          starts.push(input);
          return "call-disconnect";
        },
        finishToolCall: (callId, outcome) => {
          finishes.push({ callId, outcome });
        },
      },
    ]);
    const connection = lease.connections[0];
    if (connection === undefined) throw new Error("Expected one MCP proxy connection");
    const client = new Client({ name: "gateway-disconnect-client", version: "1.0.0" });
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
      await expect(
        client.callTool({ name: "tool_00", arguments: { query: "one attempt" } }),
      ).resolves.toMatchObject({ isError: true });
      expect(starts).toHaveLength(1);
      expect(finishes).toEqual([
        {
          callId: "call-disconnect",
          outcome: { status: "UNKNOWN_OUTCOME", failureCode: "CONNECTION_LOST" },
        },
      ]);
    } finally {
      await client.close().catch(() => undefined);
      await lease.close();
      await gateway.shutdown();
    }
  }, 20_000);

  it("lets an in-flight call finish but blocks a new call racing with revoke", async () => {
    const delayedRevision: McpProfileRevision = {
      ...revision,
      id: "revision-delayed",
      args: [fixturePath, "delayed-call"],
      canonicalDigest: "2".repeat(64),
    };
    const delayedSnapshot: McpSessionSnapshot = {
      ...snapshot,
      id: "snapshot-delayed",
      profileRevisionId: delayedRevision.id,
      profileDigest: delayedRevision.canonicalDigest,
      grantId: "grant-delayed",
    };
    const starts: string[] = [];
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const gateway = createMcpGateway({ proxyEntrypoint, supervisorEntrypoint });
    const lease = await gateway.open([
      {
        revision: delayedRevision,
        snapshot: delayedSnapshot,
        startToolCall: ({ toolName }) => {
          starts.push(toolName);
          announceStarted?.();
          return `call-${starts.length.toString()}`;
        },
        finishToolCall: () => undefined,
      },
    ]);
    const connection = lease.connections[0];
    if (connection === undefined) throw new Error("Expected one MCP proxy connection");
    const client = new Client({ name: "gateway-revoke-race-client", version: "1.0.0" });
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
      const inFlight = client.callTool({ name: "tool_00", arguments: { query: "already sent" } });
      await started;
      gateway.revoke(delayedSnapshot.grantId);
      await expect(
        client.callTool({ name: "tool_00", arguments: { query: "too late" } }),
      ).resolves.toMatchObject({ isError: true });
      await expect(inFlight).resolves.toMatchObject({
        content: [{ type: "text", text: "already sent" }],
      });
      expect(starts).toEqual(["tool_00"]);
    } finally {
      await client.close().catch(() => undefined);
      await lease.close();
      await gateway.shutdown();
    }
  }, 20_000);
});
