import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assembleContextPack } from "@loomrail/context-assembly";
import {
  checkpointDraftSchema,
  contextPackRecipeInputSchema,
  contextWindowUsageSchema,
  maxCarriedPaths,
  providerSessionProcessPidSchema,
  providerUsageSchema,
  type CheckpointDraft,
  type ContextPackSpec,
  type EndProviderSessionCommand,
  type HumanRequestDraft,
  type ProviderOutcome,
  type ProviderSessionEndReason,
  type StageAttempt,
  type WorkflowDispatch,
  type WorkflowTemplate,
  type WorkItemWorkspace,
} from "@loomrail/contracts";
import {
  decideDispatchStage,
  decideProvisionWorkspace,
  provisionRefusalRequest,
  stageRequiresWorkspace,
  workspaceBranchName,
  type DispatchStageDecision,
  type ProvisionRefusal,
} from "@loomrail/domain";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import {
  ProviderPackTooLargeError,
  type ProviderAdapter,
  type ProviderSessionListener,
  type ProviderSessionRef,
} from "@loomrail/provider-core";
import {
  addWorktree,
  createCarryInSnapshot,
  deleteBranchIfUnmoved,
  inspectRepository,
  removeWorktree,
  type AddWorktreeRefusal,
} from "@loomrail/workspace";

/**
 * The share of the provider's context window handed to the assembled pack. The rest is the agent's
 * workspace: a pack that filled the window would leave no room for the work itself.
 */
const MAX_PACK_SHARE = 0.35;

/**
 * The reported occupancy at which a session starts winding down (spec §D6). It means "start
 * wrapping up", not "stop": the cut happens at the first checkpoint after it, which is why a
 * threshold below full is what buys the tail back.
 */
const HANDOFF_THRESHOLD = 0.75;

/**
 * How long to wait for a checkpoint after asking a session to wind down before cutting it (§7).
 * `requestHandoff` is a request, not a command; without a deadline an agent that ignores it holds
 * the attempt open forever.
 */
const HANDOFF_DEADLINE_MS = 60_000;

/**
 * How far the pack share drops after a provider rejects a pack Loomrail judged as fitting (§7).
 * One automatic retry, then a Human Request: narrowing the share blindly is guessing, not recovery.
 */
const PACK_SHARE_BACKOFF = 0.1;

/**
 * Bytes per token for LOOMRAIL_ESTIMATE. Deliberately coarse, and deliberately erring toward
 * over-counting bytes: being wrong here should shrink the pack, never overflow the window.
 */
const BYTES_PER_TOKEN = 4;

/**
 * The bound on how many ProviderSessions one StageAttempt may run.
 *
 * Spec §6.5's guard is the unproductive-session counter, and it only catches a provider that stops
 * making progress. The token budget does not back it up here: usage is recorded only when
 * `decideApplyProviderOutcome` handles a BUDGET_LIMIT_REACHED outcome, so a provider that hands off
 * productively forever never moves the budget and never trips a threshold. That makes this the only
 * thing standing between such a provider and an unbounded loop -- which is why reaching it is a
 * terminal outcome (hard pause, dispatch withdrawn, question to the owner) and not a log line: a
 * loop that merely returned would leave the dispatch PENDING for the drain to hand straight back.
 */
const MAX_SESSIONS_PER_ATTEMPT = 50;

export type SessionLoopLogger = {
  info: (details: Record<string, string | number>, message: string) => void;
  warn: (details: Record<string, string | number>, message: string) => void;
};

export type HandoffDeadline = { cancel: () => void };

/**
 * Injected rather than calling `setTimeout` directly, for the same reason `now` and `createId` are
 * injected everywhere else in this codebase: a test for a wind-down request that is ignored would
 * otherwise have to wait a real HANDOFF_DEADLINE_MS.
 */
export type ScheduleHandoffDeadline = (delayMs: number, onDeadline: () => void) => HandoffDeadline;

export type RunStageAttemptDeps = {
  state: LocalState;
  adapter: ProviderAdapter;
  /** A dispatch already marked started, i.e. one whose StageAttempt is RUNNING. */
  dispatch: WorkflowDispatch;
  template: WorkflowTemplate;
  /**
   * Where a WorkItem's worktree is cut (spec D2): `<workspacesRoot>/<projectId>/<workItemId>`.
   *
   * Outside the owner's own repository on purpose -- their `git status` must not show Loomrail's
   * directories and their `git clean -fdx` must not delete an agent's work. The price is that these
   * paths are absolute and never move (spec §2.10), which is why the root is handed in rather than
   * derived here from whatever the process happens to consider its home.
   */
  workspacesRoot: string;
  // No `now` here on purpose: every timestamp this loop writes is stamped inside the state store's
  // own transaction from its injected clock, so a second clock here could only disagree with it.
  createCommandId: () => string;
  correlationId: string;
  logger: SessionLoopLogger;
  scheduleHandoffDeadline?: ScheduleHandoffDeadline;
  /**
   * Called with the live session's id when one opens and with `null` when it closes.
   *
   * `stop()` has to reach the running session to abort it (spec D5) and only this loop knows which
   * one that is. Optional and side-effect free, like `scheduleHandoffDeadline` above it.
   */
  onSessionLive?: (providerSessionId: string | null) => void;
};

const defaultScheduleHandoffDeadline: ScheduleHandoffDeadline = (delayMs, onDeadline) => {
  const handle = setTimeout(onDeadline, delayMs);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
};

const actor = { type: "SYSTEM", id: "session-loop" } as const;

type SessionOutcome =
  { type: "OUTCOME"; outcome: ProviderOutcome } | { type: "DEADLINE" } | { type: "FAILED"; error: unknown };

const errorName = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";

// Two checkpoints are the same publication when every field matches. Adapters that cannot stream
// deliver their only checkpoint in the outcome (spec §5.1), while streaming adapters deliver it
// through `onCheckpoint` and then repeat it in the outcome -- persisting both would record work
// that happened once as though it happened twice.
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameCheckpoint = (left: CheckpointDraft | null, right: CheckpointDraft): boolean =>
  left !== null &&
  left.summary === right.summary &&
  sameStrings(left.completed, right.completed) &&
  sameStrings(left.remaining, right.remaining) &&
  sameStrings(left.deadEnds, right.deadEnds) &&
  sameStrings(left.openQuestions, right.openQuestions);

const contextPackSpecFor = (template: WorkflowTemplate, stage: StageAttempt["stage"]): ContextPackSpec => {
  const declared = template.stages.find((candidate) => candidate.stage === stage);
  if (!declared) {
    throw new Error(`The workflow template declares no context pack for the ${stage} stage`);
  }
  return declared.contextPack;
};

const readStageAttempt = (deps: RunStageAttemptDeps): StageAttempt => {
  const snapshot = deps.state.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: deps.dispatch.workItemId });
  const attempt =
    snapshot.type === "WORKFLOW_SNAPSHOT"
      ? snapshot.snapshot.stageAttempts.find(({ id }) => id === deps.dispatch.stageAttemptId)
      : undefined;
  if (!attempt) throw new Error("The StageAttempt backing this dispatch no longer exists");
  return attempt;
};

