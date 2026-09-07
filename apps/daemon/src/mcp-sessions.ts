import type { McpSessionSnapshot, WorkspaceToolOperation } from "@loomrail/contracts";
import {
  McpGatewayError,
  type McpDirectSessionBinding,
  type McpGateway,
  type McpToolCallTerminalOutcome,
} from "@loomrail/mcp-gateway";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import {
  workspaceToolRequestSchema,
  type WorkspaceToolExecutor,
  type WorkspaceToolResult,
} from "@loomrail/provider-core";

import type { OpenMcpConnections } from "./session-loop.js";

export type McpSessionOrchestratorOptions = {
  state: LocalState;
  gateway: McpGateway;
  createCommandId: (kind: "START" | "FINISH") => string;
};

const oneProjectId = (snapshots: readonly McpSessionSnapshot[]): string | null => {
  const projectIds = new Set(snapshots.map(({ projectId }) => projectId));
  if (projectIds.size > 1) {
    throw new McpGatewayError(
      "CONSENT_MISMATCH",
      "One provider session cannot mix MCP profiles from different Projects",
    );
  }
  return snapshots[0]?.projectId ?? null;
};

const workspaceTools = (approvedRecipeIds: readonly string[]) =>
  [
    {
      name: "loomrail_list_directory",
      description: 'List one relative directory inside the bounded Loomrail workspace. Use "." for the root.',
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "loomrail_read_file",
      description: "Read a bounded UTF-8 range from one relative Loomrail workspace file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offsetBytes: { type: "integer", minimum: 0 },
          limitBytes: { type: "integer", minimum: 1, maximum: 65_536 },
        },
        required: ["path", "offsetBytes", "limitBytes"],
        additionalProperties: false,
      },
    },
    {
      name: "loomrail_write_file",
      description: "Atomically create or replace one relative file with compare-and-swap protection.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          expectedSha256: { type: ["string", "null"] },
          content: { type: "string" },
        },
        required: ["path", "expectedSha256", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "loomrail_delete_file",
      description: "Delete one relative regular file when its digest still matches.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, expectedSha256: { type: "string" } },
        required: ["path", "expectedSha256"],
        additionalProperties: false,
      },
    },
    ...(approvedRecipeIds.length === 0
      ? []
      : [
          {
            name: "loomrail_run_recipe",
            description: "Run one exact owner-approved Loomrail verification recipe using an enum value.",
            inputSchema: {
              type: "object",
              properties: { recipeId: { type: "string", enum: approvedRecipeIds } },
              required: ["recipeId"],
              additionalProperties: false,
            },
          },
        ]),
  ] as const;

const operationFor = (toolName: string): WorkspaceToolOperation => {
  switch (toolName) {
    case "loomrail_list_directory":
      return "LIST_DIRECTORY";
    case "loomrail_read_file":
      return "READ_FILE";
    case "loomrail_write_file":
      return "WRITE_FILE";
    case "loomrail_delete_file":
      return "DELETE_FILE";
    case "loomrail_run_recipe":
      return "RUN_RECIPE";
    default:
      throw new McpGatewayError("SESSION_BINDING_INVALID", "The workspace tool is not registered");
  }
};

const failedToolResult = (operation: WorkspaceToolOperation): WorkspaceToolResult => ({
  status: "DENIED",
  operation,
  code: "CONTENT_INVALID",
  message: "The workspace tool arguments did not satisfy the Loomrail contract",
  approvalRequired: false,
});

const workspaceDirectBinding = (input: {
  providerSessionId: string;
  executor: WorkspaceToolExecutor;
  signal: AbortSignal;
}): McpDirectSessionBinding => ({
  providerSessionId: input.providerSessionId,
  connectionId: "loomrail_workspace",
  tools: workspaceTools(input.executor.describePolicy().recipes.map(({ id }) => id)),
  callTool: async ({ callId, toolName, arguments: untrustedArguments }) => {
    const operation = operationFor(toolName);
    const request = workspaceToolRequestSchema.safeParse({
      callId,
      operation,
      ...untrustedArguments,
    });
    const result = request.success
      ? await input.executor.execute(request.data, input.signal).catch((): WorkspaceToolResult => ({
          status: "FAILED",
          operation,
          code: "INTERNAL_ERROR",
          message: "The workspace tool failed inside the bounded executor",
          approvalRequired: false,
        }))
      : failedToolResult(operation);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: { result },
      isError: result.status !== "SUCCEEDED",
    };
  },
});

/**
 * The daemon/persistence seam for one provider session. The gateway owns processes and wire
 * filtering; this module resolves immutable durable revisions and records the redacted call
 * lifecycle without exposing either concern to provider adapters.
 */
export const createMcpConnectionOpener =
  ({ state, gateway, createCommandId }: McpSessionOrchestratorOptions): OpenMcpConnections =>
  async ({ snapshots, providerSessionId, workspaceTools: executor, authoritySignal }) => {
    const projectId = oneProjectId(snapshots);
    const bindings =
      projectId === null
        ? []
        : (() => {
            const result = state.query({ type: "GET_PROJECT_MCP_PROFILES", projectId });
            if (result.type !== "PROJECT_MCP_PROFILES") {
              throw new McpGatewayError("CONSENT_MISMATCH", "The MCP profiles could not be loaded");
            }
            return snapshots.map((snapshot) => {
              const profile = result.profiles.find(
                ({ revision }) => revision.id === snapshot.profileRevisionId,
              );
              if (profile?.revision.canonicalDigest !== snapshot.profileDigest) {
                throw new McpGatewayError(
                  "CONSENT_MISMATCH",
                  "The MCP session snapshot no longer matches its immutable profile revision",
                );
              }
              return {
                snapshot,
                revision: profile.revision,
                startToolCall: ({ toolName, inputDigest }: { toolName: string; inputDigest: string }) => {
                  const call = state.execute({
                    schemaVersion: 1,
                    commandId: createCommandId("START"),
                    correlationId: `mcp-session-${snapshot.providerSessionId}`,
                    actor: { type: "SYSTEM", id: "mcp-gateway" },
                    type: "START_MCP_TOOL_CALL",
                    payload: { sessionSnapshotId: snapshot.id, toolName, inputDigest },
                  });
                  if (call.type !== "MCP_TOOL_CALL_CHANGED") {
                    throw new StateStoreError("PERSISTENCE_FAILURE", "The MCP tool call did not start");
                  }
                  return call.call.id;
                },
                finishToolCall: (callId: string, outcome: McpToolCallTerminalOutcome) => {
                  const finished = state.execute({
                    schemaVersion: 1,
                    commandId: createCommandId("FINISH"),
                    correlationId: `mcp-session-${snapshot.providerSessionId}`,
                    actor: { type: "SYSTEM", id: "mcp-gateway" },
                    type: "FINISH_MCP_TOOL_CALL",
                    payload: { callId, outcome },
                  });
                  if (finished.type !== "MCP_TOOL_CALL_CHANGED") {
                    throw new StateStoreError("PERSISTENCE_FAILURE", "The MCP tool call did not finish");
                  }
                },
              };
            });
          })();
    const directBindings =
      executor === undefined
        ? []
        : [workspaceDirectBinding({ providerSessionId, executor, signal: authoritySignal })];
    return gateway.open(bindings, directBindings);
  };
