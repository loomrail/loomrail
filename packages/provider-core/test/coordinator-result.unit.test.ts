import { describe, expect, it } from "vitest";
import { decodeProviderStageResult, providerStageResultSchemaFor } from "../src/stage-result.js";
import { z } from "zod";
const policy = { humanRequests: "DISALLOWED" as const, codeBlindCoordinator: true };
const order = {
  outcome: "Deliver the requested product outcome",
  verification: "Perform owner-approved checks and independent review",
  dependsOn: [],
  stopCondition: "VERIFICATION_FAILED",
};
describe("coordinator result boundary", () => {
  it("turns a validated DAG into a durable work order checkpoint, never acceptance", () => {
    const result = decodeProviderStageResult("PLAN", { result: { type: "PLAN", orders: [order] } }, policy);
    expect(result?.outcome.type).toBe("COMPLETED");
    expect(result?.checkpoint?.remaining).toEqual([
      "Work order 0: depends on none; stop on VERIFICATION_FAILED.",
      `Outcome 0: ${order.outcome}`,
      `Verification 0: ${order.verification}`,
    ]);
    expect(z.toJSONSchema(providerStageResultSchemaFor("PLAN", policy))).toMatchObject({ type: "object" });
  });
  it("preserves every maximum-length field without overflowing durable checkpoint items", () => {
    const text = '"\\\nёж'.repeat(100).slice(0, 400);
    const orders = Array.from({ length: 6 }, (_, index) => ({
      ...order,
      outcome: text,
      verification: text,
      dependsOn: index === 0 ? [] : [index - 1],
    }));
    const result = decodeProviderStageResult("PLAN", { result: { type: "PLAN", orders } }, policy);
    expect(result?.checkpoint?.remaining).toHaveLength(18);
    expect(result?.checkpoint?.remaining.every((item) => item.length <= 500)).toBe(true);
    expect(result?.checkpoint?.remaining[16]).toBe(`Outcome 5: ${text.trim()}`);
    expect(result?.checkpoint?.remaining[17]).toBe(`Verification 5: ${text.trim()}`);
  });
  it("has no ordinary or historical completion fallback", () => {
    for (const result of [
      { type: "COMPLETED", summary: "done", completed: [], remaining: [], deadEnds: [], openQuestions: [] },
      { type: "READY_FOR_ACCEPTANCE" },
      { type: "PLAN", orders: [{ ...order, dependsOn: [0] }] },
    ])
      expect(decodeProviderStageResult("PLAN", { result }, policy)).toBeNull();
    expect(
      decodeProviderStageResult("IMPLEMENT", { result: { type: "PLAN", orders: [order] } }, policy),
    ).toBeNull();
  });
});
