import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderOutcome, WorkflowDispatch, WorkflowTemplate } from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import { providerCapabilitiesSchema, type ProviderAdapter } from "@loomrail/provider-core";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import { listWorktrees, runGit } from "@loomrail/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runStageAttempt, type RunStageAttemptDeps, type SessionLoopLogger } from "../src/session-loop.js";

import { makeRepoMidRebase, makeThrowawayRepo } from "./repo-fixtures.js";
import { snapshotOf } from "./state-fixtures.js";

const timestamp = "2026-08-26T09:00:00.000Z";
const PROJECT_ID = "project-workspace-loop";
const WORK_ITEM_TITLE = "Fix the login redirect";

/**
 * Every test here drives real `git` subprocesses -- building the repository, snapshotting it,
 * cutting the worktree -- so a couple of dozen process spawns each. Under `pnpm test`, where every
 * package's suite runs at once, that comfortably outlives vitest's 5s default. Same reason the
 * worker and event-stream suites carry their own timeouts.
 */
const GIT_TIMEOUT_MS = 30_000;

const silentLogger: SessionLoopLogger = {
  info: () => undefined,
  warn: () => undefined,
};

// IMPLEMENT alone, so a seeded pipeline's first dispatch is already the stage that needs a
// repository. The context pack spec is the delivery template's own IMPLEMENT spec rather than a
// second copy that could drift from it.
const implementStage = mockDeliveryTemplate.stages.find(({ stage }) => stage === "IMPLEMENT");
if (!implementStage) throw new Error("The mock delivery template no longer declares IMPLEMENT");
const implementOnlyTemplate: WorkflowTemplate = {
  ...mockDeliveryTemplate,
  id: "workspace-implement-v1",
  version: 1,
  name: "Workspace implement",
  stages: [{ ...implementStage, ordinal: 0 }],
};

type SeededAttempt = { workItemId: string; stageAttemptId: string; dispatch: WorkflowDispatch };

