import { describe, expect, it } from "vitest";

import {
  adapterWorksInWorkspace,
  decideProvisionWorkspace,
  decideSessionWorkspace,
  stagesRequiringWorkspace,
  stageRequiresWorkspace,
  stagesRunningInWorkspace,
  stageRunsInWorkspace,
  workspaceBranchName,
} from "../src/index.js";

describe("workspaceBranchName", () => {
  it("builds a branch name a human can recognise and git will accept", () => {
    const branch = workspaceBranchName({
      workItemId: "workItem-9a342451-1a2b-4c3d-8e5f-1234567890ab",
      title: "Fix the login redirect",
    });
    expect(branch).toBe("loomrail/9a342451-fix-the-login-redirect");
  });

  it("keeps a title made only of punctuation from producing an unusable ref", () => {
    const branch = workspaceBranchName({
      workItemId: "workItem-9a342451-1a2b-4c3d-8e5f-1234567890ab",
      title: "??? !!!",
    });
    expect(branch).toBe("loomrail/9a342451");
  });

  // Git rejects refs containing these characters outright; a title is arbitrary human text, so the
  // branch name has to survive one that is full of them. If the slug were built by stripping a
  // hand-picked list of "bad" characters instead of assembling from a permitted alphabet, a
  // character nobody thought to list (e.g. em dash, or a git-illegal one this test doesn't even
  // name) would leak straight into the ref.
  it("never lets forbidden ref characters through, whatever the title contains", () => {
    const branch = workspaceBranchName({
      workItemId: "workItem-9a342451-1a2b-4c3d-8e5f-1234567890ab",
      title: "Fix ~HEAD^ path:[x] vs y\\z .. done. @{upstream}",
    });
    expect(branch).not.toMatch(/[~^:?*[\]\\]/);
    expect(branch).not.toContain("..");
    expect(branch).not.toContain(" ");
    expect(branch).not.toContain("@{");
    expect(branch.endsWith(".")).toBe(false);
  });

  it("truncates a long title's slug to 40 characters without leaving a trailing hyphen", () => {
    const branch = workspaceBranchName({
      workItemId: "workItem-9a342451-1a2b-4c3d-8e5f-1234567890ab",
      title: "a very long title that goes well past the forty character slug budget for a branch",
    });
    const slug = branch.slice("loomrail/9a342451-".length);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("decideProvisionWorkspace", () => {
  it("asks the owner rather than cutting a branch from a rebase in progress", () => {
    const decision = decideProvisionWorkspace({
      repository: { isRepository: true, inProgress: "REBASE", path: "/x", insideRepository: null },
    });
    expect(decision.type).toBe("REFUSED");
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.title).toContain("rebase");
    expect(decision.request.blocking).toBe(true);
  });

  it("asks the owner when the path is not a Git repository at all", () => {
    const decision = decideProvisionWorkspace({
      repository: { isRepository: false, inProgress: null, path: "/not-a-repo", insideRepository: null },
    });
    expect(decision.type).toBe("REFUSED");
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.title).toContain("/not-a-repo");
    expect(decision.request.blocking).toBe(true);
  });

  // A path *inside* a repository is refused for a different reason than a path with no repository
  // anywhere near it, and the owner has to be told which. `git status` works in such a directory,
  // so "check that the path still points at a Git repository" -- the other refusal's advice -- is
  // an instruction to go looking for a problem that is not there.
  it("tells an owner registered inside a repository which repository it is inside", () => {
    const decision = decideProvisionWorkspace({
      repository: {
        isRepository: false,
        inProgress: null,
        path: "/repo/packages/inner",
        insideRepository: "/repo",
      },
    });
    expect(decision.type).toBe("REFUSED");
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.title).not.toContain("not a Git repository");
    expect(decision.request.context).toContain("/repo/packages/inner");
    expect(decision.request.context).toContain("inside the repository at /repo");
    // Both fixes, because either is legitimate; neither is "repair the repository", which is what
    // the not-a-repository refusal would have recommended for a repository that is perfectly fine.
    expect(decision.request.recommendation).toContain("Register the project at /repo");
    expect(decision.request.recommendation).toContain("repository of its own");
    expect(decision.request.blocking).toBe(true);
    expect(decision.request.kind).toBe("FREE_TEXT");
    expect(decision.request.options).toEqual([]);
    expect(decision.request.allowOther).toBe(true);
  });

  // The rebase and "not a repository" refusals name different fixes; a caller reading only
  // `decision.type === "REFUSED"` cannot tell the owner which one applies. Distinguishing the
  // wording, not just the outcome, is the whole point of naming the state instead of just refusing.
  it("gives the rebase and not-a-repository refusals different wording", () => {
    const rebase = decideProvisionWorkspace({
      repository: { isRepository: true, inProgress: "REBASE", path: "/x", insideRepository: null },
    });
    const notARepo = decideProvisionWorkspace({
      repository: { isRepository: false, inProgress: null, path: "/x", insideRepository: null },
    });
    if (rebase.type !== "REFUSED" || notARepo.type !== "REFUSED") throw new Error("unreachable");
    expect(rebase.request.title).not.toBe(notARepo.request.title);
  });

  // Every refusal in this module follows decideDispatchStage's convention (workflow.ts): the right
  // fix is out-of-band and cannot be enumerated, so it is FREE_TEXT with no options and allowOther.
  it("builds every refusal as a blocking, unstructured question", () => {
    const decision = decideProvisionWorkspace({
      repository: { isRepository: true, inProgress: "MERGE", path: "/x", insideRepository: null },
    });
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.kind).toBe("FREE_TEXT");
    expect(decision.request.options).toEqual([]);
    expect(decision.request.allowOther).toBe(true);
  });

  it("allows provisioning a clean repository with nothing in progress", () => {
    const decision = decideProvisionWorkspace({
      repository: { isRepository: true, inProgress: null, path: "/x", insideRepository: null },
    });
    expect(decision).toEqual({ type: "PROVISION" });
  });
});

