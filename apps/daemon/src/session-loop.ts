import { access, constants, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assembleContextPack } from "@loomrail/context-assembly";
import {
  checkpointDraftSchema,
  contextPackRecipeInputSchema,
  contextWindowUsageSchema,
  maxCarriedPaths,
  providerSessionProcessPidSchema,
  providerUsageSchema,
  type AgentProfile,
  type AgentRunPolicySnapshot,
  type CheckpointDraft,
  type ContextPackSpec,
  type EndProviderSessionCommand,
  type HumanRequestDraft,
  type McpSessionSnapshot,
  type ProviderOutcome,
  type ProviderSessionEndReason,
  type StageAttempt,
  type WorkflowDispatch,
  type WorkflowTemplate,
  type WorkItemWorkspace,
} from "@loomrail/contracts";
import {
  adapterWorksInWorkspace,
  decideDispatchStage,
  decideProvisionWorkspace,
  decideSessionWorkspace,
  findBuiltinAgentProfile,
  provisionRefusalRequest,
  refineContextPackForRole,
  stageRequiresWorkspace,
  stageRunsInWorkspace,
  workspaceBranchName,
  type DispatchStageDecision,
  type ProvisionRefusal,
  type ProvisionRefusalCause,
} from "@loomrail/domain";
import { StateStoreError, type LocalState } from "@loomrail/persistence-sqlite";
import {
  ProviderPackTooLargeError,
  type ProviderAdapter,
  type ProviderMcpConnection,
  type ProviderSessionListener,
  type ProviderSessionRef,
  type ProviderStageResultPolicy,
  type ProviderWorkspace,
} from "@loomrail/provider-core";
import {
  addWorktree,
  createCarryInSnapshot,
  deleteBranchIfUnmoved,
  inspectRepository,
  removeWorktree,
  readReviewDiff,
  treeOfWorktree,
  type AddWorktreeRefusal,
} from "@loomrail/workspace";

import { prepareReviewContext, type ReviewContextPreparation } from "./review-context.js";

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

const isAuthorityRevoked = (signal: AbortSignal): boolean => signal.aborted;

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

export type McpConnectionLease = {
  connections: readonly ProviderMcpConnection[];
  close: () => Promise<void>;
};

export type OpenMcpConnections = (snapshots: readonly McpSessionSnapshot[]) => Promise<McpConnectionLease>;

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
  /** Opens daemon-owned MCP servers for the immutable snapshots captured at session start. */
  openMcpConnections?: OpenMcpConnections;
  /** Revoked synchronously when owner cancellation removes this AgentRun's authority. */
  authoritySignal?: AbortSignal;
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

type ActiveAgentExecutionPolicy = {
  agentRunId: string;
  profile: AgentProfile;
  snapshot: AgentRunPolicySnapshot;
};

const activeAgentExecutionPolicy = (
  deps: RunStageAttemptDeps,
  stageAttemptId: string,
): ActiveAgentExecutionPolicy | null => {
  const result = deps.state.query({ type: "LIST_AGENT_RUNS", status: "RUNNING", limit: 200 });
  if (result.type !== "AGENT_RUNS") throw new Error("The active AgentRun could not be read");
  const run = result.runs.find((candidate) => candidate.stageAttemptId === stageAttemptId);
  if (run === undefined) return null;
  const profile = findBuiltinAgentProfile(run.profile);
  if (profile === null) {
    throw new StateStoreError("PERSISTENCE_FAILURE", "The active AgentRun profile revision is unavailable");
  }
  if (run.policySnapshot === null) {
    throw new StateStoreError("PERSISTENCE_FAILURE", "The active AgentRun policy snapshot is unavailable");
  }
  return { agentRunId: run.id, profile, snapshot: run.policySnapshot };
};

const readStageAttemptState = (
  deps: RunStageAttemptDeps,
): { attempt: StageAttempt; humanRequests: ProviderStageResultPolicy["humanRequests"] } => {
  const snapshot = deps.state.query({ type: "GET_WORKFLOW_SNAPSHOT", workItemId: deps.dispatch.workItemId });
  const attempt =
    snapshot.type === "WORKFLOW_SNAPSHOT"
      ? snapshot.snapshot.stageAttempts.find(({ id }) => id === deps.dispatch.stageAttemptId)
      : undefined;
  if (!attempt) throw new Error("The StageAttempt backing this dispatch no longer exists");
  // A question consumes the normal run's one provider-authored owner gate when it is opened, not
  // only after it is answered. Carry the consumption across the first attempt of every later
  // stage: those attempts are automatic workflow progression, not the explicit retry ADR-0004
  // requires before a genuinely new business blocker can ask again. A retry has `attempt > 1` and
  // receives one fresh gate of its own; once it opens that request, this same-attempt check closes
  // it again. The OPEN state cannot normally reach a new session, but counting it closes that race
  // as well.
  //
  // `dispatch.mode` is deliberately not used: RESUME also means an operator resumed a soft-paused
  // or interrupted attempt, where no owner gate may have existed.
  const stageAttemptIds =
    snapshot.type === "WORKFLOW_SNAPSHOT"
      ? new Set(snapshot.snapshot.stageAttempts.map(({ id }) => id))
      : new Set<string>();
  const requestsInRun =
    snapshot.type === "WORKFLOW_SNAPSHOT"
      ? snapshot.snapshot.humanRequests.filter(({ stageAttemptId }) => stageAttemptIds.has(stageAttemptId))
      : [];
  const gateUsedInAttempt = requestsInRun.some(({ stageAttemptId }) => stageAttemptId === attempt.id);
  const inheritedGateUsed = attempt.attempt === 1 && requestsInRun.length > 0;
  return {
    attempt,
    humanRequests: gateUsedInAttempt || inheritedGateUsed ? "DISALLOWED" : "ALLOWED",
  };
};

