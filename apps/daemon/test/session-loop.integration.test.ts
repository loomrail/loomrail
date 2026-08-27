import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ProviderOutcome,
  WorkflowDispatch,
  WorkflowTemplate,
  WorkItemWorkspace,
} from "@loomrail/contracts";
import { openLocalState, type LocalState } from "@loomrail/persistence-sqlite";
import {
  providerCapabilitiesSchema,
  type ProviderAdapter,
  type ProviderInvocation,
} from "@loomrail/provider-core";
import { mockDeliveryTemplate } from "@loomrail/workflow-engine";
import { addWorktree, listWorktrees, runGit } from "@loomrail/workspace";
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

// `onStart` is handed the invocation as well as the count, because part of what this suite pins is
// what the adapter is GIVEN, not only what it can see on disk from inside its own call.
const completingAdapter = (
  onStart: (invocationCount: number, invocation: ProviderInvocation) => Promise<void> | void,
): ProviderAdapter => {
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
    start: async (invocation: ProviderInvocation): Promise<ProviderOutcome> => {
      started += 1;
      await onStart(started, invocation);
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
  const seedAttempt = (
    localState: LocalState,
    options: { template?: WorkflowTemplate; registerProject?: boolean } = {},
  ): SeededAttempt => {
    const template = options.template ?? implementOnlyTemplate;
    // A second attempt under the same Project registers nothing: REGISTER_FIXTURE_PROJECT refuses a
    // Project whose id, fixture or repository path is already taken, which is the right refusal --
    // it just means the caller that wants a second work item says so.
    if (options.registerProject !== false) {
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
    }
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

  // The workspace an earlier StageAttempt would have left behind: a real worktree at the path this
  // work item's workspace always occupies (spec D2), plus the row recording it.
  const cutWorktree = async (seeded: SeededAttempt, branch: string): Promise<string> => {
    const worktreePath = join(workspacesRoot, PROJECT_ID, seeded.workItemId);
    await mkdir(dirname(worktreePath), { recursive: true });
    const added = await addWorktree({
      topLevel: repositoryPath,
      branch,
      path: worktreePath,
      startPoint: "HEAD",
    });
    if (added.type !== "ADDED") throw new Error(`Expected a worktree, got ${added.refusal.type}`);
    return worktreePath;
  };

  const recordWorkspace = (
    localState: LocalState,
    seeded: SeededAttempt,
    worktreePath: string,
    branch: string,
  ): WorkItemWorkspace => {
    const created = localState.execute({
      schemaVersion: 1,
      commandId: createCommandId(),
      correlationId: "correlation-seed-workspace",
      actor: { type: "SYSTEM", id: "session-loop" },
      type: "CREATE_WORK_ITEM_WORKSPACE",
      payload: {
        workItemId: seeded.workItemId,
        projectId: PROJECT_ID,
        branch,
        worktreePath,
        baseCommit: null,
        snapshotCommit: null,
        carriedPaths: [],
      },
    });
    if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("Expected a recorded workspace");
    return created.workspace;
  };

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

  // The defect this test exists for shipped and was live on `main`: the daemon cut the worktree,
  // took its lease, and then built the invocation from `dispatch`/`session`/`contextPack` alone.
  // `ProviderInvocation.workspace` was set by nothing outside tests, so the Codex adapter -- which
  // had just started declaring IMPLEMENT -- read the field as absent, ran `codex exec -s read-only
  // --skip-git-repo-check` in an empty temporary directory, and the stage closed COMPLETED carrying
  // a schema-valid answer about work nothing had a repository to do.
  //
  // Asserted against the workspace ROW rather than against literals: the row is what the daemon was
  // supposed to pass on, so a test that agreed with a hand-written path would still pass if the two
  // drifted. `path` carries the row's `worktreePath` under the adapter's own name for it.
  it(
    "hands the adapter the worktree it just cut and leased, with the branch and base commit",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);

      let received: ProviderInvocation | undefined;
      const adapter = completingAdapter((_count, invocation) => {
        received = invocation;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      const workspace = workspaceOf(localState, seeded.workItemId);
      expect(workspace).not.toBeNull();
      expect(received?.workspace).toEqual({
        path: workspace?.worktreePath,
        branch: workspace?.branch,
        baseCommit: workspace?.baseCommit,
      });
      // The path is the load-bearing field, and a row is not evidence about a disk: this is the
      // directory the adapter would launch its CLI in, so it has to be the real worktree and not
      // merely a string that matches the row.
      expect(await pathExists(join(received?.workspace?.path ?? "", ".git"))).toBe(true);
      // And the gate above it did not fire: an IMPLEMENT dispatch that reaches an adapter with no
      // workspace is refused to the owner instead, so a run that asked no question is what tells
      // these two assertions apart from a passing test that never dispatched at all.
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toHaveLength(0);
    },
    GIT_TIMEOUT_MS,
  );

  // The other side of the same rule: DISCOVERY, PLAN, REVIEW and ACCEPTANCE produce prose, no
  // worktree is cut for them, and the invocation must therefore OMIT the field rather than carry an
  // empty one -- `exactOptionalPropertyTypes` makes absent and `undefined` different things, and
  // absent is what the contract defines and what the adapter's read-only branch keys on.
  it(
    "leaves the workspace out entirely for a stage that only produces prose",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const planStage = mockDeliveryTemplate.stages.find(({ stage }) => stage === "PLAN");
      if (!planStage) throw new Error("The mock delivery template no longer declares PLAN");
      const planOnlyTemplate: WorkflowTemplate = {
        ...implementOnlyTemplate,
        id: "workspace-plan-v1",
        name: "Workspace plan",
        stages: [{ ...planStage, ordinal: 0 }],
      };
      const seeded = seedAttempt(localState, { template: planOnlyTemplate });

      let received: ProviderInvocation | undefined;
      const adapter = completingAdapter((_count, invocation) => {
        received = invocation;
      });

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), template: planOnlyTemplate });

      expect(received).toBeDefined();
      expect(received === undefined ? true : "workspace" in received).toBe(false);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
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
    "refuses to branch the repository a project's path merely sits inside",
    async () => {
      // The shape the bundled fixture has today: a directory that lives *inside* a repository
      // rather than being one. `git status` works there, `git rev-parse --show-toplevel` names the
      // enclosing repository, and a worktree cut from it would branch the owner's own checkout and
      // hand the agent everything in it.
      const enclosing = await realpath(await throwawayRepository(makeThrowawayRepo));
      repositoryPath = join(enclosing, "packages", "inner");
      await mkdir(repositoryPath, { recursive: true });
      const localState = openState();
      const seeded = seedAttempt(localState);
      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      // Asserted first, and asserted about the enclosing repository rather than about the question:
      // without the guard the whole attempt succeeds, so every assertion about the owner being
      // asked would merely report a missing HumanRequest, while these two report the worktree and
      // the branch that appeared in a repository nobody offered Loomrail.
      expect(await listWorktrees(enclosing)).toHaveLength(1);
      const branches = await runGit(["branch", "--list", "loomrail/*"], { cwd: enclosing });
      expect(branches.stdout).toBe("");
      expect(sessionStarted).toBe(false);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();

      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.blocking).toBe(true);
      // Names what is actually true. The refusal for a path with no repository near it would tell
      // the owner to check that the path still points at a repository -- advice that would send
      // them looking for a problem this repository does not have.
      expect(requests[0]?.context).toContain(`inside the repository at ${enclosing}`);
      expect(requests[0]?.recommendation).toContain(`Register the project at ${enclosing}`);
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
      const seeded = seedAttempt(localState, { template: discoveryTemplate });
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

  // The reuse path: QA after IMPLEMENT, or any attempt that picks up a work item whose workspace
  // already exists. Four tests, because the branch has four outcomes and each one is a different
  // promise to the owner.
  it(
    "writes in the workspace an earlier attempt left, rather than cutting a second one",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const branch = "loomrail/earlier-attempt";
      const worktreePath = await cutWorktree(seeded, branch);
      const recorded = recordWorkspace(localState, seeded, worktreePath, branch);

      let observedBranch = "";
      const adapter = completingAdapter(async () => {
        const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
        observedBranch = head.stdout.trim();
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      expect(observedBranch).toBe(branch);
      // Two: the repository itself and the workspace that was already there. A third would mean the
      // reuse path cut a second workspace for a work item that already had one.
      expect(await listWorktrees(repositoryPath)).toHaveLength(2);
      const after = workspaceOf(localState, seeded.workItemId);
      expect(after?.id).toBe(recorded.id);
      expect(after?.leaseHolder).toBeNull();
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toEqual([]);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "asks the owner instead of dispatching into a workspace whose directory went away",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const branch = "loomrail/removed-under-us";
      const worktreePath = await cutWorktree(seeded, branch);
      recordWorkspace(localState, seeded, worktreePath, branch);
      // Removed while the daemon is running, which is the whole point: startup reconciliation checks
      // the disk once, at startup, and never looks again. Between two restarts the row is the only
      // thing saying this workspace exists.
      await rm(worktreePath, { recursive: true, force: true });

      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      expect(sessionStarted).toBe(false);
      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.title).toContain("no longer on disk");
      expect(requests[0]?.context).toContain(worktreePath);
      expect(requests[0]?.blocking).toBe(true);
      // Every option the recommendation offers must be one Loomrail can actually perform. It used to
      // offer a second -- remove the workspace and let the next attempt cut a fresh one -- that no
      // command in this codebase does, so an owner who took it found nothing to click and met the
      // same question on the next dispatch, forever.
      expect(requests[0]?.recommendation).toContain("git worktree add");
      expect(requests[0]?.recommendation).not.toContain("remove the workspace");
      // Nothing is repaired behind the owner's back (AD-008): the record is left exactly as it was,
      // and the lease was never taken on a workspace that is not there.
      expect(workspaceOf(localState, seeded.workItemId)).toMatchObject({
        status: "READY",
        leaseHolder: null,
      });
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "asks the owner when the recorded path is an ordinary directory git no longer calls this workspace",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const branch = "loomrail/pruned-under-us";
      // The other half of the disk check, and the only test that reaches it: every case above
      // removes the directory outright, so `realpath` fails and the check answers before it ever
      // asks git anything. A pruned worktree leaves an ORDINARY DIRECTORY behind -- it exists, it
      // just is not a worktree any more -- and when that directory sits inside some repository (an
      // owner whose Loomrail data directory lives in a checkout, which is all it takes)
      // `rev-parse --show-toplevel` answers with the ENCLOSING repository instead of failing. Only
      // comparing that answer to the path itself separates "a directory is there" from "git still
      // calls it this workspace"; without it an agent is dispatched into someone else's checkout.
      const enclosing = await throwawayRepository(makeThrowawayRepo);
      const worktreePath = join(enclosing, "workspaces", PROJECT_ID, seeded.workItemId);
      await mkdir(worktreePath, { recursive: true });
      recordWorkspace(localState, seeded, worktreePath, branch);

      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      expect(sessionStarted).toBe(false);
      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.title).toContain("no longer on disk");
      expect(requests[0]?.context).toContain(worktreePath);
      expect(requests[0]?.blocking).toBe(true);
      expect(workspaceOf(localState, seeded.workItemId)).toMatchObject({
        status: "READY",
        leaseHolder: null,
      });
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "names the orphaning when the workspace was already marked orphaned",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const branch = "loomrail/orphaned-earlier";
      const worktreePath = await cutWorktree(seeded, branch);
      const recorded = recordWorkspace(localState, seeded, worktreePath, branch);
      // What startup reconciliation does when it finds the worktree gone (Task 10). The directory is
      // deliberately left in place here, so what this test pins is the *status* being refused and
      // not the disk check above it -- the two refusals tell the owner different things.
      localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-orphan",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "MARK_WORKSPACE_ORPHANED",
        payload: { workspaceId: recorded.id, expectedVersion: recorded.version },
      });

      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      expect(sessionStarted).toBe(false);
      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.title).toContain("orphaned");
      expect(requests[0]?.context).toContain(branch);
      expect(requests[0]?.blocking).toBe(true);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "waits, without asking the owner, while another attempt holds the workspace lease",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const branch = "loomrail/leased-elsewhere";
      const worktreePath = await cutWorktree(seeded, branch);
      const recorded = recordWorkspace(localState, seeded, worktreePath, branch);
      // A second work item under the same Project, only so its StageAttempt is a real id the lease
      // can name -- a lease is a claim by an attempt, and the storage layer refuses one that names
      // an attempt that does not exist.
      const otherAttempt = seedAttempt(localState, { registerProject: false });
      localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-other-lease",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "ACQUIRE_WORKSPACE_LEASE",
        payload: {
          workspaceId: recorded.id,
          stageAttemptId: otherAttempt.stageAttemptId,
          expectedVersion: recorded.version,
        },
      });

      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      expect(sessionStarted).toBe(false);
      // Not a refusal: the owner cannot act on "someone else is writing right now", and a question
      // they cannot answer is worse than silence. The dispatch simply waits for the next drain.
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toEqual([]);
      expect(workspaceOf(localState, seeded.workItemId)?.leaseHolder).toBe(otherAttempt.stageAttemptId);
      const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.find(
        ({ id }) => id === seeded.stageAttemptId,
      );
      expect(attempt?.status).toBe("RUNNING");
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "picks its own attempt back up when the workspace is already leased to it",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const branch = "loomrail/leased-to-us";
      const worktreePath = await cutWorktree(seeded, branch);
      const recorded = recordWorkspace(localState, seeded, worktreePath, branch);
      // The ordinary state after a daemon restart picked this attempt back up: the lease is already
      // this attempt's. Claiming it again would be refused by the storage claim's own
      // `WHERE lease_holder IS NULL`, and reading that as "someone else is writing" would postpone
      // this dispatch for good -- the attempt would wait for a lease it is already holding.
      localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-own-lease",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "ACQUIRE_WORKSPACE_LEASE",
        payload: {
          workspaceId: recorded.id,
          stageAttemptId: seeded.stageAttemptId,
          expectedVersion: recorded.version,
        },
      });

      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      expect(sessionStarted).toBe(true);
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toEqual([]);
      expect(workspaceOf(localState, seeded.workItemId)?.leaseHolder).toBeNull();
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "leaves neither a worktree nor a branch behind when the workspace it cut cannot be recorded",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      // Uncommitted work, so the branch is cut on the carry-in snapshot commit -- a commit no other
      // ref reaches. That is the ordinary case, and the one where a merged-ness check would refuse
      // to clean up after a rollback.
      await writeFile(join(repositoryPath, "committed.txt"), "edited but never committed\n");
      const localState = openState();
      const seeded = seedAttempt(localState);
      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });
      // The one failure this rollback exists for: the worktree is already on disk and the row that
      // would name it cannot be written.
      const failingState: LocalState = {
        ...localState,
        execute: (command) => {
          if (command.type === "CREATE_WORK_ITEM_WORKSPACE") {
            throw new Error("the workspace row could not be written");
          }
          return localState.execute(command);
        },
      };

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), state: failingState });

      expect(sessionStarted).toBe(false);
      // Disk and database agree that nothing was cut, and so does the branch namespace. A surviving
      // `loomrail/*` branch would meet the next attempt as BRANCH_EXISTS -- a refusal that asks the
      // owner to delete or rename a branch Loomrail itself created and abandoned seconds earlier.
      expect(await listWorktrees(repositoryPath)).toHaveLength(1);
      const branches = await runGit(["branch", "--list", "loomrail/*"], { cwd: repositoryPath });
      expect(branches.stdout).toBe("");
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
      // The owner's own working copy is untouched by any of it: the carry-in only ever copied it.
      expect(await readFile(join(repositoryPath, "committed.txt"), "utf8")).toBe(
        "edited but never committed\n",
      );

      const requests = snapshotOf(localState, seeded.workItemId).humanRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.blocking).toBe(true);
      expect(requests[0]?.title).toContain("could not be prepared");
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