// Controller ruling R1: Task 9 reads this constant instead of a workflow-template field, because
// the template has no such field and adding one is out of this milestone's scope.
//
// R11 corrected WHAT the constant says. It was IMPLEMENT and QA, on the reasoning that every other
// stage "only ever produces prose" -- and a real REVIEW session, on a real repository, reported that
// it could find no repository and no implementation to assess. Producing prose is not needing no
// input: a review reads the change it is reviewing. The list is now every stage an agent runs, and
// the assertion below is spelled out stage by stage so that narrowing it back fails here rather
// than passing as a silently smaller set.
describe("stagesRunningInWorkspace", () => {
  it("runs every agent stage in the work item's worktree, ACCEPTANCE alone excepted", () => {
    expect(stagesRunningInWorkspace).toEqual(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA"]);
    expect(stageRunsInWorkspace("DISCOVERY")).toBe(true);
    expect(stageRunsInWorkspace("PLAN")).toBe(true);
    expect(stageRunsInWorkspace("IMPLEMENT")).toBe(true);
    // The stage the defect was found on: REVIEW reads the implementation it is judging.
    expect(stageRunsInWorkspace("REVIEW")).toBe(true);
    expect(stageRunsInWorkspace("QA")).toBe(true);
    // Not an omission, and not "it produces prose": acceptance is the owner's decision, not an
    // agent's reading of the tree.
    expect(stageRunsInWorkspace("ACCEPTANCE")).toBe(false);
  });
});

// The narrower list, and the reason there are two: being handed a worktree and being refused
// without one are different questions. A Project whose path is not a repository -- a legacy fixture
// Project, a path that moved -- ran DISCOVERY, PLAN and REVIEW before this milestone and has to go
// on running them, so widening the list above must not widen this one with it.
describe("stagesRequiringWorkspace", () => {
  it("refuses only the stages that cannot honestly run without a worktree", () => {
    expect(stagesRequiringWorkspace).toEqual(["IMPLEMENT", "QA"]);
    expect(stageRequiresWorkspace("IMPLEMENT")).toBe(true);
    expect(stageRequiresWorkspace("QA")).toBe(true);
    expect(stageRequiresWorkspace("DISCOVERY")).toBe(false);
    expect(stageRequiresWorkspace("PLAN")).toBe(false);
    expect(stageRequiresWorkspace("REVIEW")).toBe(false);
    expect(stageRequiresWorkspace("ACCEPTANCE")).toBe(false);
  });
});

// Cutting a worktree writes a ref, a carry-in commit and a `.git/worktrees` entry into the owner's
// own repository, so it is not done on behalf of an adapter that will discard it. Declaring a stage
// that requires one is the only signal an adapter gives, and today it separates the two live
// adapters exactly: Codex declares all six stages and reads `invocation.workspace`; Claude Code
// declares three prose stages and always runs in a temporary directory of its own.
describe("adapterWorksInWorkspace", () => {
  it("answers for the stages an adapter declares, not for the stage being dispatched", () => {
    expect(adapterWorksInWorkspace(["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"])).toBe(
      true,
    );
    expect(adapterWorksInWorkspace(["DISCOVERY", "PLAN", "REVIEW"])).toBe(false);
    expect(adapterWorksInWorkspace(["QA"])).toBe(true);
  });
});

// The gate that closes E1's live defect: the Codex adapter began declaring IMPLEMENT and QA, and
// `decideDispatchStage` answers DISPATCH from the declared list alone, so nothing between that
// decision and the adapter checked that the writing stage actually had somewhere to write. It did
// not: the daemon built its invocation without the workspace it had just cut and leased, the
// adapter took its read-only branch in an empty temporary directory, and the stage closed
// COMPLETED on an answer the agent had no repository to produce.
describe("decideSessionWorkspace", () => {
  it("refuses a stage that changes files when the invocation carries no workspace", () => {
    for (const stage of stagesRequiringWorkspace) {
      const decision = decideSessionWorkspace({ stage, hasWorkspace: false });
      expect(decision.type).toBe("REFUSED");
      if (decision.type !== "REFUSED") throw new Error("unreachable: asserted immediately above");
      expect(decision.request.title).toContain(stage);
      expect(decision.request.blocking).toBe(true);
      // The refusal has to say what went wrong in terms the owner can act on -- and here what they
      // can act on is nothing in their repository, so it must not send them looking.
      expect(decision.request.context).toContain("read-only");
      expect(decision.request.recommendation).toContain("Nothing in the project or its repository");
    }
  });

  it("proceeds once the invocation carries the workspace", () => {
    for (const stage of stagesRequiringWorkspace) {
      expect(decideSessionWorkspace({ stage, hasWorkspace: true })).toEqual({ type: "PROCEED" });
    }
  });

  // The other half, and the reason this is not simply "always require a workspace": DISCOVERY,
  // PLAN and REVIEW are dispatched into the worktree when there is one (`stagesRunningInWorkspace`)
  // and dispatched without one when there is not -- a project whose path is not a repository still
  // runs them, exactly as it did before E1. ACCEPTANCE never gets one at all. A gate that refused
  // any of the four would refuse four of the six stages of every pipeline on such a project.
  it("proceeds for a stage that can answer without a worktree, with or without one", () => {
    for (const stage of ["DISCOVERY", "PLAN", "REVIEW", "ACCEPTANCE"] as const) {
      expect(decideSessionWorkspace({ stage, hasWorkspace: false })).toEqual({ type: "PROCEED" });
      expect(decideSessionWorkspace({ stage, hasWorkspace: true })).toEqual({ type: "PROCEED" });
    }
  });

  it("builds its refusal as the same blocking, unstructured question every other one on this path is", () => {
    const decision = decideSessionWorkspace({ stage: "IMPLEMENT", hasWorkspace: false });
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.kind).toBe("FREE_TEXT");
    expect(decision.request.options).toEqual([]);
    expect(decision.request.allowOther).toBe(true);
  });
});
