import type { BudgetPolicy } from "@loomrail/contracts";
import { describe, expect, it } from "vitest";

import { workflowPolicyFormValues } from "./workflowPolicy";

const policy: BudgetPolicy = {
  schemaVersion: 1,
  id: "budget-policy-8",
  projectId: "project-1",
  workItemId: "work-item-1",
  pipelineRunId: "pipeline-run-1",
  revision: 8,
  maxEstimatedTokens: 5_500_000,
  warningThresholds: [0.5, 0.8, 0.95],
  modelTierOverride: "FAST",
  agentRunMaxEstimatedTokensOverride: 1_000_000,
  createdBy: { type: "HUMAN", id: "local-owner" },
  createdAt: "2026-09-04T14:18:00.000Z",
};

describe("workflow cost-policy form", () => {
  it("starts an override from the durable policy instead of stale setup suggestions", () => {
    expect(workflowPolicyFormValues(policy)).toEqual({
      budgetLimitInput: "5500000",
      agentRunLimitInput: "1000000",
      modelTierOverride: "FAST",
    });
  });

  it("keeps explicit setup fallbacks for legacy role-default policies", () => {
    expect(
      workflowPolicyFormValues({
        ...policy,
        modelTierOverride: null,
        agentRunMaxEstimatedTokensOverride: null,
      }),
    ).toEqual({
      budgetLimitInput: "5500000",
      agentRunLimitInput: "175000",
      modelTierOverride: "FAST",
    });
  });
});
