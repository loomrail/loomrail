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
      canStart: true,
    });
    expect(decision.type).toBe("STAGE_NOT_SERVED");
  });

  it("dispatches a stage the adapter did declare", () => {
    const decision = decideDispatchStage({
      stage: "PLAN",
      provider: "CODEX",
      declaredStages: ["DISCOVERY", "PLAN", "REVIEW"],
      canStart: true,
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
      canStart: true,
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
      canStart: true,
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
      expect(
        decideDispatchStage({ stage, provider: "MOCK", declaredStages: allStages, canStart: true }),
      ).toEqual({
        type: "DISPATCH",
      });
    }
  });

  // Task 10.5: `capabilities().start` and `capabilities().stages` are separate claims -- an
  // adapter whose CLI is not on this machine still declares its normal stages (see
  // provider-codex's/provider-claude-code's `capabilities()`, which keep `stages` populated even
  // when `start` is `false`), so checking `declaredStages` alone would dispatch to it anyway.
  // `stage: "PLAN"` is deliberately one CODEX *does* declare in `codexDeclaredStages`, so a
  // decision to dispatch here can only be explained by the gate ignoring `canStart`, not by the
  // stage being undeclared -- the mutation this test exists to catch.
  it("refuses to dispatch when the adapter cannot start at all, even for a stage it declares", () => {
    const decision = decideDispatchStage({
      stage: "PLAN",
      provider: "CODEX",
      declaredStages: codexDeclaredStages,
      canStart: false,
    });
    expect(decision.type).toBe("STAGE_NOT_SERVED");
  });

  // "CODEX cannot serve PLAN" would be actively misleading here: CODEX does declare PLAN, and the
  // real reason is that its CLI is not on this machine -- a different fact calling for a different
  // fix (install the CLI, not reassign the stage). The wording must say so, not merely refuse; and
  // it must not reuse the undeclared-stage branch's phrasing, which would point the owner at the
  // wrong fix.
  it("names the reason as unavailability, not as an undeclared stage, when the adapter cannot start", () => {
    const decision = decideDispatchStage({
      stage: "PLAN",
      provider: "CODEX",
      declaredStages: codexDeclaredStages,
      canStart: false,
    });
    expect(decision.type).toBe("STAGE_NOT_SERVED");
    if (decision.type !== "STAGE_NOT_SERVED") throw new Error("unreachable: asserted above");
    expect(decision.request.title).toContain("not installed");
    expect(decision.request.title).toContain("CODEX");
    expect(decision.request.context).toContain("PLAN");
    expect(decision.request.context).not.toContain("cannot serve");
    expect(decision.request.context).not.toContain("declares only");
  });
});
