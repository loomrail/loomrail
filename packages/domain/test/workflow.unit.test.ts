import { describe, expect, it } from "vitest";

import { decideDispatchStage } from "../src/index.js";

// A live CODEX adapter, milestone A2: it has no filesystem access before E1, so it declares every
// stage except the one that needs to change something -- IMPLEMENT.
const codexDeclaredStages = ["DISCOVERY", "PLAN", "REVIEW", "QA", "ACCEPTANCE"] as const;

describe("decideDispatchStage", () => {
  it("refuses to dispatch a stage the adapter did not declare", () => {
    const decision = decideDispatchStage({
      stage: "IMPLEMENT",
      provider: "CODEX",
      declaredStages: ["DISCOVERY", "PLAN", "REVIEW"],
    });
    expect(decision.type).toBe("STAGE_NOT_SERVED");
  });

  it("dispatches a stage the adapter did declare", () => {
    const decision = decideDispatchStage({
      stage: "PLAN",
      provider: "CODEX",
      declaredStages: ["DISCOVERY", "PLAN", "REVIEW"],
    });
    expect(decision.type).toBe("DISPATCH");
  });

  // A refusal the owner cannot see is a stage that silently never runs. The check is on `.title`
  // AND `.context`, not merely that a request object exists: a HumanRequest whose wording never
  // says which stage or which provider is exactly as unactionable as no request at all -- and would
  // pass a test that only checked `decision.type === "STAGE_NOT_SERVED"`.
  it("opens a Human Request naming the stage and the provider", () => {
    const decision = decideDispatchStage({
      stage: "IMPLEMENT",
      provider: "CODEX",
      declaredStages: codexDeclaredStages,
    });
    expect(decision.type).toBe("STAGE_NOT_SERVED");
    if (decision.type !== "STAGE_NOT_SERVED") throw new Error("unreachable: asserted above");
    expect(decision.request.title).toContain("IMPLEMENT");
    expect(decision.request.title).toContain("CODEX");
    expect(decision.request.context).toContain("IMPLEMENT");
    expect(decision.request.context).toContain("CODEX");
  });

  // Same check, a different provider and a different declared set, so the wording under test is not
  // an accident of the one fixture above -- the request has to be built from the arguments, not a
  // constant string that happens to contain "IMPLEMENT" and "CODEX".
  it("names the stage and provider it was actually given, not a fixed pair", () => {
    const decision = decideDispatchStage({
      stage: "REVIEW",
      provider: "CLAUDE_CODE",
      declaredStages: ["DISCOVERY", "PLAN"],
    });
    expect(decision.type).toBe("STAGE_NOT_SERVED");
    if (decision.type !== "STAGE_NOT_SERVED") throw new Error("unreachable: asserted above");
    expect(decision.request.title).toContain("REVIEW");
    expect(decision.request.title).toContain("CLAUDE_CODE");
    expect(decision.request.context).toContain("REVIEW");
    expect(decision.request.context).toContain("CLAUDE_CODE");
  });

  // provider-mock declares all six stages (spec: it exists precisely so every stage has somewhere to
  // run in the mock milestones). This is the gate's required no-op: every stage the mock declares
  // must dispatch, not merely one of them.
  it("is a no-op for an adapter that declares every stage, like the mock", () => {
    const allStages = ["DISCOVERY", "PLAN", "IMPLEMENT", "REVIEW", "QA", "ACCEPTANCE"] as const;
    for (const stage of allStages) {
      expect(decideDispatchStage({ stage, provider: "MOCK", declaredStages: allStages })).toEqual({
        type: "DISPATCH",
      });
    }
  });
});
