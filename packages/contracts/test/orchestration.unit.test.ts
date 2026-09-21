import { describe, expect, it } from "vitest";
import {
  codeBlindOrchestrationSchema,
  coordinatorPacketSchema,
  coordinatorPlanSchema,
  squadStageAssignmentSchema,
} from "../src/index.js";

const order = {
  outcome: "Deliver the approved product outcome",
  verification: "Run the required independent checks",
  dependsOn: [],
  stopCondition: "SCOPE_CHANGE",
};
describe("closed coordinator contracts", () => {
  it("rejects model, tool and repository authority in owner opt-in", () => {
    const valid = { mode: "CODE_BLIND", ownerOutcome: "Make progress visible to the owner." };
    expect(codeBlindOrchestrationSchema.safeParse(valid).success).toBe(true);
    for (const key of ["model", "tools", "repository", "permissions", "fallback", "budget"])
      expect(codeBlindOrchestrationSchema.safeParse({ ...valid, [key]: "malicious" }).success).toBe(false);
  });
  it("accepts bounded acyclic work orders and refuses bad references, extras and unbounded plans", () => {
    expect(
      coordinatorPlanSchema.safeParse({ type: "PLAN", orders: [order, { ...order, dependsOn: [0] }] })
        .success,
    ).toBe(true);
    for (const orders of [
      [],
      [{ ...order, dependsOn: [0] }],
      [order, { ...order, dependsOn: [0, 0] }],
      [order, { ...order, dependsOn: [5] }],
      Array.from({ length: 7 }, () => order),
      [{ ...order, tools: ["read"] }],
    ])
      expect(coordinatorPlanSchema.safeParse({ type: "PLAN", orders }).success).toBe(false);
  });
  it("has no free-text worker report channel and no manager assignment outside PLAN", () => {
    const packet = {
      version: 1,
      ownerOutcome: "Deliver a useful product outcome",
      discovery: "COMPLETED",
      unresolvedQuestions: 0,
      attempt: 1,
      sessionOrdinal: 1,
    };
    for (const key of ["source", "summary", "paths", "code", "report", "encoded", "decisions", "evidence"])
      expect(coordinatorPacketSchema.safeParse({ ...packet, [key]: "const secret = 42" }).success).toBe(
        false,
      );
    expect(
      squadStageAssignmentSchema.safeParse({
        stage: "IMPLEMENT",
        profile: { id: "builtin.code-blind-coordinator", role: "LEAD_PM", revision: 1 },
        execution: { kind: "CODE_BLIND_MANAGER", ownerOutcome: packet.ownerOutcome },
      }).success,
    ).toBe(false);
  });
});
