import { describe, expect, it } from "vitest";

import {
  mcpProfileCandidateSchema,
  mcpToolCallRecordSchema,
  proposeContext7PresetRequestSchema,
  proposeMcpProfileRequestSchema,
  setMcpProfileGrantCommandSchema,
} from "../src/index.js";

const candidate = {
  profileId: null,
  name: "Local docs",
  executable: "/opt/loomrail/bin/docs-mcp",
  args: ["--read-only", "справка"],
  declaredTools: ["search_docs", "read/document"],
};

describe("MCP contracts", () => {
  it("accepts exact POSIX and Windows argv recipes without turning them into shell strings", () => {
    expect(mcpProfileCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(
      mcpProfileCandidateSchema.safeParse({
        ...candidate,
        executable: "C:\\Program Files\\Loomrail\\docs-mcp.exe",
      }).success,
    ).toBe(true);
  });

  it("rejects a relative executable and duplicate tool declarations", () => {
    expect(mcpProfileCandidateSchema.safeParse({ ...candidate, executable: "docs-mcp" }).success).toBe(false);
    expect(
      mcpProfileCandidateSchema.safeParse({
        ...candidate,
        declaredTools: ["search_docs", "search_docs"],
      }).success,
    ).toBe(false);
  });

  it("keeps remote, environment and shell-mode fields outside the proposal surface", () => {
    const base = {
      schemaVersion: 1,
      expectedProjectVersion: 3,
      candidate,
    };
    expect(proposeMcpProfileRequestSchema.safeParse(base).success).toBe(true);
    expect(
      proposeMcpProfileRequestSchema.safeParse({
        ...base,
        candidate: { ...candidate, url: "https://example.invalid/mcp" },
      }).success,
    ).toBe(false);
    expect(
      proposeMcpProfileRequestSchema.safeParse({
        ...base,
        candidate: { ...candidate, env: { TOKEN: "secret" } },
      }).success,
    ).toBe(false);
    expect(
      proposeMcpProfileRequestSchema.safeParse({
        ...base,
        candidate: { ...candidate, shell: true },
      }).success,
    ).toBe(false);
  });

  it("keeps the Context7 preset request free of client-supplied launch data", () => {
    const request = { schemaVersion: 1, expectedProjectVersion: 3 };
    expect(proposeContext7PresetRequestSchema.safeParse(request).success).toBe(true);
    expect(
      proposeContext7PresetRequestSchema.safeParse({
        ...request,
        executable: "/bin/sh",
        args: ["-c", "exit 0"],
      }).success,
    ).toBe(false);
  });

  it("requires an explicit read-only attestation and unique granted tools", () => {
    const command = {
      schemaVersion: 1,
      commandId: "command-1",
      correlationId: "correlation-1",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "SET_MCP_PROFILE_GRANT",
      payload: {
        projectId: "project-1",
        expectedProjectVersion: 3,
        profileRevisionId: "revision-1",
        expectedGrantVersion: null,
        tools: ["search_docs"],
        ownerAttestsReadOnly: true,
      },
    };
    expect(setMcpProfileGrantCommandSchema.safeParse(command).success).toBe(true);
    expect(
      setMcpProfileGrantCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, ownerAttestsReadOnly: false },
      }).success,
    ).toBe(false);
    expect(
      setMcpProfileGrantCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, tools: ["search_docs", "search_docs"] },
      }).success,
    ).toBe(false);
  });

  it("keeps started and terminal tool-call records structurally distinct", () => {
    const started = {
      schemaVersion: 1,
      id: "call-1",
      projectId: "project-1",
      providerSessionId: "session-1",
      sessionSnapshotId: "snapshot-1",
      profileRevisionId: "revision-1",
      toolName: "search_docs",
      inputDigest: "a".repeat(64),
      status: "STARTED",
      failureCode: null,
      startedAt: "2026-08-31T10:00:00.000Z",
      finishedAt: null,
    };
    expect(mcpToolCallRecordSchema.safeParse(started).success).toBe(true);
    expect(
      mcpToolCallRecordSchema.safeParse({
        ...started,
        status: "UNKNOWN_OUTCOME",
        failureCode: "CONNECTION_LOST",
        finishedAt: "2026-08-31T10:00:01.000Z",
      }).success,
    ).toBe(true);
    expect(
      mcpToolCallRecordSchema.safeParse({ ...started, status: "SUCCEEDED", finishedAt: null }).success,
    ).toBe(false);
  });
});