/**
 * The attempt's sessions, as one read: the next ordinal and "is one already running" are two
 * questions about the same list, and asking them separately would let the answers disagree.
 */
const readAttemptSessions = (deps: RunStageAttemptDeps): { nextOrdinal: number; running: boolean } => {
  const sessions = deps.state.query({
    type: "LIST_PROVIDER_SESSIONS",
    stageAttemptId: deps.dispatch.stageAttemptId,
  });
  if (sessions.type !== "PROVIDER_SESSIONS") throw new Error("Provider sessions could not be read");
  return {
    nextOrdinal: sessions.sessions.reduce((highest, { ordinal }) => Math.max(highest, ordinal), 0) + 1,
    running: sessions.sessions.some(({ status }) => status === "RUNNING"),
  };
};

const endSessionCommand = (
  deps: RunStageAttemptDeps,
  providerSessionId: string,
  endReason: ProviderSessionEndReason,
  providerStarted = true,
): EndProviderSessionCommand => ({
  schemaVersion: 1,
  commandId: deps.createCommandId(),
  correlationId: deps.correlationId,
  actor,
  type: "END_PROVIDER_SESSION",
  payload: { providerSessionId, endReason, providerStarted },
});

// The adapter's input surface is the pack plus identifiers for correlation (spec §5): `stage` and
// `attempt` are what an adapter legitimately keys a model tier or tool set on, and they are passed
// structurally rather than being parsed back out of the rendered pack text.
const providerSessionRef = (
  session: { id: string; ordinal: number },
  attempt: StageAttempt,
): ProviderSessionRef => ({
  id: session.id,
  ordinal: session.ordinal,
  stageAttemptId: attempt.id,
  stage: attempt.stage,
  attempt: attempt.attempt,
});

const readWorkItemWorkspace = (deps: RunStageAttemptDeps): WorkItemWorkspace | null => {
  const result = deps.state.query({
    type: "GET_WORKSPACE_BY_WORK_ITEM",
    workItemId: deps.dispatch.workItemId,
  });
  if (result.type !== "WORKSPACE") throw new Error("The work item's workspace could not be read");
  return result.workspace;
};

/**
 * What preparing the workspace for one StageAttempt ended in.
 *
 * `POSTPONED` is deliberately not a refusal: a lease held by another StageAttempt is spec §7's
 * "dispatch is postponed, not carried out by a second writer" -- a transient fact about who is
 * writing right now, which the owner cannot act on and must not be asked about. Every other way
 * this can end is a `REFUSED` carrying the question the owner *can* act on.
 */
type WorkspacePreparation =
  | { type: "PREPARED"; workspace: WorkItemWorkspace }
  | { type: "REFUSED"; request: HumanRequestDraft }
  | { type: "POSTPONED"; detail: string };

// `git worktree add`'s four refusals (@loomrail/workspace), each named as the question the owner can
// actually answer. Paths and git's own stderr stay out of `title` and go in `context`: a title is
// capped at 200 characters by `humanRequestSchema`, and a long worktree path or a chatty git build
// would push a refusal past that and turn an owner-facing question into a parse failure.
const worktreeRefusal = (
  refusal: AddWorktreeRefusal,
  context: { branch: string; path: string },
): ProvisionRefusal => {
  switch (refusal.type) {
    case "BRANCH_CHECKED_OUT":
      return {
        title: `The branch ${refusal.branch} is already checked out elsewhere`,
        context: `Loomrail cuts this work item's workspace on ${refusal.branch}, but that branch is already checked out in ${refusal.occupiedBy}. Git allows one worktree per branch, and choosing another name automatically would split this work item's work across two branches without anyone deciding to.`,
        recommendation: `Remove or release the worktree at ${refusal.occupiedBy}, or rename the work item so its branch name differs.`,
      };
    case "BRANCH_EXISTS":
      return {
        title: `The branch ${refusal.branch} already exists`,
        context: `Loomrail cuts this work item's workspace on a new branch named ${refusal.branch}, and a branch with that name is already in the repository. Reusing it would put this work item's changes on top of whatever that branch already holds; picking a different name automatically would hide the collision.`,
        recommendation: `Delete or rename the existing ${refusal.branch} branch if it is not needed, or rename the work item so its branch name differs.`,
      };
    case "PATH_EXISTS":
      return {
        title: "This work item's workspace directory is already occupied",
        context: `Loomrail cuts this work item's worktree at ${context.path}, and something is already there. Workspace paths are fixed per work item (spec D2), so Loomrail will not pick another one: whatever is at that path may be an earlier workspace whose record was lost, and deleting it automatically could destroy work.`,
        recommendation: `Inspect ${context.path}, move or delete it once you are sure nothing there is needed, then retry the stage.`,
      };
    case "WORKTREE_ADD_FAILED":
      return {
        title: "Git refused to create this work item's workspace",
        context: `Loomrail ran \`git worktree add\` for the branch ${context.branch} at ${context.path} and git exited ${refusal.exitCode.toString()}. Git reported: ${refusal.stderr.trim().length === 0 ? "(nothing on stderr)" : refusal.stderr.trim()}`,
        recommendation:
          "Read git's message above and repair whatever it names -- disk space, permissions, or the repository itself -- then retry the stage.",
      };
  }
};

// `humanRequestSchema` (@loomrail/contracts) caps a title at 200 characters and a context or
// recommendation at 4000. Refusals on this path are built from values Loomrail does not choose -- a
// registered repository path is allowed 4096 characters on its own, and git's stderr is bounded but
// not short -- so a perfectly ordinary deep path would push a title past its cap. Left unbounded,
// the command carrying the question would be rejected by its own schema and the refusal would reach
// the owner as nothing at all, which is the one outcome this whole path exists to prevent. Cut by
// UTF-16 code unit, so a cut landing inside a surrogate pair is repaired rather than left as an
// ill-formed string.
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 4_000;

const bounded = (text: string, limit: number): string => {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit - 1);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
};

const boundedRequest = (request: HumanRequestDraft): HumanRequestDraft => ({
  ...request,
  title: bounded(request.title, TITLE_LIMIT),
  context: bounded(request.context, DESCRIPTION_LIMIT),
  recommendation: request.recommendation === null ? null : bounded(request.recommendation, DESCRIPTION_LIMIT),
});

const noBaseCommitRefusal = (path: string): ProvisionRefusal => ({
  title: "The repository has no commit to cut a workspace from",
  context: `The repository at ${path} has no commits yet, and nothing uncommitted to carry in either, so there is no commit a worktree could be based on. Git cannot create a worktree from an empty repository.`,
  recommendation: "Make the repository's first commit, then retry the stage.",
});

