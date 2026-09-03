import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  McpSessionSnapshot,
  ProviderOutcome,
  WorkflowDispatch,
  WorkflowTemplate,
  WorkItemWorkspace,
} from "@loomrail/contracts";
import { canonicalMcpProfileSource } from "@loomrail/domain";
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
      if (invocation.session.stage === "ACCEPTANCE") {
        return {
          type: "NEEDS_HUMAN",
          request: {
            kind: "FREE_TEXT",
            blocking: true,
            title: "Confirm the acceptance note",
            context: "The owner must resolve this before an acceptance package can be prepared.",
            recommendation: "Confirm the bounded note.",
            options: [],
            allowOther: true,
          },
        };
      }
      // REVIEW and QA are the two stages the domain refuses to complete without their typed
      // evidence artifact (`decideApplyProviderOutcome`, @loomrail/domain). Produced here so a test
      // driving one of them asserts what this suite is about -- the workspace the adapter was
      // handed -- instead of dying on an unrelated stage rule.
      return {
        type: "COMPLETED",
        summary: "The mock session finished the stage.",
        ...(invocation.session.stage === "REVIEW"
          ? {
              artifacts: [
                {
                  kind: "REVIEW_REPORT" as const,
                  title: "Mock review",
                  summary: "The synthetic reviewer found nothing blocking.",
                  checks: ["Requirements traced"],
                },
              ],
            }
          : {}),
      };
    },
    requestHandoff: () => Promise.resolve(),
    abortSession: () => Promise.resolve(),
  };
};

