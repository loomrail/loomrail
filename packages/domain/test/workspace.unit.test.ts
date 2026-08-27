import { describe, expect, it } from "vitest";

import {
  decideProvisionWorkspace,
  stagesRequiringWorkspace,
  stageRequiresWorkspace,
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
      repository: { isRepository: true, inProgress: "REBASE", path: "/x" },
    });
    expect(decision.type).toBe("REFUSED");
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.title).toContain("rebase");
    expect(decision.request.blocking).toBe(true);
  });

  it("asks the owner when the path is not a Git repository at all", () => {
    const decision = decideProvisionWorkspace({
      repository: { isRepository: false, inProgress: null, path: "/not-a-repo" },
    });
    expect(decision.type).toBe("REFUSED");
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.title).toContain("/not-a-repo");
    expect(decision.request.blocking).toBe(true);
  });

  // The rebase and "not a repository" refusals name different fixes; a caller reading only
  // `decision.type === "REFUSED"` cannot tell the owner which one applies. Distinguishing the
  // wording, not just the outcome, is the whole point of naming the state instead of just refusing.
  it("gives the rebase and not-a-repository refusals different wording", () => {
    const rebase = decideProvisionWorkspace({
      repository: { isRepository: true, inProgress: "REBASE", path: "/x" },
    });
    const notARepo = decideProvisionWorkspace({
      repository: { isRepository: false, inProgress: null, path: "/x" },
    });
    if (rebase.type !== "REFUSED" || notARepo.type !== "REFUSED") throw new Error("unreachable");
    expect(rebase.request.title).not.toBe(notARepo.request.title);
  });

  // Every refusal in this module follows decideDispatchStage's convention (workflow.ts): the right
  // fix is out-of-band and cannot be enumerated, so it is FREE_TEXT with no options and allowOther.
  it("builds every refusal as a blocking, unstructured question", () => {
    const decision = decideProvisionWorkspace({
      repository: { isRepository: true, inProgress: "MERGE", path: "/x" },
    });
    if (decision.type !== "REFUSED") throw new Error("unreachable");
    expect(decision.request.kind).toBe("FREE_TEXT");
    expect(decision.request.options).toEqual([]);
    expect(decision.request.allowOther).toBe(true);
  });

  it("allows provisioning a clean repository with nothing in progress", () => {
    const decision = decideProvisionWorkspace({
      repository: { isRepository: true, inProgress: null, path: "/x" },
    });
    expect(decision).toEqual({ type: "PROVISION" });
  });
});

// Controller ruling R1: Task 9 reads this constant instead of a workflow-template field, because
// the template has no such field and adding one is out of this milestone's scope.
describe("stagesRequiringWorkspace", () => {
  it("requires a workspace for IMPLEMENT and QA, and no other stage", () => {
    expect(stagesRequiringWorkspace).toEqual(["IMPLEMENT", "QA"]);
    expect(stageRequiresWorkspace("IMPLEMENT")).toBe(true);
    expect(stageRequiresWorkspace("QA")).toBe(true);
    expect(stageRequiresWorkspace("DISCOVERY")).toBe(false);
    expect(stageRequiresWorkspace("PLAN")).toBe(false);
    expect(stageRequiresWorkspace("REVIEW")).toBe(false);
    expect(stageRequiresWorkspace("ACCEPTANCE")).toBe(false);
  });
});
