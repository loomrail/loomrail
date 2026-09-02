import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpConsent, McpProfileRevision } from "@loomrail/contracts";
import { mcpProbeEnvironment, probeMcpRevision } from "@loomrail/mcp-gateway";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/readonly-plugin.mjs", import.meta.url));
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});

const revision: McpProfileRevision = {
  schemaVersion: 1,
  id: "revision_plugin_fixture",
  profileId: "profile_plugin_fixture",
  projectId: "project_fixture",
  revision: 1,
  name: "SDK fixture",
  executable: process.execPath,
  args: [fixture],
  declaredTools: ["echo_docs", "fail_safely", "invalid_result"],
  canonicalDigest: "a".repeat(64),
  createdAt: "2026-08-31T00:00:00.000Z",
};
const consent: McpConsent = {
  schemaVersion: 1,
  id: "consent_plugin_fixture",
  projectId: revision.projectId,
  profileRevisionId: revision.id,
  canonicalDigest: revision.canonicalDigest,
  ownerId: "owner_fixture",
  consentedAt: revision.createdAt,
};

describe("plugin SDK conformance", () => {
  it("passes the real C1 probe with the exact read-only tool surface", async () => {
    const observation = await probeMcpRevision(revision, consent);
    expect(observation).toEqual({
      state: "READY",
      protocolVersion: observation.protocolVersion,
      tools: ["echo_docs", "fail_safely", "invalid_result"],
      resources: [],
      prompts: [],
    });
    expect(typeof observation.protocolVersion).toBe("string");
  }, 10_000);

  it("owns annotations and redacts a handler exception", async () => {
    const client = new Client(
      { name: "loomrail-plugin-sdk-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      env: mcpProbeEnvironment(),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([
      "echo_docs",
      "fail_safely",
      "invalid_result",
    ]);
    for (const listedTool of listed.tools) {
      expect(listedTool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    const invalidInputResult = await client.callTool({ name: "echo_docs", arguments: {} });
    expect(invalidInputResult).toMatchObject({ isError: true });
    expect(stderr).not.toContain("ECHO_HANDLER_CALLED");

    const thrownResult = await client.callTool({ name: "fail_safely", arguments: {} });
    expect(thrownResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "The plugin tool failed." }],
    });
    const invalidResult = await client.callTool({ name: "invalid_result", arguments: {} });
    expect(invalidResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "The plugin tool failed." }],
    });
    expect(JSON.stringify(thrownResult)).not.toContain("PLUGIN_TEST_SECRET_MUST_NOT_ESCAPE");
    expect(stderr).not.toContain("PLUGIN_TEST_SECRET_MUST_NOT_ESCAPE");
  });
});
