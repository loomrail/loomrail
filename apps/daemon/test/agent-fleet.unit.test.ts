import { describe, expect, it } from "vitest";

import type { AgentRun, Project, StageAttempt, WorkflowSnapshot, WorkItem } from "@loomrail/contracts";
import type {
  LatestAgentRunActivityEntry,
  LocalState,
  StateQuery,
  StateQueryResult,
} from "@loomrail/persistence-sqlite";
import { validateSchedulerLimits } from "@loomrail/scheduler";

import { buildAgentFleet } from "../src/agent-fleet.js";

// This suite proves the projection's wiring in isolation from SQLite: `buildAgentFleet` never
// queries a table by itself, only `state.query`, so a fake LocalState that answers each query type
// from an in-memory fixture exercises exactly the same code real persistence would drive --
// packages/persistence-sqlite/test/agent-run-activity.integration.test.ts owns proving the SQL
// underneath LIST_LATEST_AGENT_RUN_ACTIVITY itself reads back correctly (including the interleaved
// -sources case this file does not repeat). What this file is the right place to prove instead: the
// projection maps that read onto `latestAction` correctly, and it never turns "many running entries"
// into "one query per entry".

const timestamp = "2026-09-14T10:00:00.000Z";

const buildProject = (id: string): Project => ({
  schemaVersion: 1,
  id,
  workspaceId: "workspace-local",
  fixtureId: null,
  name: `Project ${id}`,
  repositoryPath: `/tmp/agent-fleet-fixture/${id}`,
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const buildWorkItem = (id: string, projectId: string): WorkItem => ({
  schemaVersion: 1,
  id,
  projectId,
  parentId: null,
  type: "TASK",
  title: `Work item ${id}`,
  description: "Fixture work item",
  state: "IN_PROGRESS",
  currentStage: "ACCEPTANCE",
  priority: "MEDIUM",
  risk: "LOW",
  acceptanceCriteria: ["Done"],
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});

// ACCEPTANCE deliberately: the one WorkflowStage that does not run in a worktree
// (stagesRunningInWorkspace in packages/domain), so the scheduler's own workspaceClaim() never
// queries GET_WORKSPACE_BY_WORK_ITEM and this fixture can stay free of a fourth query type to fake.
const buildStageAttempt = (
  id: string,
  run: { pipelineRunId: string; projectId: string; workItemId: string },
): StageAttempt => ({
  schemaVersion: 1,
  id,
  pipelineRunId: run.pipelineRunId,
  projectId: run.projectId,
  workItemId: run.workItemId,
  correctionRunId: null,
  verificationCorrectionRunId: null,
  stage: "ACCEPTANCE",
  attempt: 1,
  status: "RUNNING",
  version: 1,
  startedAt: timestamp,
  finishedAt: null,
  failureCode: null,
  unproductiveSessions: 0,
  packShareBackoffs: 0,
  resultTree: null,
});

const buildAgentRun = (
  id: string,
  run: { projectId: string; workItemId: string; stageAttemptId: string },
): AgentRun => ({
  schemaVersion: 1,
  id,
  projectId: run.projectId,
  workItemId: run.workItemId,
  pipelineRunId: `${id}-pipeline`,
  stageAttemptId: run.stageAttemptId,
  ordinal: 1,
  squadAssignmentId: `${id}-squad`,
  profile: { id: "builtin.developer", revision: 1, role: "DEVELOPER" },
  provider: "CODEX",
  status: "RUNNING",
  policySnapshot: null,
  policySnapshotHash: `sha256:${"a".repeat(64)}`,
  startedAt: timestamp,
  finishedAt: null,
  version: 1,
});

const buildWorkflowSnapshot = (stageAttempt: StageAttempt): WorkflowSnapshot => ({
  schemaVersion: 1,
  run: null,
  stageAttempts: [stageAttempt],
  humanRequests: [],
  decisions: [],
  budgetPolicies: [],
  usageRecords: [],
  recoveryReports: [],
  artifacts: [],
  acceptancePackage: null,
});

type Fixture = {
  project: Project;
  workItem: WorkItem;
  stageAttempt: StageAttempt;
  agentRun: AgentRun;
};

const buildFixture = (suffix: string): Fixture => {
  const project = buildProject(`project-${suffix}`);
  const workItem = buildWorkItem(`work-item-${suffix}`, project.id);
  const stageAttempt = buildStageAttempt(`stage-attempt-${suffix}`, {
    pipelineRunId: `pipeline-${suffix}`,
    projectId: project.id,
    workItemId: workItem.id,
  });
  const agentRun = buildAgentRun(`agent-run-${suffix}`, {
    projectId: project.id,
    workItemId: workItem.id,
    stageAttemptId: stageAttempt.id,
  });
  return { project, workItem, stageAttempt, agentRun };
};

// Builds a fake LocalState that answers exactly the query types buildAgentFleet and its
// readAgentSchedulingSnapshot dependency issue for a Fleet made only of RUNNING entries (no queued
// dispatches), and counts how many times each query type is asked -- the counter is what proves the
// N+1 test below.
const fakeState = (
  fixtures: readonly Fixture[],
  latestByRun: ReadonlyMap<string, LatestAgentRunActivityEntry>,
): { state: LocalState; callCounts: Map<StateQuery["type"], number> } => {
  const callCounts = new Map<StateQuery["type"], number>();
  const runs = fixtures.map((fixture) => fixture.agentRun);
  const query = (input: StateQuery): StateQueryResult => {
    callCounts.set(input.type, (callCounts.get(input.type) ?? 0) + 1);
    switch (input.type) {
      case "LIST_PENDING_DISPATCHES":
        return { type: "WORKFLOW_DISPATCHES", dispatches: [] };
      case "LIST_AGENT_RUNS":
        return { type: "AGENT_RUNS", runs };
      case "GET_PROJECT": {
        const fixture = fixtures.find(({ project }) => project.id === input.projectId);
        return { type: "PROJECT", project: fixture?.project ?? null };
      }
      case "GET_WORK_ITEM": {
        const fixture = fixtures.find(({ workItem }) => workItem.id === input.workItemId);
        return { type: "WORK_ITEM", workItem: fixture?.workItem ?? null };
      }
      case "GET_WORKFLOW_SNAPSHOT": {
        const fixture = fixtures.find(({ workItem }) => workItem.id === input.workItemId);
        if (fixture === undefined) throw new Error(`Unexpected workItemId ${input.workItemId}`);
        return { type: "WORKFLOW_SNAPSHOT", snapshot: buildWorkflowSnapshot(fixture.stageAttempt) };
      }
      case "LIST_LATEST_AGENT_RUN_ACTIVITY": {
        const entries = input.agentRunIds
          .map((agentRunId) => latestByRun.get(agentRunId))
          .filter((entry): entry is LatestAgentRunActivityEntry => entry !== undefined);
        return { type: "LATEST_AGENT_RUN_ACTIVITY", entries };
      }
      default:
        throw new Error(`Unexpected query ${input.type}`);
    }
  };
  return {
    callCounts,
    state: {
      startup: { appliedMigrations: [] },
      execute: (command) => {
        throw new Error(`Unexpected command ${command.type}`);
      },
      query,
      close: () => undefined,
    },
  };
};

const limits = validateSchedulerLimits({ global: 5, defaultProject: 5, defaultProvider: 5 });
const resolveAdapter = (): never => {
  throw new Error("resolveAdapter should not be called: this fixture has no pending dispatches");
};

describe("buildAgentFleet latestAction", () => {
  it("reports the latest action of a running entry and null when there is none", () => {
    const withActivity = buildFixture("1");
    const withoutActivity = buildFixture("2");
    const latestByRun = new Map<string, LatestAgentRunActivityEntry>([
      [
        withActivity.agentRun.id,
        {
          agentRunId: withActivity.agentRun.id,
          id: "activity-1",
          at: "2026-09-14T10:05:00.000Z",
          origin: "PROVIDER_REPORTED",
          label: "pnpm test",
          detail: null,
          status: null,
        },
      ],
    ]);
    const { state } = fakeState([withActivity, withoutActivity], latestByRun);

    const fleet = buildAgentFleet({ state, resolveAdapter, schedulingLimits: limits });

    const active = fleet.entries.find((entry) => entry.agentRunId === withActivity.agentRun.id);
    const idle = fleet.entries.find((entry) => entry.agentRunId === withoutActivity.agentRun.id);
    expect(active?.latestAction).toEqual({ label: "pnpm test", origin: "PROVIDER_REPORTED" });
    expect(idle?.latestAction).toBeNull();
  });

  it("falls back to detail, then status, when a reported entry has no label", () => {
    const fixture = buildFixture("1");
    const latestByRun = new Map<string, LatestAgentRunActivityEntry>([
      [
        fixture.agentRun.id,
        {
          agentRunId: fixture.agentRun.id,
          id: "activity-1",
          at: "2026-09-14T10:05:00.000Z",
          origin: "DAEMON_AUDITED",
          label: null,
          detail: "src/index.ts",
          status: "SUCCEEDED",
        },
      ],
    ]);
    const { state } = fakeState([fixture], latestByRun);

    const fleet = buildAgentFleet({ state, resolveAdapter, schedulingLimits: limits });

    expect(fleet.entries[0]?.latestAction).toEqual({ label: "src/index.ts", origin: "DAEMON_AUDITED" });
  });

  // The mistake this test exists to catch: an implementation that loops over the running entries
  // and issues LIST_LATEST_AGENT_RUN_ACTIVITY once per run instead of once for the whole batch. Two
  // running entries and a call count of 1 is the only way to fail this for the right reason.
  it("reads many running entries' latest actions in a single query, not one per entry", () => {
    const first = buildFixture("1");
    const second = buildFixture("2");
    const { state, callCounts } = fakeState([first, second], new Map());

    const fleet = buildAgentFleet({ state, resolveAdapter, schedulingLimits: limits });

    expect(fleet.entries).toHaveLength(2);
    expect(callCounts.get("LIST_LATEST_AGENT_RUN_ACTIVITY")).toBe(1);
  });

  it("never queries latest activity when there are no running entries", () => {
    const { state, callCounts } = fakeState([], new Map());

    const fleet = buildAgentFleet({ state, resolveAdapter, schedulingLimits: limits });

    expect(fleet.entries).toHaveLength(0);
    expect(callCounts.has("LIST_LATEST_AGENT_RUN_ACTIVITY")).toBe(false);
  });
});
