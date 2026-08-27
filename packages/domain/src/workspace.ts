import type { HumanRequestDraft, WorkflowStage } from "@loomrail/contracts";

/**
 * Stages that need a real repository to run in (spec §5, D11).
 *
 * The plan's Task 9 wants this list "from the workflow template", but the template has no such
 * field, and adding one is scope this milestone does not ask for -- a workflow template describes
 * an ordering of stages, not what a stage needs to execute. What a stage needs is a property of the
 * stage itself: IMPLEMENT changes files, QA runs the result, and every other stage (DISCOVERY,
 * PLAN, REVIEW, ACCEPTANCE) only ever produces prose. That is fixed by what the stage *is*, not by
 * which project it happens to run against, so it belongs here as a constant next to the rest of
 * this package's decisions, not as per-template data nobody would ever vary.
 */
export const stagesRequiringWorkspace = ["IMPLEMENT", "QA"] as const satisfies readonly WorkflowStage[];

export const stageRequiresWorkspace = (stage: WorkflowStage): boolean =>
  (stagesRequiringWorkspace as readonly WorkflowStage[]).includes(stage);

const MAX_BRANCH_SLUG_LENGTH = 40;
const SHORT_ID_LENGTH = 8;

// git forbids spaces, ~^:?*[, backslash, two consecutive dots, a trailing dot, a trailing .lock, a
// leading or trailing slash, and @{ in a ref name. Building the slug from a fixed, permitted
// alphabet -- lowercase Latin letters, digits and hyphen -- satisfies all of that by construction,
// rather than by trying to enumerate and strip every character a title happens to contain. A work
// item title is arbitrary human text (any script, any punctuation), so anything not on the allowed
// alphabet collapses to a separator instead of leaking into the ref.
const slugify = (title: string): string => {
  const collapsed = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Truncating at a fixed length can leave a trailing separator behind (e.g. a cut that lands
  // right after a word boundary); strip it so the branch name never ends in a bare hyphen.
  return collapsed.slice(0, MAX_BRANCH_SLUG_LENGTH).replace(/-+$/g, "");
};

// A WorkItem id is `workItem-<uuid>` (see @loomrail/persistence-sqlite's id generator). The short
// id a human can recognise in a branch name is the uuid's first hyphen-delimited group -- stable,
// short, and already how the rest of Loomrail's ids read at a glance.
const shortWorkItemId = (workItemId: string): string => {
  const withoutPrefix = workItemId.startsWith("workItem-")
    ? workItemId.slice("workItem-".length)
    : workItemId;
  const firstSegment = withoutPrefix.split("-")[0] ?? "";
  return firstSegment.slice(0, SHORT_ID_LENGTH);
};

/**
 * Names the branch a workspace is cut on: recognisable to a human (the work item's short id and a
 * slug of its title) and guaranteed acceptable to git (built from a permitted alphabet -- see
 * `slugify`). A title made only of punctuation collapses to an empty slug rather than an unusable
 * or empty ref component; the id alone is still a valid, recognisable branch name.
 */
export const workspaceBranchName = (context: { workItemId: string; title: string }): string => {
  const shortId = shortWorkItemId(context.workItemId);
  const slug = slugify(context.title);
  return slug.length > 0 ? `loomrail/${shortId}-${slug}` : `loomrail/${shortId}`;
};

/**
 * The pieces of a refusal that are specific to *why* a workspace could not be cut. Kept separate
 * from the full `HumanRequestDraft` because every refusal this module produces shares the same
 * `kind`/`blocking`/`options`/`allowOther` -- see `provisionRefusalRequest` -- and repeating those
 * four fields at each call site would just be a chance for one branch to drift from the others.
 */
export type ProvisionRefusal = { title: string; context: string; recommendation: string };

/**
 * Wraps a `ProvisionRefusal` in the owner-facing question every refusal on this path shares.
 *
 * Same convention as decideDispatchStage's two refusal branches (workflow.ts): FREE_TEXT with an
 * empty `options` array and `allowOther: true`, because the right fix here -- repair the
 * repository, or reassign the stage -- is out-of-band and cannot be enumerated as choices. Every
 * refusal on this path is `blocking: true`: none of these are worth starting a session over while
 * waiting for an answer.
 *
 * Exported because `decideProvisionWorkspace` is not the only place a workspace can be refused: the
 * daemon's own provisioning steps (a branch that already exists, a worktree directory that is
 * already occupied, `git worktree add` failing for a reason nobody modelled) produce refusals too,
 * and they have to reach the owner as the same kind of question. Without this, the caller would
 * have to restate `kind`/`blocking`/`options`/`allowOther` itself -- which is exactly the drift
 * `ProvisionRefusal` exists to prevent.
 */
export const provisionRefusalRequest = (refusal: ProvisionRefusal): HumanRequestDraft => ({
  kind: "FREE_TEXT",
  blocking: true,
  title: refusal.title,
  context: refusal.context,
  recommendation: refusal.recommendation,
  options: [],
  allowOther: true,
});

const inProgressWording: Record<string, string> = {
  REBASE: "rebase",
  MERGE: "merge",
  CHERRY_PICK: "cherry-pick",
  BISECT: "bisect",
};

const notARepositoryRefusal = (path: string): ProvisionRefusal => ({
  title: `${path} is not a Git repository we can cut a workspace from`,
  context: `Loomrail could not find a usable Git repository at ${path}, so no workspace can be cut from it.`,
  recommendation:
    "Check that the project's configured path still points at a Git repository, and repair or re-register it.",
});

const inProgressRefusal = (inProgress: string, path: string): ProvisionRefusal => {
  const wording = inProgressWording[inProgress] ?? inProgress.toLowerCase();
  return {
    title: `The repository is mid a ${wording}, so we can't cut a workspace from it yet`,
    context: `The repository at ${path} is in the middle of a ${wording}, so its HEAD is a scratch commit rather than a base a workspace can safely start from. Cutting a workspace here would either fail or silently base the work on the ${wording}'s intermediate state.`,
    recommendation: `Finish or abort the ${wording} in the repository, then retry.`,
  };
};

export type ProvisionWorkspaceDecision =
  { type: "PROVISION" } | { type: "REFUSED"; request: HumanRequestDraft };

/**
 * Gates a repository against having a workspace cut from it (spec D5). Two questions, checked in
 * order, because they are different claims with different fixes: is this path a Git repository at
 * all, and -- if it is -- is it mid an operation (rebase/merge/cherry-pick/bisect) whose scratch
 * state must never be mistaken for a base to branch from. `worktree add` succeeds in both of those
 * mid-operation states and lands the workspace on the operation's intermediate commit, so this
 * check has to happen before `worktree add` is ever attempted, not be inferred from its result.
 *
 * Takes the repository's state as plain data (`isRepository`, `inProgress`, `path`) rather than the
 * `RepositoryState | null` that `@loomrail/workspace`'s `inspectRepository` returns, so this
 * package never has to depend on `@loomrail/workspace` -- the daemon, which already calls
 * `inspectRepository`, is the layer that owns turning its `null` result into `isRepository: false`.
 */
export const decideProvisionWorkspace = (context: {
  repository: { isRepository: boolean; inProgress: string | null; path: string };
}): ProvisionWorkspaceDecision => {
  const { repository } = context;
  if (!repository.isRepository) {
    return { type: "REFUSED", request: provisionRefusalRequest(notARepositoryRefusal(repository.path)) };
  }
  if (repository.inProgress !== null) {
    return {
      type: "REFUSED",
      request: provisionRefusalRequest(inProgressRefusal(repository.inProgress, repository.path)),
    };
  }
  return { type: "PROVISION" };
};