const workspaceNotReadyRefusal = (workspace: WorkItemWorkspace): ProvisionRefusal => ({
  title: `This work item's workspace is ${workspace.status.toLowerCase()}, not ready to be written in`,
  context: `The workspace recorded for this work item is on branch ${workspace.branch} at ${workspace.worktreePath}, and its status is ${workspace.status}. Loomrail does not recreate a workspace by itself (AD-008): a directory that disappeared may still hold the only copy of earlier work, and re-cutting one silently would hide that.`,
  recommendation: `Restore or remove ${workspace.worktreePath} yourself, then retry the stage. The branch ${workspace.branch} still holds whatever was committed to it.`,
});

const workspaceGoneRefusal = (workspace: WorkItemWorkspace): ProvisionRefusal => ({
  title: "This work item's workspace is no longer on disk",
  context: `Loomrail records this work item's workspace as ready on branch ${workspace.branch} at ${workspace.worktreePath}, but there is no worktree there now -- the directory was removed, or git no longer recognises it as one. Dispatching the stage anyway would start an agent in a directory that does not exist. Loomrail does not re-cut a workspace by itself (AD-008): the branch may still hold work nobody has merged, and quietly starting a second workspace would hide that.`,
  recommendation: `Restore the worktree at ${workspace.worktreePath} from the project's repository (\`git worktree add ${workspace.worktreePath} ${workspace.branch}\`), or, once you are sure nothing on ${workspace.branch} is needed, remove the workspace and let the next attempt cut a fresh one. Then retry the stage.`,
});

const provisioningFailedRefusal = (error: unknown, path: string | null): ProvisionRefusal => ({
  title: "This work item's workspace could not be prepared",
  context: `Loomrail could not cut a workspace${path === null ? "" : ` from the repository at ${path}`}: ${errorName(error)}. No session was started, because an agent with no workspace would produce prose for a stage that is meant to change files.`,
  recommendation:
    "Check the repository and the Loomrail data directory for whatever the message above names, then retry the stage.",
});

const canonicalPathOf = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

/**
 * Cuts the workspace this StageAttempt will write in, in the order spec §6 fixes: inspect the
 * repository, let the domain decide, snapshot what is uncommitted, `worktree add`, and only then
 * record the entity. The order is the correctness: nothing reaches the database before the thing it
 * describes exists on disk, because a row naming a worktree that was never created is worse than no
 * row at all.
 */
const createWorkspace = async (
  deps: RunStageAttemptDeps,
): Promise<
  { type: "PREPARED"; workspace: WorkItemWorkspace } | { type: "REFUSED"; request: HumanRequestDraft }
> => {
  const workItemResult = deps.state.query({ type: "GET_WORK_ITEM", workItemId: deps.dispatch.workItemId });
  const workItem = workItemResult.type === "WORK_ITEM" ? workItemResult.workItem : null;
  if (!workItem) throw new Error("The WorkItem backing this dispatch no longer exists");
  const projectResult = deps.state.query({ type: "GET_PROJECT", projectId: workItem.projectId });
  const project = projectResult.type === "PROJECT" ? projectResult.project : null;
  if (!project) throw new Error("The Project backing this dispatch no longer exists");

  // Canonicalised before anything is compared to it: git reports its top level as a physical path,
  // so a repository reached through a symlink -- macOS's own `/var` -> `/private/var`, or a data
  // directory the owner symlinked -- would never compare equal to the path as registered.
  const canonicalPath = await canonicalPathOf(project.repositoryPath);
  const inspected = canonicalPath === null ? null : await inspectRepository(canonicalPath);
  // A Project registered at a *subdirectory* of a repository is not a repository Loomrail may cut
  // from: `--show-toplevel` names the enclosing repository, and a worktree cut from that would
  // branch the owner's outer repository and hand the agent everything inside it. The same refusal
  // as a path that is not a repository at all, but not the same *reason*: which of the two it is
  // travels to the domain as `insideRepository`, because the fix an owner is given differs.
  const isOwnTopLevel = inspected !== null && inspected.topLevel === canonicalPath;
  const repository = isOwnTopLevel ? inspected : null;

  const decision = decideProvisionWorkspace({
    repository: {
      isRepository: repository !== null,
      inProgress: repository?.inProgress ?? null,
      path: project.repositoryPath,
      insideRepository: isOwnTopLevel ? null : (inspected?.topLevel ?? null),
    },
  });
  if (decision.type === "REFUSED") return { type: "REFUSED", request: decision.request };
  if (repository === null) {
    // Unreachable today: `decideProvisionWorkspace` refuses every repository it was told is not
    // one, and `repository === null` is exactly what produced `isRepository: false` above. A throw
    // rather than a non-null assertion (AGENTS.md) so a future change that let PROVISION through
    // without a repository fails loudly instead of dereferencing null.
    throw new Error("A workspace was approved for a path that is not a repository");
  }

  const snapshot = await createCarryInSnapshot({
    topLevel: repository.topLevel,
    headCommit: repository.headCommit,
    message: `Loomrail carry-in for ${workItem.id}`,
  });
  // The snapshot when there was something to carry, HEAD when there was not. Both null means an
  // empty repository with nothing in it -- there is no commit to branch from, and git would refuse.
  const startPoint = snapshot?.commit ?? repository.headCommit;
  if (startPoint === null) {
    return { type: "REFUSED", request: provisionRefusalRequest(noBaseCommitRefusal(project.repositoryPath)) };
  }

  const branch = workspaceBranchName({ workItemId: workItem.id, title: workItem.title });
  const worktreePath = join(deps.workspacesRoot, workItem.projectId, workItem.id);
  // Only the parent: `addWorktree` refuses a path that already exists (PATH_EXISTS), and git
  // creates the worktree directory itself.
  await mkdir(dirname(worktreePath), { recursive: true });

  const added = await addWorktree({
    topLevel: repository.topLevel,
    branch,
    path: worktreePath,
    startPoint,
  });
  if (added.type === "REFUSED") {
    return {
      type: "REFUSED",
      request: provisionRefusalRequest(worktreeRefusal(added.refusal, { branch, path: worktreePath })),
    };
  }

  // `maxCarriedPaths` is the same bound the contract enforces, read from the contract rather than
  // restated here (contracts/workspace.ts exports it for exactly this). A carry-in of more files
  // than the event can list is still a legitimate carry-in -- the worktree already holds all of
  // them -- so the list is cut to what the audit record can hold and the cut is logged, rather than
  // letting `.parse` reject a workspace that exists on disk.
  const carriedPaths = snapshot?.carriedPaths ?? [];
  if (carriedPaths.length > maxCarriedPaths) {
    deps.logger.warn(
      { workItemId: workItem.id, carriedPaths: carriedPaths.length, recorded: maxCarriedPaths },
      "More files were carried into the workspace than the event can list; the record names the first of them",
    );
  }

  try {
    const created = deps.state.execute({
      schemaVersion: 1,
      commandId: deps.createCommandId(),
      correlationId: deps.correlationId,
      actor,
      type: "CREATE_WORK_ITEM_WORKSPACE",
      payload: {
        workItemId: workItem.id,
        projectId: workItem.projectId,
        branch,
        worktreePath,
        baseCommit: repository.headCommit,
        snapshotCommit: snapshot?.commit ?? null,
        carriedPaths: carriedPaths.slice(0, maxCarriedPaths),
      },
    });
    if (created.type !== "WORK_ITEM_WORKSPACE_CREATED") throw new Error("The workspace was not recorded");
    return { type: "PREPARED", workspace: created.workspace };
  } catch (error: unknown) {
    // The worktree exists on disk and nothing records it. Left alone it would be a directory no row
    // names, and the next attempt would meet it as PATH_EXISTS forever. Removing it is safe
    // precisely because `addWorktree` refused a path that already existed: this directory is the one
    // this call just created.
    try {
      await removeWorktree({ topLevel: repository.topLevel, path: worktreePath });
      // And the branch with it. `git worktree remove` deliberately leaves the branch behind, which
      // for a rollback is litter that blames the owner: the next attempt meets its own abandoned
      // branch as BRANCH_EXISTS, and that refusal asks the owner to delete or rename a branch
      // Loomrail created seconds earlier and never used. Deleting it is safe here for two reasons
      // that both have to hold: `addWorktree` refused both BRANCH_CHECKED_OUT and BRANCH_EXISTS, so
      // this branch did not exist before this call created it; and the deletion is conditional on
      // the ref still pointing at the very commit it was created at, so a branch that somehow
      // acquired a commit is left alone. No session ever opened, so there is nothing on it to lose.
      // Removing it also unreferences the carry-in snapshot commit, which is the only other thing
      // this failed attempt left in the owner's repository -- the work it holds is still sitting in
      // their working copy, where it never stopped being.
      const branchRemoval = await deleteBranchIfUnmoved({
        topLevel: repository.topLevel,
        branch,
        expectedCommit: startPoint,
      });
      if (branchRemoval !== "DELETED") {
        deps.logger.warn(
          { branch, outcome: branchRemoval },
          "The branch of a workspace that could not be recorded was left in the repository",
        );
      }
    } catch (removalError: unknown) {
      deps.logger.warn(
        { worktreePath, error: errorName(removalError) },
        "A workspace that could not be recorded could not be removed either; its directory is still on disk",
      );
    }
    return {
      type: "REFUSED",
      request: provisionRefusalRequest(provisioningFailedRefusal(error, project.repositoryPath)),
    };
  }
};