const completingAdapter = (onStart: (invocationCount: number) => Promise<void> | void): ProviderAdapter => {
  let started = 0;
  return {
    capabilities: () =>
      providerCapabilitiesSchema.parse({
        provider: "MOCK",
        start: true,
        interrupt: true,
        eventStream: false,
        usageReporting: false,
        contextWindowReporting: false,
        checkpointOnRequest: false,
        contextWindowTokens: 128_000,
        stages: ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"],
        costReporting: false,
      }),
    start: async (): Promise<ProviderOutcome> => {
      started += 1;
      await onStart(started);
      return { type: "COMPLETED", summary: "The mock session finished the stage." };
    },
    requestHandoff: () => Promise.resolve(),
    abortSession: () => Promise.resolve(),
  };
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

describe("session loop workspace provisioning", () => {
  let temporaryDirectory = "";
  let workspacesRoot = "";
  let repositoryPath = "";
  let state: LocalState | undefined;
  let nextId = 0;
  let nextCommandId = 0;
  const throwawayRepositories: string[] = [];

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "loomrail session loop "));
    workspacesRoot = join(temporaryDirectory, "workspaces");
    nextId = 0;
    nextCommandId = 0;
    state = await openLocalState({
      databasePath: join(temporaryDirectory, "local state.sqlite"),
      now: () => new Date(timestamp),
      createId: (kind) => `${kind}-${(nextId += 1).toString()}`,
    });
  });

  afterEach(async () => {
    state?.close();
    state = undefined;
    await Promise.all(
      [temporaryDirectory, ...throwawayRepositories.splice(0)].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  const createCommandId = (): string => `command-${(nextCommandId += 1).toString()}`;

  const openState = (): LocalState => {
    if (!state) throw new Error("The local state is not open");
    return state;
  };

  const throwawayRepository = async (make: () => Promise<string>): Promise<string> => {
    const path = await make();
    throwawayRepositories.push(path);
    return path;
  };

  // A project pointed at a real repository, a READY work item under it, and a pipeline whose first
  // (and only) stage is IMPLEMENT, with its dispatch already marked started -- which is the shape
  // `runStageAttempt` expects to be handed.
  const seedAttempt = (localState: LocalState, template = implementOnlyTemplate): SeededAttempt => {
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-project",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "REGISTER_FIXTURE_PROJECT",
      payload: {
        id: PROJECT_ID,
        fixtureId: "web-app-a",
        name: "Workspace fixture",
        repositoryPath,
      },
    });
    const created = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-item",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "CREATE_WORK_ITEM",
      payload: {
        projectId: PROJECT_ID,
        parentId: null,
        type: "TASK",
        title: WORK_ITEM_TITLE,
        description: "Synthetic fixture work for the session loop's workspace provisioning.",
        priority: "MEDIUM",
        risk: "LOW",
        acceptanceCriteria: ["The stage runs in a real worktree"],
      },
    });
    if (created.type !== "WORK_ITEM_CREATED") throw new Error("Expected a WorkItem");
    localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-ready",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "MOVE_WORK_ITEM",
      payload: { workItemId: created.workItem.id, expectedVersion: 1, targetState: "READY" },
    });
    const startedPipeline = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-pipeline",
      actor: { type: "HUMAN", id: "local-owner" },
      type: "START_MOCK_PIPELINE",
      payload: {
        workItemId: created.workItem.id,
        expectedVersion: 2,
        template,
        budget: { maxEstimatedTokens: 100_000, warningThresholds: [0.5, 0.8, 0.95] },
      },
    });
    if (startedPipeline.type !== "PIPELINE_STARTED") throw new Error("Expected a started pipeline");
    const dispatched = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-dispatch",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "MARK_WORKFLOW_DISPATCH_STARTED",
      payload: { dispatchId: startedPipeline.dispatch.id },
    });
    if (dispatched.type !== "WORKFLOW_DISPATCH_STARTED") throw new Error("Expected a started dispatch");
    return {
      workItemId: created.workItem.id,
      stageAttemptId: startedPipeline.stageAttempt.id,
      dispatch: dispatched.dispatch,
    };
  };

  const depsFor = (
    localState: LocalState,
    seeded: SeededAttempt,
    adapter: ProviderAdapter,
  ): RunStageAttemptDeps => ({
    state: localState,
    adapter,
    dispatch: seeded.dispatch,
    template: implementOnlyTemplate,
    workspacesRoot,
    createCommandId,
    correlationId: "correlation-session-loop",
    logger: silentLogger,
  });

  const workspaceOf = (localState: LocalState, workItemId: string) => {
    const result = localState.query({ type: "GET_WORKSPACE_BY_WORK_ITEM", workItemId });
    if (result.type !== "WORKSPACE") throw new Error("Expected a workspace query result");
    return result.workspace;
  };

  it(
    "cuts the worktree, carrying uncommitted work into it, before the session that edits it starts",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      // Uncommitted work in front of HEAD: what spec §2.9 carries in, and what proves the worktree was
      // based on the carry-in snapshot rather than on HEAD.
      await writeFile(join(repositoryPath, "committed.txt"), "edited but never committed\n");
      await writeFile(join(repositoryPath, "untracked.txt"), "untracked\n");
      const localState = openState();
      const seeded = seedAttempt(localState);
      const worktreePath = join(workspacesRoot, PROJECT_ID, seeded.workItemId);

      // Everything asserted below is read *inside* `start`, i.e. at the moment the agent would first
      // touch the repository. Read after `runStageAttempt` returned, the same assertions would pass
      // even if the workspace had been cut afterwards, which is the ordering this test exists for.
      let observed: { exists: boolean; status: string; carried: string; branch: string } | undefined;
      const adapter = completingAdapter(async () => {
        const status = await runGit(["status", "--porcelain"], { cwd: worktreePath });
        const carried = await runGit(["show", "HEAD:committed.txt"], { cwd: worktreePath });
        const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
        observed = {
          exists: await pathExists(worktreePath),
          status: status.stdout,
          carried: carried.stdout,
          branch: branch.stdout.trim(),
        };
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      expect(observed?.exists).toBe(true);
      // A clean `git status` in the worktree: the carried-in work arrived as a commit, not as a pile
      // of loose edits the agent would mistake for its own.
      expect(observed?.status).toBe("");
      expect(observed?.carried).toBe("edited but never committed\n");
      expect(observed?.branch).toBe(
        `loomrail/${seeded.workItemId.split("-")[1] ?? ""}-fix-the-login-redirect`,
      );
      expect(await pathExists(join(worktreePath, "untracked.txt"))).toBe(true);

      const workspace = workspaceOf(localState, seeded.workItemId);
      expect(workspace).toMatchObject({ status: "READY", worktreePath, projectId: PROJECT_ID });
      expect(workspace?.snapshotCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(workspace?.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "asks the owner instead of running an agent over a rebase's scratch commit",
    async () => {
      repositoryPath = await throwawayRepository(makeRepoMidRebase);
      const localState = openState();
      const seeded = seedAttempt(localState);
      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      // Asserted first on purpose: the worktree count is what notices a *missing* gate. Without the
      // domain decision the run succeeds end to end, so every assertion about the owner being asked
      // reports a missing HumanRequest, while this one reports the worktree that should never have
      // been cut from a rebase's scratch state.
      expect(await listWorktrees(repositoryPath)).toHaveLength(1);
      expect(sessionStarted).toBe(false);
      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests[0]?.title).toContain("rebase");
      expect(requests[0]?.blocking).toBe(true);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "does not cut a workspace for a stage that only produces prose",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      // The delivery template's own first stage is DISCOVERY, which needs no repository at all.
      const discoveryTemplate: WorkflowTemplate = {
        ...mockDeliveryTemplate,
        id: "workspace-discovery-v1",
        version: 1,
        name: "Workspace discovery",
        stages: mockDeliveryTemplate.stages.filter(({ stage }) => stage === "DISCOVERY"),
      };
      const seeded = seedAttempt(localState, discoveryTemplate);
      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), template: discoveryTemplate });

      expect(sessionStarted).toBe(true);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
      expect(await listWorktrees(repositoryPath)).toHaveLength(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "gives the workspace lease back so the work item's next stage can take it",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);

      await runStageAttempt(
        depsFor(
          localState,
          seeded,
          completingAdapter(() => undefined),
        ),
      );

      expect(workspaceOf(localState, seeded.workItemId)?.leaseHolder).toBeNull();
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "still reaches the owner when the refusal is about a path too long to fit a question's title",
    async () => {
      // A registered repository path may be 4096 characters (contracts' `repositoryPathSchema`),
      // while a HumanRequest's title may be 200 -- and the refusal for a path that is not a
      // repository names the path. Nothing here is exotic: a deep enough directory is all it takes,
      // and an unbounded refusal would be rejected by its own schema, leaving the owner with no
      // question at all rather than a long one.
      repositoryPath = join(temporaryDirectory, `not-a-repository-${"x".repeat(250)}`);
      const localState = openState();
      const seeded = seedAttempt(localState);
      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      // Asserted as a resolution rather than merely awaited: what this guards against is the
      // refusal escaping as an exception -- the command that carries the question rejecting its own
      // over-long payload -- instead of reaching the owner, and that has to red as an assertion.
      await expect(runStageAttempt(depsFor(localState, seeded, adapter))).resolves.toBeUndefined();

      expect(sessionStarted).toBe(false);
      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.blocking).toBe(true);
      expect(requests[0]?.context).toContain("could not find a usable Git repository");
    },
    GIT_TIMEOUT_MS,
  );
});
