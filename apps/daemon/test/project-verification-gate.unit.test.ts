import type {
  Project,
  StateCommand,
  StateCommandResult,
  VerificationCheck,
  VerificationPlan,
  VerificationPlanPublication,
  VerificationRun,
  WorkItem,
  WorkflowDispatch,
} from "@loomrail/contracts";
import type { LocalState, StateQueryResult } from "@loomrail/persistence-sqlite";
import { describe, expect, it } from "vitest";

import { createProjectVerificationWorkflowGate } from "../src/project-verification-gate.js";

const timestamp = "2026-09-05T12:00:00.000Z";
const completedAt = "2026-09-05T12:00:01.000Z";
const tree = "b".repeat(40);
const project: Project = {
  schemaVersion: 1,
  id: "project-one",
  workspaceId: "workspace-default",
  fixtureId: null,
  name: "Project one",
  repositoryPath: "/private/loomrail-fixture/project-one",
  providerPreference: "AUTO",
  status: "ACTIVE",
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workItem: WorkItem = {
  schemaVersion: 1,
  id: "work-item-one",
  projectId: project.id,
  parentId: null,
  type: "TASK",
  title: "Verify before Browser QA",
  description: "Synthetic workflow gate fixture",
  state: "IN_PROGRESS",
  currentStage: "QA",
  priority: "MEDIUM",
  risk: "LOW",
  acceptanceCriteria: ["Required Project checks pass"],
  version: 7,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const dispatch: WorkflowDispatch = {
  schemaVersion: 1,
  id: "dispatch-qa-one",
  projectId: project.id,
  workItemId: workItem.id,
  pipelineRunId: "pipeline-one",
  stageAttemptId: "stage-qa-one",
  mode: "START",
  status: "PENDING",
  createdAt: timestamp,
  completedAt: null,
};
const plan: VerificationPlan = {
  schemaVersion: 1,
  id: "verification-plan-one",
  projectId: project.id,
  revision: 1,
  status: "ACTIVE",
  recipes: [
    {
      schemaVersion: 1,
      id: "package-test",
      kind: "UNIT",
      label: "Tests",
      required: true,
      executable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      timeoutSeconds: 300,
      outputLimitBytes: 65_536,
      environmentProfile: "VERIFICATION_BASELINE",
      networkPolicy: "INHERIT_HOST",
      provenance: {
        source: "PACKAGE_JSON_SCRIPT",
        manifestPath: "package.json",
        manifestContentHash: "a".repeat(64),
        scriptName: "test",
        scriptBodyPreview: "vitest run",
      },
    },
  ],
  sourceProposalHash: "c".repeat(64),
  contentHash: "d".repeat(64),
  createdAt: timestamp,
};
const publication: VerificationPlanPublication = {
  schemaVersion: 1,
  id: "verification-publication-one",
  projectId: project.id,
  planId: plan.id,
  targetPath: ".loomrail/verification-plan.json",
  expectedTargetDigest: null,
  contentHash: plan.contentHash,
  status: "APPLIED",
  attempts: 1,
  lastErrorCode: null,
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
  appliedAt: timestamp,
};

const queuedRun = (): VerificationRun => ({
  schemaVersion: 1,
  id: "verification-run-one",
  projectId: project.id,
  workItemId: workItem.id,
  pipelineRunId: dispatch.pipelineRunId,
  workspaceId: "workspace-one",
  planId: plan.id,
  planRevision: plan.revision,
  planContentHash: plan.contentHash,
  implementationTree: tree,
  ordinal: 1,
  retryOfRunId: null,
  platform: "darwin",
  status: "QUEUED",
  currentCheckId: null,
  terminalReason: null,
  startedAt: null,
  completedAt: null,
  createdAt: timestamp,
  version: 1,
});

const queuedCheck = (runId: string): VerificationCheck => ({
  schemaVersion: 1,
  id: "verification-check-one",
  projectId: project.id,
  workItemId: workItem.id,
  runId,
  recipeId: plan.recipes[0]?.id ?? "missing-recipe",
  ordinal: 1,
  required: true,
  status: "QUEUED",
  startedAt: null,
  completedAt: null,
  durationMs: null,
  exitCode: null,
  signal: null,
  errorCode: null,
  output: null,
  version: 1,
});

const passedRun = (run: VerificationRun): VerificationRun => ({
  ...run,
  status: "PASSED",
  terminalReason: "ALL_REQUIRED_PASSED",
  startedAt: timestamp,
  completedAt,
  version: 3,
});

const passedCheck = (check: VerificationCheck): VerificationCheck => ({
  ...check,
  status: "PASSED",
  startedAt: timestamp,
  completedAt,
  durationMs: 1_000,
  exitCode: 0,
  output: {
    schemaVersion: 1,
    artifactId: "verification-output-one",
    sha256: "e".repeat(64),
    capturedBytes: 4,
    stdoutBytes: 4,
    stderrBytes: 0,
    truncated: false,
    available: true,
  },
  version: 3,
});

const createHarness = (options: {
  activePlan?: VerificationPlan | null;
  initialRun?: VerificationRun | null;
  initialChecks?: VerificationCheck[];
  completion?: "PASSED" | "FAILED";
  moveDispatchAfterCompletion?: boolean;
}) => {
  let currentRun = options.initialRun ?? null;
  let currentChecks = options.initialChecks ?? [];
  const commands: StateCommand[] = [];
  const wakes: string[] = [];
  const waits: string[] = [];
  let dispatchPending = true;

  const query: LocalState["query"] = (request): StateQueryResult => {
    switch (request.type) {
      case "GET_PROJECT_VERIFICATION_PLAN":
        return {
          type: "PROJECT_VERIFICATION_PLAN",
          project,
          plan: options.activePlan === undefined ? plan : options.activePlan,
          publication: options.activePlan === null ? null : publication,
        };
      case "GET_WORK_ITEM":
        return { type: "WORK_ITEM", workItem };
      case "LIST_WORK_ITEM_VERIFICATION_RUNS":
        return { type: "VERIFICATION_RUNS", runs: currentRun === null ? [] : [currentRun] };
      case "GET_VERIFICATION_RUN":
        return { type: "VERIFICATION_RUN", run: currentRun, checks: currentChecks };
      case "LIST_PENDING_DISPATCHES":
        return { type: "WORKFLOW_DISPATCHES", dispatches: dispatchPending ? [dispatch] : [] };
      default:
        throw new Error(`Unexpected gate query: ${request.type}`);
    }
  };
  const execute: LocalState["execute"] = (command): StateCommandResult => {
    if (command.type !== "START_VERIFICATION_RUN") {
      throw new Error(`Unexpected gate command: ${command.type}`);
    }
    commands.push(command);
    currentRun = queuedRun();
    currentChecks = [queuedCheck(currentRun.id)];
    return {
      schemaVersion: 1,
      type: "VERIFICATION_RUN_RESERVED",
      replayed: false,
      run: currentRun,
      checks: currentChecks,
    } as StateCommandResult;
  };
  const gate = createProjectVerificationWorkflowGate({
    state: { query, execute },
    runner: {
      wake: (runId) => {
        wakes.push(runId);
      },
      whenIdle: (runId) => {
        if (runId === undefined) throw new Error("The workflow gate must await one exact Run");
        waits.push(runId);
        if (currentRun === null || currentChecks[0] === undefined) return Promise.resolve();
        if (options.moveDispatchAfterCompletion === true) dispatchPending = false;
        if (options.completion === "FAILED") {
          currentRun = {
            ...currentRun,
            status: "FAILED",
            terminalReason: "REQUIRED_CHECK_FAILED",
            startedAt: timestamp,
            completedAt,
            version: 3,
          };
          currentChecks = [{ ...currentChecks[0], status: "FAILED" }];
          return Promise.resolve();
        }
        currentRun = passedRun(currentRun);
        currentChecks = [passedCheck(currentChecks[0])];
        return Promise.resolve();
      },
    },
    platform: () => "darwin",
    createCommandId: () => "verification-workflow-command-one",
  });
  return { gate, commands, wakes, waits };
};

describe("Project verification workflow gate", () => {
  it("runs the adopted Plan before Browser QA and returns only after fresh required evidence", async () => {
    const harness = createHarness({});

    await expect(harness.gate.beforeBrowserQA({ dispatch, testedTree: tree })).resolves.toEqual({
      status: "READY",
      configured: true,
    });
    expect(harness.commands).toMatchObject([
      {
        commandId: "verification-workflow-command-one",
        actor: { type: "SYSTEM", id: "verification-workflow" },
        type: "START_VERIFICATION_RUN",
        payload: {
          workItemId: workItem.id,
          expectedWorkItemVersion: workItem.version,
          expectedPlanRevision: plan.revision,
          expectedPlanContentHash: plan.contentHash,
          implementationTree: tree,
          platform: "darwin",
        },
      },
    ]);
    expect(harness.wakes).toEqual(["verification-run-one"]);
    expect(harness.waits).toEqual(["verification-run-one"]);
  });

  it("blocks Browser QA after a required Project check fails without inventing an automatic retry", async () => {
    const harness = createHarness({ completion: "FAILED" });

    await expect(harness.gate.beforeBrowserQA({ dispatch, testedTree: tree })).resolves.toEqual({
      status: "BLOCKED",
      blocker: "RUN_FAILED",
    });
    expect(harness.commands).toHaveLength(1);
    expect(harness.wakes).toEqual(["verification-run-one"]);
  });

  it("stops the old dispatch when verification atomically moved the correction workflow", async () => {
    const harness = createHarness({ completion: "PASSED", moveDispatchAfterCompletion: true });

    await expect(harness.gate.beforeBrowserQA({ dispatch, testedTree: tree })).resolves.toEqual({
      status: "MOVED",
    });
    expect(harness.commands).toHaveLength(1);
  });

  it("preserves Projects without an adopted Plan and starts no verification process", async () => {
    const harness = createHarness({ activePlan: null });

    await expect(harness.gate.beforeBrowserQA({ dispatch, testedTree: tree })).resolves.toEqual({
      status: "READY",
      configured: false,
    });
    expect(harness.commands).toEqual([]);
    expect(harness.wakes).toEqual([]);
  });
});