/**
 * Takes the workspace's lease for this StageAttempt (spec D6: one writer at a time).
 *
 * A lease this attempt already holds is not re-taken -- that is the ordinary state after a daemon
 * restart picked the attempt back up, and the storage claim (`WHERE lease_holder IS NULL`) would
 * read it as someone else's and refuse forever.
 */
const acquireWorkspaceLease = (
  deps: RunStageAttemptDeps,
  workspace: WorkItemWorkspace,
): WorkspacePreparation => {
  const stageAttemptId = deps.dispatch.stageAttemptId;
  if (workspace.leaseHolder === stageAttemptId) return { type: "PREPARED", workspace };
  if (workspace.leaseHolder !== null) {
    return { type: "POSTPONED", detail: `held by ${workspace.leaseHolder}` };
  }
  try {
    const acquired = deps.state.execute({
      schemaVersion: 1,
      commandId: deps.createCommandId(),
      correlationId: deps.correlationId,
      actor,
      type: "ACQUIRE_WORKSPACE_LEASE",
      payload: { workspaceId: workspace.id, stageAttemptId, expectedVersion: workspace.version },
    });
    if (acquired.type !== "WORKSPACE_LEASE_ACQUIRED") throw new Error("The workspace lease was not acquired");
    return { type: "PREPARED", workspace: acquired.workspace };
  } catch (error: unknown) {
    // Both codes mean the same thing for a caller: someone else moved the workspace between the read
    // above and this claim. Spec §7 postpones the dispatch rather than failing it -- the claim is a
    // single `UPDATE ... WHERE lease_holder IS NULL`, so losing it is proof another writer won, not
    // an error to retry blindly.
    if (
      error instanceof StateStoreError &&
      (error.code === "WORKSPACE_LEASE_HELD" || error.code === "WORKSPACE_VERSION_CONFLICT")
    ) {
      return { type: "POSTPONED", detail: error.code };
    }
    throw error;
  }
};

/**
 * Whether the worktree a recorded workspace names is still a worktree at that path.
 *
 * The row alone is not evidence. Startup reconciliation checks the disk once, at startup; a
 * directory removed while the daemon runs -- by the owner, by a cleanup script, by an agent -- is
 * seen by nothing until the next restart, and every stage in between would be dispatched into a
 * path with nothing at it. Checked the same way `createWorkspace` checks a repository: `realpath`
 * first, because a missing directory has no real path at all, and then git's own answer, because a
 * directory that exists is not the same as a worktree git still recognises (a pruned worktree
 * leaves an ordinary directory behind, and a re-created one is not this workspace).
 */
const worktreeStillUsable = async (worktreePath: string): Promise<boolean> => {
  const canonical = await canonicalPathOf(worktreePath);
  if (canonical === null) return false;
  const inspected = await inspectRepository(canonical);
  return inspected !== null && inspected.topLevel === canonical;
};

const prepareWorkspace = async (deps: RunStageAttemptDeps): Promise<WorkspacePreparation> => {
  const existing = readWorkItemWorkspace(deps);
  if (existing === null) {
    const created = await createWorkspace(deps);
    return created.type === "PREPARED" ? acquireWorkspaceLease(deps, created.workspace) : created;
  }
  if (existing.status !== "READY") {
    return { type: "REFUSED", request: provisionRefusalRequest(workspaceNotReadyRefusal(existing)) };
  }
  // A READY row is a claim about the disk, and this is the one place that verifies it before the
  // claim is acted on. Checked before the lease rather than after: taking a lease on a workspace
  // that is not there would hand this attempt a writer's claim over nothing, and the next attempt
  // would meet it as postponed rather than as the question the owner can answer.
  if (!(await worktreeStillUsable(existing.worktreePath))) {
    return { type: "REFUSED", request: provisionRefusalRequest(workspaceGoneRefusal(existing)) };
  }
  return acquireWorkspaceLease(deps, existing);
};

/**
 * `prepareWorkspace` with the guarantee spec §6 asks of this whole path: every way it can fail ends
 * as a blocking question to the owner, not as an exception thrown into the session loop.
 *
 * The named refusals inside already cover every failure anyone modelled -- a repository mid-rebase,
 * an occupied branch, a directory in the way, git exiting non-zero. This catch is for the rest: a
 * `git` binary that is not on PATH at all, a plumbing command that fails mid-snapshot, a full disk
 * under `mkdir`. Left to propagate, those would surface as the background worker's "could not
 * finish a pass" and the dispatch would sit PENDING with nobody told why.
 */
