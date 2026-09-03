import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentFleetResponseSchema,
  type ProviderId,
  type WorkflowStage,
  type WorkflowTemplate,
} from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { validateSchedulerLimits } from "@loomrail/scheduler";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAgentFleet } from "../src/agent-fleet.js";
import { readAgentSchedulingSnapshot } from "../src/agent-scheduling.js";
import { startDaemon, type RunningDaemon } from "../src/server.js";
import { gatedAdapter } from "./gated-adapter.js";
import { seedQueuedAttempt } from "./state-fixtures.js";

const timestamp = "2026-09-02T00:00:00.000Z";

describe("Agent Fleet projection", () => {
  let temporaryDirectory = "";
  let databasePath = "";
  let state: LocalState | undefined;
  let daemon: RunningDaemon | undefined;
  let nextId = 0;
  let nextCommandId = 0;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail agent fleet "));
    databasePath = join(temporaryDirectory, "state.sqlite");
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await daemon?.close();
    daemon = undefined;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const open = async (): Promise<LocalState> => {
    state = await openLocalState({
      databasePath,
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString().padStart(4, "0")}`,
    });
    return state;
  };
  const createCommandId = (): string => `command-${(nextCommandId += 1).toString()}`;

  it("projects a durable running role and a machine-readable capacity wait after reopen", async () => {
    const localState = await open();
    const first = seedQueuedAttempt(localState, createCommandId, temporaryDirectory);
    const second = seedQueuedAttempt(localState, createCommandId, temporaryDirectory);
    const assignment = localState.query({
      type: "GET_SQUAD_ASSIGNMENT",
      pipelineRunId: first.dispatch.pipelineRunId,
    });
    if (assignment.type !== "SQUAD_ASSIGNMENT" || assignment.assignment === null) {
      throw new Error("Expected a durable SquadAssignment");
    }
    expect(assignment.assignment.stages).toContainEqual({
      stage: "DISCOVERY",
      profile: { id: "builtin.product-analyst", revision: 1, role: "PRODUCT_ANALYST" },
    });

    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "fleet-running",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: first.dispatch.id,
        provider: "CODEX",
        limits: { global: 1, project: 1, provider: 1 },
      },
    });
    const adapter = gatedAdapter(200_000, { provider: "CODEX" });
    const limits = validateSchedulerLimits({ global: 1, defaultProject: 1, defaultProvider: 1 });
    const project = (): ReturnType<typeof buildAgentFleet> =>
      buildAgentFleet({
        state: state ?? localState,
        resolveAdapter: () => adapter,
        schedulingLimits: limits,
      });

    const initialFleet = project();
    const runningAgentRunId = initialFleet.entries[0]?.agentRunId;
    if (runningAgentRunId === null || runningAgentRunId === undefined) {
      throw new Error("Expected the first Fleet row to identify its active AgentRun");
    }
    expect(runningAgentRunId).toMatch(/^agentRun-/);
    expect(initialFleet).toMatchObject({
      capacity: { active: 1, globalLimit: 1 },
      entries: [
        {
          agentRunId: runningAgentRunId,
          stageAttemptId: first.stageAttemptId,
          profile: { role: "PRODUCT_ANALYST" },
          stage: "DISCOVERY",
          provider: "CODEX",
          status: "RUNNING",
          waitReason: null,
        },
        {
          agentRunId: null,
          dispatchId: second.dispatch.id,
          profile: { role: "PRODUCT_ANALYST" },
          status: "WAITING",
          waitReason: "GLOBAL_LIMIT",
        },
      ],
    });

    localState.close();
    state = undefined;
    await open();
    expect(project()).toMatchObject({
      capacity: { active: 1, globalLimit: 1 },
      entries: [{ status: "RUNNING" }, { status: "WAITING", waitReason: "GLOBAL_LIMIT" }],
    });
  });

  it("routes an AUTO review away from the latest implementation author provider", async () => {
    const localState = await open();
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "review-routing-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_PROJECT",
      payload: {
        id: "project-review-routing",
        fixtureId: null,
        name: "Review routing",
        repositoryPath: temporaryDirectory,
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "review-routing-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: "project-review-routing",
        parentId: null,
        type: "TASK",
        title: "Route an independent review",
        description: "Synthetic scheduler fixture",
        priority: "HIGH",
        risk: "MEDIUM",
        acceptanceCriteria: ["The reviewer uses another ready provider"],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected WorkItem creation");
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "review-routing-ready",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const stages = mockDeliveryTemplate.stages.filter(
      ({ stage }) => stage === "IMPLEMENT" || stage === "REVIEW",
    );
    const template: WorkflowTemplate = {
      ...mockDeliveryTemplate,
      id: "review-routing-v1",
      version: 1,
      name: "Review routing",
      stages: stages.map((stage, ordinal) => ({ ...stage, ordinal })),
    };
    const started = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "review-routing-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template,
        budget: { maxEstimatedTokens: 100, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (started.type !== "PIPELINE_STARTED") throw new Error("Expected PipelineRun");
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "review-routing-author",
      actor: { type: "SYSTEM", id: "local-daemon" },
      type: "START_AGENT_RUN",
      payload: {
        dispatchId: started.dispatch.id,
        provider: "CODEX",
        limits: { global: 3, project: 3, provider: 3 },
      },
    });
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "review-routing-implemented",
      actor: { type: "SYSTEM", id: "codex-provider" },
      type: "APPLY_PROVIDER_OUTCOME",
      payload: {
        dispatchId: started.dispatch.id,
        provider: "CODEX",
        template,
        outcome: { type: "COMPLETED", summary: "Implementation ready for review." },
        resultTree: "a".repeat(40),
      },
    });
    const codex = gatedAdapter(200_000, { provider: "CODEX" });
    const claude = gatedAdapter(200_000, { provider: "CLAUDE_CODE" });
    const calls: {
      projectId: string;
      stage: WorkflowStage | undefined;
      avoidProvider: ProviderId | null | undefined;
    }[] = [];
    const scheduling = readAgentSchedulingSnapshot({
      state: localState,
      resolveAdapter: (projectId, stage, avoidProvider) => {
        calls.push({ projectId, stage, avoidProvider });
        return avoidProvider === "CODEX" ? claude : codex;
      },
    });

    expect(calls).toEqual([{ projectId: "project-review-routing", stage: "REVIEW", avoidProvider: "CODEX" }]);
    expect(scheduling.candidates).toMatchObject([{ provider: "CLAUDE_CODE" }]);
    expect([...scheduling.contexts.values()][0]?.adapter).toBe(claude);
  });

  it("projects queued Acceptance preparation as the bounded Acceptance Manager", async () => {
    const localState = await open();
    const acceptanceStage = mockDeliveryTemplate.stages.find(({ stage }) => stage === "ACCEPTANCE");
    if (acceptanceStage === undefined) throw new Error("Expected the Acceptance stage");
    const acceptanceTemplate: WorkflowTemplate = {
      ...mockDeliveryTemplate,
      id: "fleet-acceptance-v1",
      name: "Fleet acceptance",
      stages: [{ ...acceptanceStage, ordinal: 0 }],
    };
    const seeded = seedQueuedAttempt(
      localState,
      createCommandId,
      temporaryDirectory,
      "project-web",
      acceptanceTemplate,
    );
    const fleet = buildAgentFleet({
      state: localState,
      resolveAdapter: () => gatedAdapter(200_000, { provider: "CODEX" }),
      schedulingLimits: validateSchedulerLimits(),
    });

    expect(fleet).toMatchObject({
      capacity: { active: 0, globalLimit: 3 },
      entries: [
        {
          dispatchId: seeded.dispatch.id,
          stageAttemptId: seeded.stageAttemptId,
          agentRunId: null,
          profile: {
            id: "builtin.acceptance-manager",
            revision: 1,
            role: "ACCEPTANCE_MANAGER",
          },
          stage: "ACCEPTANCE",
          provider: "CODEX",
          status: "READY",
          waitReason: null,
        },
      ],
    });
  });

  it("keeps the Fleet endpoint authenticated and returns its bounded wire contract", async () => {
    const token = randomBytes(32).toString("base64url");
    daemon = await startDaemon({ bootstrapToken: token, logger: false });
    const unauthorized = await fetch(`${daemon.baseUrl}/api/v1/agent-fleet`);
    expect(unauthorized.status).toBe(401);

    const exchange = await fetch(`${daemon.baseUrl}/api/session/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: daemon.baseUrl },
      body: JSON.stringify({ bootstrapToken: token }),
    });
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("Expected an authenticated cookie");
    const response = await fetch(`${daemon.baseUrl}/api/v1/agent-fleet`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(agentFleetResponseSchema.parse(await response.json())).toEqual({
      schemaVersion: 1,
      entries: [],
      capacity: { active: 0, globalLimit: 3 },
    });
  });
});
