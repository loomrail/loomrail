import type { ProviderId, WorkItem } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import {
  MAX_SCHEDULER_CANDIDATES,
  SchedulerPlanningError,
  agentRunClaimLimits,
  planDispatchBatch,
  validateSchedulerLimits,
  type ActiveAgentRun,
  type SchedulerCandidate,
  type SchedulerLimits,
  type SchedulerWorkspaceClaim,
} from "../src/index.js";

const noWorkspace = (): SchedulerWorkspaceClaim => ({ type: "NONE" });

const workspace = (
  workspaceId: string,
  access: "READ_ONLY" | "READ_WRITE",
  checkpoint: string | null = "tree-1",
): SchedulerWorkspaceClaim => ({ type: "WORKSPACE", workspaceId, access, checkpoint });

const candidate = (
  id: string,
  overrides: {
    stageAttemptId?: string;
    projectId?: string;
    provider?: ProviderId;
    priority?: WorkItem["priority"];
    createdAt?: string;
    ready?: boolean;
    budgetAllowed?: boolean;
    requiresStableCheckpoint?: boolean;
    workspace?: SchedulerWorkspaceClaim;
  } = {},
): SchedulerCandidate => ({
  dispatchId: `dispatch-${id}`,
  stageAttemptId: overrides.stageAttemptId ?? `attempt-${id}`,
  projectId: overrides.projectId ?? "project-1",
  provider: overrides.provider ?? "CODEX",
  priority: overrides.priority ?? "MEDIUM",
  createdAt: overrides.createdAt ?? "2026-09-01T10:00:00.000Z",
  ready: overrides.ready ?? true,
  budgetAllowed: overrides.budgetAllowed ?? true,
  requiresStableCheckpoint: overrides.requiresStableCheckpoint ?? false,
  workspace: overrides.workspace ?? noWorkspace(),
});

const activeRun = (
  id: string,
  overrides: {
    stageAttemptId?: string;
    projectId?: string;
    provider?: ProviderId;
    workspace?: SchedulerWorkspaceClaim;
  } = {},
): ActiveAgentRun => ({
  agentRunId: `agent-run-${id}`,
  stageAttemptId: overrides.stageAttemptId ?? `active-attempt-${id}`,
  projectId: overrides.projectId ?? "project-1",
  provider: overrides.provider ?? "CODEX",
  workspace: overrides.workspace ?? noWorkspace(),
});