const prepareWorkspaceSafely = async (deps: RunStageAttemptDeps): Promise<WorkspacePreparation> => {
  try {
    return await prepareWorkspace(deps);
  } catch (error: unknown) {
    const workItem = deps.state.query({ type: "GET_WORK_ITEM", workItemId: deps.dispatch.workItemId });
    const project =
      workItem.type === "WORK_ITEM" && workItem.workItem !== null
        ? deps.state.query({ type: "GET_PROJECT", projectId: workItem.workItem.projectId })
        : null;
    const path = project?.type === "PROJECT" ? (project.project?.repositoryPath ?? null) : null;
    deps.logger.warn(
      { stageAttemptId: deps.dispatch.stageAttemptId, error: errorName(error) },
      "The work item's workspace could not be prepared; the owner was asked",
    );
    return { type: "REFUSED", request: provisionRefusalRequest(provisioningFailedRefusal(error, path)) };
  }
};

/**
 * Gives the workspace back once the StageAttempt is done with it (spec §6: the lease is held for
 * the attempt's duration, and released when it ends -- including when it ends badly).
 *
 * Nothing here escapes: this runs in the `finally` of an attempt that may already be unwinding, and
 * a throw would replace whatever really went wrong with a lease-release error. A lease left behind
 * is visible as the next attempt's postponed dispatch, and is what startup reconciliation exists to
 * clear.
 */
const releaseWorkspaceLease = (deps: RunStageAttemptDeps, workspaceId: string): void => {
  const stageAttemptId = deps.dispatch.stageAttemptId;
  try {
    const workspace = readWorkItemWorkspace(deps);
    // Only this attempt's own lease on this very workspace is given back: anything else means the
    // workspace moved on (a release that already happened, a row this attempt never held) and
    // releasing it would take a lease away from whoever holds it now.
    if (workspace?.id !== workspaceId || workspace.leaseHolder !== stageAttemptId) return;
    deps.state.execute({
      schemaVersion: 1,
      commandId: deps.createCommandId(),
      correlationId: deps.correlationId,
      actor,
      type: "RELEASE_WORKSPACE_LEASE",
      payload: { workspaceId, stageAttemptId, expectedVersion: workspace.version },
    });
  } catch (error: unknown) {
    deps.logger.warn(
      { workspaceId, stageAttemptId, error: errorName(error) },
      "The workspace lease could not be released; the next stage attempt will find it held",
    );
  }
};

/** The workspace whose lease this attempt took, so the `finally` below knows whether to give it back. */
type WorkspaceLeaseSlot = { workspaceId: string | null };

