import type { HumanRequestDraft, WorkflowStage } from "@loomrail/contracts";

/**
 * Stages that run inside the work item's own Git worktree (spec §5, D11).
 *
 * The plan's Task 9 wants this list "from the workflow template", but the template has no such
 * field, and adding one is scope this milestone does not ask for -- a workflow template describes
 * an ordering of stages, not what a stage needs to execute. What a stage needs is a property of the
 * stage itself, fixed by what the stage *is* rather than by which project it happens to run
 * against, so it belongs here as a constant next to the rest of this package's decisions.
 *
 * WHAT that property is was got wrong once, and the correction is why this list is five stages and
 * not two. The first version read a stage's OUTPUT: IMPLEMENT and QA change files, "every other
 * stage only ever produces prose", so those four were given nothing. Producing prose is not the
 * same as needing no input. A REVIEW session run that way was handed the adapter's empty scratch
 * directory and reported -- correctly, and uselessly -- that it could find no repository and no
 * implementation to assess, on a work item whose IMPLEMENT stage had just edited a real file in a
 * real worktree minutes earlier. Nothing caught it, because the comment that stood here explained
 * the choice rather than tested it.
 *
 * The rule that replaces it: what a stage needs is what it READS OR WRITES, not what it emits.
 * REVIEW and QA read the change, IMPLEMENT writes it, and DISCOVERY and PLAN on a real codebase are
 * worth having only when they can read the code they are reasoning about instead of paraphrasing
 * the brief. All five are dispatched into the same worktree, cut once for the work item.
 *
 * ACCEPTANCE is the single exception, and not on the old grounds: it is the owner's decision about
 * whether the work is done, not an agent's reading of the tree. Nothing it decides comes off disk.
 *
 * This is what a stage is GIVEN when there is a worktree to give it. What happens when there is not
 * -- a Project whose path is no longer a repository, one mid-rebase, a worktree that vanished -- is
 * the separate question `stagesRequiringWorkspace` below answers, and the two lists differ on
 * purpose.
 */
export const stagesRunningInWorkspace = [
  "DISCOVERY",
  "PLAN",
  "IMPLEMENT",
  "REVIEW",
  "QA",
] as const satisfies readonly WorkflowStage[];

export const stageRunsInWorkspace = (stage: WorkflowStage): boolean =>
  (stagesRunningInWorkspace as readonly WorkflowStage[]).includes(stage);

/**
 * The narrower list: stages that cannot honestly run at all without a worktree.
 *
 * `stagesRunningInWorkspace` decides who is handed the worktree; this decides who is REFUSED when
 * there is none to hand over. They are different questions and they have different answers, which
 * is why a stage appearing in the wider list does not put it here.
 *
 * A Project's repository can fail to be one at the moment a stage is dispatched -- a path that
 * stopped being a repository, a repository parked mid-rebase, a legacy fixture Project still
 * recorded at a bundled template. Before this list widened, none of that touched DISCOVERY, PLAN or
 * REVIEW: they were dispatched with no workspace and answered from the brief. Refusing them now
 * would take a project that ran yesterday and stop it, to no one's benefit -- a DISCOVERY with no
 * worktree is the poorer session this milestone exists to stop shipping, but it is still a session
 * that can answer honestly from what it was given. An IMPLEMENT or QA session with no worktree
 * cannot: it can only report work it had nowhere to do. So those two, and only those two, are
 * refused rather than degraded.
 */
export const stagesRequiringWorkspace = ["IMPLEMENT", "QA"] as const satisfies readonly WorkflowStage[];

export const stageRequiresWorkspace = (stage: WorkflowStage): boolean =>
  (stagesRequiringWorkspace as readonly WorkflowStage[]).includes(stage);

