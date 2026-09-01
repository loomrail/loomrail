import type { McpSessionSnapshot } from "@loomrail/contracts";
import { McpGatewayError, type McpGateway, type McpToolCallTerminalOutcome } from "@loomrail/mcp-gateway";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";

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

/**
 * The daemon/persistence seam for one provider session. The gateway owns processes and wire
 * filtering; this module resolves immutable durable revisions and records the redacted call
 * lifecycle without exposing either concern to provider adapters.
 */
export const createMcpConnectionOpener =
  ({ state, gateway, createCommandId }: McpSessionOrchestratorOptions): OpenMcpConnections =>
  async (snapshots) => {
    const projectId = oneProjectId(snapshots);
    if (projectId === null) return { connections: [], close: () => Promise.resolve() };
    const result = state.query({ type: "GET_PROJECT_MCP_PROFILES", projectId });
    if (result.type !== "PROJECT_MCP_PROFILES") {
      throw new McpGatewayError("CONSENT_MISMATCH", "The MCP profiles could not be loaded");
    }
    const bindings = snapshots.map((snapshot) => {
      const profile = result.profiles.find(({ revision }) => revision.id === snapshot.profileRevisionId);
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
    return gateway.open(bindings);
  };