const runProviderSessions = async (deps: RunStageAttemptDeps, lease: WorkspaceLeaseSlot): Promise<void> => {
  const scheduleDeadline = deps.scheduleHandoffDeadline ?? defaultScheduleHandoffDeadline;
  const capabilities = deps.adapter.capabilities();
  const stageAttemptId = deps.dispatch.stageAttemptId;
  let lastSessionOrdinal = 0;

  for (let session = 0; session < MAX_SESSIONS_PER_ATTEMPT; session += 1) {
    const attempt = readStageAttempt(deps);
    if (attempt.status !== "RUNNING") {
      deps.logger.info(
        { stageAttemptId, status: attempt.status },
        "The stage attempt is no longer running; the session loop stops",
      );
      return;
    }

    // Task 9 (milestone A2): before E1 a live adapter has no filesystem access, so it cannot serve
    // a stage it did not declare in `capabilities().stages` -- most notably IMPLEMENT. Task 10.5
    // added the other half: `capabilities().start` is `false` when the adapter's CLI is not on this
    // machine at all, and that must refuse every stage, not just the ones it happens not to
    // declare -- an adapter with no executable still declares its normal `stages` (task 10.5
    // deliberately keeps `start` and `stages` as separate claims; see provider-codex/provider-
    // claude-code's `capabilities()`), so checking `declaredStages` alone would have dispatched to
    // it anyway. Checked here, before a session ever opens: starting one anyway would either fail to
    // spawn or let the adapter return prose for a stage it never touched, and the stage would look
    // done with no work behind it. The refusal is completed through the same APPLY_PROVIDER_OUTCOME
    // command a provider's own NEEDS_HUMAN outcome uses, so it reaches the owner exactly the way any
    // other blocking question does -- a HumanRequest, the run and this StageAttempt moved to
    // WAITING_HUMAN, and the pending dispatch completed rather than left to spin the drain.
    const dispatchDecision = decideDispatchStage({
      stage: attempt.stage,
      provider: capabilities.provider,
      declaredStages: capabilities.stages,
      canStart: capabilities.start,
    });
    // Both refusals are completed the same way -- through the same APPLY_PROVIDER_OUTCOME command a
    // provider's own NEEDS_HUMAN outcome uses -- because from the dispatcher's side they are the
    // same outcome: a stage that did not start, and a question explaining why. They stay separate
    // variants of `DispatchStageDecision` because their fixes differ, and the log line names which
    // one happened.
    const refuseDispatch = (decision: Exclude<DispatchStageDecision, { type: "DISPATCH" }>): void => {
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: deps.dispatch.id,
          outcome: { type: "NEEDS_HUMAN", request: boundedRequest(decision.request) },
          template: deps.template,
        },
      });
      deps.logger.warn(
        {
          stageAttemptId,
          stage: attempt.stage,
          provider: capabilities.provider,
          canStart: String(capabilities.start),
          reason: decision.type,
        },
        decision.type === "STAGE_NOT_SERVED"
          ? "The adapter refused this dispatch; the owner was asked"
          : "This stage needs a workspace and none could be cut; the owner was asked",
      );
    };

    if (dispatchDecision.type === "STAGE_NOT_SERVED") {
      refuseDispatch(dispatchDecision);
      return;
    }

    // Spec §6: the workspace is cut before the first session opens, never alongside it. Which stages
    // need one is a property of the stage (`stagesRequiringWorkspace` in `@loomrail/domain`), read
    // from there rather than compared against stage names here -- DISCOVERY, PLAN, REVIEW and
    // ACCEPTANCE produce prose and must not have a worktree cut for them at all. Done once per
    // attempt: `lease.workspaceId` is set as soon as this attempt holds the lease, and every later
    // session in the same attempt writes in the same worktree (spec D1).
    if (lease.workspaceId === null && stageRequiresWorkspace(attempt.stage)) {
      const prepared = await prepareWorkspaceSafely(deps);
      if (prepared.type === "REFUSED") {
        refuseDispatch({ type: "WORKSPACE_NOT_PROVISIONED", request: prepared.request });
        return;
      }
      if (prepared.type === "POSTPONED") {
        // Spec §7: a lease another StageAttempt holds postpones this dispatch rather than failing
        // it. The dispatch stays PENDING -- exactly like the "another caller is already running a
        // session" branch below -- so the next drain picks it back up once the lease is given back.
        deps.logger.info(
          { stageAttemptId, workItemId: deps.dispatch.workItemId, detail: prepared.detail },
          "Another stage attempt is writing in this work item's workspace; this dispatch waits",
        );
        return;
      }
      lease.workspaceId = prepared.workspace.id;
      deps.logger.info(
        {
          stageAttemptId,
          workspaceId: prepared.workspace.id,
          branch: prepared.workspace.branch,
          worktreePath: prepared.workspace.worktreePath,
        },
        "The work item's workspace is ready and leased to this stage attempt",
      );
    }

    const sessions = readAttemptSessions(deps);
    // Nothing serialises the daemon's drain, and the dispatch stays PENDING for the attempt's whole
    // life, so two concurrent callers can reach this point for the same dispatch. A session already
    // running on this attempt means another caller owns it -- which is the same situation as an
    // attempt that is no longer RUNNING, and is answered the same way. The storage invariant
    // (PROVIDER_SESSION_ALREADY_RUNNING) stays as the backstop it is; without this check it was the
    // thing the owner met, as a 500.
    if (sessions.running) {
      deps.logger.info(
        { stageAttemptId },
        "Another caller is already running a provider session on this stage attempt; the session loop stops",
      );
      return;
    }

    const sessionOrdinal = sessions.nextOrdinal;
    lastSessionOrdinal = sessionOrdinal;
    const sources = deps.state.query({ type: "READ_CONTEXT_SOURCES", stageAttemptId, sessionOrdinal });
    if (sources.type !== "CONTEXT_SOURCES") throw new Error("The context sources could not be read");

    // Spec §6.1 step 2: a share of the window declared by the adapter, never the whole window.
    // The share is derived from the attempt's own durable backoff count, not from a local variable:
    // §6.4 makes a daemon restart an ordinary end of a session, and a share held in memory would be
    // silently restored to full by the very event §7's "one automatic retry" has to survive.
    const packShare = MAX_PACK_SHARE - attempt.packShareBackoffs * PACK_SHARE_BACKOFF;
    const budgetTokens = Math.max(1, Math.floor(capabilities.contextWindowTokens * packShare));
    const assembled = assembleContextPack({
      sources: sources.sources,
      spec: contextPackSpecFor(deps.template, attempt.stage),
      budgetTokens,
      bytesPerToken: BYTES_PER_TOKEN,
    });

    if (assembled.type === "FLOOR_EXCEEDED") {
      // Spec §D8: the required sections do not fit, so the session does not start at all. Trimming
      // a required section would hand the agent an input Loomrail knows is incomplete.
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "HARD_PAUSE_STAGE_ATTEMPT",
        payload: {
          stageAttemptId,
          reason: {
            type: "CONTEXT_FLOOR_EXCEEDED",
            sessionOrdinal,
            requiredBytes: assembled.requiredBytes,
            budgetBytes: assembled.budgetBytes,
            budgetTokens,
          },
        },
      });
      deps.logger.warn(
        { stageAttemptId, sessionOrdinal, requiredBytes: assembled.requiredBytes, budgetTokens },
        "The required context sections do not fit the pack budget; the attempt is hard-paused",
      );
      return;
    }

    const started = deps.state.execute({
      schemaVersion: 1,
      commandId: deps.createCommandId(),
      correlationId: deps.correlationId,
      actor,
      type: "START_PROVIDER_SESSION",
      payload: {
        stageAttemptId,
        // Parsed rather than cast: `ContextSourceRef.kind` is a plain string on the assembler's
        // side, and the recipe is the audit record spec D7 rests on, so the narrowing to the
        // contract's source kinds happens through the schema that defines them.
        recipe: contextPackRecipeInputSchema.parse({
          schemaVersion: 1,
          templateId: deps.template.id,
          templateVersion: deps.template.version,
          specSource: "WORKFLOW_TEMPLATE",
          sections: assembled.recipe.sections,
          omitted: assembled.recipe.omitted,
          contentHash: assembled.pack.contentHash,
          estimatedTokens: assembled.recipe.estimatedTokens,
          budgetTokens: assembled.recipe.budgetTokens,
          // Loomrail sized this pack from its own byte count, whatever the adapter can report about
          // occupancy later: the estimate quality describes how the size was arrived at, not how
          // well the provider can measure itself.
          estimateQuality: "LOOMRAIL_ESTIMATE",
        }),
        // Always null here, never guessed: `ProviderAdapter.start()` below has not even been
        // called yet at this point, and it is `start()` that spawns the child, deep inside its own
        // implementation. The real pid, if any, arrives later on `listener.onProcessStarted` and is
        // recorded through its own RECORD_PROVIDER_SESSION_PROCESS command below, once it is known.
        pid: null,
      },
    });
    if (started.type !== "PROVIDER_SESSION_STARTED") throw new Error("The ProviderSession did not start");
    const providerSession = started.session;
    deps.onSessionLive?.(providerSession.id);

    // One mutable record rather than four `let`s: the listener callbacks below run while `start()`
    // is still in flight, so these are shared between this function body and those closures.
    const live = {
      closed: false,
      handoffRequested: false,
      checkpointWriteFailed: false,
      // Every integer percent already reported to state for this session. At most 101 entries.
      // See the comment on `reportedPercent` in `onContextWindow`.
      reportedPercents: new Set<number>(),
    };
    let lastPublished: CheckpointDraft | null = null;
    let deadline: HandoffDeadline | undefined;
    let signalDeadline: (() => void) | undefined;
    const deadlineReached = new Promise<SessionOutcome>((resolve) => {
      signalDeadline = () => {
        resolve({ type: "DEADLINE" });
      };
    });

    const publishCheckpoint = (draft: CheckpointDraft): boolean => {
      try {
        deps.state.execute({
          schemaVersion: 1,
          commandId: deps.createCommandId(),
          correlationId: deps.correlationId,
          actor,
          type: "PUBLISH_CHECKPOINT",
          payload: { providerSessionId: providerSession.id, checkpoint: draft },
        });
        lastPublished = draft;
        return true;
      } catch (error: unknown) {
        // Spec §6.2: a failed checkpoint write cannot be swallowed. The agent believes it published
        // progress, and the next pack would be assembled without it, so the session ends
        // INTERRUPTED and stays unproductive rather than dissolving into a log line.
        live.checkpointWriteFailed = true;
        deps.logger.warn(
          { providerSessionId: providerSession.id, error: errorName(error) },
          "A published checkpoint could not be persisted; the session will be cut",
        );
        return false;
      }
    };

    const listener: ProviderSessionListener = {
      onContextWindow: (reported) => {
        if (live.closed || live.handoffRequested) return;
        // Provider output is untrusted input: a report that does not satisfy the contract is
        // recorded and dropped rather than driving a cut.
        const usage = contextWindowUsageSchema.safeParse(reported);
        if (!usage.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider reported context-window occupancy that does not satisfy the contract",
          );
          return;
        }
        // Occupancy is state now, and state is written by a command, so every report costs a row
        // in the append-only `commands` table -- it already did, because the receipt is written
        // outside the branch that decided the report changed nothing. With the mock that is a
        // handful of rows; a live adapter streams occupancy continuously across up to
        // MAX_SESSIONS_PER_ATTEMPT sessions, and most of those rows say only "not yet".
        //
        // So a report is sent once per integer percentage point of the window, which is exactly
        // the resolution the cockpit renders: 101 rows per session at the very worst, and the
        // displayed figure never more than a point stale. The commandId is built from that same
        // percent rather than freshly generated, so the row a report costs is identified by what
        // makes it worth writing.
        //
        // The set has to hold every point already sent, not just the last one: occupancy is not
        // monotonic (dropping a large tool result out of the window frees points), so a session
        // can return to a percent it has left. A repeat would then reuse the commandId with a
        // different token count in the payload, and `execute` rejects a reused id whose input
        // hashes differently -- COMMAND_ID_REUSED, thrown from inside a provider callback, which
        // this loop can only read as the provider failing.
        //
        // Two consequences, both accepted deliberately. First, a handoff fires on the first
        // reading in the percentage band that contains the threshold and every later reading in
        // that band is suppressed, so a 75% threshold can be crossed at up to just under 76% --
        // simulated at 75.51%. Second, what a session stores is its PEAK occupancy, not its
        // current one: readings that fall back into a band already visited never reach state at
        // all, and persistence keeps the highest reading regardless. Showing true current
        // occupancy for a provider that compacts its own window would need a command id that
        // survives revisiting a percent, and belongs to A2, when such an adapter exists. Do not
        // build it here.
        const reportedPercent = Math.round((usage.data.usedTokens / usage.data.windowTokens) * 100);
        if (live.reportedPercents.has(reportedPercent)) return;
        live.reportedPercents.add(reportedPercent);
        const requested = deps.state.execute({
          schemaVersion: 1,
          commandId: `usage-${providerSession.id}-${reportedPercent.toString()}`,
          correlationId: deps.correlationId,
          actor,
          type: "REQUEST_CONTEXT_HANDOFF",
          payload: {
            providerSessionId: providerSession.id,
            usage: usage.data,
            handoffThreshold: HANDOFF_THRESHOLD,
          },
        });
        if (requested.type !== "CONTEXT_HANDOFF_REQUESTED" || !requested.requested) return;
        live.handoffRequested = true;
        deps.logger.info(
          { providerSessionId: providerSession.id, usedTokens: usage.data.usedTokens },
          "Asked the provider to wind this session down",
        );
        // Deliberately not awaited: `onContextWindow` is called while `start()` is still running,
        // and the request is idempotent and safe for a session that has already ended (§6.2).
        void deps.adapter.requestHandoff(providerSession.id).catch((error: unknown) => {
          deps.logger.warn(
            { providerSessionId: providerSession.id, error: errorName(error) },
            "The provider could not be asked to wind down",
          );
        });
        deadline = scheduleDeadline(HANDOFF_DEADLINE_MS, () => signalDeadline?.());
      },
      onCheckpoint: (draft) => {
        if (live.closed) return;
        // Spec §7: an invalid checkpoint is rejected rather than half-accepted -- the next pack is
        // built on it. The session then simply published nothing, which §6.5 already accounts for.
        const validated = checkpointDraftSchema.safeParse(draft);
        if (!validated.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider published a checkpoint that does not satisfy the contract; it was rejected",
          );
          return;
        }
        publishCheckpoint(validated.data);
      },
      // Spend, not occupancy (see the comment on `ProviderSessionListener.onUsage` in
      // provider-core): a separate channel from `onContextWindow` because window occupancy drives
      // handoff while this drives budget thresholds and the HARD pause (BD-001).
      //
      // Provider output is untrusted input, exactly like the two listeners above: a report that
      // does not satisfy the contract is logged and dropped rather than acted on.
      //
      // There is nowhere durable to put a valid report yet. `usage_records` and the budget
      // machinery that reads it (`decideApplyProviderOutcome`'s BUDGET_LIMIT_REACHED branch) are
      // built around one lump-sum outcome at the end of a bounded mock stage, tied to a
      // BudgetPolicy and to the IMPLEMENT stage -- not a per-turn stream of real spend from a live
      // adapter. Recording a report through that path would mean deciding, inside this task, how a
      // ProviderUsage maps onto that shape; that design belongs to whichever task wires real
      // budget enforcement to live adapters, not to opening this channel. Until it lands, a valid
      // report is written to the structured logger so it is visible rather than silently dropped.
      onUsage: (reported) => {
        if (live.closed) return;
        const usage = providerUsageSchema.safeParse(reported);
        if (!usage.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider reported usage that does not satisfy the contract",
          );
          return;
        }
        deps.logger.info(
          {
            providerSessionId: providerSession.id,
            inputTokens: usage.data.inputTokens,
            outputTokens: usage.data.outputTokens,
            quality: usage.data.quality,
          },
          "The provider reported usage",
        );
      },
      // Spec §8 follow-up: the durable half of `ProviderSessionListener.onProcessStarted`
      // (@loomrail/provider-core) -- a live adapter calls this at most once, right after its
      // process runner returns a pid, and MOCK (and any adapter that spawns nothing) never calls
      // it at all, which is exactly what leaves the session's `pid` null. Written through its own
      // command, like every other durable report in this loop, rather than as a direct write --
      // the commandId is keyed on the session alone (not a value like `onContextWindow`'s percent)
      // because a pid is reported at most once per session, so there is nothing to distinguish
      // repeat reports by.
      onProcessStarted: (pid) => {
        if (live.closed) return;
        const validated = providerSessionProcessPidSchema.safeParse(pid);
        if (!validated.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The adapter reported a process id that does not satisfy the contract",
          );
          return;
        }
        deps.state.execute({
          schemaVersion: 1,
          commandId: `process-${providerSession.id}`,
          correlationId: deps.correlationId,
          actor,
          type: "RECORD_PROVIDER_SESSION_PROCESS",
          payload: { providerSessionId: providerSession.id, pid: validated.data },
        });
        deps.logger.info(
          { providerSessionId: providerSession.id, pid: validated.data },
          "Recorded the process this session is driving",
        );
      },
    };

    // Wrapped in its own async function rather than chaining `.then(onSuccess, onFailure)` off the
    // call directly: `.then` only catches a *rejected* promise, and an adapter that throws
    // synchronously instead of rejecting (or a synchronous throw from `providerSessionRef` itself)
    // would otherwise escape `Promise.race` entirely, skipping `live.closed = true` and
    // `onSessionLive(null)` below and leaving `liveSessionId` pointed at a session that is no
    // longer live for a later `stop()` to mis-abort. `await` inside a try/catch converts either
    // failure mode into the same FAILED outcome the reject path already produces.
    const startSession = async (): Promise<SessionOutcome> => {
      try {
        const outcome = await deps.adapter.start(
          {
            dispatch: deps.dispatch,
            session: providerSessionRef(providerSession, attempt),
            contextPack: assembled.pack,
          },
          listener,
        );
        return { type: "OUTCOME", outcome };
      } catch (error: unknown) {
        return { type: "FAILED", error };
      }
    };

    const result: SessionOutcome = await Promise.race([startSession(), deadlineReached]);
    live.closed = true;
    deps.onSessionLive?.(null);
    deadline?.cancel();

    if (result.type === "FAILED") {
      // `providerStarted: false`: the adapter refused the invocation, so this session never had a
      // chance to publish anything and §6.5's guard does not apply to it. §7's branches below own
      // this case, and pausing twice for one failure would ask the owner two questions about it.
      deps.state.execute(endSessionCommand(deps, providerSession.id, "INTERRUPTED", false));
      // Only a size rejection is something Loomrail can act on by itself (spec §7). Any other
      // failure is the provider's, and shrinking the pack in response would treat a transient error
      // as an estimation mistake and then ask the owner a question about a context size that had
      // nothing to do with it.
      const packWasTooLarge = result.error instanceof ProviderPackTooLargeError;
      const canRetrySmaller =
        packWasTooLarge && attempt.packShareBackoffs === 0 && packShare - PACK_SHARE_BACKOFF > 0;
      if (canRetrySmaller) {
        deps.state.execute({
          schemaVersion: 1,
          commandId: deps.createCommandId(),
          correlationId: deps.correlationId,
          actor,
          type: "REDUCE_CONTEXT_PACK_SHARE",
          payload: { stageAttemptId },
        });
        deps.logger.warn(
          { stageAttemptId, sessionOrdinal, error: errorName(result.error) },
          "The provider rejected the assembled pack; retrying once with a smaller pack share",
        );
        continue;
      }
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "HARD_PAUSE_STAGE_ATTEMPT",
        payload: {
          stageAttemptId,
          reason: {
            type: packWasTooLarge ? "PROVIDER_REJECTED_PACK" : "PROVIDER_START_FAILED",
            sessionOrdinal,
          },
        },
      });
      deps.logger.warn(
        { stageAttemptId, sessionOrdinal, error: errorName(result.error) },
        packWasTooLarge
          ? "The provider rejected the assembled pack after a retry; the attempt is hard-paused"
          : "The provider session failed to start; the attempt is hard-paused",
      );
      return;
    }

    let endReason: ProviderSessionEndReason;
    let stageResult: ProviderOutcome | null = null;
    if (result.type === "DEADLINE") {
      // Spec §7: the wind-down request was ignored, so the session is cut hard. Awaited, unlike
      // `requestHandoff`: the next session must not open while this one is still running. Loomrail
      // records the end either way -- a provider that cannot be reached to be stopped is exactly the
      // case the owner has to be able to see -- but it stops as soon as the abort settles rather
      // than leaving two live sessions on one StageAttempt.
      try {
        await deps.adapter.abortSession(providerSession.id);
      } catch (error: unknown) {
        deps.logger.warn(
          { providerSessionId: providerSession.id, error: errorName(error) },
          "The cut session could not be aborted; it may still be running on the provider",
        );
      }
      endReason = "CONTEXT_EXHAUSTED";
      deps.logger.warn(
        { providerSessionId: providerSession.id, deadlineMs: HANDOFF_DEADLINE_MS },
        "The provider did not wind down before the handoff deadline; the session was cut",
      );
    } else if (result.outcome.type === "HANDED_OFF" || result.outcome.type === "CONTEXT_EXHAUSTED") {
      const carried = result.outcome.checkpoint;
      if (carried !== undefined && !sameCheckpoint(lastPublished, carried)) {
        const validated = checkpointDraftSchema.safeParse(carried);
        if (validated.success) {
          publishCheckpoint(validated.data);
        } else {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider's final checkpoint does not satisfy the contract; it was rejected",
          );
        }
      }
      endReason = result.outcome.type === "HANDED_OFF" ? "HANDOFF" : "CONTEXT_EXHAUSTED";
    } else {
      endReason = "COMPLETED";
      stageResult = result.outcome;
    }
    // Only when the session ended without a stage result. §6.2 cuts a session whose checkpoint
    // could not be persisted because the *next* session's pack would be assembled without it -- and
    // a session that finished the stage has no next session on this attempt, so nothing is carried
    // forward and nothing is lost. Rewriting the reason there would also route a completed stage
    // through §6.5, hard-pause the attempt on the second occurrence, and then hand
    // APPLY_PROVIDER_OUTCOME an attempt that is no longer RUNNING.
    if (live.checkpointWriteFailed && stageResult === null) endReason = "INTERRUPTED";

    const ended = deps.state.execute(endSessionCommand(deps, providerSession.id, endReason));
    if (ended.type !== "PROVIDER_SESSION_ENDED") throw new Error("The ProviderSession did not end");

    if (stageResult !== null) {
      // The stage-level result. The outcome is untrusted provider output and is validated where it
      // is written: `execute` parses the whole command, outcome included, before touching state.
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "APPLY_PROVIDER_OUTCOME",
        payload: { dispatchId: deps.dispatch.id, outcome: stageResult, template: deps.template },
      });
      return;
    }

    if (ended.nextSessionOrdinal === null) {
      deps.logger.info(
        { stageAttemptId, status: ended.stageAttempt.status },
        "The stage attempt stopped producing sessions",
      );
      return;
    }
  }

  // Reaching the backstop is terminal, like every other way this loop stops without a stage result:
  // the attempt hard-pauses, its pending dispatch is withdrawn in the same transaction, and the
  // owner gets a question. Returning here with the dispatch still PENDING sent the drain straight
  // back into the same attempt until it raised its own safety-limit error -- which, from startup,
  // rejected `startDaemon`.
  deps.state.execute({
    schemaVersion: 1,
    commandId: deps.createCommandId(),
    correlationId: deps.correlationId,
    actor,
    type: "HARD_PAUSE_STAGE_ATTEMPT",
    payload: {
      stageAttemptId,
      reason: {
        type: "SESSION_LIMIT_REACHED",
        sessionOrdinal: lastSessionOrdinal,
        maxSessions: MAX_SESSIONS_PER_ATTEMPT,
      },
    },
  });
  deps.logger.warn(
    { stageAttemptId, maxSessions: MAX_SESSIONS_PER_ATTEMPT },
    "The stage attempt reached the session backstop without finishing; the attempt is hard-paused",
  );
};

/**
 * Runs one StageAttempt as a sequence of context-assembled provider sessions (spec §6).
 *
 * Every session -- the first and every later one alike -- is started the same way: read the context
 * sources as one snapshot, assemble a pack against a share of the adapter's declared window, and
 * write the session, its recipe and the event in one transaction. There is no separate "resume"
 * path, because a resume is just the next assembly from state Loomrail already owns (D1).
 *
 * When the stage needs a repository, the workspace is cut and leased before the first session opens
 * (spec §6). The lease is given back here, once, however the attempt ends -- including when it ends
 * badly, which is why the release lives in a `finally` rather than at each of the loop's exits: a
 * lease left behind is a workspace the *next* stage of this work item can never write in.
 */
export const runStageAttempt = async (deps: RunStageAttemptDeps): Promise<void> => {
  const lease: WorkspaceLeaseSlot = { workspaceId: null };
  try {
    await runProviderSessions(deps, lease);
  } finally {
    if (lease.workspaceId !== null) releaseWorkspaceLease(deps, lease.workspaceId);
  }
};