/**
 * Whether a stage may CHANGE the worktree it is given, as opposed to only reading it.
 *
 * The third question about a worktree, and the one that decides what an adapter asks its CLI's
 * sandbox for. It exists because giving every agent stage the worktree (R11) silently gave every
 * agent stage WRITE access with it: the Codex adapter picked its sandbox mode from the mere
 * presence of a workspace, so DISCOVERY, PLAN and REVIEW -- stages that read the repository to
 * reason about it -- began launching under `-s workspace-write` with network access opened. A
 * review that can rewrite the code it is judging is not a review, and none of the three needs to
 * write anything to do its job.
 *
 * Answered off `stagesRequiringWorkspace` rather than from a second list, here or in an adapter,
 * because writing is exactly WHY those two are refused when there is no worktree: an IMPLEMENT or
 * QA with nowhere to write can only report work it never did, while a DISCOVERY with nothing to
 * read is merely a poorer session. One list, two questions it genuinely answers. If a stage ever
 * needs write access without being refused for the lack of it (or the reverse), this function is
 * the seam where the two part company -- and the adapter, which has no notion of a stage, still
 * does not grow one.
 */
export const stageWritesInWorkspace = (stage: WorkflowStage): boolean =>
  (stagesRequiringWorkspace as readonly WorkflowStage[]).includes(stage);

/**
 * Whether an adapter uses a workspace at all, read off the stages it declares.
 *
 * Cutting a worktree is not free and not invisible: it writes a `loomrail/…` ref, a carry-in commit
 * and a `.git/worktrees/<name>/` entry into the owner's own repository (THREAT-MODEL.md, E1 delta).
 * Doing that for an adapter that will not look at the result is litter charged to the owner, and
 * `provider-claude-code` is exactly that adapter today: it always runs its CLI in a fresh temporary
 * directory and reads `ProviderInvocation.workspace` nowhere.
 *
 * Declaring a stage that *requires* a workspace is the only signal an adapter gives about this --
 * `ProviderCapabilities` has no field for "I use the worktree", and inventing one is a contract
 * change this fix does not need. An adapter that never serves IMPLEMENT or QA has no write path,
 * which is precisely why its sibling was never taught to use the worktree at all. The same
 * expression backs the launcher's `worksInRepository` line, so the sentence an owner reads at
 * startup and the decision the dispatcher makes cannot drift apart.
 */
export const adapterWorksInWorkspace = (declaredStages: readonly WorkflowStage[]): boolean =>
  declaredStages.some(stageRequiresWorkspace);

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

/**
 * A path that *is* inside a Git repository, just not at its top level.
 *
 * Deliberately not the "not a Git repository" refusal above: `git status` works perfectly well in
 * such a directory, so telling the owner their path no longer points at a repository sends them
 * hunting a problem that does not exist. What is actually true is narrower and immediately
 * actionable -- this directory belongs to a larger repository, and cutting a workspace here would
 * branch *that* repository and hand the agent everything inside it. Both fixes are named because
 * either is legitimate: register the repository Loomrail would otherwise branch by accident, or
 * make this directory a repository in its own right.
 */
