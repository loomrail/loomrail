import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentRunActivityPageSchema,
  apiErrorResponseSchema,
  type WorkflowTemplate,
} from "@loomrail/contracts";
import { openLocalState } from "@loomrail/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon, type RunningDaemon } from "../src/server.js";
import { authenticate, bootstrapToken } from "./daemon-fixtures.js";

const contextPack = {
  schemaVersion: 1 as const,
  sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
};

const activityTemplate: WorkflowTemplate = {
  schemaVersion: 1,
  id: "agent-run-activity-http-template",
  version: 1,
  name: "Agent run activity HTTP boundary",
  stages: [{ stage: "IMPLEMENT", ordinal: 0, contextPack }],
};

describe("agent run activity HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("authenticates the caller, scopes by AgentRun existence, and merges both origins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail activity api тест "));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    const timestamp = "2026-09-14T10:00:00.000Z";
    let clockOffsetMs = 0;
    // Strictly increasing so the merged feed's `(at, origin, id)` ordering is exercised by real
    // distinct timestamps, not by the id tie-break alone.
    const tick = (): Date => {
      clockOffsetMs += 1;
      return new Date(new Date(timestamp).getTime() + clockOffsetMs);
    };
    let nextId = 0;

    const state = await openLocalState({
      databasePath,
      now: tick,
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    let agentRunId: string;
    try {
      state.execute({
        schemaVersion: 1,
        commandId: "register-project",
        correlationId: "correlation-register-project",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
        payload: {
          id: "project-1",
          fixtureId: null,
          name: "Agent run activity HTTP fixture",
          repositoryPath: join(directory, "repo"),
        },
      });
      const created = state.execute({
        schemaVersion: 1,
        commandId: "create-work-item",
        correlationId: "correlation-create-work-item",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CREATE_WORK_ITEM",
        payload: {
          projectId: "project-1",
          parentId: null,
          type: "TASK",
          title: "Serve the merged activity feed",
          description: "Synthetic fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: ["The HTTP route answers with both origins"],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      state.execute({
        schemaVersion: 1,
        commandId: "ready-work-item",
        correlationId: "correlation-ready-work-item",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
      });
      const pipeline = state.execute({
        schemaVersion: 1,
        commandId: "start-pipeline",
        correlationId: "correlation-start-pipeline",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId: created.workItem.id,
          expectedVersion: 2,
          template: activityTemplate,
          budget: { maxEstimatedTokens: 200_000, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      const agent = state.execute({
        schemaVersion: 1,
        commandId: "start-agent-run",
        correlationId: "correlation-start-agent-run",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: pipeline.dispatch.id,
          provider: "CODEX",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (agent.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun start");
      agentRunId = agent.run.id;
      const session = state.execute({
        schemaVersion: 1,
        commandId: "start-provider-session",
        correlationId: "correlation-start-provider-session",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "START_PROVIDER_SESSION",
        payload: {
          stageAttemptId: pipeline.stageAttempt.id,
          recipe: {
            schemaVersion: 1,
            templateId: activityTemplate.id,
            templateVersion: activityTemplate.version,
            specSource: "ROLE_PLAYBOOK",
            roleProfile: { id: agent.run.profile.id, revision: agent.run.profile.revision },
            sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
            omitted: [],
            contentHash: `sha256:${"a".repeat(64)}`,
            estimatedTokens: 10,
            budgetTokens: 100,
            estimateQuality: "LOOMRAIL_ESTIMATE",
          },
        },
      });
      if (session.type !== "PROVIDER_SESSION_STARTED") throw new Error("Expected ProviderSession start");

      // The audited half: one daemon-verified workspace tool call, start then terminal.
      const startedCall = state.execute({
        schemaVersion: 1,
        commandId: "workspace-tool-start-1",
        correlationId: "correlation-workspace-tool",
        actor: { type: "SYSTEM", id: "workspace-executor" },
        type: "START_WORKSPACE_TOOL_CALL",
        payload: {
          providerSessionId: session.session.id,
          providerCallKey: "a".repeat(64),
          operation: "READ_FILE",
          target: "src/index.ts",
          policyDigest: "b".repeat(64),
          inputDigest: "c".repeat(64),
        },
      });
      if (startedCall.type !== "WORKSPACE_TOOL_CALL_CHANGED") throw new Error("Expected tool reservation");
      state.execute({
        schemaVersion: 1,
        commandId: "workspace-tool-finish-1",
        correlationId: "correlation-workspace-tool",
        actor: { type: "SYSTEM", id: "workspace-executor" },
        type: "FINISH_WORKSPACE_TOOL_CALL",
        payload: {
          callId: startedCall.call.id,
          outcome: {
            status: "SUCCEEDED",
            outputDigest: "d".repeat(64),
            outputBytes: 128,
            exitCode: null,
          },
        },
      });

      // The reported half: one entry the provider CLI claimed about itself, unverified.
      state.execute({
        schemaVersion: 1,
        commandId: "activity-1-end",
        correlationId: "correlation-agent-run-activity",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "RECORD_AGENT_RUN_ACTIVITY",
        payload: {
          agentRunId,
          providerSessionId: session.session.id,
          provider: "CODEX",
          entry: {
            actionKey: "provider-reported-1",
            kind: "AGENT_TEXT",
            label: null,
            detail: "Reading the file now",
            status: null,
            terminal: true,
            truncated: false,
          },
        },
      });
    } finally {
      state.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: databasePath,
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });

    // Unauthenticated: the route requires a session like its neighbours.
    const unauthenticated = await fetch(`${daemon.baseUrl}/api/v1/agent-runs/${agentRunId}/activity`);
    expect(unauthenticated.status).toBe(401);

    const session = await authenticate(daemon, token);
    const authedHeaders = { cookie: session.cookie };

    // Scoped by existence: an AgentRun id nothing seeded is 404, not an empty 200 -- same as every
    // other :id-scoped route in this daemon that has no separate project ACL to defer to.
    const missing = await fetch(`${daemon.baseUrl}/api/v1/agent-runs/agent-run-does-not-exist/activity`, {
      headers: authedHeaders,
    });
    expect(missing.status).toBe(404);

    // A cursor that is not even well-formed base64url/JSON/shape is refused, not silently treated as
    // "no cursor".
    const malformedCursor = await fetch(
      `${daemon.baseUrl}/api/v1/agent-runs/${agentRunId}/activity?after=not-a-real-cursor!!`,
      { headers: authedHeaders },
    );
    expect(malformedCursor.status).toBe(400);
    apiErrorResponseSchema.parse(await malformedCursor.json());

    const response = await fetch(`${daemon.baseUrl}/api/v1/agent-runs/${agentRunId}/activity`, {
      headers: authedHeaders,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const page = agentRunActivityPageSchema.parse(await response.json());
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((entry) => entry.origin)).toEqual(["DAEMON_AUDITED", "PROVIDER_REPORTED"]);
    expect(page.entries[0]).toMatchObject({
      origin: "DAEMON_AUDITED",
      kind: "TOOL_CALL",
      label: "READ_FILE",
      detail: "src/index.ts",
      status: "SUCCEEDED",
    });
    expect(page.entries[1]).toMatchObject({
      origin: "PROVIDER_REPORTED",
      kind: "AGENT_TEXT",
      detail: "Reading the file now",
    });
    expect(page.gap).toBe(false);
    // Not a false positive: this AgentRun's ProviderSession is still RUNNING when the process that
    // seeded it exits, so RECONCILE_WORKFLOWS's own startup pass (synchronous, before `app.listen`
    // -- see packages/persistence-sqlite/src/index.ts) interrupts it and honestly marks its feed
    // degraded, the same way a real crash-and-restart would. `degraded` still has to reach the HTTP
    // response unchanged, which is exactly what this asserts.
    expect(page.degraded).toBe(true);
  });
});
