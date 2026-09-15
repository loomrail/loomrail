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

// Fix round 1 of Task 2 (docs/plans/129): the WorkItem-scoped `GET /api/v1/work-items/:id/activity`
// route (apps/daemon/src/server.ts) had no route-level test at all when this file was written -- the
// unit suite (agent-run-activity.unit.test.ts) only ever exercises the pure page builder directly,
// never the route's own wiring (session/404/cursor-decode/headers, and its own combination of the
// three `degraded` sources). A reviewer mutating the route found two guards the full daemon suite
// could not distinguish from their broken form: an undecodable cursor silently treated as "no
// cursor" instead of refused, and the audited side's own `degraded` dropped from the response's OR.
// This file exists to close both gaps and to prove the WorkItem-scoping fix itself (a WorkItem with
// more than one pipeline run no longer 500s).

const contextPack = {
  schemaVersion: 1 as const,
  sections: [{ id: "WORK_ITEM_BRIEF" as const, ordinal: 0, required: true }],
};

const timestamp = "2026-09-14T10:00:00.000Z";

describe("work item activity HTTP boundary", () => {
  let daemon: RunningDaemon | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  const openState = async (directory: string) => {
    let clockOffsetMs = 0;
    // Strictly increasing so the merged feed's `(at, origin, id)` ordering is exercised by real
    // distinct timestamps, not by the id tie-break alone -- same reasoning as the deleted
    // AgentRun-scoped route's own HTTP test used.
    const tick = (): Date => {
      clockOffsetMs += 1;
      return new Date(new Date(timestamp).getTime() + clockOffsetMs);
    };
    let nextId = 0;
    return openLocalState({
      databasePath: join(directory, "state.sqlite"),
      now: tick,
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
  };

  // Fix round 2: the plan's own Task 2 brief asked for one guard per test, and the reviewer found
  // the reason why -- bundled into a single `it`, a mutation that breaks 401 aborts the request
  // before 404, 400 or the headers are ever reached, so only the first broken guard is ever caught.
  // This seeds a fresh daemon (register, create, ready) per guard so each test's own mutation
  // evidence stands on its own.
  const seedReadyWorkItem = async (directory: string): Promise<string> => {
    const state = await openState(directory);
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
          name: "Work item activity HTTP fixture",
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
          title: "Serve the work-item-scoped activity feed",
          description: "Synthetic fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: ["The HTTP route answers with hardening intact"],
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
      return created.workItem.id;
    } finally {
      state.close();
    }
  };

  it("rejects an unauthenticated request with 401", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail work item activity 401 тест "));
    directories.push(directory);
    const workItemId = await seedReadyWorkItem(directory);
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(directory, "state.sqlite"),
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });
    const unauthenticated = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity`);
    expect(unauthenticated.status).toBe(401);
  });

  it("returns 404 for a WorkItem that does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail work item activity 404 тест "));
    directories.push(directory);
    await seedReadyWorkItem(directory);
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(directory, "state.sqlite"),
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });
    const session = await authenticate(daemon, token);
    // Scoped by existence: a WorkItem id nothing seeded is 404, not an empty 200 -- same as every
    // other :id-scoped route in this daemon that has no separate project ACL to defer to.
    const missing = await fetch(`${daemon.baseUrl}/api/v1/work-items/work-item-does-not-exist/activity`, {
      headers: { cookie: session.cookie },
    });
    expect(missing.status).toBe(404);
  });

  it("returns 400 INVALID_ACTIVITY_CURSOR for a cursor that will not decode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail work item activity 400 тест "));
    directories.push(directory);
    const workItemId = await seedReadyWorkItem(directory);
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(directory, "state.sqlite"),
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });
    const session = await authenticate(daemon, token);
    // A cursor that is not even well-formed base64url/JSON/shape is refused, not silently treated
    // as "no cursor" -- a regression here would quietly restart the feed instead of telling the
    // caller their own cursor was rejected.
    const malformedCursor = await fetch(
      `${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity?after=not-a-real-cursor!!`,
      { headers: { cookie: session.cookie } },
    );
    expect(malformedCursor.status).toBe(400);
    apiErrorResponseSchema.parse(await malformedCursor.json());
  });

  it("answers a valid request with cache-control: no-store and x-content-type-options: nosniff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loomrail work item activity headers тест "));
    directories.push(directory);
    const workItemId = await seedReadyWorkItem(directory);
    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(directory, "state.sqlite"),
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });
    const session = await authenticate(daemon, token);
    const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const page = agentRunActivityPageSchema.parse(await response.json());
    expect(page.entries).toEqual([]);
    expect(page.gap).toBe(false);
    expect(page.degraded).toBe(false);
  });

  it("resolves every referenced AgentRun's stage from its own pipeline run, not just the WorkItem's latest one, once the WorkItem has completed a pipeline and started a second", async () => {
    // The critical fix this round: a WorkItem is allowed to start a second pipeline once its first
    // one is no longer active (IN_PROGRESS -> READY is an allowed WorkItem transition --
    // packages/domain/src/index.ts -- and completing a pipeline leaves the WorkItem itself
    // IN_PROGRESS untouched -- packages/domain/src/workflow.ts's ApplyProviderOutcome COMPLETED
    // branch returns `workItem: context.workItem` unchanged when there is no next stage). Before this
    // fix, GET_WORKFLOW_SNAPSHOT's `stageAttempts` -- scoped to the WorkItem's *latest* pipeline run
    // only -- could not resolve the first run's own stage, and the route threw a 500
    // PERSISTENCE_FAILURE for the WorkItem's entire activity page, permanently, breaking spec 128's
    // whole reason for existing: an action from an earlier stage staying visible after the pipeline
    // moves on.
    const directory = await mkdtemp(join(tmpdir(), "loomrail work item activity multi pipeline тест "));
    directories.push(directory);
    const state = await openState(directory);

    const discoveryOnlyTemplate: WorkflowTemplate = {
      schemaVersion: 1,
      id: "work-item-activity-discovery-only",
      version: 1,
      name: "Discovery only",
      stages: [{ stage: "DISCOVERY", ordinal: 0, contextPack }],
    };
    const planOnlyTemplate: WorkflowTemplate = {
      schemaVersion: 1,
      id: "work-item-activity-plan-only",
      version: 1,
      name: "Plan only",
      stages: [{ stage: "PLAN", ordinal: 0, contextPack }],
    };

    let workItemId: string;
    let firstAgentRunId: string;
    let secondAgentRunId: string;
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
          name: "Work item activity multi-pipeline fixture",
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
          title: "Cross a pipeline-run boundary",
          description: "Synthetic fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: ["An earlier pipeline run's activity stays visible"],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      workItemId = created.workItem.id;
      state.execute({
        schemaVersion: 1,
        commandId: "ready-work-item",
        correlationId: "correlation-ready-work-item",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: { workItemId, expectedVersion: 1, targetState: "READY" },
      });

      // Pipeline 1: a single DISCOVERY stage, run to completion.
      const pipeline1 = state.execute({
        schemaVersion: 1,
        commandId: "start-pipeline-1",
        correlationId: "correlation-start-pipeline-1",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId,
          expectedVersion: 2,
          template: discoveryOnlyTemplate,
          budget: { maxEstimatedTokens: 200_000, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (pipeline1.type !== "PIPELINE_STARTED") throw new Error("Expected first pipeline start");
      const agent1 = state.execute({
        schemaVersion: 1,
        commandId: "start-agent-run-1",
        correlationId: "correlation-start-agent-run-1",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: pipeline1.dispatch.id,
          provider: "CODEX",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (agent1.type !== "AGENT_RUN_STARTED") throw new Error("Expected first AgentRun start");
      firstAgentRunId = agent1.run.id;
      const session1 = state.execute({
        schemaVersion: 1,
        commandId: "start-provider-session-1",
        correlationId: "correlation-start-provider-session-1",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "START_PROVIDER_SESSION",
        payload: {
          stageAttemptId: pipeline1.stageAttempt.id,
          recipe: {
            schemaVersion: 1,
            templateId: discoveryOnlyTemplate.id,
            templateVersion: discoveryOnlyTemplate.version,
            specSource: "ROLE_PLAYBOOK",
            roleProfile: { id: agent1.run.profile.id, revision: agent1.run.profile.revision },
            sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
            omitted: [],
            contentHash: `sha256:${"a".repeat(64)}`,
            estimatedTokens: 10,
            budgetTokens: 100,
            estimateQuality: "LOOMRAIL_ESTIMATE",
          },
        },
      });
      if (session1.type !== "PROVIDER_SESSION_STARTED")
        throw new Error("Expected first ProviderSession start");

      // One audited entry on run 1, so its own contribution to the merged page is verifiable once
      // the pipeline that made it has long since finished.
      const startedCall1 = state.execute({
        schemaVersion: 1,
        commandId: "workspace-tool-start-1",
        correlationId: "correlation-workspace-tool-1",
        actor: { type: "SYSTEM", id: "workspace-executor" },
        type: "START_WORKSPACE_TOOL_CALL",
        payload: {
          providerSessionId: session1.session.id,
          providerCallKey: "a".repeat(64),
          operation: "READ_FILE",
          target: "src/index.ts",
          policyDigest: "b".repeat(64),
          inputDigest: "c".repeat(64),
        },
      });
      if (startedCall1.type !== "WORKSPACE_TOOL_CALL_CHANGED") throw new Error("Expected tool reservation");
      state.execute({
        schemaVersion: 1,
        commandId: "workspace-tool-finish-1",
        correlationId: "correlation-workspace-tool-1",
        actor: { type: "SYSTEM", id: "workspace-executor" },
        type: "FINISH_WORKSPACE_TOOL_CALL",
        payload: {
          callId: startedCall1.call.id,
          outcome: { status: "SUCCEEDED", outputDigest: "d".repeat(64), outputBytes: 128, exitCode: null },
        },
      });
      state.execute({
        schemaVersion: 1,
        commandId: "activity-1",
        correlationId: "correlation-agent-run-activity-1",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "RECORD_AGENT_RUN_ACTIVITY",
        payload: {
          agentRunId: firstAgentRunId,
          providerSessionId: session1.session.id,
          provider: "CODEX",
          entry: {
            actionKey: "provider-reported-1",
            kind: "AGENT_TEXT",
            label: null,
            detail: "Discovery notes",
            status: null,
            terminal: true,
            truncated: false,
          },
        },
      });

      // Completes pipeline 1 outright (single-stage template -> nextStage === null): the WorkItem
      // itself is left IN_PROGRESS, not moved to DONE.
      state.execute({
        schemaVersion: 1,
        commandId: "complete-discovery-1",
        correlationId: "correlation-complete-discovery-1",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: pipeline1.dispatch.id,
          provider: "CODEX",
          outcome: { type: "COMPLETED", summary: "Discovery is complete." },
          template: discoveryOnlyTemplate,
          resultTree: null,
          sessionCompletion: { providerSessionId: session1.session.id, usage: null },
        },
      });

      // The reproduction: no cancellation, no rejection -- just READY again, then a second pipeline.
      state.execute({
        schemaVersion: 1,
        commandId: "ready-work-item-again",
        correlationId: "correlation-ready-work-item-again",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: { workItemId, expectedVersion: 3, targetState: "READY" },
      });
      const pipeline2 = state.execute({
        schemaVersion: 1,
        commandId: "start-pipeline-2",
        correlationId: "correlation-start-pipeline-2",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId,
          expectedVersion: 4,
          template: planOnlyTemplate,
          budget: { maxEstimatedTokens: 200_000, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (pipeline2.type !== "PIPELINE_STARTED") throw new Error("Expected second pipeline start");
      const agent2 = state.execute({
        schemaVersion: 1,
        commandId: "start-agent-run-2",
        correlationId: "correlation-start-agent-run-2",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: pipeline2.dispatch.id,
          provider: "CODEX",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (agent2.type !== "AGENT_RUN_STARTED") throw new Error("Expected second AgentRun start");
      secondAgentRunId = agent2.run.id;
      const session2 = state.execute({
        schemaVersion: 1,
        commandId: "start-provider-session-2",
        correlationId: "correlation-start-provider-session-2",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "START_PROVIDER_SESSION",
        payload: {
          stageAttemptId: pipeline2.stageAttempt.id,
          recipe: {
            schemaVersion: 1,
            templateId: planOnlyTemplate.id,
            templateVersion: planOnlyTemplate.version,
            specSource: "ROLE_PLAYBOOK",
            roleProfile: { id: agent2.run.profile.id, revision: agent2.run.profile.revision },
            sections: [{ id: "WORK_ITEM_BRIEF", sources: [], bytes: 10 }],
            omitted: [],
            contentHash: `sha256:${"a".repeat(64)}`,
            estimatedTokens: 10,
            budgetTokens: 100,
            estimateQuality: "LOOMRAIL_ESTIMATE",
          },
        },
      });
      if (session2.type !== "PROVIDER_SESSION_STARTED")
        throw new Error("Expected second ProviderSession start");
      state.execute({
        schemaVersion: 1,
        commandId: "activity-2",
        correlationId: "correlation-agent-run-activity-2",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "RECORD_AGENT_RUN_ACTIVITY",
        payload: {
          agentRunId: secondAgentRunId,
          providerSessionId: session2.session.id,
          provider: "CODEX",
          entry: {
            actionKey: "provider-reported-2",
            kind: "AGENT_TEXT",
            label: null,
            detail: "Plan notes",
            status: null,
            terminal: true,
            truncated: false,
          },
        },
      });
      // Completes pipeline 2's session too -- otherwise it is still RUNNING when this process exits,
      // and startDaemon's own startup reconciliation (RECONCILE_WORKFLOWS) honestly marks an
      // interrupted session's run degraded, the same way a real crash-and-restart would. Leaving that
      // in would make `degraded` below prove nothing about the fix this test targets.
      state.execute({
        schemaVersion: 1,
        commandId: "complete-plan-2",
        correlationId: "correlation-complete-plan-2",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: pipeline2.dispatch.id,
          provider: "CODEX",
          outcome: { type: "COMPLETED", summary: "Plan is complete." },
          template: planOnlyTemplate,
          resultTree: null,
          sessionCompletion: { providerSessionId: session2.session.id, usage: null },
        },
      });
    } finally {
      state.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(directory, "state.sqlite"),
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });
    const session = await authenticate(daemon, token);
    const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity`, {
      headers: { cookie: session.cookie },
    });
    // Before the fix: 500 PERSISTENCE_FAILURE, permanently, for this WorkItem's whole activity page.
    expect(response.status).toBe(200);
    const page = agentRunActivityPageSchema.parse(await response.json());
    expect(page.degraded).toBe(false);
    expect(page.entries).toHaveLength(3);
    const byRun = new Map(page.entries.map((entry) => [entry.agentRunId, entry.stage]));
    // Each run's stage comes from its OWN pipeline run -- proof this is not just "the WorkItem's
    // current stage" applied to every entry regardless of which run produced it.
    expect(byRun.get(firstAgentRunId)).toBe("DISCOVERY");
    expect(byRun.get(secondAgentRunId)).toBe("PLAN");
  });

  it("flags the page degraded when an audited call's own run has no live provider, even though the reported side is not degraded", async () => {
    // Targets the OR-combination the reviewer found mutation-invisible: `degraded` must reflect the
    // AUDITED side's own contribution (a MOCK-provider run's orphaned workspace tool calls,
    // resolveAuditedCallsForRead), not only the REPORTED side's own aggregate flag. Nothing here
    // issues MARK_AGENT_RUN_ACTIVITY_DEGRADED or writes an `agent_run_activity_state` row at all, so
    // a passing assertion here cannot be explained by the reported side.
    const directory = await mkdtemp(join(tmpdir(), "loomrail work item activity mock degraded тест "));
    directories.push(directory);
    const state = await openState(directory);
    const template: WorkflowTemplate = {
      schemaVersion: 1,
      id: "work-item-activity-mock-degraded",
      version: 1,
      name: "Mock provider degraded",
      stages: [{ stage: "DISCOVERY", ordinal: 0, contextPack }],
    };

    let workItemId: string;
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
          name: "Work item activity MOCK-provider fixture",
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
          title: "Orphan a MOCK run's audited calls",
          description: "Synthetic fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: ["A MOCK run's audited calls degrade the page, not fail it"],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      workItemId = created.workItem.id;
      state.execute({
        schemaVersion: 1,
        commandId: "ready-work-item",
        correlationId: "correlation-ready-work-item",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: { workItemId, expectedVersion: 1, targetState: "READY" },
      });
      const pipeline = state.execute({
        schemaVersion: 1,
        commandId: "start-pipeline",
        correlationId: "correlation-start-pipeline",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId,
          expectedVersion: 2,
          template,
          budget: { maxEstimatedTokens: 200_000, warningThresholds: [0.5, 0.8, 0.95] },
        },
      });
      if (pipeline.type !== "PIPELINE_STARTED") throw new Error("Expected pipeline start");
      // Nothing in production drives a MOCK session through the real workspace-tool gateway (see
      // agent-run-activity.ts's own doc comments), but nothing at the command-store level forbids
      // it either -- this is exactly the "historical data / fixture" shape
      // `resolveAuditedCallsForRead` exists to degrade rather than 500 on.
      const agent = state.execute({
        schemaVersion: 1,
        commandId: "start-agent-run",
        correlationId: "correlation-start-agent-run",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: pipeline.dispatch.id,
          provider: "MOCK",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (agent.type !== "AGENT_RUN_STARTED") throw new Error("Expected AgentRun start");
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
            templateId: template.id,
            templateVersion: template.version,
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
      const started = state.execute({
        schemaVersion: 1,
        commandId: "workspace-tool-start",
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
      if (started.type !== "WORKSPACE_TOOL_CALL_CHANGED") throw new Error("Expected tool reservation");
      state.execute({
        schemaVersion: 1,
        commandId: "workspace-tool-finish",
        correlationId: "correlation-workspace-tool",
        actor: { type: "SYSTEM", id: "workspace-executor" },
        type: "FINISH_WORKSPACE_TOOL_CALL",
        payload: {
          callId: started.call.id,
          outcome: { status: "SUCCEEDED", outputDigest: "d".repeat(64), outputBytes: 128, exitCode: null },
        },
      });
      // Completes the run's session -- otherwise it is still RUNNING when this process exits, and
      // startDaemon's own startup reconciliation (RECONCILE_WORKFLOWS) honestly marks an interrupted
      // session's run degraded on its own account. Without this, `page.degraded` below would read
      // `true` regardless of whether the audited-side OR term this test targets is even present --
      // exactly the kind of fixture that cannot tell a real guard from a broken one.
      state.execute({
        schemaVersion: 1,
        commandId: "complete-discovery",
        correlationId: "correlation-complete-discovery",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: pipeline.dispatch.id,
          provider: "MOCK",
          outcome: { type: "COMPLETED", summary: "Discovery is complete." },
          template,
          resultTree: null,
          sessionCompletion: { providerSessionId: session.session.id, usage: null },
        },
      });
    } finally {
      state.close();
    }

    const token = bootstrapToken();
    daemon = await startDaemon({
      bootstrapToken: token,
      logger: false,
      stateDatabasePath: join(directory, "state.sqlite"),
      verificationArtifactsDirectory: join(directory, "verification-output"),
    });
    const session = await authenticate(daemon, token);
    const response = await fetch(`${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const page = agentRunActivityPageSchema.parse(await response.json());
    expect(page.degraded).toBe(true);
    // The orphaned audited call is dropped from the page, not shown mislabelled with a guessed
    // provider.
    expect(page.entries).toEqual([]);
  });

  it("flags gap instead of silently truncating when a run of same-timestamp entries outlasts the fetch window", async () => {
    // Fix round 2, reproduced through the real route: 250 reported rows sharing one observed_at
    // millisecond outlast the 201-row-per-source fetch window this route uses per page
    // (MAX_ACTIVITY_PAGE_SIZE + 1). The caller's `>= cursor.at` filter (deliberately inclusive, see
    // the query's own comment in packages/persistence-sqlite/src/index.ts) re-reads the identical
    // first 201 rows on every later page, unable to ever slide past the tie -- before this fix, the
    // feed ended 49 rows short with `gap: false`, `degraded: false`, `nextCursor: null`, a silent
    // hole. `buildAgentRunActivityPage`'s own new guard (agent-run-activity.ts) now flags `gap`
    // instead. This is the reviewer's own reproduction; 200+ same-millisecond collisions are not
    // expected in production (each RECORD_AGENT_RUN_ACTIVITY entry is its own transaction), but the
    // guard has to hold regardless of how implausible the trigger is.
    const directory = await mkdtemp(join(tmpdir(), "loomrail work item activity tied timestamps тест "));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    // Frozen, not ticking (unlike `openState`'s own strictly-increasing clock): every entry below
    // shares this exact instant.
    const frozenAt = new Date(timestamp);
    let nextId = 0;
    const state = await openLocalState({
      databasePath,
      now: () => frozenAt,
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
    const template: WorkflowTemplate = {
      schemaVersion: 1,
      id: "work-item-activity-tied-timestamps",
      version: 1,
      name: "Tied timestamps",
      stages: [{ stage: "DISCOVERY", ordinal: 0, contextPack }],
    };
    let workItemId: string;
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
          name: "Work item activity tied-timestamps fixture",
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
          title: "Outlast the fetch window with tied timestamps",
          description: "Synthetic fixture",
          priority: "MEDIUM",
          risk: "LOW",
          acceptanceCriteria: ["A tie thicker than one page still tells the owner about the hole"],
        },
      });
      if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
      workItemId = created.workItem.id;
      state.execute({
        schemaVersion: 1,
        commandId: "ready-work-item",
        correlationId: "correlation-ready-work-item",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "MOVE_WORK_ITEM",
        payload: { workItemId, expectedVersion: 1, targetState: "READY" },
      });
      const pipeline = state.execute({
        schemaVersion: 1,
        commandId: "start-pipeline",
        correlationId: "correlation-start-pipeline",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "START_MOCK_PIPELINE",
        payload: {
          workItemId,
          expectedVersion: 2,
          template,
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
            templateId: template.id,
            templateVersion: template.version,
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

      for (let index = 0; index < 250; index += 1) {
        state.execute({
          schemaVersion: 1,
          commandId: `activity-${index.toString()}`,
          correlationId: "correlation-agent-run-activity",
          actor: { type: "SYSTEM", id: "session-loop" },
          type: "RECORD_AGENT_RUN_ACTIVITY",
          payload: {
            agentRunId: agent.run.id,
            providerSessionId: session.session.id,
            provider: "CODEX",
            entry: {
              actionKey: `tied-${index.toString()}`,
              kind: "AGENT_TEXT",
              label: null,
              detail: `Entry ${index.toString()}`,
              status: null,
              terminal: true,
              truncated: false,
            },
          },
        });
      }

      // Completes the session so startDaemon's own startup reconciliation does not mark this run
      // degraded on its own account -- unrelated to what this test proves, and would make
      // `degraded` in the assertions below ambiguous.
      state.execute({
        schemaVersion: 1,
        commandId: "complete-discovery",
        correlationId: "correlation-complete-discovery",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: pipeline.dispatch.id,
          provider: "CODEX",
          outcome: { type: "COMPLETED", summary: "Discovery is complete." },
          template,
          resultTree: null,
          sessionCompletion: { providerSessionId: session.session.id, usage: null },
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
    const session = await authenticate(daemon, token);

    // Walks pages the way a well-behaved client does: a page flagging `gap: true` is a restart, not
    // a continuation (the same contract eviction-caused gaps already carried before this fix round),
    // so this stops there rather than keep summing entries across it -- the gap-rewind fallback
    // (server.ts) legitimately re-serves entries a client already saw, and a client that kept
    // blindly following `nextCursor` past a flagged gap here would just replay the same rewound page
    // forever, which is a client-side bug this test is not the place to reproduce.
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const url =
        cursor === null
          ? `${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity`
          : `${daemon.baseUrl}/api/v1/work-items/${workItemId}/activity?after=${encodeURIComponent(cursor)}`;
      const response = await fetch(url, { headers: { cookie: session.cookie } });
      expect(response.status).toBe(200);
      const body = agentRunActivityPageSchema.parse(await response.json());
      for (const entry of body.entries) seenIds.add(entry.id);
      if (body.gap) {
        // Reached: the fix converted what would have been a silent `nextCursor: null` false-
        // completeness claim into an honest signal instead. That is what this test exists to prove.
        return;
      }
      if (body.nextCursor === null) {
        // The exact silent-hole shape the reviewer reproduced: nothing said `gap` here, so every
        // entry must genuinely have been served, or this is the hole this fix round closes.
        expect(seenIds.size).toBe(250);
        return;
      }
      cursor = body.nextCursor;
    }
    throw new Error("Expected the feed to either flag a gap or terminate within 4 pages");
  });
});