const insideRepositoryRefusal = (path: string, topLevel: string): ProvisionRefusal => ({
  title: "This project's path is inside a Git repository rather than being one",
  context: `Loomrail cuts a workspace from a repository's own top level, and ${path} is not one: it is a directory inside the repository at ${topLevel}. Cutting a workspace here would create a branch in ${topLevel} and give the agent everything that repository contains, not just this project.`,
  recommendation: `Register the project at ${topLevel} itself if that whole repository is what this work belongs to, or make ${path} a repository of its own (\`git init\` there and commit), then retry the stage.`,
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
 * Takes the repository's state as plain data (`isRepository`, `inProgress`, `path`,
 * `insideRepository`) rather than the `RepositoryState | null` that `@loomrail/workspace`'s
 * `inspectRepository` returns, so this package never has to depend on `@loomrail/workspace` -- the
 * daemon, which already calls `inspectRepository`, is the layer that owns turning its `null` result
 * into `isRepository: false`.
 *
 * `insideRepository` splits the first question in two, because "there is no repository here" and
 * "there is a repository here, but this is not its top level" have different fixes and only one of
 * them is true at a time. It is required rather than optional so a caller has to answer it: the
 * daemon already knows (it compares the reported top level against the registered path), and a
 * caller that silently omitted it would send every project registered inside a repository the
 * refusal that tells it to go looking for a repository it already has.
 */
export const decideProvisionWorkspace = (context: {
  repository: {
    isRepository: boolean;
    inProgress: string | null;
    path: string;
    /** The top level of the repository `path` sits inside, when `path` is not that top level itself. */
    insideRepository: string | null;
  };
}): ProvisionWorkspaceDecision => {
  const { repository } = context;
  if (!repository.isRepository) {
    return {
      type: "REFUSED",
      request: provisionRefusalRequest(
        repository.insideRepository === null
          ? notARepositoryRefusal(repository.path)
          : insideRepositoryRefusal(repository.path, repository.insideRepository),
      ),
    };
  }
  if (repository.inProgress !== null) {
    return {
      type: "REFUSED",
      request: provisionRefusalRequest(inProgressRefusal(repository.inProgress, repository.path)),
    };
  }
  return { type: "PROVISION" };
};

const noSessionWorkspaceRefusal = (stage: WorkflowStage): ProvisionRefusal => ({
  title: `A ${stage} session was about to start with no workspace`,
  context: `${stage} is one of the stages that changes files (${stagesRequiringWorkspace.join(" and ")}), so it runs in the work item's own Git worktree. This session was about to be handed no workspace at all, which is not a smaller version of the same thing: the adapter would have run its CLI read-only in an empty temporary directory, the agent would have written a plausible answer about work it never did, and the stage would have closed as done with nothing changed on disk. The dispatch was refused instead.`,
  recommendation:
    "Nothing in the project or its repository caused this, and nothing done there will change it: the worktree was prepared and only Loomrail's own dispatch failed to pass it on. Report this message with the work item's id -- every retry will be refused the same way until Loomrail is fixed.",
});

export type SessionWorkspaceDecision = { type: "PROCEED" } | { type: "REFUSED"; request: HumanRequestDraft };

/**
 * The last gate between `stagesRequiringWorkspace` and a provider session: a stage that changes
 * files must never reach an adapter without the worktree it is meant to change.
 *
 * This exists because the two facts were connected by nothing. `decideDispatchStage` answers
 * DISPATCH from an adapter's DECLARED stages alone, and once the Codex adapter declared IMPLEMENT
 * and QA, an invocation that carried no workspace was indistinguishable -- to the adapter -- from a
 * DISCOVERY session that was never meant to write. The adapter took its read-only branch, the agent
 * answered from an empty directory, and the stage closed COMPLETED. A session reporting work it
 * never did is the worst outcome this project has, so the invariant is checked rather than assumed.
 *
 * Takes `hasWorkspace` rather than a workspace, so this package states the rule without knowing
 * `ProviderWorkspace` (`@loomrail/provider-core`) -- the daemon, which builds the invocation, is the
 * layer that answers whether the invocation it is about to send carries one. The caller must read
 * that answer off the invocation itself and not off whatever it *meant* to put there: reading it
 * anywhere else re-opens exactly the gap this closes.
 *
 * Reads `stagesRequiringWorkspace` and deliberately NOT `stagesRunningInWorkspace`, which is now
 * the wider of the two. This gate ends a dispatch with a blocking question, and the only sessions
 * worth ending that way are the ones that would otherwise report work they had nowhere to do. A
 * DISCOVERY or REVIEW whose project has no usable repository is a worse session than it could be,
 * not a dishonest one, and it is dispatched exactly as it was before that list widened.
 */
export const decideSessionWorkspace = (context: {
  stage: WorkflowStage;
  hasWorkspace: boolean;
}): SessionWorkspaceDecision => {
  if (!stageRequiresWorkspace(context.stage) || context.hasWorkspace) return { type: "PROCEED" };
  return { type: "REFUSED", request: provisionRefusalRequest(noSessionWorkspaceRefusal(context.stage)) };
};