describe("dispatch batch planning", () => {
  it("validates configuration once and resolves exact transactional claim limits", () => {
    const limits = validateSchedulerLimits({
      global: 6,
      defaultProject: 2,
      defaultProvider: 4,
      projects: { "project-narrow": 1 },
      providers: { CODEX: 3 },
    });

    expect(agentRunClaimLimits(limits, "project-narrow", "CODEX")).toEqual({
      global: 6,
      project: 1,
      provider: 3,
    });
    expect(agentRunClaimLimits(limits, "project-other", "MOCK")).toEqual({
      global: 6,
      project: 2,
      provider: 4,
    });
    expect(() => validateSchedulerLimits({ providers: { CODEX: 33 } })).toThrow(SchedulerPlanningError);
    expect(() =>
      validateSchedulerLimits({ providers: { UNKNOWN: 1 } } as unknown as SchedulerLimits),
    ).toThrow(/unknown scope/u);
  });

  it("selects at most the default three runs in priority, age and id order", () => {
    const plan = planDispatchBatch({
      candidates: [
        candidate("low", { priority: "LOW", createdAt: "2026-09-01T08:00:00.000Z" }),
        candidate("urgent-new", { priority: "URGENT", createdAt: "2026-09-01T10:00:00.000Z" }),
        candidate("urgent-old", { priority: "URGENT", createdAt: "2026-09-01T09:00:00.000Z" }),
        candidate("high", { priority: "HIGH" }),
      ],
      activeRuns: [],
    });

    expect(plan.selectedDispatchIds).toEqual(["dispatch-urgent-old", "dispatch-urgent-new", "dispatch-high"]);
    expect(plan.deferred).toEqual([{ dispatchId: "dispatch-low", reason: "GLOBAL_LIMIT" }]);
  });

  it("accounts for active runs and applies project and provider overrides independently", () => {
    const plan = planDispatchBatch({
      candidates: [
        candidate("same-project", { projectId: "project-1", provider: "CLAUDE_CODE" }),
        candidate("same-provider", { projectId: "project-2", provider: "CODEX" }),
        candidate("free", { projectId: "project-3", provider: "MOCK" }),
      ],
      activeRuns: [activeRun("existing")],
      limits: {
        global: 4,
        projects: { "project-1": 1 },
        providers: { CODEX: 1 },
      },
    });

    expect(plan.selectedDispatchIds).toEqual(["dispatch-free"]);
    expect(plan.deferred).toEqual([
      { dispatchId: "dispatch-same-project", reason: "PROJECT_LIMIT" },
      { dispatchId: "dispatch-same-provider", reason: "PROVIDER_LIMIT" },
    ]);
  });

  it("treats zero as an explicit pause for new runs", () => {
    const plan = planDispatchBatch({
      candidates: [candidate("one")],
      activeRuns: [],
      limits: { global: 0 },
    });

    expect(plan).toEqual({
      selectedDispatchIds: [],
      deferred: [{ dispatchId: "dispatch-one", reason: "GLOBAL_LIMIT" }],
    });
  });

  it("allows readers of one checkpoint and conflicts a writer with every same-workspace run", () => {
    const plan = planDispatchBatch({
      candidates: [
        candidate("reader-same", {
          workspace: workspace("workspace-1", "READ_ONLY", "tree-1"),
          requiresStableCheckpoint: true,
        }),
        candidate("reader-other-tree", {
          workspace: workspace("workspace-1", "READ_ONLY", "tree-2"),
          requiresStableCheckpoint: true,
        }),
        candidate("writer", { workspace: workspace("workspace-1", "READ_WRITE", null) }),
        candidate("other-workspace", { workspace: workspace("workspace-2", "READ_WRITE", null) }),
      ],
      activeRuns: [activeRun("reader", { workspace: workspace("workspace-1", "READ_ONLY", "tree-1") })],
      limits: { global: 5, defaultProject: 5, defaultProvider: 5 },
    });

    expect(plan.selectedDispatchIds).toEqual(["dispatch-other-workspace", "dispatch-reader-same"]);
    expect(plan.deferred).toEqual([
      { dispatchId: "dispatch-reader-other-tree", reason: "WORKSPACE_CONFLICT" },
      { dispatchId: "dispatch-writer", reason: "WORKSPACE_CONFLICT" },
    ]);
  });

  it("defers readiness, budget, checkpoint and active-attempt gates before capacity", () => {
    const plan = planDispatchBatch({
      candidates: [
        candidate("not-ready", { ready: false }),
        candidate("budget", { budgetAllowed: false }),
        candidate("checkpoint", {
          requiresStableCheckpoint: true,
          workspace: workspace("workspace-1", "READ_ONLY", null),
        }),
        candidate("active", { stageAttemptId: "active-attempt-one" }),
      ],
      activeRuns: [activeRun("one")],
      limits: { global: 1 },
    });

    expect(plan.selectedDispatchIds).toEqual([]);
    expect(plan.deferred).toEqual([
      { dispatchId: "dispatch-active", reason: "ATTEMPT_ACTIVE" },
      { dispatchId: "dispatch-budget", reason: "BUDGET_BLOCKED" },
      { dispatchId: "dispatch-checkpoint", reason: "CHECKPOINT_NOT_STABLE" },
      { dispatchId: "dispatch-not-ready", reason: "NOT_READY" },
    ]);
  });

  it("is deterministic and does not mutate caller-owned arrays", () => {
    const candidates = [
      candidate("b", { createdAt: "2026-09-01T10:00:00.000Z" }),
      candidate("a", { createdAt: "2026-09-01T10:00:00.000Z" }),
    ];
    const before = [...candidates];

    const first = planDispatchBatch({ candidates, activeRuns: [] });
    const second = planDispatchBatch({ candidates, activeRuns: [] });

    expect(first).toEqual(second);
    expect(candidates).toEqual(before);
    expect(first.selectedDispatchIds).toEqual(["dispatch-a", "dispatch-b"]);
  });

  it("fails closed on duplicate identity, unbounded input and invalid limits", () => {
    expect(() =>
      planDispatchBatch({ candidates: [candidate("one"), candidate("one")], activeRuns: [] }),
    ).toThrow(SchedulerPlanningError);

    expect(() =>
      planDispatchBatch({
        candidates: [
          candidate("candidate-a", { stageAttemptId: "shared-attempt" }),
          candidate("candidate-b", { stageAttemptId: "shared-attempt" }),
        ],
        activeRuns: [],
      }),
    ).toThrow(/duplicate candidate StageAttempt/u);

    expect(() =>
      planDispatchBatch({
        candidates: Array.from({ length: MAX_SCHEDULER_CANDIDATES + 1 }, (_, index) =>
          candidate(String(index)),
        ),
        activeRuns: [],
      }),
    ).toThrow(/not bounded/u);

    expect(() =>
      planDispatchBatch({ candidates: [candidate("one")], activeRuns: [], limits: { global: -1 } }),
    ).toThrow(/limit is invalid/u);
  });
});
