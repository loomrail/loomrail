import { createHash, randomUUID } from "node:crypto";

import type { AgentRunPolicySnapshot, ProviderSession, VerificationPlan } from "@loomrail/contracts";
import type { LocalState } from "@loomrail/persistence-sqlite";
import type { ProviderWorkspace, WorkspaceToolExecutor } from "@loomrail/provider-core";
import { createWorkspaceToolExecutor } from "@loomrail/workspace-executor";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type CreateSessionWorkspaceTools = (input: {
  providerSession: ProviderSession;
  projectId: string;
  workspace: ProviderWorkspace;
  policy: AgentRunPolicySnapshot;
}) => Promise<WorkspaceToolExecutor>;

export const createSessionWorkspaceToolFactory =
  (input: {
    state: LocalState;
    artifactsDirectory: string;
    processRegistryDirectory: string;
  }): CreateSessionWorkspaceTools =>
  async ({ providerSession, projectId, workspace, policy }) => {
    const readPlan = (): VerificationPlan | null => {
      const result = input.state.query({ type: "GET_PROJECT_VERIFICATION_PLAN", projectId });
      return result.type === "PROJECT_VERIFICATION_PLAN" ? result.plan : null;
    };
    const capturedPlan = readPlan();
    const correlationId = `workspace-tool-${providerSession.id}`;
    return createWorkspaceToolExecutor({
      workspacePath: workspace.path,
      access: workspace.access,
      networkAccess: policy.workspace.networkAccess,
      providerSessionId: providerSession.id,
      verificationPlan: capturedPlan,
      readCurrentVerificationPlan: readPlan,
      artifactsDirectory: input.artifactsDirectory,
      processRegistryDirectory: input.processRegistryDirectory,
      createArtifactId: () => `workspace-tool-output-${randomUUID()}`,
      audit: {
        reserve: (call) => {
          const result = input.state.execute({
            schemaVersion: 1,
            commandId: `workspace-tool-start-${call.providerCallKey}`,
            correlationId,
            actor: { type: "SYSTEM", id: "workspace-executor" },
            type: "START_WORKSPACE_TOOL_CALL",
            payload: { providerSessionId: providerSession.id, ...call },
          });
          if (result.type !== "WORKSPACE_TOOL_CALL_CHANGED") {
            throw new Error("The workspace tool call reservation was not recorded");
          }
          return { call: result.call, replayed: result.replayed };
        },
        finish: (callId, outcome) => {
          const result = input.state.execute({
            schemaVersion: 1,
            commandId: `workspace-tool-finish-${digest({ callId, outcome })}`,
            correlationId,
            actor: { type: "SYSTEM", id: "workspace-executor" },
            type: "FINISH_WORKSPACE_TOOL_CALL",
            payload: { callId, outcome },
          });
          if (result.type !== "WORKSPACE_TOOL_CALL_CHANGED") {
            throw new Error("The workspace tool call outcome was not recorded");
          }
          return { call: result.call, replayed: result.replayed };
        },
      },
    });
  };