/**
 * The attempt's sessions, as one read: the next ordinal and "is one already running" are two
 * questions about the same list, and asking them separately would let the answers disagree.
 */
const readAttemptSessions = (
  deps: RunStageAttemptDeps,
  agentRunId: string | null,
): { nextOrdinal: number; running: boolean; agentRunSessionCount: number } => {
  const sessions = deps.state.query({
    type: "LIST_PROVIDER_SESSIONS",
    stageAttemptId: deps.dispatch.stageAttemptId,
  });
  if (sessions.type !== "PROVIDER_SESSIONS") throw new Error("Provider sessions could not be read");
  return {
    nextOrdinal: sessions.sessions.reduce((highest, { ordinal }) => Math.max(highest, ordinal), 0) + 1,
    running: sessions.sessions.some(({ status }) => status === "RUNNING"),
    agentRunSessionCount: sessions.sessions.filter((session) => session.agentRunId === agentRunId).length,
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
  // `cause` is what lets a stage that merely READS better with a worktree tell two situations
  // apart: a Project with no repository behind it (which has always run its prose stages this way
  // and must go on doing so) and a repository-backed Project whose workspace could not be prepared
  // right now (which must not answer "there is no implementation to assess" about work sitting in
  // the repository it names). See `ProvisionRefusalCause` (@loomrail/domain).
  | { type: "REFUSED"; cause: ProvisionRefusalCause; request: HumanRequestDraft }
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

// The recommendation names no action on the workspace, and that is the whole point of its wording.
// It used to say "Restore or remove <path> yourself, then retry" -- the same false advice already
// deleted from `workspaceGoneRefusal` below, and worse here, because there the restore genuinely
// works. Once reconciliation has marked a workspace ORPHANED the status is terminal: no command
// returns it to READY, nothing produces REMOVED, and CREATE_WORK_ITEM_WORKSPACE refuses while the
// row exists. Restoring the directory changes nothing, removal does not exist, and the next
// dispatch reads the same row and refuses identically -- an owner who followed that advice was in
// a loop with no exit in it.
//
// What is true is that this work item cannot run again in this workspace, and that Loomrail has no
// affordance -- yet -- for the intervention that would free it. Saying so plainly is worth more
// than an instruction that does nothing, and the branch really is still there, which is the one
// thing an owner can still act on. Building a removal command is a decision for a later milestone,
// not something to smuggle in behind this sentence.
const workspaceNotReadyRefusal = (workspace: WorkItemWorkspace): ProvisionRefusal => ({
  title: `This work item's workspace is ${workspace.status.toLowerCase()}, and cannot be returned to service`,
  context: `The workspace recorded for this work item is on branch ${workspace.branch} at ${workspace.worktreePath}, and its status is ${workspace.status} rather than READY. That status is the end of the line for this workspace: nothing in Loomrail moves a workspace back to READY, and no second workspace can be cut for this work item while this record exists. Every later stage of this work item that needs a repository will be refused exactly like this one. Loomrail does not recreate a workspace by itself (AD-008): a directory that disappeared may still hold the only copy of earlier work, and re-cutting one silently would hide that.`,
  recommendation: `There is nothing to do at ${workspace.worktreePath}: restoring the directory will not change this answer, and Loomrail has no command that clears a workspace record. This work item is stuck until it does, which is not something you can do from the cockpit today. What survives is the branch ${workspace.branch} -- it still holds whatever was committed to it, so read it with git and carry the work forward under a new work item, which gets a workspace of its own.`,
});

const workspaceGoneRefusal = (workspace: WorkItemWorkspace): ProvisionRefusal => ({
  title: "This work item's workspace is no longer on disk",
  context: `Loomrail records this work item's workspace as ready on branch ${workspace.branch} at ${workspace.worktreePath}, but there is no worktree there now -- the directory was removed, or git no longer recognises it as one. Dispatching the stage anyway would start an agent in a directory that does not exist. Loomrail does not re-cut a workspace by itself (AD-008): the branch may still hold work nobody has merged, and quietly starting a second workspace would hide that.`,
  // Restoring the worktree is the WHOLE recommendation, and deliberately so. This used to offer a
  // second option -- remove the workspace and let the next attempt cut a fresh one -- that Loomrail
  // has no affordance for: the workspace commands are CREATE/ACQUIRE/RELEASE/MARK_ORPHANED, nothing
  // produces REMOVED, and CREATE_WORK_ITEM_WORKSPACE refuses while the row exists. An owner who took
  // that option found nothing to click, and the next dispatch re-read the same READY row, failed the
  // same disk check, and asked the same question again. `git worktree add` is correct on its own.
  recommendation: `Restore the worktree at ${workspace.worktreePath} from the project's repository (\`git worktree add ${workspace.worktreePath} ${workspace.branch}\`), then retry the stage.`,
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
  | { type: "PREPARED"; workspace: WorkItemWorkspace }
  | { type: "REFUSED"; cause: ProvisionRefusalCause; request: HumanRequestDraft }
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
  // The cause travels with the request: the domain is the only layer that knows whether this
  // Project has a repository at all, and the dispatcher below is the only one that acts on it.
  if (decision.type === "REFUSED") {
    return { type: "REFUSED", cause: decision.cause, request: decision.request };
  }
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
    // A repository with no commit yet IS a repository: the owner makes one commit and this stage
    // runs. REPOSITORY_UNUSABLE, like every refusal below it.
    return {
      type: "REFUSED",
      cause: "REPOSITORY_UNUSABLE",
      request: provisionRefusalRequest(noBaseCommitRefusal(project.repositoryPath)),
    };
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
      cause: "REPOSITORY_UNUSABLE",
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
    const activeRuns = deps.state.query({ type: "LIST_AGENT_RUNS", status: "RUNNING" });
    const activeAgentRun =
      activeRuns.type === "AGENT_RUNS"
        ? activeRuns.runs.find(({ stageAttemptId }) => stageAttemptId === deps.dispatch.stageAttemptId)
        : undefined;
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
        ...(activeAgentRun === undefined ? {} : { initialLeaseHolder: deps.dispatch.stageAttemptId }),
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
      cause: "REPOSITORY_UNUSABLE",
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
    return {
      type: "REFUSED",
      cause: "REPOSITORY_UNUSABLE",
      request: provisionRefusalRequest(workspaceNotReadyRefusal(existing)),
    };
  }
  // A READY row is a claim about the disk, and this is the one place that verifies it before the
  // claim is acted on. Checked before the lease rather than after: taking a lease on a workspace
  // that is not there would hand this attempt a writer's claim over nothing, and the next attempt
  // would meet it as postponed rather than as the question the owner can answer.
  if (!(await worktreeStillUsable(existing.worktreePath))) {
    // The row is left READY on purpose: this refuses the dispatch, it does not orphan the workspace.
    // ORPHANED is terminal -- nothing returns a workspace to READY, and CREATE_WORK_ITEM_WORKSPACE
    // refuses while the row exists -- so recording it here would dead-end every later IMPLEMENT and
    // QA for this work item, the owner's own `git worktree add` restore included. A refusal the
    // owner can answer is worth more than a status that closes the only door out.
    return {
      type: "REFUSED",
      cause: "REPOSITORY_UNUSABLE",
      request: provisionRefusalRequest(workspaceGoneRefusal(existing)),
    };
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
    // Whatever this was -- no `git` on PATH, a plumbing command that failed mid-snapshot, a full
    // disk -- it is not "this Project has no repository", which is the only thing that earns a
    // degraded prose session. An unknown failure is reported, not stepped over.
    return {
      type: "REFUSED",
      cause: "REPOSITORY_UNUSABLE",
      request: provisionRefusalRequest(provisioningFailedRefusal(error, path)),
    };
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

/**
 * The tree the work item's worktree holds right now -- the stage-end label spec D3 has the daemon
 * write onto StageAttempt, taken at the moment the stage is about to be recorded as succeeded,
 * while this attempt still holds the workspace's lease.
 *
 * Read through `treeOfWorktree` (`@loomrail/workspace`), not `summariseChanges`. D3 says a summary
 * and ITS tree must come out of one temporary index so the two cannot disagree -- but no summary is
 * produced here, so there is nothing for the label to disagree with, and D3 does not reach this call
 * site. `read-tree <anything>` + `add -A` + `write-tree` yields a tree that depends only on the
 * working tree, never on a baseline, so `treeOfWorktree` needs no baseline and pays for none of
 * `summariseChanges`'s two `diff-index` reads, which this call was previously running and then
 * discarding. Measured on this checkout (median of 8 runs, `summariseChanges` against HEAD vs.
 * `treeOfWorktree`, both warmed once first): 593 ms -> 391 ms, a 34% cut; the saving is the two
 * `diff-index` passes; `add -A`'s walk of the working tree is paid by both and does not shrink.
 *
 * Never throws, and never refuses the stage. A label is Loomrail's bookkeeping; the stage is the
 * owner's work. A stage whose agent finished and whose worktree then vanished has genuinely
 * succeeded, and failing it over a forty-byte note nobody reads in this milestone would destroy
 * real work to protect a convenience. What a failure produces instead is `null` -- "no tree was
 * measured", the same fact every pre-0013 attempt records -- and a line in the log, so a label that
 * is quietly never taken cannot pass for a stage that ended on the tree it started on.
 *
 * The worktree's existence is checked before `treeOfWorktree` is ever called, and not folded into
 * its `catch`. `spawn`ing git with a working directory that does not exist fails to start at all,
 * the same failure as git not being on PATH, and `@loomrail/workspace` reports both as
 * `GitMissingError` -- "git executable was not found". Read through `errorName` in the log that
 * would tell an operator whose agent's worktree was cleaned up mid-session that git is not
 * installed on this machine, which is not true and not fixable by installing anything. The daemon
 * already drew this line once, in `server.ts`'s change routes, for the same reason: ask the
 * filesystem first, so a missing worktree is named as itself rather than reaching git's own
 * ENOENT-for-anything reporting.
 */
const readStageResultTree = async (
  deps: RunStageAttemptDeps,
  workspace: WorkItemWorkspace | null,
): Promise<string | null> => {
  // No workspace at all is not a failure and earns no log line: every prose stage ends this way
  // (spec §7's first row), and warning on each would bury the case that matters.
  if (workspace === null) return null;
  const stageAttemptId = deps.dispatch.stageAttemptId;

  try {
    // `R_OK | X_OK`, never a bare `access` (which defaults to `F_OK` and would pass for a worktree
    // this process cannot actually enter). See the identical check in `server.ts`'s
    // `changeReadContext`, which this one exists to stay consistent with.
    await access(workspace.worktreePath, constants.R_OK | constants.X_OK);
  } catch (error: unknown) {
    deps.logger.warn(
      { stageAttemptId, worktreePath: workspace.worktreePath, error: errorName(error) },
      "The tree this stage ended on could not be recorded",
    );
    return null;
  }

  try {
    return await treeOfWorktree({ worktreePath: workspace.worktreePath });
  } catch (error: unknown) {
    deps.logger.warn(
      { stageAttemptId, worktreePath: workspace.worktreePath, error: errorName(error) },
      "The tree this stage ended on could not be recorded",
    );
    return null;
  }
};

/**
 * The workspace this attempt leased, so the `finally` below knows whether to give it back -- and so
 * every session in the attempt can be handed the worktree it is meant to write in.
 *
 * The whole entity, not just its id: `worktreePath`, `branch` and `baseCommit` are what an
 * invocation carries (`ProviderWorkspace` in `@loomrail/provider-core`), and re-reading the row for
 * them at each session would re-read a row this attempt already holds the lease on.
 */
type WorkspaceLeaseSlot = { workspace: WorkItemWorkspace | null; releaseOnExit: boolean };

const runProviderSessions = async (deps: RunStageAttemptDeps, lease: WorkspaceLeaseSlot): Promise<void> => {
  const scheduleDeadline = deps.scheduleHandoffDeadline ?? defaultScheduleHandoffDeadline;
  const authoritySignal = deps.authoritySignal ?? new AbortController().signal;
  const capabilities = deps.adapter.capabilities();
  const stageAttemptId = deps.dispatch.stageAttemptId;
  const executionPolicy = activeAgentExecutionPolicy(deps, stageAttemptId);
  if (executionPolicy === null) {
    throw new StateStoreError(
      "PERSISTENCE_FAILURE",
      "A provider session cannot start without an active AgentRun authority",
    );
  }
  const roleProfile = executionPolicy.profile;
  const maxSessions = executionPolicy.snapshot.budget.maxProviderSessions;
  const agentRunId = executionPolicy.agentRunId;
  const templateContextSpec = contextPackSpecFor(deps.template, readStageAttemptState(deps).attempt.stage);
  const contextSpec = refineContextPackForRole(templateContextSpec, roleProfile.playbook);
  const initialSessions = readAttemptSessions(deps, agentRunId);
  if (initialSessions.running) {
    deps.logger.info(
      { stageAttemptId },
      "Another caller is already running a provider session on this stage attempt; the session loop stops",
    );
    return;
  }
  let lastSessionOrdinal = initialSessions.nextOrdinal - 1;

  for (let session = initialSessions.agentRunSessionCount; session < maxSessions; session += 1) {
    if (isAuthorityRevoked(authoritySignal)) return;
    const { attempt, humanRequests } = readStageAttemptState(deps);
    if (attempt.status !== "RUNNING") {
      deps.logger.info(
        { stageAttemptId, status: attempt.status },
        "The stage attempt is no longer running; the session loop stops",
      );
      return;
    }

    // Task 9 (milestone A2): before E1 a live adapter has no filesystem access, so it cannot serve
    // a stage it did not declare in `capabilities().stages` -- most notably IMPLEMENT. Task 10.5
    // added the other half: `capabilities().start` is `false` when the adapter is not ready for a
    // new session, and that must refuse every stage, not just the ones it happens not to declare
    // -- an unavailable adapter still declares its normal `stages` (task 10.5
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
    type PreSessionRefusal =
      | Exclude<DispatchStageDecision, { type: "DISPATCH" }>
      | ({ type: "REVIEW_CONTEXT_UNAVAILABLE" } & Omit<
          Extract<ReviewContextPreparation, { type: "REFUSED" }>,
          "type"
        >);
    const refuseDispatch = (decision: PreSessionRefusal): void => {
      deps.state.execute({
        schemaVersion: 1,
        commandId: deps.createCommandId(),
        correlationId: deps.correlationId,
        actor,
        type: "APPLY_PROVIDER_OUTCOME",
        payload: {
          dispatchId: deps.dispatch.id,
          provider: capabilities.provider,
          outcome: { type: "NEEDS_HUMAN", request: boundedRequest(decision.request) },
          template: deps.template,
          // No stage ran, so there is nothing to have ended on. Neither refusal here reaches a
          // worktree: one is an adapter that does not serve the stage, the other a workspace that
          // could not be prepared at all.
          resultTree: null,
        },
      });
      deps.logger.warn(
        {
          stageAttemptId,
          stage: attempt.stage,
          provider: capabilities.provider,
          canStart: String(capabilities.start),
          reason: decision.type === "REVIEW_CONTEXT_UNAVAILABLE" ? decision.reason : decision.type,
          ...(decision.type === "REVIEW_CONTEXT_UNAVAILABLE" && decision.cause !== null
            ? { error: errorName(decision.cause) }
            : {}),
        },
        decision.type === "STAGE_NOT_SERVED"
          ? "The adapter refused this dispatch; the owner was asked"
          : decision.type === "WORKSPACE_NOT_PROVISIONED"
            ? "No workspace could be prepared for this stage; the owner was asked"
            : "The stable review diff could not be measured; the owner was asked",
      );
    };

    if (dispatchDecision.type === "STAGE_NOT_SERVED") {
      refuseDispatch(dispatchDecision);
      return;
    }

    // Spec §6: the workspace is cut before the first session opens, never alongside it. Which stages
    // run in one is a property of the stage (`stagesRunningInWorkspace` in `@loomrail/domain`), read
    // from there rather than compared against stage names here -- every repository-reading stage.
    // ACCEPTANCE preparation is an AgentRun too, but it reads the durable pack and leaves the later
    // decision to the owner, so it does not receive or lease the tree. Done once per
    // attempt: `lease.workspace` is set as soon as this attempt holds the lease, and every later
    // session in the same attempt writes in the same worktree (spec D1).
    //
    // That list used to be IMPLEMENT and QA alone, so this is now reached at a work item's FIRST
    // agent stage rather than at IMPLEMENT: the worktree and its carry-in commit are created
    // earlier in the run than they were. Everything downstream already handled that, because
    // nothing downstream knew which stage cut the workspace -- `prepareWorkspace` reads the
    // recorded row first and reuses it, `acquireWorkspaceLease` takes the lease per StageAttempt
    // and `releaseWorkspaceLease` gives it back in the attempt's `finally`, and startup
    // reconciliation judges rows and worktrees, never the stage that produced them. What changes is
    // only that the reuse path, rather than the create path, is the one IMPLEMENT now takes.
    //
    // `adapterWorksInWorkspace` is the other half, and it is about the owner's repository rather
    // than about this stage: cutting a worktree writes a ref, a commit and a `.git/worktrees` entry
    // into it, and an adapter that reads `invocation.workspace` nowhere would ordinarily have all
    // of that done on its behalf and then discard it. Today that is `provider-claude-code`, which
    // serves its sessions out of its own temporary directory. REVIEW is the deliberate exception:
    // the daemon itself needs the completed implementation's recorded workspace to build the
    // bounded diff that gives a filesystem-isolated reviewer actual code. In an ordinary pipeline
    // that workspace already exists from IMPLEMENT; acquiring it here holds the single-writer
    // lease while the stable review snapshot is taken and judged.
    // Why this stage has no workspace, when it has none -- kept rather than acted on here.
    //
    // Whether the LACK of a workspace ends the dispatch is one decision and it is made in one
    // place: `decideSessionWorkspace`, below. This block is the only thing that knows WHY there is
    // no workspace, and that reason is what makes the owner's question specific to their own
    // repository rather than generic, so it is carried down to the gate instead of being turned
    // into a second, parallel refusal here. Null means there was nothing to prepare or the
    // preparation succeeded -- and a writing stage reaching the gate with a null reason is the one
    // case the gate's own wording describes: a Loomrail bug, not anything the owner can repair.
    let provisionRefusal: HumanRequestDraft | null = null;
    if (
      lease.workspace === null &&
      stageRunsInWorkspace(attempt.stage) &&
      (adapterWorksInWorkspace(capabilities.stages) || attempt.stage === "REVIEW")
    ) {
      const prepared = await prepareWorkspaceSafely(deps);
      if (prepared.type === "REFUSED") {
        provisionRefusal = prepared.request;
        // A stage that merely reads better with a worktree is refused when the Project HAS a
        // repository and the workspace could not be prepared from it -- mid-rebase, an occupied
        // branch, a worktree that vanished, a `git` that would not run. This is the degrade that
        // used to be silent: the session ran with no worktree and answered "there is no
        // implementation to assess" about a work item whose implementation was sitting in the
        // repository the Project names, while the only record of why was a warning in a log the
        // owner never sees. Those causes are all repairable, and the owner is the one who repairs
        // them, so they get the same question IMPLEMENT would have got. Refused here rather than at
        // the gate because the gate does not refuse a prose stage at all, and must not start to.
        if (prepared.cause === "REPOSITORY_UNUSABLE") {
          refuseDispatch({ type: "WORKSPACE_NOT_PROVISIONED", request: prepared.request });
          return;
        }
        // A Project with no repository behind it at all -- a fixture Project still recorded at a
        // bundled template, a path the owner moved. It has run its prose stages with no workspace
        // since before E1, nothing about it is going to change, and a question about it would be
        // one the owner cannot act on and did not ask for. That one still degrades, and says so.
        //
        // A writing stage on such a Project does NOT degrade; it falls through to the gate, which
        // refuses it carrying `provisionRefusal` -- the same question, from the same draft, that
        // this branch used to raise itself. Moving it there is what makes the gate load-bearing:
        // it used to be unreachable by construction (every writing stage was refused here first),
        // so deleting it changed no observable behaviour and no test could notice.
        if (!stageRequiresWorkspace(attempt.stage)) {
          deps.logger.info(
            { stageAttemptId, stage: attempt.stage, reason: prepared.request.title },
            "This project has no repository to cut a workspace from; the stage runs on its context pack alone",
          );
        }
      } else if (prepared.type === "POSTPONED") {
        // Spec §7: a lease another StageAttempt holds postpones this dispatch rather than failing
        // it. The dispatch stays PENDING -- exactly like the "another caller is already running a
        // session" branch below -- so the next drain picks it back up once the lease is given back.
        deps.logger.info(
          { stageAttemptId, workItemId: deps.dispatch.workItemId, detail: prepared.detail },
          "Another stage attempt is writing in this work item's workspace; this dispatch waits",
        );
        return;
      } else {
        lease.workspace = prepared.workspace;
        deps.logger.info(
          {
            stageAttemptId,
            stage: attempt.stage,
            workspaceId: prepared.workspace.id,
            branch: prepared.workspace.branch,
            worktreePath: prepared.workspace.worktreePath,
          },
          "The work item's workspace is ready and leased to this stage attempt",
        );
      }
    }

    // The workspace fields of the invocation built below, in the shape an adapter reads them
    // (`ProviderWorkspace`, @loomrail/provider-core). Assembled HERE, once, and spread into the
    // invocation verbatim, rather than composed at the `start()` call site: the gate immediately
    // underneath asks its question of this very object, so a change that stops populating it is
    // refused instead of quietly reaching an adapter.
    //
    // Spread rather than assigned, because `exactOptionalPropertyTypes` makes an absent `workspace`
    // and one set to `undefined` different things, and absent is the one the contract defines.
    // `worktreePath` is renamed to `path` because that is what the adapter's own type calls it;
    // `branch` and `baseCommit` travel with it because they say WHICH work this worktree holds --
    // the base a later step diffs against, and the branch the change lives on -- and a consumer
    // that had to re-derive them would shell out to git against a directory that may have moved on.
    const policyWorkspace = executionPolicy.snapshot.workspace;
    const workspaceAccess = policyWorkspace.access;
    const invocationWorkspace: { workspace?: ProviderWorkspace } =
      lease.workspace === null || workspaceAccess === "NONE"
        ? {}
        : {
            workspace: {
              path: lease.workspace.worktreePath,
              branch: lease.workspace.branch,
              baseCommit: lease.workspace.baseCommit,
              // What this stage may DO in that worktree, which is not the same question as whether
              // it gets one. Every agent stage runs in the work item's worktree (R11), and only
              // IMPLEMENT may change it. Read from the domain rather than decided by the adapter,
              // which has no stage to decide from: keying the sandbox mode off the mere presence of
              // a workspace is what put DISCOVERY, PLAN and REVIEW under `-s workspace-write` with
              // the network opened.
              access: workspaceAccess,
              networkAccess: policyWorkspace.networkAccess,
            },
          };

    // The invariant `stagesRequiringWorkspace` only ever implied, now checked (@loomrail/domain's
    // `decideSessionWorkspace`). Before E1 nothing needed it: the live adapters declared three
    // stages, so `decideDispatchStage` refused IMPLEMENT and QA on the declaration alone and no
    // writing stage could reach an adapter at all. Task 11 widened the declaration to six, and the
    // gap it left was live: an IMPLEMENT invocation with no workspace made the Codex adapter run
    // `-s read-only` in an empty temporary directory, the agent answered from nothing, and the
    // stage closed COMPLETED reporting work that never happened.
    //
    // Asked of `invocationWorkspace` and not of `lease.workspace`, which is the point: the two can
    // only disagree through a bug in the four lines above, and that disagreement is precisely the
    // defect being closed. Refused, not thrown: the owner meets it as the same blocking question
    // every other provisioning failure produces, and no ProviderSession is opened for it.
    const sessionWorkspaceDecision = decideSessionWorkspace({
      stage: attempt.stage,
      hasWorkspace: invocationWorkspace.workspace !== undefined,
    });
    if (sessionWorkspaceDecision.type === "REFUSED") {
      // The reason from `prepareWorkspaceSafely` when there is one -- it names the owner's actual
      // path and what to do about it -- and the gate's own wording when there is not, which is
      // exactly the case that wording was written for: the worktree was prepared and Loomrail's own
      // dispatch failed to pass it on.
      refuseDispatch({
        type: "WORKSPACE_NOT_PROVISIONED",
        request: provisionRefusal ?? sessionWorkspaceDecision.request,
      });
      return;
    }

    const sessions = readAttemptSessions(deps, agentRunId);
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
    const contextSnapshot = deps.state.query({
      type: "READ_CONTEXT_SOURCES",
      stageAttemptId,
      sessionOrdinal,
    });
    if (contextSnapshot.type !== "CONTEXT_SOURCES") throw new Error("The context sources could not be read");
    const reviewContext = await prepareReviewContext({
      sources: contextSnapshot.sources,
      workspace: lease.workspace,
      readDiff: readReviewDiff,
    });
    if (reviewContext.type === "REFUSED") {
      refuseDispatch({ ...reviewContext, type: "REVIEW_CONTEXT_UNAVAILABLE" });
      return;
    }

    // Spec §6.1 step 2: a share of the window declared by the adapter, never the whole window.
    // The share is derived from the attempt's own durable backoff count, not from a local variable:
    // §6.4 makes a daemon restart an ordinary end of a session, and a share held in memory would be
    // silently restored to full by the very event §7's "one automatic retry" has to survive.
    const packShare = MAX_PACK_SHARE - attempt.packShareBackoffs * PACK_SHARE_BACKOFF;
    const budgetTokens = Math.max(1, Math.floor(capabilities.contextWindowTokens * packShare));
    const assembled = assembleContextPack({
      sources: reviewContext.sources,
      spec: contextSpec,
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

    if (isAuthorityRevoked(authoritySignal)) return;
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
          specSource: "ROLE_PLAYBOOK",
          roleProfile: { id: roleProfile.id, revision: roleProfile.revision },
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
      usageReported: false,
      budgetPaused: false,
      budgetAbort: null as Promise<boolean> | null,
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
        if (live.closed || isAuthorityRevoked(authoritySignal) || live.handoffRequested) return;
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
        // the immutable AgentProfile session cap, and most of those rows say only "not yet".
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
        if (live.closed || isAuthorityRevoked(authoritySignal)) return;
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
      // Spend, not occupancy (BD-001). Supported adapters emit one terminal cumulative report per
      // session. Its deterministic command id and the report table's UNIQUE(session) invariant are
      // independent backstops against callback retries charging the budget twice.
      onUsage: (reported) => {
        if (live.closed || isAuthorityRevoked(authoritySignal) || live.usageReported) return;
        const usage = providerUsageSchema.safeParse(reported);
        if (!usage.success) {
          deps.logger.warn(
            { providerSessionId: providerSession.id },
            "The provider reported usage that does not satisfy the contract",
          );
          return;
        }
        const recorded = deps.state.execute({
          schemaVersion: 1,
          commandId: `provider-usage-${providerSession.id}`,
          correlationId: deps.correlationId,
          actor,
          type: "RECORD_PROVIDER_USAGE",
          payload: { providerSessionId: providerSession.id, usage: usage.data },
        });
        if (recorded.type !== "PROVIDER_USAGE_RECORDED") {
          throw new Error("The ProviderUsage report was not recorded");
        }
        live.usageReported = true;
        live.budgetPaused = recorded.hardPaused;
        deps.logger.info(
          {
            providerSessionId: providerSession.id,
            inputTokens: usage.data.inputTokens,
            outputTokens: usage.data.outputTokens,
            quality: usage.data.quality,
          },
          recorded.hardPaused
            ? "The provider reported usage and exhausted the active budget"
            : "The provider usage was recorded",
        );
        if (recorded.hardPaused) {
          live.budgetAbort = deps.adapter.abortSession(providerSession.id).then(
            () => true,
            (error: unknown) => {
              deps.logger.warn(
                { providerSessionId: providerSession.id, error: errorName(error) },
                "The budget-paused provider session could not be aborted; it may still be running",
              );
              return false;
            },
          );
        }
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
        if (live.closed || isAuthorityRevoked(authoritySignal)) return;
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
      let mcpLease: McpConnectionLease | null = null;
      try {
        if (started.mcpSnapshots.length === 0) {
          mcpLease = { connections: [], close: () => Promise.resolve() };
        } else {
          const openMcpConnections = deps.openMcpConnections;
          if (openMcpConnections === undefined) {
            throw new Error("The MCP gateway connector opener is missing");
          }
          mcpLease = await openMcpConnections(started.mcpSnapshots);
        }
        const mcpConnections = mcpLease.connections;
        authoritySignal.throwIfAborted();
        const outcome = await deps.adapter.start(
          {
            dispatch: deps.dispatch,
            session: providerSessionRef(providerSession, attempt),
            contextPack: assembled.pack,
            modelTier: executionPolicy.snapshot.modelTier,
            modelId: executionPolicy.snapshot.modelId ?? null,
            acceptanceInput:
              attempt.stage === "ACCEPTANCE"
                ? {
                    criteria: reviewContext.sources.workItemBrief.acceptanceCriteria,
                    evidence: reviewContext.sources.evidence.map(({ kind, checks }) => ({ kind, checks })),
                  }
                : null,
            humanRequests,
            mcpConnections,
            authoritySignal,
            ...invocationWorkspace,
          },
          listener,
        );
        return { type: "OUTCOME", outcome };
      } catch (error: unknown) {
        return { type: "FAILED", error };
      } finally {
        if (mcpLease !== null) {
          await mcpLease.close().catch((error: unknown) => {
            deps.logger.warn(
              {
                providerSessionId: providerSession.id,
                errorName: errorName(error),
              },
              "Could not close the MCP gateway connector lease",
            );
          });
        }
      }
    };

    const result: SessionOutcome = await Promise.race([startSession(), deadlineReached]);
    live.closed = true;
    deadline?.cancel();

    try {
      // Owner cancellation owns all terminal writes: its durable transition blocks new work first,
      // then the HTTP boundary ends this ProviderSession/AgentRun only after the worker confirms the
      // adapter stopped. This revoked loop must not race that finalization with a second outcome.
      // Soft Pause does not revoke this signal: its current turn is allowed to finish.
      if (isAuthorityRevoked(authoritySignal)) return;

      if (live.budgetPaused) {
        const stopped = live.budgetAbort === null ? false : await live.budgetAbort;
        if (isAuthorityRevoked(authoritySignal)) return;
        if (!stopped) {
          // Keep the durable session/run/lease active for startup recovery. Ending them here would
          // make another writer eligible while the failed abort may have left this child alive.
          lease.releaseOnExit = false;
          return;
        }
        deps.state.execute(endSessionCommand(deps, providerSession.id, "INTERRUPTED"));
        deps.logger.warn(
          { providerSessionId: providerSession.id, stageAttemptId },
          "The active provider token budget was exhausted; the workflow is hard-paused",
        );
        return;
      }

      if (result.type === "FAILED") {
        // `providerStarted: false`: the adapter refused the invocation, so this session never had a
        // chance to publish anything and §6.5's guard does not apply to it. §7's branches below own
        // this case, and pausing twice for one failure would ask the owner two questions about it.
        const failedEnd = deps.state.execute(
          endSessionCommand(deps, providerSession.id, "INTERRUPTED", false),
        );
        if (failedEnd.type !== "PROVIDER_SESSION_ENDED") {
          throw new Error("The failed ProviderSession did not end");
        }
        if (failedEnd.stageAttempt.status !== "RUNNING") return;
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
          lease.releaseOnExit = false;
          return;
        }
        if (isAuthorityRevoked(authoritySignal)) return;
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

      // Soft Pause lets the in-flight turn persist checkpoints and reach a natural outcome, but it
      // forbids that stale outcome from advancing the paused workflow. END_PROVIDER_SESSION above
      // closes the session and its AgentRun before the attempt releases its workspace lease.
      if (ended.stageAttempt.status !== "RUNNING") return;

      if (stageResult !== null) {
        // Spec §6 step 5: the tree is measured HERE, immediately before the command that ends the
        // stage, so that what the label names is the worktree as the stage left it -- and so that the
        // label and the ending land in one transaction (the domain writes it onto the succeeding
        // attempt). Measured before the command rather than inside it because reading a worktree
        // means running `git`, and `execute` is synchronous by design.
        //
        // `lease.workspace` rather than a fresh read: this attempt holds the lease on that row, so
        // nothing else could have moved the worktree under it, and re-reading would only add a way
        // for the two to differ.
        const resultTree = await readStageResultTree(deps, lease.workspace);
        if (isAuthorityRevoked(authoritySignal)) return;
        // The stage-level result. The outcome is untrusted provider output and is validated where it
        // is written: `execute` parses the whole command, outcome included, before touching state.
        deps.state.execute({
          schemaVersion: 1,
          commandId: deps.createCommandId(),
          correlationId: deps.correlationId,
          actor,
          type: "APPLY_PROVIDER_OUTCOME",
          payload: {
            dispatchId: deps.dispatch.id,
            provider: capabilities.provider,
            outcome: stageResult,
            template: deps.template,
            resultTree,
          },
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
    } finally {
      // Keep the session registered through every awaited internal stop. Owner cancellation must
      // be able to find and await it until either this loop has persisted its terminal state or a
      // revoked loop has handed terminal ownership back to the cancelling boundary.
      deps.onSessionLive?.(null);
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
        maxSessions,
      },
    },
  });
  deps.logger.warn(
    { stageAttemptId, maxSessions },
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
  const lease: WorkspaceLeaseSlot = { workspace: null, releaseOnExit: true };
  try {
    await runProviderSessions(deps, lease);
  } finally {
    // A revoked loop is not the authority that proves the child stopped. Successful cancellation
    // releases this lease when END_PROVIDER_SESSION commits after awaited adapter shutdown; failed
    // shutdown and daemon stop leave it held for startup reconciliation instead of advertising a
    // free writer.
    if (
      lease.workspace !== null &&
      lease.releaseOnExit &&
      (deps.authoritySignal === undefined || !isAuthorityRevoked(deps.authoritySignal))
    ) {
      releaseWorkspaceLease(deps, lease.workspace.id);
    }
  }
};
