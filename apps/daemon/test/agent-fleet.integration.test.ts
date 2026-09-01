import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentFleetResponseSchema } from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { validateSchedulerLimits } from "@loomrail/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAgentFleet } from "../src/agent-fleet.js";
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