// The shape `provider-claude-code` has: three prose stages, no stage that requires a workspace, and
// a `start` that never looks at `invocation.workspace`. Declared here rather than imported so this
// suite pins the daemon's rule about such an adapter, not that package's current stage list.
const proseOnlyAdapter = (onStart: (invocation: ProviderInvocation) => void): ProviderAdapter => ({
  capabilities: () =>
    providerCapabilitiesSchema.parse({
      provider: "CLAUDE_CODE",
      start: true,
      interrupt: true,
      eventStream: false,
      usageReporting: false,
      contextWindowReporting: false,
      checkpointOnRequest: false,
      contextWindowTokens: 128_000,
      stages: ["DISCOVERY", "PLAN", "REVIEW"],
      costReporting: false,
    }),
  start: (invocation: ProviderInvocation): Promise<ProviderOutcome> => {
    onStart(invocation);
    return Promise.resolve({
      type: "COMPLETED",
      summary: "The prose session finished the stage.",
      ...(invocation.session.stage === "REVIEW"
        ? {
            artifacts: [
              {
                kind: "REVIEW_REPORT" as const,
                title: "Isolated review",
                summary: "The bounded implementation diff was reviewed.",
                checks: ["Stable diff inspected"],
              },
            ],
            reviewReport: {
              kind: "REVIEW_REPORT" as const,
              title: "Isolated review",
              summary: "The bounded implementation diff was reviewed.",
              checks: ["Stable diff inspected"],
              verdict: "PASSED" as const,
              findings: [],
            },
          }
        : {}),
    });
  },
  requestHandoff: () => Promise.resolve(),
  abortSession: () => Promise.resolve(),
});

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
  // (and only) stage is IMPLEMENT. By default its immutable AgentRun is already reserved, which is
  // the only shape `runStageAttempt` may execute.
  const seedAttempt = (
    localState: LocalState,
    options: {
      template?: WorkflowTemplate;
      registerProject?: boolean;
      startAgentRun?: boolean;
      leaveQueued?: boolean;
    } = {},
  ): SeededAttempt => {
    const template = options.template ?? implementOnlyTemplate;
    // A second attempt under the same Project registers nothing: REGISTER_PROJECT refuses a
    // Project whose id, fixture or repository path is already taken, which is the right refusal --
    // it just means the caller that wants a second work item says so.
    if (options.registerProject !== false) {
      localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-seed-project",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "REGISTER_PROJECT",
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
    let dispatch = startedPipeline.dispatch;
    if (options.leaveQueued !== true && options.startAgentRun !== false) {
      const agent = localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-seed-agent-run",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: startedPipeline.dispatch.id,
          provider: "MOCK",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (agent.type !== "AGENT_RUN_STARTED") throw new Error("Expected a started AgentRun");
    } else if (options.leaveQueued !== true) {
      const dispatched = localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-seed-dispatch",
        actor: { type: "SYSTEM", id: "session-loop" },
        type: "MARK_WORKFLOW_DISPATCH_STARTED",
        payload: { dispatchId: startedPipeline.dispatch.id },
      });
      if (dispatched.type !== "WORKFLOW_DISPATCH_STARTED") throw new Error("Expected a started dispatch");
      dispatch = dispatched.dispatch;
    }
    return {
      workItemId: created.workItem.id,
      stageAttemptId: startedPipeline.stageAttempt.id,
      dispatch,
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
    // Asserted, not thrown: this helper builds the precondition several tests below depend on, and
    // a `git worktree add` that refused should name itself as a failed expectation -- with git's own
    // refusal in the message -- rather than as a crash from a sentence of ours.
    expect(added, "the helper's `git worktree add` should have succeeded").toMatchObject({ type: "ADDED" });
    if (added.type !== "ADDED") {
      throw new Error("unreachable: the assertion above should already have failed");
    }
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

  it("refuses to open a provider session without active AgentRun authority", async () => {
    repositoryPath = await throwawayRepository(makeThrowawayRepo);
    const localState = openState();
    const seeded = seedAttempt(localState, { startAgentRun: false });
    let started = false;
    const adapter = completingAdapter(() => {
      started = true;
    });

    await expect(runStageAttempt(depsFor(localState, seeded, adapter))).rejects.toMatchObject({
      code: "PERSISTENCE_FAILURE",
    });
    expect(started).toBe(false);
    const sessions = localState.query({
      type: "LIST_PROVIDER_SESSIONS",
      stageAttemptId: seeded.stageAttemptId,
    });
    expect(sessions.type === "PROVIDER_SESSIONS" ? sessions.sessions : []).toHaveLength(0);
  });

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
        // IMPLEMENT is one of the two stages that change the worktree, so this is the invocation
        // that asks its adapter's CLI for write access. The REVIEW test below is the other half.
        access: "READ_WRITE",
        networkAccess: true,
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

  it(
    "opens the exact MCP session snapshots before provider start and closes their connector lease",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState, { leaveQueued: true });
      const candidate = {
        profileId: null,
        name: "Local docs",
        executable: join(temporaryDirectory, "mcp server"),
        args: ["--read-only"],
        declaredTools: ["search_docs"],
      };
      const canonicalDigest = createHash("sha256").update(canonicalMcpProfileSource(candidate)).digest("hex");
      const consented = localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-mcp-consent",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "CONFIRM_MCP_PROFILE",
        payload: {
          projectId: PROJECT_ID,
          expectedProjectVersion: 1,
          candidate,
          canonicalDigest,
        },
      });
      if (consented.type !== "MCP_PROFILE_CONSENTED") throw new Error("Expected an MCP profile");
      localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-mcp-probe",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "RECORD_MCP_CAPABILITY_SNAPSHOT",
        payload: {
          projectId: PROJECT_ID,
          profileRevisionId: consented.revision.id,
          state: "READY",
          protocolVersion: "2026-07-28",
          tools: ["search_docs"],
          resources: [],
          prompts: [],
        },
      });
      const granted = localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-mcp-grant",
        actor: { type: "HUMAN", id: "local-owner" },
        type: "SET_MCP_PROFILE_GRANT",
        payload: {
          projectId: PROJECT_ID,
          expectedProjectVersion: 2,
          profileRevisionId: consented.revision.id,
          expectedGrantVersion: null,
          tools: ["search_docs"],
          ownerAttestsReadOnly: true,
        },
      });
      if (granted.type !== "MCP_GRANT_CHANGED") throw new Error("Expected an MCP grant");
      const agent = localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-mcp-agent-run",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: seeded.dispatch.id,
          provider: "MOCK",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (agent.type !== "AGENT_RUN_STARTED") throw new Error("Expected an MCP-authorized AgentRun");

      let openedSnapshots: readonly McpSessionSnapshot[] = [];
      let leaseClosed = false;
      let received: ProviderInvocation | undefined;
      const adapter = completingAdapter((_count, invocation) => {
        received = invocation;
      });
      await runStageAttempt({
        ...depsFor(localState, seeded, adapter),
        openMcpConnections: (snapshots) => {
          openedSnapshots = snapshots;
          return Promise.resolve({
            connections: [
              {
                id: "loomrail_01",
                proxyCommand: "/opt/loomrail/bin/mcp-proxy",
                proxyArgs: ["connect", "opaque-token"],
                enabledTools: ["search_docs"],
              },
            ],
            close: () => {
              leaseClosed = true;
              return Promise.resolve();
            },
          });
        },
      });

      expect(openedSnapshots).toHaveLength(1);
      expect(openedSnapshots[0]).toMatchObject({
        providerSessionId: received?.session.id,
        profileRevisionId: consented.revision.id,
        profileDigest: canonicalDigest,
        grantId: granted.grant.id,
        tools: ["search_docs"],
      });
      expect(received?.mcpConnections).toEqual([
        {
          id: "loomrail_01",
          proxyCommand: "/opt/loomrail/bin/mcp-proxy",
          proxyArgs: ["connect", "opaque-token"],
          enabledTools: ["search_docs"],
        },
      ]);
      expect(leaseClosed).toBe(true);
    },
    GIT_TIMEOUT_MS,
  );

  // The test that would have caught R11, at the level where it is an assertion about behaviour and
  // not a restatement of a constant: REVIEW is neither IMPLEMENT nor QA, the Project is backed by a
  // real repository, and what is asserted is the invocation the adapter was actually handed.
  //
  // The defect was found by running a real session against the live Codex CLI. DISCOVERY, PLAN and
  // IMPLEMENT ran, the agent really did edit a file in the work item's worktree, and REVIEW then
  // reported -- correctly -- that the workspace contained no repository and no implementation to
  // assess, because it had been handed the adapter's empty scratch directory. Every test and every
  // review round had agreed with the constant instead of with the run.
  //
  // Asserted against the workspace ROW rather than against literals, for the same reason the
  // IMPLEMENT test above is: the row is what the daemon was supposed to pass on, so a test agreeing
  // with a hand-written path would still pass if the two drifted.
  it(
    "hands a REVIEW stage the same worktree, because a review reads the change it is judging",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const reviewStage = mockDeliveryTemplate.stages.find(({ stage }) => stage === "REVIEW");
      if (!reviewStage) throw new Error("The mock delivery template no longer declares REVIEW");
      const reviewOnlyTemplate: WorkflowTemplate = {
        ...implementOnlyTemplate,
        id: "workspace-review-v1",
        name: "Workspace review",
        stages: [{ ...reviewStage, ordinal: 0 }],
      };
      const seeded = seedAttempt(localState, { template: reviewOnlyTemplate });

      let received: ProviderInvocation | undefined;
      const baseAdapter = completingAdapter(() => undefined);
      const adapter: ProviderAdapter = {
        ...baseAdapter,
        start: (invocation) => {
          received = invocation;
          return Promise.resolve({
            type: "NEEDS_HUMAN",
            request: {
              kind: "FREE_TEXT",
              blocking: true,
              title: "Provide the missing review fixture",
              context: "This focused workspace test has no implementation author lineage.",
              recommendation: "Use the full implementation-to-review test below.",
              options: [],
              allowOther: true,
            },
          });
        },
      };

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), template: reviewOnlyTemplate });

      // Asserted before the row, because the invocation is the subject: a REVIEW that reached the
      // adapter with this field absent is the live defect, whatever the database says.
      expect(received?.workspace).toBeDefined();
      const workspace = workspaceOf(localState, seeded.workItemId);
      expect(workspace).not.toBeNull();
      expect(received?.workspace).toEqual({
        path: workspace?.worktreePath,
        branch: workspace?.branch,
        baseCommit: workspace?.baseCommit,
        // The same worktree as IMPLEMENT's, and NOT the same access to it. R11 gave every agent
        // stage the workspace, which was right; what it also did, silently, was give them all write
        // access, because the Codex adapter read the mere presence of a worktree as permission to
        // write in it -- so REVIEW ran under `-s workspace-write` with the network opened. A review
        // reads the change it is judging. The daemon states which it is (`stageWritesInWorkspace`,
        // @loomrail/domain), and this is where that statement is pinned.
        access: "READ_ONLY",
        networkAccess: false,
      });
      // A row is not evidence about a disk: this is the directory the adapter would launch its CLI
      // in, so it has to be the real worktree and not merely a string that matches the row.
      expect(await pathExists(join(received?.workspace?.path ?? "", ".git"))).toBe(true);
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toHaveLength(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "gives REVIEW a bounded measured diff for exactly the completed IMPLEMENT tree",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const reviewStage = mockDeliveryTemplate.stages.find(({ stage }) => stage === "REVIEW");
      if (!reviewStage) throw new Error("The mock delivery template no longer declares REVIEW");
      const implementReviewTemplate: WorkflowTemplate = {
        ...mockDeliveryTemplate,
        id: "workspace-implement-review-v1",
        name: "Workspace implement and review",
        stages: [
          { ...implementStage, ordinal: 0 },
          { ...reviewStage, ordinal: 1 },
        ],
      };
      const seeded = seedAttempt(localState, {
        template: implementReviewTemplate,
        startAgentRun: true,
      });
      const fileBody = "export const reviewedValue = 42;\n";
      const implementationAdapter = completingAdapter(async (_count, invocation) => {
        const path = invocation.workspace?.path;
        if (path === undefined) throw new Error("IMPLEMENT did not receive its worktree");
        await writeFile(join(path, "review-target.ts"), fileBody);
      });

      await runStageAttempt({
        ...depsFor(localState, seeded, implementationAdapter),
        template: implementReviewTemplate,
      });

      const implementationSnapshot = snapshotOf(localState, seeded.workItemId);
      const implementationAttempt = implementationSnapshot.stageAttempts.find(
        ({ stage }) => stage === "IMPLEMENT",
      );
      expect(implementationAttempt).toMatchObject({ status: "SUCCEEDED" });
      expect(implementationAttempt?.resultTree).toMatch(/^[0-9a-f]{40}$/);
      const pending = localState.query({ type: "LIST_PENDING_DISPATCHES" });
      if (pending.type !== "WORKFLOW_DISPATCHES" || pending.dispatches.length !== 1) {
        throw new Error("Expected the REVIEW dispatch");
      }
      const reviewDispatch = pending.dispatches[0];
      if (reviewDispatch === undefined) throw new Error("Expected the REVIEW dispatch");
      const reviewer = localState.execute({
        schemaVersion: 1,
        commandId: createCommandId(),
        correlationId: "correlation-start-reviewer",
        actor: { type: "SYSTEM", id: "local-daemon" },
        type: "START_AGENT_RUN",
        payload: {
          dispatchId: reviewDispatch.id,
          provider: "CLAUDE_CODE",
          limits: { global: 3, project: 3, provider: 3 },
        },
      });
      if (reviewer.type !== "AGENT_RUN_STARTED") throw new Error("Expected the reviewer AgentRun");
      let reviewPack = "";
      let reviewWorkspaceAccess = "";
      let reviewModelTier = "";
      const reviewAdapter = proseOnlyAdapter((invocation) => {
        reviewPack = invocation.contextPack.text;
        reviewWorkspaceAccess = invocation.workspace?.access ?? "NONE";
        reviewModelTier = invocation.modelTier;
      });

      await runStageAttempt({
        ...depsFor(
          localState,
          {
            workItemId: seeded.workItemId,
            stageAttemptId: reviewDispatch.stageAttemptId,
            dispatch: reviewDispatch,
          },
          reviewAdapter,
        ),
        template: implementReviewTemplate,
      });

      expect(reviewPack).toContain(`Stable result tree: ${implementationAttempt?.resultTree ?? ""}`);
      expect(reviewPack).toContain("Changed files and bounded unified-diff fragments");
      expect(reviewPack).toContain("- ADDED review-target.ts (+1 -0)");
      expect(reviewPack).toContain(fileBody.trim());
      expect(reviewWorkspaceAccess).toBe("READ_ONLY");
      expect(reviewer.run.policySnapshot?.modelTier).toBe("DEEP");
      expect(reviewModelTier).toBe("DEEP");
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toHaveLength(0);
    },
    GIT_TIMEOUT_MS,
  );

  // The Acceptance Manager prepares the package from durable context; it does not read the
  // worktree and cannot take the owner's later decision. The field must be OMITTED rather than
  // carry an empty value -- `exactOptionalPropertyTypes` makes absent and `undefined` different
  // things, and absent is what the contract defines.
  it(
    "leaves the workspace out of bounded Acceptance Manager preparation",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const acceptanceStage = mockDeliveryTemplate.stages.find(({ stage }) => stage === "ACCEPTANCE");
      if (!acceptanceStage) throw new Error("The mock delivery template no longer declares ACCEPTANCE");
      const acceptanceOnlyTemplate: WorkflowTemplate = {
        ...implementOnlyTemplate,
        id: "workspace-acceptance-v1",
        name: "Workspace acceptance",
        stages: [{ ...acceptanceStage, ordinal: 0 }],
      };
      const seeded = seedAttempt(localState, { template: acceptanceOnlyTemplate });

      let received: ProviderInvocation | undefined;
      const adapter = completingAdapter((_count, invocation) => {
        received = invocation;
      });

      await runStageAttempt({
        ...depsFor(localState, seeded, adapter),
        template: acceptanceOnlyTemplate,
      });

      expect(received).toBeDefined();
      expect(received === undefined ? true : "workspace" in received).toBe(false);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
      // Nothing was cut from the owner's repository for a decision that reads nothing off disk.
      expect(await listWorktrees(repositoryPath)).toHaveLength(1);
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

  // R11 moved WHEN the worktree and its carry-in commit are first created: a work item's FIRST
  // agent stage cuts them now, not IMPLEMENT. That is the visible consequence of the wider list, and
  // it is asserted on the owner's own repository -- the second worktree in it is the one DISCOVERY
  // caused -- rather than only on the invocation.
  it(
    "cuts the work item's workspace at its first agent stage, not at IMPLEMENT",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      // The delivery template's own first stage, and the one a run reaches before any other.
      const discoveryTemplate: WorkflowTemplate = {
        ...mockDeliveryTemplate,
        id: "workspace-discovery-v1",
        version: 1,
        name: "Workspace discovery",
        stages: mockDeliveryTemplate.stages.filter(({ stage }) => stage === "DISCOVERY"),
      };
      const seeded = seedAttempt(localState, { template: discoveryTemplate });
      let received: ProviderInvocation | undefined;
      const adapter = completingAdapter((_count, invocation) => {
        received = invocation;
      });

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), template: discoveryTemplate });

      const workspace = workspaceOf(localState, seeded.workItemId);
      expect(workspace).toMatchObject({ status: "READY", projectId: PROJECT_ID });
      expect(received?.workspace?.path).toBe(workspace?.worktreePath);
      // Two: the repository itself, and the worktree this DISCOVERY caused to be cut from it.
      expect(await listWorktrees(repositoryPath)).toHaveLength(2);
      // And the lease is handed back, so the IMPLEMENT that follows takes the reuse path rather
      // than meeting its own DISCOVERY as another writer.
      expect(workspace?.leaseHolder).toBeNull();
    },
    GIT_TIMEOUT_MS,
  );

  // The constraint that keeps the wider list from breaking projects that never had a repository: a
  // Project whose path is not one -- a fixture Project still recorded at a bundled template, a path
  // the owner moved -- ran its prose stages before E1 and must go on running them. What used to be
  // no decision at all is now a refusal from `prepareWorkspace` that this stage steps past, so the
  // failure mode being guarded is a DISCOVERY that suddenly asks the owner a blocking question.
  it(
    "still dispatches a prose stage with no workspace when the project has no repository",
    async () => {
      repositoryPath = join(temporaryDirectory, "not a repository");
      await mkdir(repositoryPath, { recursive: true });
      const localState = openState();
      const discoveryTemplate: WorkflowTemplate = {
        ...mockDeliveryTemplate,
        id: "workspace-discovery-bare-v1",
        version: 1,
        name: "Workspace discovery without a repository",
        stages: mockDeliveryTemplate.stages.filter(({ stage }) => stage === "DISCOVERY"),
      };
      const seeded = seedAttempt(localState, { template: discoveryTemplate });
      let received: ProviderInvocation | undefined;
      const adapter = completingAdapter((_count, invocation) => {
        received = invocation;
      });

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), template: discoveryTemplate });

      expect(received).toBeDefined();
      expect(received === undefined ? true : "workspace" in received).toBe(false);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
      // The whole point: the owner is asked nothing. An IMPLEMENT on this same project is still
      // refused -- that is the test two above -- because it could only report work it never did.
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toHaveLength(0);
      expect(snapshotOf(localState, seeded.workItemId).stageAttempts[0]?.status).toBe("SUCCEEDED");
    },
    GIT_TIMEOUT_MS,
  );

  // The gate that closes "the worst outcome this project has" (`decideSessionWorkspace`,
  // @loomrail/domain), driven through the daemon rather than called in isolation.
  //
  // Its only test was the pure function, and nothing asserted the gate was wired in at all:
  // deleting the `decideSessionWorkspace` call together with its `refuseDispatch` and `return` left
  // this file at 15/15 and the whole daemon suite at 123/123. It could not have been otherwise --
  // every writing stage was refused one branch earlier, so the gate was unreachable by
  // construction. It is reachable now (see the comment on `provisionRefusal` in session-loop.ts),
  // and this is the case that reaches it: a writing stage, an adapter that declares it, and a
  // Project with no repository to cut a workspace from.
  //
  // The prose half of exactly this situation is the test above, which asserts the opposite outcome
  // on the same Project: DISCOVERY runs, IMPLEMENT does not. The two differ in the stage and in
  // nothing else.
  it(
    "refuses a writing stage that reached dispatch with no workspace, rather than letting it report work it never did",
    async () => {
      repositoryPath = join(temporaryDirectory, "not a repository either");
      await mkdir(repositoryPath, { recursive: true });
      const localState = openState();
      const seeded = seedAttempt(localState);
      let received: ProviderInvocation | undefined;
      const adapter = completingAdapter((_count, invocation) => {
        received = invocation;
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      // Asserted first, and about the adapter rather than about the owner's question: a session that
      // opened at all is the defect. The adapter cannot tell an IMPLEMENT with no workspace from a
      // DISCOVERY that was never meant to write, so it takes its read-only branch in an empty
      // temporary directory, the agent answers from nothing, and the stage closes COMPLETED.
      expect(received).toBeUndefined();

      const snapshot = snapshotOf(localState, seeded.workItemId);
      // Not SUCCEEDED, which is what a deleted gate produces here: the stage stops, and the owner
      // is the one who decides what happens next.
      expect(snapshot.stageAttempts[0]?.status).toBe("WAITING_HUMAN");
      expect(snapshot.humanRequests).toHaveLength(1);
      expect(snapshot.humanRequests[0]?.blocking).toBe(true);
      // The question names this Project's own path, because that is the thing the owner can act on.
      // The gate's own wording ("Nothing in the project or its repository caused this") would be a
      // lie here, and it is deliberately not what is sent: the refusal `prepareWorkspace` produced
      // travels down to the gate and is the one raised.
      expect(snapshot.humanRequests[0]?.context).toContain(repositoryPath);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
    },
    GIT_TIMEOUT_MS,
  );

  // The other side of that constraint, and the degrade that used to be silent. This Project HAS a
  // repository -- it is merely parked mid-rebase this minute -- so a DISCOVERY dispatched with no
  // worktree would answer from the brief alone about a codebase that is sitting right there, and
  // the only record of why would be a warning in a log the owner never sees. That is the sentence
  // this milestone exists to eliminate ("there is no implementation to assess"), arrived at by a
  // different route.
  //
  // The refusal is the same question IMPLEMENT gets, because the repair is the same and the owner
  // is the one who makes it. What separates this test from the one above it is one fact about the
  // Project -- whether there is a repository at all -- and nothing about the stage.
  it(
    "asks the owner instead of running a prose stage blind against a repository it could not use",
    async () => {
      repositoryPath = await throwawayRepository(makeRepoMidRebase);
      const localState = openState();
      const discoveryTemplate: WorkflowTemplate = {
        ...mockDeliveryTemplate,
        id: "workspace-discovery-unusable-v1",
        version: 1,
        name: "Workspace discovery against an unusable repository",
        stages: mockDeliveryTemplate.stages.filter(({ stage }) => stage === "DISCOVERY"),
      };
      const seeded = seedAttempt(localState, { template: discoveryTemplate });
      let sessionStarted = false;
      const adapter = completingAdapter(() => {
        sessionStarted = true;
      });

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), template: discoveryTemplate });

      // Asserted first: a session that ran at all is the defect, whatever the owner was or was not
      // told afterwards -- it is the one that produces the plausible answer about nothing.
      expect(sessionStarted).toBe(false);
      const snapshot = snapshotOf(localState, seeded.workItemId);
      expect(snapshot.humanRequests).toHaveLength(1);
      expect(snapshot.humanRequests[0]?.blocking).toBe(true);
      // The question names the repository's real state, not a generic "no workspace": the owner has
      // to finish or abort the rebase, and nothing else will do.
      expect(snapshot.humanRequests[0]?.title).toContain("rebase");
      // And the stage did not close. A DISCOVERY that reports SUCCEEDED here is exactly the outcome
      // the log-only degrade produced.
      expect(snapshot.stageAttempts[0]?.status).toBe("WAITING_HUMAN");
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
    },
    GIT_TIMEOUT_MS,
  );

  // An adapter that reads `invocation.workspace` nowhere gets no worktree cut on its behalf: doing
  // so would write a ref, a carry-in commit and a `.git/worktrees` entry into the owner's own
  // repository for a session that runs in a temporary directory of its own. `provider-claude-code`
  // is that adapter today, and it is recognised by the stages it declares -- it serves no stage that
  // requires a workspace, which is the same fact the launcher's "worksInRepository" line reads.
  it(
    "cuts nothing for an adapter that declares no stage needing a workspace",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const discoveryTemplate: WorkflowTemplate = {
        ...mockDeliveryTemplate,
        id: "workspace-discovery-prose-adapter-v1",
        version: 1,
        name: "Workspace discovery on a prose-only adapter",
        stages: mockDeliveryTemplate.stages.filter(({ stage }) => stage === "DISCOVERY"),
      };
      const seeded = seedAttempt(localState, { template: discoveryTemplate });
      let received: ProviderInvocation | undefined;
      const adapter = proseOnlyAdapter((invocation) => {
        received = invocation;
      });

      await runStageAttempt({ ...depsFor(localState, seeded, adapter), template: discoveryTemplate });

      expect(received).toBeDefined();
      expect(received === undefined ? true : "workspace" in received).toBe(false);
      expect(workspaceOf(localState, seeded.workItemId)).toBeNull();
      expect(await listWorktrees(repositoryPath)).toHaveLength(1);
      expect(snapshotOf(localState, seeded.workItemId).humanRequests).toHaveLength(0);
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
      // ORPHANED is terminal, so the question must not end in an instruction that leads nowhere.
      // It used to say "Restore or remove <path> yourself, then retry the stage": restoring changes
      // nothing (the status, not the disk, is what refuses), removal is not a command Loomrail has,
      // and the retry re-reads the same row and asks the same question -- a loop the owner cannot
      // leave. Pinned as three separate claims because they fail for three different reasons.
      expect(requests[0]?.recommendation).not.toContain("retry");
      expect(requests[0]?.recommendation).toContain("nothing to do at");
      expect(requests[0]?.recommendation).toContain(branch);
      expect(requests[0]?.context).toContain("Every later stage");
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
  // ---------------------------------------------------------------------------------------------
  // The stage-end tree label (spec D3, §4). Written here and read by nothing in this milestone --
  // see the comment on `resultTree` in @loomrail/contracts for who is meant to read it and what
  // they can still do with it by then.
  // ---------------------------------------------------------------------------------------------

  it(
    "records the tree the worktree ended on, naming what the agent actually produced",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const worktreePath = join(workspacesRoot, PROJECT_ID, seeded.workItemId);
      const adapter = completingAdapter(async () => {
        await writeFile(join(worktreePath, "added by the agent.txt"), "the agent's work\n");
      });

      await runStageAttempt(depsFor(localState, seeded, adapter));

      const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.at(-1);
      expect(attempt?.status).toBe("SUCCEEDED");
      // Asserted before the shape so that a label that was never taken reds as "expected null not
      // to be null" rather than as `.toMatch` complaining about its own argument.
      expect(attempt?.resultTree).not.toBeNull();
      expect(attempt?.resultTree).toMatch(/^[0-9a-f]{40}$/);
      // Forty hex characters is not evidence: the BASELINE's tree has exactly that shape, so a
      // label computed over the wrong index -- or over an index the agent's file never reached --
      // passes the regex above with room to spare (the same trap E15-1 found in Task 1). What the
      // label names is therefore read back out of the repository it was written into.
      const listed = await runGit(["ls-tree", "-r", "--name-only", attempt?.resultTree ?? ""], {
        cwd: repositoryPath,
      });
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.split("\n")).toContain("added by the agent.txt");
    },
    GIT_TIMEOUT_MS,
  );

  // The question the label only answers if it is never collapsed to null: a stage that changed
  // nothing is a measurement, and it must not be stored as the absence of one. Both readings are
  // pinned -- that the value is there, and that it is the tree the stage started on -- because
  // "not null" alone would still pass for a label naming some other tree.
  it(
    "records a measured tree for a stage that changed nothing, rather than no measurement at all",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const worktreePath = join(workspacesRoot, PROJECT_ID, seeded.workItemId);
      const adapter = completingAdapter(() => undefined);

      await runStageAttempt(depsFor(localState, seeded, adapter));

      const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.at(-1);
      expect(attempt?.status).toBe("SUCCEEDED");
      const carriedIn = await runGit(["rev-parse", "HEAD^{tree}"], { cwd: worktreePath });
      expect(attempt?.resultTree).toBe(carriedIn.stdout.trim());
    },
    GIT_TIMEOUT_MS,
  );

  // The label is Loomrail's bookkeeping and the stage is the owner's work, so the stage outranks
  // it: a tree that could not be read is recorded as "not measured" and said in the log, and the
  // stage still succeeds. The worktree is removed from INSIDE the session, which is the one order
  // that leaves a genuinely completed stage with nothing left to measure.
  it(
    "completes the stage, saying so in the log, when the tree could not be recorded",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const worktreePath = join(workspacesRoot, PROJECT_ID, seeded.workItemId);
      const warnings: string[] = [];
      const adapter = completingAdapter(async () => {
        await rm(worktreePath, { recursive: true, force: true });
      });

      // Asserted as a resolution rather than merely awaited, the same way the refusal test below
      // is: what this guards against is a label that could not be taken escaping as an exception
      // and taking a finished stage down with it, and that has to red as an assertion rather than
      // as a rejected promise nobody named.
      await expect(
        runStageAttempt({
          ...depsFor(localState, seeded, adapter),
          logger: { info: () => undefined, warn: (_fields, message) => warnings.push(message) },
        }),
      ).resolves.toBeUndefined();

      const attempt = snapshotOf(localState, seeded.workItemId).stageAttempts.at(-1);
      expect(attempt?.status).toBe("SUCCEEDED");
      expect(attempt?.resultTree).toBeNull();
      expect(warnings).toContain("The tree this stage ended on could not be recorded");
    },
    GIT_TIMEOUT_MS,
  );

  // `@loomrail/workspace` reports ANY failure to spawn `git` as `GitMissingError` -- "git
  // executable was not found" -- and a working directory that does not exist is one of the ways
  // spawning fails, indistinguishable at that boundary from git not being on PATH. The vanished
  // worktree above is exactly that case, so what the log says about it is pinned here, separately
  // from the message text: an operator reading `error` must not be told to go check their git
  // installation over a worktree an agent (or a stray `rm`) already removed.
  it(
    "logs the vanished worktree as itself, not as git being missing from the machine",
    async () => {
      repositoryPath = await throwawayRepository(makeThrowawayRepo);
      const localState = openState();
      const seeded = seedAttempt(localState);
      const worktreePath = join(workspacesRoot, PROJECT_ID, seeded.workItemId);
      const treeWarnings: Record<string, string | number>[] = [];
      const adapter = completingAdapter(async () => {
        await rm(worktreePath, { recursive: true, force: true });
      });

      await runStageAttempt({
        ...depsFor(localState, seeded, adapter),
        logger: {
          info: () => undefined,
          warn: (fields, message) => {
            if (message === "The tree this stage ended on could not be recorded") {
              treeWarnings.push(fields);
            }
          },
        },
      });

      expect(treeWarnings).toHaveLength(1);
      const error = String(treeWarnings[0]?.["error"] ?? "");
      expect(error).not.toContain("GitMissingError");
      expect(error).not.toContain("git executable was not found");
    },
    GIT_TIMEOUT_MS,
  );
});
